import { createHash } from "node:crypto";
import { decodeBinary } from "./client.js";
import { runJson, type ToolContext } from "./tools/context.js";
import { prepareRequest } from "./validate.js";

export interface ReportRequest {
  id: string;
  accessType: string;
  stoppedDueToInactivity?: boolean;
}

export interface AnalyticsReport {
  id: string;
  name: string;
  category: string;
}

/** The app's report requests, active ongoing ones first. */
export async function reportRequests(ctx: ToolContext, appId: string): Promise<ReportRequest[]> {
  const res = await runJson(ctx, "apps_analyticsReportRequests_getToManyRelated", {
    pathParams: { id: appId },
    query: { "fields[analyticsReportRequests]": ["accessType", "stoppedDueToInactivity"], limit: 50 },
  });
  const all: ReportRequest[] = (res.data ?? []).map((r: any) => ({ id: r.id, ...r.attributes }));
  const rank = (r: ReportRequest) => (r.accessType === "ONGOING" && !r.stoppedDueToInactivity ? 0 : r.accessType === "ONGOING" ? 2 : 1);
  return all.sort((a, b) => rank(a) - rank(b));
}

export async function listReports(ctx: ToolContext, appId: string, category?: string): Promise<{ requests: ReportRequest[]; reports: AnalyticsReport[] }> {
  const requests = await reportRequests(ctx, appId);
  const reports = new Map<string, AnalyticsReport>();
  for (const req of requests) {
    const path = prepareRequest(ctx.catalog, ctx.catalog.require("analyticsReportRequests_reports_getToManyRelated"), {
      pathParams: { id: req.id },
      query: { "filter[category]": category, "fields[analyticsReports]": ["name", "category"], limit: 200 },
    });
    const res = await ctx.client.requestAll(path, 2000);
    if (res.kind !== "json") continue;
    for (const r of res.data.data ?? []) {
      // The same report can appear under several requests; keep the first (from the best request).
      if (![...reports.values()].some((x) => x.name === r.attributes?.name)) reports.set(r.id, { id: r.id, name: r.attributes?.name, category: r.attributes?.category });
    }
  }
  return { requests, reports: [...reports.values()].sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name)) };
}

/** Finds a report by id, or by name (exact, then partial match) within the app's reports. */
export async function findReport(ctx: ToolContext, args: { appId?: string; reportId?: string; reportName?: string }): Promise<AnalyticsReport> {
  if (args.reportId) {
    const r = await runJson(ctx, "analyticsReports_getInstance", { pathParams: { id: args.reportId }, query: { "fields[analyticsReports]": ["name", "category"] } });
    return { id: r.data.id, name: r.data.attributes?.name, category: r.data.attributes?.category };
  }
  if (!args.appId || !args.reportName) throw new Error("Pass reportId, or appId with reportName.");
  const { reports } = await listReports(ctx, args.appId);
  if (!reports.length) throw new Error("This app has no analytics reports yet. Run asc_analytics_setup, then allow a day or two for Apple to produce them.");
  const wanted = args.reportName.toLowerCase();
  const exact = reports.filter((r) => r.name.toLowerCase() === wanted);
  const partial = exact.length ? exact : reports.filter((r) => r.name.toLowerCase().includes(wanted));
  if (partial.length === 1) return partial[0];
  if (!partial.length) throw new Error(`No report matches "${args.reportName}". Use asc_list_analytics_reports to see the names.`);
  throw new Error(`"${args.reportName}" matches several reports: ${partial.map((r) => r.name).join("; ")}. Use the full name or reportId.`);
}

export interface Instance {
  id: string;
  granularity: string;
  processingDate: string;
}

export async function listInstances(ctx: ToolContext, reportId: string, granularity?: string): Promise<Instance[]> {
  const path = prepareRequest(ctx.catalog, ctx.catalog.require("analyticsReports_instances_getToManyRelated"), {
    pathParams: { id: reportId },
    query: { "filter[granularity]": granularity, "fields[analyticsReportInstances]": ["granularity", "processingDate"], limit: 200 },
  });
  const res = await ctx.client.requestAll(path, 2000);
  const items: Instance[] = res.kind === "json" ? (res.data.data ?? []).map((i: any) => ({ id: i.id, ...i.attributes })) : [];
  return items.sort((a, b) => b.processingDate.localeCompare(a.processingDate));
}

interface Segment {
  url: string;
  checksum?: string;
  sizeInBytes?: number;
}

async function segmentsOf(ctx: ToolContext, instanceId: string): Promise<Segment[]> {
  const res = await runJson(ctx, "analyticsReportInstances_segments_getToManyRelated", {
    pathParams: { id: instanceId },
    query: { "fields[analyticsReportSegments]": ["checksum", "sizeInBytes", "url"], limit: 200 },
  });
  return (res.data ?? []).map((s: any) => s.attributes as Segment);
}

