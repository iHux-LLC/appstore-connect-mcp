import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { decodeBinary, type ApiResult } from "./client.js";
import { safeOutputPath } from "./paths.js";

// JSON:API responses carry self/related links on every resource and relationship.
// They are rarely useful to a model and can double the size of a response.
function compactResource(resource: any): any {
  if (!resource || typeof resource !== "object") return resource;
  const { links: _links, ...rest } = resource;
  if (rest.relationships) {
    const rels: Record<string, any> = {};
    for (const [name, rel] of Object.entries<any>(rest.relationships)) {
      if (rel && "data" in rel) rels[name] = rel.meta ? { data: rel.data, meta: rel.meta } : { data: rel.data };
      else if (rel?.meta) rels[name] = { meta: rel.meta };
    }
    if (Object.keys(rels).length) rest.relationships = rels;
    else delete rest.relationships;
  }
  return rest;
}

export function compactJson(payload: any): any {
  if (!payload || typeof payload !== "object") return payload;
  const out: any = {};
  if (Array.isArray(payload.data)) out.data = payload.data.map(compactResource);
  else if (payload.data !== undefined) out.data = compactResource(payload.data);
  if (payload.included) out.included = payload.included.map(compactResource);
  if (payload.meta) out.meta = payload.meta;
  if (payload.links?.next) out.nextUrl = payload.links.next;
  for (const [k, v] of Object.entries(payload)) if (!["data", "included", "meta", "links"].includes(k)) out[k] = v;
  return out;
}

/** Serializes a payload, trimming list items until it fits maxChars. */
export function fitToBudget(payload: any, maxChars: number, listKey = "data"): string {
  let text = JSON.stringify(payload);
  if (text.length <= maxChars) return text;
  if (Array.isArray(payload?.[listKey])) {
    const total = payload[listKey].length;
    let keep = total;
    const trimmed = { ...payload };
    while (keep > 1 && text.length > maxChars) {
      keep = Math.max(1, Math.floor(keep * Math.min(0.9, maxChars / text.length)));
      trimmed[listKey] = payload[listKey].slice(0, keep);
      if (payload.included) trimmed.included = undefined;
      trimmed.truncated = `Showing ${keep} of ${total} items to stay under ${maxChars} characters (included resources dropped). Narrow the request with filters, fields[...] or a smaller limit, or pass saveTo to write the full response to a file.`;
      text = JSON.stringify(trimmed);
    }
    if (text.length <= maxChars) return text;
  }
  return (
    text.slice(0, maxChars) +
    `\n…[truncated: response is ${text.length} characters. Use fields[...] to request fewer attributes, or pass saveTo to write it to a file.]`
  );
}

/** Writes a new file for saveTo; never overwrites (see paths.ts for where it may write). */
export function saveFile(path: string, content: string | Buffer): string {
  const full = safeOutputPath(path);
  mkdirSync(dirname(full), { recursive: true });
  try {
    writeFileSync(full, content, { flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`${full} already exists; choose a new file name.`);
    throw err;
  }
  return full;
}

export interface TsvTable {
  columns: string[];
  rows: Record<string, string>[];
}

export function parseTsv(text: string): TsvTable {
  const lines = text.replace(/\r/g, "").split("\n").filter((l) => l.trim().length > 0);
  if (!lines.length) return { columns: [], rows: [] };
  const columns = lines[0].split("\t");
  const rows = lines.slice(1).map((line) => {
    const cells = line.split("\t");
    const row: Record<string, string> = {};
    columns.forEach((c, i) => {
      if (cells[i] !== undefined && cells[i] !== "") row[c] = cells[i];
    });
    return row;
  });
  return { columns, rows };
}

export interface RenderOptions {
  compact?: boolean;
  maxChars: number;
  saveTo?: string;
  maxRows?: number;
}

/** Turns an API result into the text returned to the model. */
export function renderResult(result: ApiResult, opts: RenderOptions): string {
  const rate = result.rateLimit ? { rateLimit: result.rateLimit } : {};
  if (result.kind === "empty") return JSON.stringify({ status: result.status, ok: true, ...rate });

  if (result.kind === "json") {
    const payload = opts.compact === false ? result.data : compactJson(result.data);
    if (opts.saveTo) {
      const file = saveFile(opts.saveTo, JSON.stringify(payload, null, 2));
      const count = Array.isArray(payload?.data) ? payload.data.length : 1;
      return JSON.stringify({ status: result.status, savedTo: file, items: count, nextUrl: payload?.nextUrl, ...rate });
    }
    return fitToBudget(payload, opts.maxChars);
  }

  const bytes = decodeBinary(result.bytes);
  const text = bytes.toString("utf8");
  const looksTsv = text.slice(0, 2000).includes("\t");
  if (opts.saveTo) {
    const file = saveFile(opts.saveTo, looksTsv ? text : bytes);
    return JSON.stringify({ status: result.status, savedTo: file, bytes: bytes.length, contentType: result.contentType });
  }
  if (!looksTsv) {
    return JSON.stringify({
      status: result.status,
      contentType: result.contentType,
      bytes: bytes.length,
      note: "Binary response. Pass saveTo to write it to a file.",
    });
  }
  const table = parseTsv(text);
  const maxRows = opts.maxRows ?? 200;
  const payload = {
    columns: table.columns,
    totalRows: table.rows.length,
    rows: table.rows.slice(0, maxRows),
    ...(table.rows.length > maxRows ? { truncated: `Showing ${maxRows} of ${table.rows.length} rows. Pass saveTo to write the full report.` } : {}),
  };
  return fitToBudget(payload, opts.maxChars, "rows");
}
