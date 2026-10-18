import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Catalog } from "../catalog.js";
import type { AscClient } from "../client.js";
import type { Config } from "../config.js";
import { renderResult } from "../format.js";
import { prepareRequest, type CallInput } from "../validate.js";

export interface ToolContext {
  catalog: Catalog;
  client: AscClient;
  config: Config;
}

export function text(value: string | object): CallToolResult {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }] };
}

/** Wraps a handler so every thrown error becomes a readable tool error instead of a protocol failure. */
export function safe<A>(handler: (args: A) => Promise<CallToolResult>): (args: A) => Promise<CallToolResult> {
  return async (args: A) => {
    try {
      return await handler(args);
    } catch (err) {
      return { isError: true, content: [{ type: "text", text: (err as Error).message ?? String(err) }] };
    }
  };
}

/** Runs one catalog operation and returns the raw API result. */
export async function runOperation(ctx: ToolContext, operationId: string, input: CallInput = {}) {
  const op = ctx.catalog.require(operationId);
  return ctx.client.request(prepareRequest(ctx.catalog, op, input));
}

/** Runs one catalog operation and returns its parsed JSON body (throws if there is none). */
export async function runJson(ctx: ToolContext, operationId: string, input: CallInput = {}): Promise<any> {
  const res = await runOperation(ctx, operationId, input);
  if (res.kind !== "json") return {};
  return res.data;
}

export function render(ctx: ToolContext, result: Awaited<ReturnType<typeof runOperation>>, saveTo?: string) {
  return text(renderResult(result, { maxChars: ctx.config.maxResponseChars, saveTo }));
}

/** Flattens a JSON:API resource to { id, ...attributes } for compact curated output. */
export function flat(resource: any, extra: Record<string, unknown> = {}): Record<string, unknown> {
  if (!resource) return {};
  return { id: resource.id, ...resource.attributes, ...extra };
}
