import { execFile } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { platform } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TokenProvider } from "../auth.js";
import { Catalog } from "../catalog.js";
import { AscApiError, AscClient } from "../client.js";
import { loadConfig, MODES, type Mode } from "../config.js";
import { AREAS, areaHasWrites, LEVELS, TOOL_AREAS, type Area, type Level } from "../permissions.js";
import { NPX_COMMAND, VERSION } from "../version.js";
import { clientStatuses, installClient, uninstallClient, type ClientId, type Runner } from "./clients.js";
import { isPrivateKeyPem, keyIdFromFileName, readStored, saveKey, settingsFile, updateStored } from "./store.js";

export interface SettingsServerOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  runner?: Runner;
  /** Closes the page after this long without a request (default 15 minutes). */
  idleMs?: number;
}

export interface SettingsServer {
  url: string;
  close: () => void;
  closed: Promise<void>;
}

const CLIENT_IDS: ClientId[] = ["claude-code", "claude-desktop", "cursor"];
const MAX_BODY = 64 * 1024;

function pageTemplate(): string {
  return readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "assets", "settings.html"), "utf8");
}

async function readBody(req: IncomingMessage): Promise<any> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error("Request too large"), { status: 413 });
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

/** Calls Apple with the given credentials and reports which apps the key can see. */
async function testCredentials(keyId: string, issuerId: string, pem: string, fetchImpl: typeof fetch) {
  const config = loadConfig({ ASC_KEY_ID: keyId, ASC_ISSUER_ID: issuerId, ASC_PRIVATE_KEY: pem, ASC_MODE: "readonly" }, {});
  const client = new AscClient(config, new TokenProvider(config), fetchImpl);
  try {
    const res = await client.request({ method: "GET", path: "/v1/apps", query: { limit: "200", "fields[apps]": "name" } });
    const apps = res.kind === "json" ? res.data.data ?? [] : [];
    return {
      ok: true as const,
      appCount: apps.length,
      moreApps: Boolean(res.kind === "json" && res.data.links?.next),
      appNames: apps.slice(0, 6).map((a: any) => a.attributes?.name).filter(Boolean),
    };
  } catch (err) {
    const message =
      err instanceof AscApiError && err.status === 401
        ? "Apple rejected this key. Check that the Key ID and Issuer ID match the .p8 file and that the key hasn't been revoked."
        : (err as Error).message;
    return { ok: false as const, error: message };
  }
}

function openBrowser(url: string) {
  const [cmd, args] =
    platform() === "darwin" ? ["open", [url]] : platform() === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  execFile(cmd, args as string[], () => undefined);
}

