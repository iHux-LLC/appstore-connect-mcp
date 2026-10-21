import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig, type Mode } from "../src/config.js";
import { AREAS, effectiveLevel, TOOL_AREAS, toolAllowed, type Access } from "../src/permissions.js";
import { createServer } from "../src/server.js";
import { updateStored } from "../src/settings/store.js";
import { startSettingsServer } from "../src/settings/web.js";
import { mockFetch, privatePem, resultText } from "./helpers.js";

const freshEnv = () => ({ ASC_CONFIG_DIR: mkdtempSync(join(tmpdir(), "asc-perm-")) });

async function connectWith(mode: Mode, access: Access = {}, env = freshEnv()) {
  updateStored({ mode, access }, env);
  const config = loadConfig({ ...env, ASC_KEY_ID: "K", ASC_ISSUER_ID: "I", ASC_PRIVATE_KEY: privatePem });
  const { server, reload } = createServer(config, { env, fetchImpl: mockFetch().fn });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "t", version: "1" });
  let changes = 0;
  client.setNotificationHandler(ToolListChangedNotificationSchema, async () => void changes++);
  await client.connect(ct);
  const names = async () => (await client.listTools()).tools.map((t) => t.name).sort();
  return { client, names, reload, env, changes: () => changes };
}

describe("tool map", () => {
  it("covers every registered tool, and nothing else", async () => {
    const { names } = await connectWith("full");
    expect(await names()).toEqual(Object.keys(TOOL_AREAS).sort());
  });
});

describe("effective level", () => {
  it("follows the mode when an area isn't set", () => {
    expect(effectiveLevel("reviews", "readonly")).toBe("read");
    expect(effectiveLevel("reviews", "write")).toBe("write");
  });

  it("caps an area at the overall limit, and read-only areas at read", () => {
    expect(effectiveLevel("reviews", "readonly", { reviews: "write" })).toBe("read");
    expect(effectiveLevel("sales", "full", { sales: "write" })).toBe("read");
    expect(effectiveLevel("testflight", "full", { testflight: "off" })).toBe("off");
  });

  it("always allows the core tools", () => {
    const allOff = Object.fromEntries(AREAS.map((a) => [a.id, "off"])) as Access;
    expect(toolAllowed("asc_list_apps", "readonly", allOff)).toBe(true);
    expect(toolAllowed("asc_open_settings", "readonly", allOff)).toBe(true);
    expect(toolAllowed("asc_unknown_tool", "full")).toBe(false);
  });
});

describe("tools shown to the client", () => {
  it("matches the old behaviour when no areas are set", async () => {
    const readonly = await (await connectWith("readonly")).names();
    expect(readonly).toEqual(Object.entries(TOOL_AREAS).filter(([, t]) => t.kind === "read").map(([n]) => n).sort());
    expect(await (await connectWith("write")).names()).toHaveLength(Object.keys(TOOL_AREAS).length);
  });

  it("hides an area that is off, and its write tools when it's read-only", async () => {
    const { names } = await connectWith("write", { reviews: "off", testflight: "read" });
    const shown = await names();
    expect(shown).not.toContain("asc_list_customer_reviews");
    expect(shown).not.toContain("asc_reply_to_customer_review");
    expect(shown).toContain("asc_list_builds");
    expect(shown).not.toContain("asc_distribute_build");
    expect(shown).toContain("asc_upload_screenshots");
  });

  it("applies settings changes live and notifies the client", async () => {
    const s = await connectWith("write");
    expect(await s.names()).toContain("asc_reply_to_customer_review");
    updateStored({ access: { reviews: "read", analytics: "off" } }, s.env);
    s.reload();
    await new Promise((r) => setTimeout(r, 20));
    expect(s.changes()).toBeGreaterThan(0);
    const shown = await s.names();
    expect(shown).toContain("asc_list_customer_reviews");
    expect(shown).not.toContain("asc_reply_to_customer_review");
    expect(shown).not.toContain("asc_download_analytics_report");
  });

  it("keeps the last good settings when the file has an invalid area", async () => {
    const s = await connectWith("write");
    updateStored({ access: { reviews: "sometimes" } as any }, s.env);
    s.reload();
    expect(await s.names()).toContain("asc_reply_to_customer_review");
  });
});

describe("Full API access", () => {
  it("blocks writes through the generic tool when the area is read-only, but allows reads", async () => {
    const { client } = await connectWith("write", { api: "read" });
    const write: any = await client.callTool({
      name: "asc_call_operation",
      arguments: { operationId: "betaTesters_createInstance", body: { data: { type: "betaTesters", attributes: { email: "a@b.co" } } } },
    });
    expect(write.isError).toBe(true);
    expect(resultText(write)).toMatch(/Full API access are turned off/);
    const read: any = await client.callTool({ name: "asc_call_operation", arguments: { operationId: "apps_getCollection" } });
    expect(read.isError, resultText(read)).toBeFalsy();
  });

  it("reports the areas in asc_check_connection", async () => {
    const { client } = await connectWith("write", { sales: "off" });
    const out = JSON.parse(resultText(await client.callTool({ name: "asc_check_connection", arguments: {} })));
    expect(out.areas).toMatchObject({ sales: "off", reviews: "write", api: "write" });
  });
});

describe("settings page", () => {
  it("saves an area, refuses impossible levels, and resets", async () => {
    const env = freshEnv();
    const page = await startSettingsServer({ env, runner: async () => { throw new Error("no claude"); } });
    const url = new URL(page.url);
    const post = (body: unknown) =>
      fetch(new URL("/api/access", url), {
        method: "POST",
        headers: { "X-Session-Token": url.searchParams.get("t")!, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    const saved = await (await post({ area: "reviews", level: "off" })).json();
    expect(saved.settings.access).toEqual({ reviews: "off" });
    expect(saved.areas.find((a: any) => a.id === "sales")).toMatchObject({ readTools: 2, writeTools: 0 });
    expect(saved.totalTools).toBe(Object.keys(TOOL_AREAS).length);
    expect((await post({ area: "sales", level: "write" })).status).toBe(400);
    expect((await post({ area: "everything", level: "off" })).status).toBe(400);
    expect((await (await post({ reset: true })).json()).settings.access).toEqual({});
    page.close();
  });
});
