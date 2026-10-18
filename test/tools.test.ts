import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { connect, gzipTsv, json, mockFetch, resultText } from "./helpers.js";

describe("tool registration", () => {
  it("hides write shortcuts in readonly mode and stays well under client tool limits", async () => {
    const ro = await connect("readonly", mockFetch().fn);
    const roNames = (await ro.listTools()).tools.map((t) => t.name);
    expect(roNames).toContain("asc_call_operation");
    expect(roNames).not.toContain("asc_submit_for_review");
    expect(roNames).not.toContain("asc_upload_asset");

    const rw = await connect("write", mockFetch().fn);
    const rwNames = (await rw.listTools()).tools.map((t) => t.name);
    expect(rwNames).toContain("asc_submit_for_review");
    // Cursor warns above ~40 tools across all servers; keep this server small.
    expect(rwNames.length).toBeLessThanOrEqual(25);
  });
});

describe("curated read tools send spec-valid requests", () => {
  const cases: [string, Record<string, unknown>][] = [
    ["asc_check_connection", {}],
    ["asc_list_apps", { bundleId: "com.example" }],
    ["asc_app_overview", { appId: "1" }],
    ["asc_list_builds", { appId: "1", version: "1.0", processingState: "VALID" }],
    ["asc_list_customer_reviews", { appId: "1", rating: [1, 2], territory: ["USA"], unansweredOnly: true }],
    ["asc_list_beta_groups", { appId: "1" }],
    ["asc_list_version_localizations", { versionId: "v1" }],
  ];
  it.each(cases)("%s", async (name, args) => {
    const { fn, calls } = mockFetch();
    const client = await connect("readonly", fn);
    const res: any = await client.callTool({ name, arguments: args });
    expect(res.isError, resultText(res)).toBeFalsy();
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });
});

describe("reports", () => {
  it("decodes gzipped TSV sales reports into rows", async () => {
    const { fn, calls } = mockFetch(() => gzipTsv("Provider\tUnits\nAPPLE\t5\nAPPLE\t7\n"));
    const client = await connect("readonly", fn);
    const res: any = await client.callTool({ name: "asc_download_sales_report", arguments: { vendorNumber: "8", frequency: "DAILY", reportDate: "2026-10-01" } });
    const out = JSON.parse(resultText(res));
    expect(out.totalRows).toBe(2);
    expect(out.rows[1]).toEqual({ Provider: "APPLE", Units: "7" });
    expect(calls[0].url.searchParams.get("filter[reportType]")).toBe("SALES");
  });

  it("saves a report to disk on request", async () => {
    const dir = mkdtempSync(join(tmpdir(), "asc-test-"));
    const client = await connect("readonly", mockFetch(() => gzipTsv("A\tB\n1\t2\n")).fn);
    const res: any = await client.callTool({
      name: "asc_download_finance_report",
      arguments: { vendorNumber: "8", regionCode: "ZZ", reportDate: "2026-09", saveTo: join(dir, "r.tsv") },
    });
    expect(JSON.parse(resultText(res)).savedTo).toBe(join(dir, "r.tsv"));
  });
});