/**
 * Downloads one segment. The URL always comes from Apple's API response in this same call, never
 * from the model, and no App Store Connect credentials are sent with it.
 */
async function downloadSegment(segment: Segment, fetchImpl: typeof fetch): Promise<Buffer> {
  const url = new URL(segment.url);
  if (url.protocol !== "https:") throw new Error(`Refusing a non-HTTPS report link from Apple: ${url.origin}`);
  const res = await fetchImpl(url, { method: "GET" });
  if (!res.ok) throw new Error(`Downloading a report segment failed: HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (segment.checksum) {
    const md5 = createHash("md5").update(bytes);
    const expected = segment.checksum.trim();
    const hex = md5.copy().digest("hex");
    if (expected.toLowerCase() !== hex && expected !== md5.digest("base64")) {
      throw new Error("A report segment failed its checksum check; the download was corrupted. Try again.");
    }
  }
  return decodeBinary(bytes);
}

/** Splits CSV or TSV (detected from the header), honouring quoted fields. */
export function parseDelimited(text: string): { columns: string[]; rows: Record<string, string>[] } {
  const clean = text.replace(/^﻿/, "");
  const firstLine = clean.slice(0, clean.indexOf("\n") >>> 0);
  const delimiter = firstLine.includes("\t") ? "\t" : ",";
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let quoted = false;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (quoted) {
      if (ch === '"' && clean[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === delimiter) { record.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && clean[i + 1] === "\n") i++;
      record.push(field);
      if (record.some((f) => f !== "")) records.push(record);
      record = [];
      field = "";
    } else field += ch;
  }
  record.push(field);
  if (record.some((f) => f !== "")) records.push(record);
  const [columns = [], ...body] = records;
  return {
    columns,
    rows: body.map((cells) => Object.fromEntries(columns.map((c, i) => [c, cells[i] ?? ""]).filter(([, v]) => v !== ""))),
  };
}

export interface DownloadOptions {
  granularity?: string;
  startDate?: string;
  endDate?: string;
  maxInstances: number;
  maxBytes: number;
  fetchImpl?: typeof fetch;
}

/** Downloads every segment of the matching instances and merges them into one table. */
export async function downloadReport(ctx: ToolContext, report: AnalyticsReport, opts: DownloadOptions) {
  const all = await listInstances(ctx, report.id, opts.granularity);
  const inRange = all.filter((i) => (!opts.startDate || i.processingDate >= opts.startDate) && (!opts.endDate || i.processingDate <= opts.endDate));
  if (!inRange.length) {
    const have = all.slice(0, 5).map((i) => `${i.processingDate} (${i.granularity})`).join(", ");
    throw new Error(`No ${opts.granularity ?? ""} instances of "${report.name}" in that range.${have ? ` Latest: ${have}.` : " Apple hasn't produced any yet."}`);
  }
  const chosen = inRange.slice(0, opts.maxInstances);
  const plan = await Promise.all(chosen.map(async (i) => ({ instance: i, segments: await segmentsOf(ctx, i.id) })));
  const bytes = plan.reduce((n, p) => n + p.segments.reduce((m, s) => m + (s.sizeInBytes ?? 0), 0), 0);
  if (bytes > opts.maxBytes) {
    throw new Error(`That's ${(bytes / 1e6).toFixed(0)} MB of report data; narrow the dates or use a coarser granularity (limit ${(opts.maxBytes / 1e6).toFixed(0)} MB).`);
  }
  const columns: string[] = [];
  const rows: Record<string, string>[] = [];
  let segmentCount = 0;
  for (const { segments } of plan) {
    for (const seg of segments) {
      const table = parseDelimited((await downloadSegment(seg, opts.fetchImpl ?? fetch)).toString("utf8"));
      for (const c of table.columns) if (!columns.includes(c)) columns.push(c);
      rows.push(...table.rows);
      segmentCount++;
    }
  }
  return {
    report: { id: report.id, name: report.name, category: report.category },
    granularity: opts.granularity,
    dates: chosen.map((i) => i.processingDate),
    ...(inRange.length > chosen.length ? { moreDates: inRange.length - chosen.length } : {}),
    segments: segmentCount,
    columns,
    rows,
  };
}

export function toTsv(columns: string[], rows: Record<string, string>[]): string {
  const cell = (v: string | undefined) => (v ?? "").replace(/[\t\r\n]+/g, " ");
  return [columns.join("\t"), ...rows.map((r) => columns.map((c) => cell(r[c])).join("\t"))].join("\n") + "\n";
}
