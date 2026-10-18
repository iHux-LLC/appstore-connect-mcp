import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { jwtVerify } from "jose";
import { describe, expect, it } from "vitest";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { TokenProvider } from "../src/auth.js";
import { loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";
import { clientStatuses, EXTENSION_NAME, installClient, SERVER_NAME, serverEntry, uninstallClient, type Runner } from "../src/settings/clients.js";
import { PACKAGE_NAME } from "../src/version.js";
import { keyIdFromFileName, readStored, saveKey, settingsFile, updateStored } from "../src/settings/store.js";
import { startSettingsServer } from "../src/settings/web.js";
import { connect, json, keyPair, mockFetch, privatePem, resultText } from "./helpers.js";

const freshEnv = () => ({ ASC_CONFIG_DIR: mkdtempSync(join(tmpdir(), "asc-settings-")) });
const mode = (path: string) => statSync(path).mode & 0o777;

describe("settings store", () => {
  it("writes settings and keys readable only by the user", () => {
    const env = freshEnv();
    const keyPath = saveKey(privatePem, "2x9r4hxf34", env);
    updateStored({ keyId: "2X9R4HXF34", issuerId: "iss", privateKeyPath: keyPath, mode: "write" }, env);
    expect(keyPath.endsWith("keys/AuthKey_2X9R4HXF34.p8")).toBe(true);
    expect(mode(keyPath)).toBe(0o600);
    expect(mode(settingsFile(env))).toBe(0o600);
    expect(mode(dirname(settingsFile(env)))).toBe(0o700);
    expect(readStored(env)).toEqual({ keyId: "2X9R4HXF34", issuerId: "iss", privateKeyPath: keyPath, mode: "write" });
    updateStored({ mode: "full" }, env);
    expect(readStored(env).keyId).toBe("2X9R4HXF34");
  });

  it("rejects files that are not private keys", () => {
    expect(() => saveKey("hello", "2X9R4HXF34", freshEnv())).toThrow(/not an App Store Connect private key/);
  });

  it("reads the Key ID from Apple's file name", () => {
    expect(keyIdFromFileName("/Downloads/AuthKey_2X9R4HXF34.p8")).toBe("2X9R4HXF34");
    expect(keyIdFromFileName("key.p8")).toBeUndefined();
  });
});

describe("config precedence", () => {
  it("uses the settings file and lets env override it field by field", () => {
    const env = freshEnv();
    updateStored({ keyId: "FILEKEY123", issuerId: "file-iss", privateKeyPath: "/k.p8", mode: "write" }, env);
    const fromFile = loadConfig(env);
    expect(fromFile).toMatchObject({ keyId: "FILEKEY123", mode: "write", privateKeyPath: "/k.p8" });
    expect(fromFile.sources).toEqual({ keyId: "settings", issuerId: "settings", privateKey: "settings", mode: "settings" });

    const mixed = loadConfig({ ...env, ASC_MODE: "readonly", ASC_KEY_ID: "ENVKEY1234" });
    expect(mixed).toMatchObject({ keyId: "ENVKEY1234", issuerId: "file-iss", mode: "readonly" });
    expect(mixed.sources).toMatchObject({ keyId: "env", issuerId: "settings", mode: "env" });
  });
});

describe("live reload", () => {
  it("shows write tools and notifies the client when the mode changes", async () => {
    const env = freshEnv();
    const config = loadConfig(env);
    const { server, reload } = createServer(config, { env, fetchImpl: mockFetch().fn });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "t", version: "1" });
    let notified = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => void notified++);
    await client.connect(ct);

    const names = async () => (await client.listTools()).tools.map((t) => t.name);
    expect(await names()).not.toContain("asc_submit_for_review");

    updateStored({ mode: "write" }, env);
    reload();
    await new Promise((r) => setTimeout(r, 20));
    expect(notified).toBeGreaterThan(0);
    expect(await names()).toEqual(expect.arrayContaining(["asc_submit_for_review", "asc_upload_asset"]));

    notified = 0;
    reload(); // nothing changed: no extra notifications
    await new Promise((r) => setTimeout(r, 20));
    expect(notified).toBe(0);
  });

  it("switches to new credentials without a restart", async () => {
    const env = freshEnv();
    const first = saveKey(privatePem, "AAAAAAAAAA", env);
    updateStored({ keyId: "AAAAAAAAAA", issuerId: "iss", privateKeyPath: first }, env);
    const config = loadConfig(env);
    const tokens = new TokenProvider(config);
    await jwtVerify(await tokens.getToken(), keyPair.publicKey);

    const other = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const second = saveKey(other.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), "BBBBBBBBBB", env);
    updateStored({ keyId: "BBBBBBBBBB", privateKeyPath: second }, env);
    Object.assign(config, loadConfig(env));
    tokens.reset();
    const { protectedHeader } = await jwtVerify(await tokens.getToken(), other.publicKey);
    expect(protectedHeader.kid).toBe("BBBBBBBBBB");
  });
});