describe("curated write tools", () => {
  it("submit_for_review creates a submission, adds the version and submits", async () => {
    const { fn, calls } = mockFetch();
    const client = await connect("write", fn);
    const res: any = await client.callTool({ name: "asc_submit_for_review", arguments: { appId: "1", versionId: "v1", platform: "IOS" } });
    expect(res.isError, resultText(res)).toBeFalsy();
    expect(calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual([
      "GET /v1/reviewSubmissions",
      "POST /v1/reviewSubmissions",
      "POST /v1/reviewSubmissionItems",
      "PATCH /v1/reviewSubmissions/new-id",
    ]);
    expect(calls[3].body.data.attributes).toEqual({ submitted: true });
  });

  it.each([
    ["asc_reply_to_customer_review", { reviewId: "r1", responseBody: "Thanks!" }],
    ["asc_invite_beta_tester", { email: "t@example.com", betaGroupIds: ["g1"] }],
    ["asc_update_version_localization", { localizationId: "l1", whatsNew: "Bug fixes" }],
    ["asc_create_app_store_version", { appId: "1", platform: "IOS", versionString: "2.0.0" }],
    ["asc_attach_build_to_version", { versionId: "v1", buildId: "b1" }],
  ])("%s passes spec validation", async (name, args) => {
    const client = await connect("write", mockFetch().fn);
    const res: any = await client.callTool({ name, arguments: args });
    expect(res.isError, resultText(res)).toBeFalsy();
  });
});

describe("generic tools", () => {
  it("search -> describe -> call works end to end", async () => {
    const { fn, calls } = mockFetch();
    const client = await connect("readonly", fn);
    const search = JSON.parse(resultText(await client.callTool({ name: "asc_search_operations", arguments: { query: "list builds of an app" } })));
    expect(search.results.length).toBeGreaterThan(0);

    const desc = JSON.parse(resultText(await client.callTool({ name: "asc_describe_operation", arguments: { operationId: "betaTesters_createInstance" } })));
    expect(desc.body.schema.properties.data).toBeDefined();
    expect(desc.allowedInCurrentMode).toBe(false);

    const res: any = await client.callTool({
      name: "asc_call_operation",
      arguments: { operationId: "apps_builds_getToManyRelated", pathParams: { id: "42" }, query: { limit: 5 } },
    });
    expect(res.isError, resultText(res)).toBeFalsy();
    expect(calls.at(-1)!.url.toString()).toBe("https://api.appstoreconnect.apple.com/v1/apps/42/builds?limit=5");
  });

  it("returns validation problems as tool errors", async () => {
    const client = await connect("readonly", mockFetch().fn);
    const res: any = await client.callTool({ name: "asc_call_operation", arguments: { operationId: "builds_getCollection", query: { "filter[nope]": "1" } } });
    expect(res.isError).toBe(true);
    expect(resultText(res)).toMatch(/Unknown query parameter/);
  });

  it("blocks writes in readonly mode with instructions to enable them", async () => {
    const client = await connect("readonly", mockFetch().fn);
    const res: any = await client.callTool({
      name: "asc_call_operation",
      arguments: { operationId: "betaTesters_createInstance", body: { data: { type: "betaTesters", attributes: { email: "a@b.co" } } } },
    });
    expect(res.isError).toBe(true);
    expect(resultText(res)).toMatch(/switch the mode to "write"[\s\S]*Only the user can change this/);
  });

  it("uploads an asset with reserve, chunk PUTs and commit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "asc-test-"));
    const file = join(dir, "shot.png");
    writeFileSync(file, Buffer.alloc(10, 7));
    const { fn, calls } = mockFetch((req) => {
      if (req.url.host === "upload.example.com") return new Response(null, { status: 200 });
      if (req.method === "POST") {
        return json({
          data: {
            type: "appScreenshots",
            id: "s1",
            attributes: {
              uploadOperations: [
                { method: "PUT", url: "https://upload.example.com/1", offset: 0, length: 6, requestHeaders: [{ name: "Content-Type", value: "image/png" }] },
                { method: "PUT", url: "https://upload.example.com/2", offset: 6, length: 4, requestHeaders: [] },
              ],
            },
          },
        }, 201);
      }
      if (req.method === "GET") return json({ data: { id: "s1", attributes: { assetDeliveryState: { state: "COMPLETE" } } } });
      return undefined;
    });
    // The upload module PUTs chunks with the global fetch; route it through the mock too.
    const original = globalThis.fetch;
    globalThis.fetch = fn;
    try {
      const client = await connect("write", fn);
      const res: any = await client.callTool({
        name: "asc_upload_asset",
        arguments: { createOperationId: "appScreenshots_createInstance", filePath: file, relationshipId: "set1" },
      });
      expect(res.isError, resultText(res)).toBeFalsy();
      const out = JSON.parse(resultText(res));
      expect(out).toMatchObject({ id: "s1", chunks: 2, committed: true, deliveryState: { state: "COMPLETE" } });
      const reserve = calls.find((c) => c.method === "POST")!;
      expect(reserve.body.data.relationships.appScreenshotSet.data).toEqual({ type: "appScreenshotSets", id: "set1" });
      expect(reserve.body.data.attributes).toEqual({ fileName: "shot.png", fileSize: 10 });
      const puts = calls.filter((c) => c.url.host === "upload.example.com");
      expect(puts.map((p) => (p.body as Buffer).length)).toEqual([6, 4]);
      expect(puts[0].headers).toEqual({ "Content-Type": "image/png" });
      const commit = calls.find((c) => c.method === "PATCH")!;
      expect(commit.body.data.attributes).toEqual({ uploaded: true, sourceFileChecksum: out.md5 });
    } finally {
      globalThis.fetch = original;
    }
  });
});
