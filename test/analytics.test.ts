import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseDelimited } from "../src/analytics.js";
import { connect, json, mockFetch, resultText, type Recorded } from "./helpers.js";

// ---------- a fake Apple: report requests, reports, instances, segments and a file host ----------

interface FakeOpts {
  requests?: { id: string; accessType: string; stoppedDueToInactivity?: boolean }[];
  badChecksum?: boolean;
  hugeSegments?: boolean;
}

const FILES: Record<string, string> = {
  "seg-1": "Date\tApp Name\tCounts\n2026-10-18\tSage\t10\n",
  "seg-2": "Date\tApp Name\tCounts\n2026-10-19\tSage\t12\n",
  "seg-3": 'Date,App Name,Counts\n2026-10-20,"Sage, Inc.",15\n',
};

function fakeApple(opts: FakeOpts = {}) {
  const requests = [...(opts.requests ?? [{ id: "req-1", accessType: "ONGOING" }])];
  const reports = [
    { id: "rep-eng", name: "App Store Discovery and Engagement Detailed", category: "APP_STORE_ENGAGEMENT" },
    { id: "rep-eng-std", name: "App Store Discovery and Engagement Standard", category: "APP_STORE_ENGAGEMENT" },
    { id: "rep-sessions", name: "App Sessions Standard", category: "APP_USAGE" },
  ];
  const instances = [
    { id: "inst-18", granularity: "DAILY", processingDate: "2026-10-18", segs: ["seg-1"] },
    { id: "inst-19", granularity: "DAILY", processingDate: "2026-10-19", segs: ["seg-2"] },
    { id: "inst-20", granularity: "DAILY", processingDate: "2026-10-20", segs: ["seg-3"] },
    { id: "inst-w", granularity: "WEEKLY", processingDate: "2026-10-13", segs: ["seg-1"] },
  ];
  const gz = (name: string) => gzipSync(Buffer.from(FILES[name]));

  const handler = (req: Recorded): Response | undefined => {
    const p = req.url.pathname;
    const m = `${req.method} ${p}`;
    if (req.url.host === "files.example.com") {
      const name = p.slice(1).replace(".gz", "");
      return new Response(gz(name), { status: 200, headers: { "content-type": "application/octet-stream" } });
    }
    if (m === "GET /v1/apps/A/analyticsReportRequests") {
      return json({ data: requests.map(({ id, ...attributes }) => ({ type: "analyticsReportRequests", id, attributes })) });
    }
    if (m === "POST /v1/analyticsReportRequests") {
      const r = { id: `req-${requests.length + 1}`, accessType: req.body.data.attributes.accessType };
      requests.push(r);
      return json({ data: { type: "analyticsReportRequests", id: r.id, attributes: { accessType: r.accessType } } }, 201);
    }
    let x: RegExpMatchArray | null;
    if (req.method === "GET" && (x = p.match(/^\/v1\/analyticsReportRequests\/([^/]+)\/reports$/))) {
      const cat = req.url.searchParams.get("filter[category]");
      return json({ data: reports.filter((r) => !cat || r.category === cat).map(({ id, ...attributes }) => ({ type: "analyticsReports", id, attributes })), links: {} });
    }
    if (req.method === "GET" && (x = p.match(/^\/v1\/analyticsReports\/([^/]+)$/))) {
      const r = reports.find((r) => r.id === x![1])!;
      return json({ data: { type: "analyticsReports", id: r.id, attributes: { name: r.name, category: r.category } } });
    }
    if (req.method === "GET" && (x = p.match(/^\/v1\/analyticsReports\/([^/]+)\/instances$/))) {
      const g = req.url.searchParams.get("filter[granularity]");
      return json({
        data: instances.filter((i) => !g || i.granularity === g).map((i) => ({ type: "analyticsReportInstances", id: i.id, attributes: { granularity: i.granularity, processingDate: i.processingDate } })),
        links: {},
      });
    }
    if (req.method === "GET" && (x = p.match(/^\/v1\/analyticsReportInstances\/([^/]+)\/segments$/))) {
      const inst = instances.find((i) => i.id === x![1])!;
      return json({
        data: inst.segs.map((name) => ({
          type: "analyticsReportSegments",
          id: name,
          attributes: {
            url: `https://files.example.com/${name}.gz`,
            checksum: opts.badChecksum ? "0".repeat(32) : createHash("md5").update(gz(name)).digest("hex"),
            sizeInBytes: opts.hugeSegments ? 600 * 1024 * 1024 : gz(name).length,
          },
        })),
      });
    }
    return undefined;
  };
  return mockFetch(handler);
}

let originalFetch: typeof fetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function setup(mode: "readonly" | "write", opts: FakeOpts = {}) {
  const apple = fakeApple(opts);
  globalThis.fetch = apple.fn; // segment downloads use the global fetch
  return { apple, client: await connect(mode, apple.fn) };
}

const call = async (client: any, name: string, args: Record<string, unknown>) => {
  const res = await client.callTool({ name, arguments: args });
  return { res, text: resultText(res), json: () => JSON.parse(resultText(res)) };
};

// ---------- tests ----------

describe("parseDelimited", () => {
  it("reads TSV and quoted CSV", () => {
    expect(parseDelimited("a\tb\n1\t2\n")).toEqual({ columns: ["a", "b"], rows: [{ a: "1", b: "2" }] });
    expect(parseDelimited('name,note\r\n"Sage, Inc.","said ""hi""\nthere"\r\n')).toEqual({
      columns: ["name", "note"],
      rows: [{ name: "Sage, Inc.", note: 'said "hi"\nthere' }],
    });
  });
});