export async function startSettingsServer(opts: SettingsServerOptions = {}): Promise<SettingsServer> {
  const env = opts.env ?? process.env;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const idleMs = opts.idleMs ?? 15 * 60 * 1000;
  const token = randomBytes(24).toString("hex");
  const nonce = randomBytes(16).toString("base64");
  const specVersion = Catalog.load().data.specVersion;
  let expiresAt = Date.now() + idleMs;

  const tokenOk = (value: string | undefined) => {
    if (!value || value.length !== token.length) return false;
    return timingSafeEqual(Buffer.from(value), Buffer.from(token));
  };

  const state = async () => {
    const stored = readStored(env);
    return {
      settings: {
        keyId: stored.keyId ?? "",
        issuerId: stored.issuerId ?? "",
        keyFile: stored.privateKeyPath ? basename(stored.privateKeyPath) : undefined,
        mode: stored.mode ?? "readonly",
        access: stored.access ?? {},
      },
      // Areas with how many tools each level unlocks, so the page can show the live tool count.
      areas: AREAS.map((a) => ({
        ...a,
        readTools: Object.values(TOOL_AREAS).filter((t) => t.area === a.id && t.kind === "read").length,
        writeTools: Object.values(TOOL_AREAS).filter((t) => t.area === a.id && t.kind === "write").length,
      })),
      coreTools: Object.values(TOOL_AREAS).filter((t) => t.area === "core").length,
      totalTools: Object.keys(TOOL_AREAS).length,
      configured: Boolean(stored.keyId && stored.issuerId && stored.privateKeyPath),
      settingsFile: settingsFile(env),
      clients: await clientStatuses(opts.runner),
      version: VERSION,
      specVersion,
      expiresAt,
    };
  };

  const storedPem = () => {
    const stored = readStored(env);
    if (!stored.privateKeyPath) throw Object.assign(new Error("Add your .p8 key file first."), { status: 400 });
    return readFileSync(stored.privateKeyPath, "utf8");
  };

  let resolveClosed!: () => void;
  const closed = new Promise<void>((r) => (resolveClosed = r));
  let idleTimer: NodeJS.Timeout;

  const server = createServer(async (req, res) => {
    const port = (server.address() as any)?.port;
    // Only answer requests addressed to our own origin (blocks DNS-rebinding pages).
    if (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`) {
      res.writeHead(403).end();
      return;
    }
    clearTimeout(idleTimer);
    expiresAt = Date.now() + idleMs;
    idleTimer = setTimeout(close, idleMs);
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);

    try {
      if (req.method === "GET" && url.pathname === "/") {
        if (!tokenOk(url.searchParams.get("t") ?? undefined)) {
          res.writeHead(403, { "Content-Type": "text/plain" }).end(`This settings link has expired. Run \`${NPX_COMMAND} settings\` again, or ask Claude to open the settings.`);
          return;
        }
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
          "X-Frame-Options": "DENY",
          "Content-Security-Policy":
            `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline' https://fonts.googleapis.com; ` +
            "font-src https://fonts.gstatic.com; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        });
        res.end(pageTemplate().replace(/__NONCE__/g, nonce));
        return;
      }

      if (!url.pathname.startsWith("/api/")) return send(res, 404, { error: "Not found" });
      // A custom header plus JSON content type means another site can't drive this API from a browser.
      if (!tokenOk(req.headers["x-session-token"] as string | undefined)) return send(res, 403, { error: "Session expired. Reopen the settings page." });
      if (req.method === "GET" && url.pathname === "/api/state") return send(res, 200, await state());
      if (req.method !== "POST" || !(req.headers["content-type"] ?? "").includes("application/json")) {
        return send(res, 405, { error: "Method not allowed" });
      }
      const body = await readBody(req);

      switch (url.pathname) {
        case "/api/test":
        case "/api/save": {
          const keyId = String(body.keyId ?? keyIdFromFileName(body.fileName ?? "") ?? "").trim().toUpperCase();
          const issuerId = String(body.issuerId ?? "").trim();
          if (!keyId || !issuerId) return send(res, 400, { error: "Enter both the Key ID and the Issuer ID." });
          if (body.pem !== undefined && !isPrivateKeyPem(String(body.pem))) {
            return send(res, 400, { error: "That file is not an App Store Connect private key (.p8)." });
          }
          const pem = body.pem !== undefined ? String(body.pem) : storedPem();
          const result = await testCredentials(keyId, issuerId, pem, fetchImpl);
          if (!result.ok || url.pathname === "/api/test") return send(res, result.ok ? 200 : 422, result);
          // Saved only after Apple accepted the key.
          const privateKeyPath = body.pem !== undefined ? saveKey(pem, keyId, env) : undefined;
          updateStored({ keyId, issuerId, privateKeyPath }, env);
          return send(res, 200, { ...result, state: await state() });
        }
        case "/api/mode": {
          if (!MODES.includes(body.mode)) return send(res, 400, { error: `Mode must be one of ${MODES.join(", ")}.` });
          updateStored({ mode: body.mode as Mode }, env);
          return send(res, 200, await state());
        }
        case "/api/access": {
          // Either one area's level, or reset (every area follows the overall limit again).
          if (body.reset === true) {
            updateStored({ access: {} }, env);
            return send(res, 200, await state());
          }
          if (!AREAS.some((a) => a.id === body.area)) return send(res, 400, { error: "Unknown area." });
          if (!LEVELS.includes(body.level)) return send(res, 400, { error: `Level must be one of ${LEVELS.join(", ")}.` });
          if (body.level === "write" && !areaHasWrites(body.area)) return send(res, 400, { error: "This area only reads; it has no write level." });
          const access = { ...(readStored(env).access ?? {}), [body.area as Area]: body.level as Level };
          updateStored({ access }, env);
          return send(res, 200, await state());
        }
        case "/api/clients/install":
        case "/api/clients/uninstall": {
          if (!CLIENT_IDS.includes(body.client)) return send(res, 400, { error: "Unknown client." });
          const result =
            url.pathname.endsWith("/install") ? await installClient(body.client, opts.runner) : await uninstallClient(body.client, opts.runner);
          return send(res, 200, { result, state: await state() });
        }
        case "/api/close":
          send(res, 200, { ok: true });
          setTimeout(close, 50);
          return;
        default:
          return send(res, 404, { error: "Not found" });
      }
    } catch (err) {
      const status = (err as any).status ?? 500;
      send(res, status, { error: (err as Error).message });
    }
  });

  function close() {
    clearTimeout(idleTimer);
    server.close(() => resolveClosed());
    server.closeAllConnections?.();
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  idleTimer = setTimeout(close, idleMs);
  const port = (server.address() as any).port;
  return { url: `http://127.0.0.1:${port}/?t=${token}`, close, closed };
}

export { openBrowser };
