import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Operation } from "../catalog.js";
import { methodAllowed } from "../config.js";
import { effectiveLevel } from "../permissions.js";
import { renderResult } from "../format.js";
import { uploadAsset, uploadableOperations } from "../upload.js";
import { prepareRequest } from "../validate.js";
import { safe, text, type ToolContext } from "./context.js";

const queryValue = z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number(), z.boolean()]))]);

function brief(op: Operation, mode: ToolContext["config"]["mode"]) {
  return {
    operationId: op.id,
    method: op.method,
    path: op.path,
    summary: op.summary,
    ...(op.deprecated ? { deprecated: true } : {}),
    ...(methodAllowed(op.method, mode) ? {} : { blockedByMode: true }),
  };
}

export function describeOperation(ctx: ToolContext, op: Operation) {
  const query = op.params.filter((p) => p.in === "query");
  const pick = (prefix: string) => query.filter((p) => p.name.startsWith(prefix));
  const describeParam = (p: (typeof query)[number]) => ({
    name: p.name,
    type: p.type,
    ...(p.required ? { required: true } : {}),
    ...(p.enum ? { enum: p.enum } : {}),
    ...(p.description ? { description: p.description } : {}),
    ...(p.deprecated ? { deprecated: true } : {}),
  });
  const fields = Object.fromEntries(pick("fields[").map((p) => [p.name, p.enum ?? p.type]));
  const limits = pick("limit[").map((p) => p.name);
  const grouped = new Set([...pick("fields["), ...pick("limit[")].map((p) => p.name));
  return {
    operationId: op.id,
    method: op.method,
    path: op.path,
    summary: op.summary,
    tags: op.tags,
    ...(op.deprecated ? { deprecated: true } : {}),
    allowedInCurrentMode: methodAllowed(op.method, ctx.config.mode),
    pathParams: op.params.filter((p) => p.in === "path").map((p) => p.name),
    queryParams: query.filter((p) => !grouped.has(p.name)).map(describeParam),
    ...(Object.keys(fields).length ? { sparseFieldsets: fields } : {}),
    ...(limits.length ? { includedLimits: limits } : {}),
    ...(op.body ? { body: { schemaName: op.body, schema: ctx.catalog.bodySchema(op.body) } } : {}),
    ...(op.response ? { responseSchema: op.response } : {}),
    ...(op.responseType ? { responseType: `${op.responseType} (gzipped TSV reports are decoded into rows automatically)` } : {}),
    notes: [
      "Multi-value query params accept an array or a comma-separated string.",
      ...(op.method === "GET" && op.params.some((p) => p.name === "limit")
        ? ["Results are paginated (max limit is usually 200). Pass fetchAll to asc_call_operation to follow pages."]
        : []),
    ],
  };
}