describe("asc_analytics_setup", () => {
  it("creates an ongoing request once and reuses it afterwards", async () => {
    const { apple, client } = await setup("write", { requests: [] });
    expect((await call(client, "asc_analytics_setup", { appId: "A" })).json().note).toMatch(/Requested/);
    expect((await call(client, "asc_analytics_setup", { appId: "A" })).json().note).toMatch(/Already set up/);
    expect(apple.calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(apple.calls.find((c) => c.method === "POST")!.body.data).toMatchObject({ attributes: { accessType: "ONGOING" }, relationships: { app: { data: { id: "A" } } } });
  });

  it("starts again when Apple stopped the old request for inactivity", async () => {
    const { apple, client } = await setup("write", { requests: [{ id: "old", accessType: "ONGOING", stoppedDueToInactivity: true }] });
    expect((await call(client, "asc_analytics_setup", { appId: "A" })).json().note).toMatch(/Requested/);
    expect(apple.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("is hidden in read-only mode, while listing and downloading stay available", async () => {
    const { client } = await setup("readonly");
    const names = (await client.listTools()).tools.map((t: any) => t.name);
    expect(names).not.toContain("asc_analytics_setup");
    expect(names).toEqual(expect.arrayContaining(["asc_list_analytics_reports", "asc_download_analytics_report"]));
  });
});

describe("asc_list_analytics_reports", () => {
  it("explains setup when the app has no requests", async () => {
    const { client } = await setup("readonly", { requests: [] });
    expect((await call(client, "asc_list_analytics_reports", { appId: "A" })).json().note).toMatch(/Run asc_analytics_setup/);
  });

  it("lists reports by category, and a report's available dates", async () => {
    const { client } = await setup("readonly");
    const list = (await call(client, "asc_list_analytics_reports", { appId: "A", category: "APP_USAGE" })).json();
    expect(list.reports.map((r: any) => r.name)).toEqual(["App Sessions Standard"]);
    const dates = (await call(client, "asc_list_analytics_reports", { appId: "A", reportId: "rep-eng" })).json();
    expect(dates.dates).toEqual({ DAILY: { count: 3, newest: "2026-10-20", oldest: "2026-10-18" }, WEEKLY: { count: 1, newest: "2026-10-13", oldest: "2026-10-13" } });
  });
});

describe("asc_download_analytics_report", () => {
  it("downloads, verifies, unzips and merges the parts, without sending the API key", async () => {
    const { apple, client } = await setup("readonly");
    const out = (await call(client, "asc_download_analytics_report", { appId: "A", reportName: "Discovery and Engagement Detailed" })).json();
    expect(out.report.name).toBe("App Store Discovery and Engagement Detailed");
    expect(out.dates).toEqual(["2026-10-20", "2026-10-19", "2026-10-18"]);
    expect(out.columns).toEqual(["Date", "App Name", "Counts"]);
    expect(out.rows).toEqual([
      { Date: "2026-10-20", "App Name": "Sage, Inc.", Counts: "15" },
      { Date: "2026-10-19", "App Name": "Sage", Counts: "12" },
      { Date: "2026-10-18", "App Name": "Sage", Counts: "10" },
    ]);
    const downloads = apple.calls.filter((c) => c.url.host === "files.example.com");
    expect(downloads).toHaveLength(3);
    expect(downloads.every((c) => !Object.keys(c.headers ?? {}).some((h) => h.toLowerCase() === "authorization"))).toBe(true);
  });

  it("filters by date range and granularity", async () => {
    const { client } = await setup("readonly");
    const out = (await call(client, "asc_download_analytics_report", { reportId: "rep-eng", startDate: "2026-10-19", endDate: "2026-10-19" })).json();
    expect(out.dates).toEqual(["2026-10-19"]);
    const weekly = (await call(client, "asc_download_analytics_report", { reportId: "rep-eng", granularity: "WEEKLY" })).json();
    expect(weekly.dates).toEqual(["2026-10-13"]);
    const none = await call(client, "asc_download_analytics_report", { reportId: "rep-eng", startDate: "2027-01-01" });
    expect(none.text).toMatch(/No DAILY instances[\s\S]*Latest: 2026-10-20/);
  });

  it("saves every row as a new TSV file", async () => {
    const { client } = await setup("readonly");
    const file = join(mkdtempSync(join(tmpdir(), "asc-an-")), "engagement.tsv");
    const out = (await call(client, "asc_download_analytics_report", { reportId: "rep-eng", saveTo: file })).json();
    expect(out).toMatchObject({ savedTo: file, totalRows: 3 });
    expect(readFileSync(file, "utf8").split("\n")[0]).toBe("Date\tApp Name\tCounts");
  });

  it("rejects a corrupted download", async () => {
    const { client } = await setup("readonly", { badChecksum: true });
    expect((await call(client, "asc_download_analytics_report", { reportId: "rep-eng" })).text).toMatch(/failed its checksum check/);
  });

  it("refuses very large downloads before fetching anything", async () => {
    const { apple, client } = await setup("readonly", { hugeSegments: true });
    expect((await call(client, "asc_download_analytics_report", { reportId: "rep-eng" })).text).toMatch(/narrow the dates/);
    expect(apple.calls.some((c) => c.url.host === "files.example.com")).toBe(false);
  });

  it("asks for a precise name when several reports match", async () => {
    const { client } = await setup("readonly");
    expect((await call(client, "asc_download_analytics_report", { appId: "A", reportName: "Discovery and Engagement" })).text).toMatch(/matches several reports/);
    expect((await call(client, "asc_download_analytics_report", { appId: "A", reportName: "Crashes" })).text).toMatch(/No report matches/);
  });
});
