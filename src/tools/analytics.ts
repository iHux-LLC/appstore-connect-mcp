import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { downloadReport, findReport, listInstances, listReports, reportRequests, toTsv } from "../analytics.js";
import { fitToBudget, saveFile } from "../format.js";
import { runJson, safe, text, type ToolContext } from "./context.js";

const CATEGORIES = ["APP_USAGE", "APP_STORE_ENGAGEMENT", "COMMERCE", "FRAMEWORK_USAGE", "PERFORMANCE"] as const;
const SETUP_HINT = "Run asc_analytics_setup for this app first; Apple then takes a day or two to produce the first reports.";

export function registerAnalyticsReadTools(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "asc_list_analytics_reports",
    {
      title: "List App Store analytics reports",
      description:
        "List the analytics reports Apple produces for an app (App Store engagement, commerce, app usage, framework usage, performance), or, with reportId, the dates each report is available for. " +
        "Reports exist only after asc_analytics_setup has been run for the app.",
      inputSchema: {
        appId: z.string(),
        category: z.enum(CATEGORIES).optional(),
        reportId: z.string().optional().describe("Show the available dates (daily, weekly, monthly) of this report"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async ({ appId, category, reportId }) => {
      if (reportId) {
        const instances = await listInstances(ctx, reportId);
        const byGranularity: Record<string, string[]> = {};
        for (const i of instances) (byGranularity[i.granularity] ??= []).push(i.processingDate);
        return text({
          reportId,
          dates: Object.fromEntries(Object.entries(byGranularity).map(([g, d]) => [g, { count: d.length, newest: d[0], oldest: d[d.length - 1] }])),
        });
      }
      const { requests, reports } = await listReports(ctx, appId, category);
      if (!requests.length) return text({ reports: [], note: SETUP_HINT });
      const stopped = requests.every((r) => r.stoppedDueToInactivity);
      return text({
        requests: requests.map((r) => ({ id: r.id, accessType: r.accessType, ...(r.stoppedDueToInactivity ? { stoppedDueToInactivity: true } : {}) })),
        reports,
        ...(stopped ? { note: "Apple stopped producing reports because nobody downloaded them for a while. Run asc_analytics_setup to start again." } : {}),
        ...(!reports.length ? { note: "No reports yet; Apple usually needs a day or two after setup." } : {}),
      });
    }),
  );

  server.registerTool(
    "asc_download_analytics_report",
    {
      title: "Download an App Store analytics report",
      description:
        "Download one analytics report (e.g. \"App Store Discovery and Engagement Detailed\", \"App Sessions Standard\") for a date range and return its rows. " +
        "All parts are downloaded from Apple's links, checked against Apple's checksums, unzipped and merged. Find report names with asc_list_analytics_reports.",
      inputSchema: {
        appId: z.string().optional().describe("Needed with reportName"),
        reportName: z.string().optional().describe("Full or partial report name"),
        reportId: z.string().optional(),
        granularity: z.enum(["DAILY", "WEEKLY", "MONTHLY"]).optional().describe("Default DAILY"),
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Earliest processing date, YYYY-MM-DD"),
        endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Latest processing date, YYYY-MM-DD"),
        maxInstances: z.number().int().min(1).max(366).optional().describe("How many dates to download at most, newest first (default 7)"),
        maxRows: z.number().int().min(1).max(5000).optional().describe("Rows to return inline (default 200)"),
        saveTo: z.string().optional().describe("Save all rows as a new .tsv file; a bare name goes to ~/Downloads/appstore-connect; never overwrites"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async (args) => {
      const report = await findReport(ctx, args);
      const result = await downloadReport(ctx, report, {
        granularity: args.granularity ?? "DAILY",
        startDate: args.startDate,
        endDate: args.endDate,
        maxInstances: args.maxInstances ?? 7,
        maxBytes: 500 * 1024 * 1024,
      });
      const { rows, ...meta } = result;
      if (args.saveTo) {
        const file = saveFile(args.saveTo, toTsv(result.columns, rows));
        return text({ ...meta, totalRows: rows.length, savedTo: file });
      }
      const maxRows = args.maxRows ?? 200;
      return text(
        fitToBudget(
          {
            ...meta,
            totalRows: rows.length,
            rows: rows.slice(0, maxRows),
            ...(rows.length > maxRows ? { truncated: `Showing ${maxRows} of ${rows.length} rows. Pass saveTo to keep them all.` } : {}),
          },
          ctx.config.maxResponseChars,
          "rows",
        ),
      );
    }),
  );
}

/** Starting analytics creates a request in the account, so it's a write tool. */
export function registerAnalyticsWriteTools(server: McpServer, ctx: ToolContext): RegisteredTool[] {
  return [
    server.registerTool(
      "asc_analytics_setup",
      {
        title: "Turn on App Store analytics reports",
        description:
          "Ask Apple to start producing analytics reports for an app (one-time per app). Ongoing (default) keeps producing daily, weekly and monthly reports; a one-time snapshot covers past data once. " +
          "The first reports appear after a day or two. Safe to call again: it reuses an active request.",
        inputSchema: {
          appId: z.string(),
          accessType: z.enum(["ONGOING", "ONE_TIME_SNAPSHOT"]).optional().describe("Default ONGOING"),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      },
      safe(async ({ appId, accessType }) => {
        const type = accessType ?? "ONGOING";
        const existing = (await reportRequests(ctx, appId)).find((r) => r.accessType === type && !r.stoppedDueToInactivity);
        if (existing) return text({ request: existing, note: "Already set up; nothing changed." });
        const res = await runJson(ctx, "analyticsReportRequests_createInstance", {
          body: {
            data: {
              type: "analyticsReportRequests",
              attributes: { accessType: type },
              relationships: { app: { data: { type: "apps", id: appId } } },
            },
          },
        });
        return text({
          request: { id: res.data?.id, accessType: type },
          note: "Requested. Apple usually needs a day or two to produce the first reports; check with asc_list_analytics_reports.",
        });
      }),
    ),
  ];
}