describe("client installers", () => {
  const desktopPath = () =>
    process.platform === "darwin"
      ? join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json")
      : join(homedir(), ".config", "Claude", "claude_desktop_config.json");

  it("adds and removes the server in Claude Desktop and Cursor, keeping other servers and a backup", async () => {
    mkdirSync(dirname(desktopPath()), { recursive: true });
    writeFileSync(desktopPath(), JSON.stringify({ mcpServers: { other: { command: "x" } }, theme: "dark" }));
    const r = await installClient("claude-desktop");
    const cfg = JSON.parse(readFileSync(desktopPath(), "utf8"));
    expect(cfg.theme).toBe("dark");
    expect(cfg.mcpServers.other).toEqual({ command: "x" });
    expect(cfg.mcpServers[SERVER_NAME].command).toBe(process.execPath);
    expect(cfg.mcpServers[SERVER_NAME].env).toBeUndefined();
    expect(r.backup && existsSync(r.backup)).toBe(true);

    await installClient("cursor");
    const cursor = join(homedir(), ".cursor", "mcp.json");
    expect(JSON.parse(readFileSync(cursor, "utf8")).mcpServers[SERVER_NAME]).toBeDefined();

    const statuses = await clientStatuses(async () => { throw new Error("no claude"); });
    expect(statuses.map((s) => [s.id, s.installed])).toEqual([["claude-code", false], ["claude-desktop", true], ["cursor", true]]);

    await uninstallClient("claude-desktop");
    expect(JSON.parse(readFileSync(desktopPath(), "utf8")).mcpServers).toEqual({ other: { command: "x" } });
  });

  it("refuses to overwrite a config that isn't valid JSON", async () => {
    const cursor = join(homedir(), ".cursor", "mcp.json");
    mkdirSync(dirname(cursor), { recursive: true });
    writeFileSync(cursor, "{ broken");
    await expect(installClient("cursor")).rejects.toThrow(/not valid JSON/);
    expect(readFileSync(cursor, "utf8")).toBe("{ broken");
    writeFileSync(cursor, "{}");
  });

  it("flags ASC_* env overrides left in a client config", async () => {
    const cursor = join(homedir(), ".cursor", "mcp.json");
    writeFileSync(cursor, JSON.stringify({ mcpServers: { [SERVER_NAME]: { command: "node", env: { ASC_MODE: "full" } } } }));
    const status = (await clientStatuses(async () => { throw new Error("no claude"); })).find((c) => c.id === "cursor")!;
    expect(status.pinnedEnv).toEqual(["ASC_MODE"]);
  });

  it("points clients at the published package when running inside the Desktop extension", () => {
    const entry = serverEntry({ ASC_RUNTIME: "mcpb" });
    expect(entry.args.slice(-2)).toEqual(["-y", PACKAGE_NAME]);
    expect(PACKAGE_NAME).toBe("@ihux/appstore-connect-mcp");
    expect(serverEntry({}).args[0]).toMatch(/index\.(js|ts)$/);
  });

  it("recognises the Claude Desktop extension and won't add a duplicate", async () => {
    const registry = join(dirname(desktopPath()), "extensions-installations.json");
    writeFileSync(registry, JSON.stringify({ extensions: { "local.x": { manifest: { name: EXTENSION_NAME } } } }));
    try {
      const desktop = (await clientStatuses(async () => { throw new Error("no claude"); })).find((c) => c.id === "claude-desktop")!;
      expect(desktop).toMatchObject({ installed: true, managedBy: "extension" });
      await expect(installClient("claude-desktop")).rejects.toThrow(/Claude Desktop extension/);
    } finally {
      writeFileSync(registry, JSON.stringify({ extensions: {} }));
    }
  });

  it("uses the claude CLI for Claude Code", async () => {
    const calls: string[][] = [];
    const runner: Runner = async (cmd, args) => {
      calls.push([cmd, ...args]);
      return { stdout: "", stderr: "" };
    };
    await installClient("claude-code", runner);
    expect(calls.at(-1)!.slice(0, 7)).toEqual(["claude", "mcp", "add", SERVER_NAME, "--scope", "user", "--"]);
    expect(calls.at(-1)).toContain(process.execPath);
  });
});