/** Registers the catalog tools and returns the upload tool, which only works when writes are allowed. */
export function registerGenericTools(server: McpServer, ctx: ToolContext): RegisteredTool {
  const { catalog, client, config } = ctx;

  server.registerTool(
    "asc_list_resource_groups",
    {
      title: "List App Store Connect API resource groups",
      description:
        "List every resource group (tag) in the App Store Connect API with its operation count, e.g. Apps, Builds, BetaGroups, Subscriptions, GameCenterLeaderboards. Use it to browse the API when you don't know what to search for; then call asc_search_operations with a tag.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safe(async () =>
      text({
        specVersion: catalog.data.specVersion,
        totalOperations: catalog.operations.length,
        mode: config.mode,
        groups: catalog.groups(),
      }),
    ),
  );

  server.registerTool(
    "asc_search_operations",
    {
      title: "Search App Store Connect API operations",
      description:
        "Search all 1,300+ App Store Connect API operations by keywords (e.g. 'customer reviews', 'testflight testers', 'subscription prices', 'xcode cloud builds'). Returns operationIds to pass to asc_describe_operation and asc_call_operation. Prefer a curated asc_* tool when one fits the task.",
      inputSchema: {
        query: z.string().min(1).describe("Keywords, a resource name, a path like /v1/apps/{id}/builds, or an operationId"),
        method: z.enum(["GET", "POST", "PATCH", "DELETE"]).optional().describe("Only return operations with this HTTP method"),
        tag: z.string().optional().describe("Only return operations in this resource group (see asc_list_resource_groups)"),
        limit: z.number().int().min(1).max(50).optional().describe("Maximum results (default 15)"),
        includeDeprecated: z.boolean().optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safe(async ({ query, method, tag, limit, includeDeprecated }) => {
      const results = catalog.search(query, { method, tag, limit, includeDeprecated });
      if (!results.length) return text(`No operations match "${query}". Try fewer or different words, or browse asc_list_resource_groups.`);
      return text({ results: results.map((op) => brief(op, config.mode)) });
    }),
  );

  server.registerTool(
    "asc_describe_operation",
    {
      title: "Describe an App Store Connect API operation",
      description:
        "Show everything needed to call one operation: path params, query params (filters, sort, include, limit), sparse fieldsets (fields[type] -> attribute names), and the full JSON request-body schema for creates and updates. Call this before asc_call_operation for any operation you haven't used yet.",
      inputSchema: { operationId: z.string().describe("e.g. apps_getCollection or betaTesters_createInstance") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safe(async ({ operationId }) => text(describeOperation(ctx, catalog.require(operationId)))),
  );

  server.registerTool(
    "asc_call_operation",
    {
      title: "Call any App Store Connect API operation",
      description:
        "Execute any App Store Connect API operation by operationId. Inputs are validated against Apple's OpenAPI spec before sending. " +
        "Query keys use Apple's exact names, e.g. {\"filter[app]\": \"123\", \"sort\": \"-uploadedDate\", \"fields[builds]\": [\"version\",\"processingState\"], \"include\": \"preReleaseVersion\", \"limit\": 50}. " +
        "Bodies use JSON:API form: {\"data\": {\"type\": \"...\", \"attributes\": {...}, \"relationships\": {...}}}. " +
        "Responses are compacted (resource links removed); follow nextUrl with asc_fetch_url or pass fetchAll. " +
        "Creates and updates need the write access mode and deletes need full; a blocked call explains how the user can enable them.",
      inputSchema: {
        operationId: z.string(),
        pathParams: z.record(z.string(), z.union([z.string(), z.number()])).optional().describe("e.g. {\"id\": \"1234567890\"}"),
        query: z.record(z.string(), queryValue).optional(),
        body: z.record(z.string(), z.any()).optional().describe("JSON:API request body for POST/PATCH"),
        fetchAll: z.boolean().optional().describe("Follow pagination and merge all pages (GET collections only)"),
        maxItems: z.number().int().min(1).max(10000).optional().describe("Stop paginating once this many items are fetched (default 1000)"),
        saveTo: z.string().optional().describe("Save the full response as a new file instead of returning it: a bare name goes to ~/Downloads/appstore-connect; .json/.tsv/.txt/.csv/.gz/.zip only; never overwrites"),
        raw: z.boolean().optional().describe("Return the response without removing links (default false)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    safe(async ({ operationId, pathParams, query, body, fetchAll, maxItems, saveTo, raw }) => {
      const op = catalog.require(operationId);
      // In read-only mode the client explains the mode; here only the area setting is the reason.
      if (op.method !== "GET" && config.mode !== "readonly" && effectiveLevel("api", config.mode, config.access) !== "write") {
        throw new Error(
          `${op.method} calls through Full API access are turned off: the user set that area to read-only on the settings page (asc_open_settings). Only the user can change this.`,
        );
      }
      const prepared = prepareRequest(catalog, op, { pathParams, query, body });
      const result = fetchAll && op.method === "GET" ? await client.requestAll(prepared, maxItems ?? 1000) : await client.request(prepared);
      return text(renderResult(result, { maxChars: config.maxResponseChars, saveTo, compact: !raw }));
    }),
  );

  server.registerTool(
    "asc_fetch_url",
    {
      title: "Fetch an App Store Connect API URL",
      description:
        "GET a full api.appstoreconnect.apple.com URL, such as a nextUrl from a previous response or a relationship's related link. Only Apple's API host is allowed.",
      inputSchema: {
        url: z.string().url(),
        saveTo: z.string().optional().describe("Save the full response as a new file instead of returning it: a bare name goes to ~/Downloads/appstore-connect; .json/.tsv/.txt/.csv/.gz/.zip only; never overwrites"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async ({ url, saveTo }) => {
      const result = await client.request({ method: "GET", path: url });
      return text(renderResult(result, { maxChars: config.maxResponseChars, saveTo }));
    }),
  );

  const uploadIds = uploadableOperations(catalog).map((o) => o.id);
  return server.registerTool(
    "asc_upload_asset",
    {
      title: "Upload a file asset to App Store Connect",
      description:
        "Upload a local file (screenshot, app preview video, IAP/subscription image, review attachment, Game Center image, ...) using Apple's reserve, upload chunks, then commit flow, and wait for processing. " +
        "Example: createOperationId 'appScreenshots_createInstance' with relationshipId = the appScreenshotSet id. " +
        `Supported operations: ${uploadIds.join(", ")}.`,
      inputSchema: {
        createOperationId: z.enum(uploadIds as [string, ...string[]]),
        filePath: z.string().describe("Absolute path to the local file"),
        relationshipId: z.string().describe("Id of the parent resource, e.g. the appScreenshotSet or appPreviewSet id"),
        relationshipName: z.string().optional().describe("Only needed when the operation has more than one parent relationship"),
        fileName: z.string().optional().describe("Override the uploaded file name (defaults to the file's basename)"),
        attributes: z.record(z.string(), z.any()).optional().describe("Extra create attributes, e.g. {\"previewFrameTimeCode\": \"00:00:05:00\"} or a build upload's uti/assetType"),
        waitForProcessing: z.boolean().optional().describe("Poll until Apple finishes processing (default true, up to ~30s)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    safe(async (input) => text(await uploadAsset(catalog, client, input))),
  );
}
