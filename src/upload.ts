import { createHash } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { basename } from "node:path";
import type { Catalog, Operation } from "./catalog.js";
import type { AscClient } from "./client.js";
import { safeUploadPath } from "./paths.js";
import { prepareRequest } from "./validate.js";

export interface UploadInput {
  createOperationId: string;
  filePath: string;
  relationshipId: string;
  relationshipName?: string;
  fileName?: string;
  attributes?: Record<string, unknown>;
  waitForProcessing?: boolean;
  /** How long to wait for Apple to finish processing (default 30s). Videos can take minutes. */
  waitSeconds?: number;
}

export interface DeliveryState {
  state?: string;
  errors?: { code?: string; description?: string }[];
  warnings?: { code?: string; description?: string }[];
}

export interface UploadResult {
  id: string;
  type: string;
  fileName: string;
  bytes: number;
  chunks: number;
  md5: string;
  committed?: boolean;
  deliveryState?: DeliveryState;
  note?: string;
}

/** The create operations whose resources are uploaded files (screenshots, previews, IAP images, ...). */
export function uploadableOperations(catalog: Catalog): Operation[] {
  return catalog.operations.filter((op) => {
    if (op.method !== "POST" || !op.body) return false;
    const attrs = catalog.bodySchema(op.body)?.properties?.data?.properties?.attributes?.properties;
    return Boolean(attrs?.fileName && attrs?.fileSize);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const CHUNK_CONCURRENCY = 4;

/** Runs fn over items with at most `limit` in flight, keeping results in order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

function md5OfFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("md5");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

/** Describes Apple's processing errors in one line, e.g. for a rejected screenshot size. */
export function describeDelivery(state: DeliveryState | undefined): string | undefined {
  const problems = [...(state?.errors ?? []), ...(state?.warnings ?? [])];
  if (!problems.length) return undefined;
  return problems.map((p) => [p.code, p.description].filter(Boolean).join(": ")).join("; ");
}

export async function uploadAsset(
  catalog: Catalog,
  client: AscClient,
  input: UploadInput,
  fetchImpl: typeof fetch = fetch,
): Promise<UploadResult> {
  const createOp = catalog.require(input.createOperationId);
  if (!uploadableOperations(catalog).includes(createOp)) {
    const names = uploadableOperations(catalog).map((o) => o.id);
    throw new Error(`${createOp.id} is not a file-upload operation. Upload operations: ${names.join(", ")}`);
  }
  const dataSchema = catalog.bodySchema(createOp.body!).properties.data.properties;
  const resourceType: string = dataSchema.type.enum[0];
  const relSchemas: Record<string, any> = dataSchema.relationships?.properties ?? {};
  const relNames = Object.keys(relSchemas);
  const relName = input.relationshipName ?? (relNames.length === 1 ? relNames[0] : undefined);
  if (relNames.length && (!relName || !relSchemas[relName])) {
    throw new Error(`Pass relationshipName for ${createOp.id}; one of: ${relNames.join(", ")}.`);
  }

  const path = safeUploadPath(input.filePath);
  const size = statSync(path).size;
  const fileName = input.fileName ?? basename(path);
  const md5 = await md5OfFile(path);

  const relationships: Record<string, unknown> = {};
  if (relName) {
    const relData = relSchemas[relName].properties.data;
    const relType = relData.type === "array" ? relData.items.properties.type.enum[0] : relData.properties.type.enum[0];
    const ref = { type: relType, id: input.relationshipId };
    relationships[relName] = { data: relData.type === "array" ? [ref] : ref };
  }

  // Step 1: reserve the asset; Apple answers with where to PUT each chunk.
  const reserveBody = {
    data: {
      type: resourceType,
      attributes: { ...input.attributes, fileName, fileSize: size },
      ...(relName ? { relationships } : {}),
    },
  };
  const reserved = await client.request(prepareRequest(catalog, createOp, { body: reserveBody }));
  if (reserved.kind !== "json") throw new Error("Reserving the upload returned no JSON body.");
  const assetId: string = reserved.data.data.id;
  const operations: any[] = reserved.data.data.attributes?.uploadOperations ?? [];
  if (!operations.length) throw new Error(`Apple returned no uploadOperations for ${resourceType} ${assetId}.`);

  // Step 2: PUT each chunk to Apple's presigned URLs (no App Store Connect token is sent there).
  // Chunks are read from disk one at a time, so large videos never sit in memory whole.
  const handle = await open(path, "r");
  try {
    await mapLimit(operations, CHUNK_CONCURRENCY, async (part) => {
      const chunk = Buffer.alloc(part.length);
      await handle.read(chunk, 0, part.length, part.offset);
      const headers: Record<string, string> = {};
      for (const h of part.requestHeaders ?? []) headers[h.name] = h.value;
      const res = await fetchImpl(part.url, { method: part.method ?? "PUT", headers, body: chunk });
      if (!res.ok) {
        throw new Error(`Uploading bytes ${part.offset}-${part.offset + part.length} of ${fileName} failed: HTTP ${res.status} ${await res.text()}`);
      }
    });
  } finally {
    await handle.close();
  }

  // Step 3: commit, telling Apple the upload is done and what the checksum is.
  const updateOp = catalog.operations.find((o) => o.method === "PATCH" && o.path === `${createOp.path}/{id}`);
  const result: UploadResult = { id: assetId, type: resourceType, fileName, bytes: size, chunks: operations.length, md5 };
  if (!updateOp?.body) {
    result.note = "No commit operation exists for this resource type; Apple processes it once all chunks arrive.";
    return result;
  }
  const updateAttrs = catalog.bodySchema(updateOp.body).properties.data.properties.attributes?.properties ?? {};
  const commitAttrs: Record<string, unknown> = { uploaded: true };
  if (updateAttrs.sourceFileChecksum) commitAttrs.sourceFileChecksum = md5;
  else if (updateAttrs.sourceFileChecksums) commitAttrs.sourceFileChecksums = { file: { hash: md5, algorithm: "MD5" } };
  await client.request(
    prepareRequest(catalog, updateOp, {
      pathParams: { id: assetId },
      body: { data: { type: resourceType, id: assetId, attributes: commitAttrs } },
    }),
  );
  result.committed = true;

  // Step 4: optionally poll until Apple has processed the asset.
  const getOp = catalog.operations.find((o) => o.method === "GET" && o.path === `${createOp.path}/{id}`);
  if (input.waitForProcessing !== false && getOp) {
    const deadline = Date.now() + (input.waitSeconds ?? 30) * 1000;
    for (let attempt = 0; ; attempt++) {
      const res = await client.request({ method: "GET", path: `${createOp.path}/${encodeURIComponent(assetId)}` });
      const attrs = res.kind === "json" ? res.data.data?.attributes ?? {} : {};
      const state: DeliveryState | undefined = attrs.assetDeliveryState ?? attrs.deliveryState;
      if (state) result.deliveryState = state;
      if (!state?.state || ["COMPLETE", "FAILED"].includes(state.state) || Date.now() >= deadline) break;
      await sleep(Math.min(2000 + attempt * 1000, 5000, Math.max(0, deadline - Date.now())));
    }
  }
  return result;
}