describe("settings page server", () => {
  const noClaude: Runner = async () => { throw new Error("no claude"); };

  async function start(fetchImpl = mockFetch().fn) {
    const env = freshEnv();
    const page = await startSettingsServer({ env, fetchImpl, runner: noClaude });
    const url = new URL(page.url);
    const token = url.searchParams.get("t")!;
    const api = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
      fetch(new URL(path, url), {
        method: body === undefined ? "GET" : "POST",
        headers: { "X-Session-Token": token, ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    return { env, page, url, token, api };
  }

  it("serves the page only with the session token, with a strict CSP", async () => {
    const { page, url } = await start();
    expect((await fetch(new URL("/", url))).status).toBe(403);
    const res = await fetch(page.url);
    expect(res.status).toBe(200);
    const csp = res.headers.get("content-security-policy")!;
    const nonce = /nonce-([^']+)/.exec(csp)![1];
    expect(await res.text()).toContain(`<script nonce="${nonce}">`);
    page.close();
    await page.closed;
  });

  it("rejects API calls without the token or from another host name", async () => {
    const { page, url, api } = await start();
    expect((await fetch(new URL("/api/state", url))).status).toBe(403);
    // Node's fetch won't let us forge Host, so check via a raw request.
    const http = await import("node:http");
    const status = await new Promise<number>((resolve) => {
      http.get({ host: "127.0.0.1", port: url.port, path: "/api/state", headers: { Host: "evil.example:80" } }, (r) => resolve(r.statusCode!));
    });
    expect(status).toBe(403);
    expect((await api("/api/state")).status).toBe(200);
    page.close();
  });

  it("saves credentials only after Apple accepts them", async () => {
    let accept = false;
    const fetchImpl = mockFetch(() =>
      accept ? json({ data: [{ type: "apps", id: "1", attributes: { name: "My App" } }], links: {} }) : json({ errors: [{ status: "401", title: "Unauthorized" }] }, 401),
    ).fn;
    const { env, page, api } = await start(fetchImpl);
    const body = { keyId: "2X9R4HXF34", issuerId: "57246542-96fe-1a63-e053-0824d011072a", pem: privatePem, fileName: "AuthKey_2X9R4HXF34.p8" };

    expect((await api("/api/save", { ...body, pem: "nope" })).status).toBe(400);
    const rejected = await api("/api/save", body);
    expect(rejected.status).toBe(422);
    expect((await rejected.json()).error).toMatch(/Apple rejected this key/);
    expect(readStored(env)).toEqual({});

    accept = true;
    const saved = await (await api("/api/save", body)).json();
    expect(saved).toMatchObject({ ok: true, appCount: 1, appNames: ["My App"], state: { configured: true } });
    const stored = readStored(env);
    expect(stored.keyId).toBe("2X9R4HXF34");
    expect(mode(stored.privateKeyPath!)).toBe(0o600);

    // Testing again without a new file uses the stored key.
    expect((await (await api("/api/test", { keyId: body.keyId, issuerId: body.issuerId })).json()).ok).toBe(true);

    expect((await api("/api/mode", { mode: "god" })).status).toBe(400);
    expect((await (await api("/api/mode", { mode: "write" })).json()).settings.mode).toBe("write");
    expect(readStored(env).mode).toBe("write");
    page.close();
  });

  it("rejects form-style posts", async () => {
    const { page, api } = await start();
    expect((await api("/api/mode", "mode=full", { "Content-Type": "text/plain" })).status).toBe(405);
    page.close();
  });

  it("closes on request", async () => {
    const { page, api } = await start();
    await api("/api/close", {});
    await expect(page.closed).resolves.toBeUndefined();
  });
});

describe("asc_open_settings", () => {
  it("opens the page in the browser without giving the token to the model", async () => {
    const opened: string[] = [];
    const client = await connect("readonly", mockFetch().fn, { env: freshEnv(), openBrowser: (u) => opened.push(u) });
    const res: any = await client.callTool({ name: "asc_open_settings", arguments: {} });
    expect(opened[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]{48}$/);
    expect(resultText(res)).not.toContain("127.0.0.1");
    expect(resultText(res)).toMatch(/Opened the App Store Connect settings page/);
  });
});

describe("test isolation", () => {
  it("runs with a throwaway home directory", () => {
    expect(homedir().startsWith(tmpdir()) || homedir().includes("asc-home-")).toBe(true);
    expect(readdirSync(homedir())).not.toContain("Documents");
  });
});
