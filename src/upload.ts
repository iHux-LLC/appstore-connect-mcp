import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import type { Catalog, Operation } from "./catalog.js";
import type { AscClient } from "./client.js";
import { resolveOutputPath } from "./format.js";
import { prepareRequest } from "./validate.js";

export interface UploadInput {
  createOperationId: string;
  filePath: string;
  relationshipId: string;
  relationshipName?: string;
  fileName?: string;
  attributes?: Record<string, unknown>;
  waitForProcessing?: boolean;
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

export async function uploadAsset(
  catalog: Catalog,
  client: AscClient,
  input: UploadInput,
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, unknown>> {
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

  const path = resolveOutputPath(input.filePath);
  const bytes = readFileSync(path);
  const fileName = input.fileName ?? basename(path);
  const md5 = createHash("md5").update(bytes).digest("hex");

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
      attributes: { ...input.attributes, fileName, fileSize: statSync(path).size },
      ...(relName ? { relationships } : {}),
    },
  };
  const reserved = await client.request(prepareRequest(catalog, createOp, { body: reserveBody }));
  if (reserved.kind !== "json") throw new Error("Reserving the upload returned no JSON body.");
  const assetId: string = reserved.data.data.id;
  const operations: any[] = reserved.data.data.attributes?.uploadOperations ?? [];
  if (!operations.length) throw new Error(`Apple returned no uploadOperations for ${resourceType} ${assetId}.`);

  // Step 2: PUT each chunk to Apple's presigned URLs (no App Store Connect token is sent there).
  for (const part of operations) {
    const headers: Record<string, string> = {};
    for (const h of part.requestHeaders ?? []) headers[h.name] = h.value;
    const chunk = bytes.subarray(part.offset, part.offset + part.length);
    const res = await fetchImpl(part.url, { method: part.method ?? "PUT", headers, body: chunk });
    if (!res.ok) {
      throw new Error(`Uploading bytes ${part.offset}-${part.offset + part.length} of ${fileName} failed: HTTP ${res.status} ${await res.text()}`);
    }
  }

  // Step 3: commit, telling Apple the upload is done and what the checksum is.
  const updateOp = catalog.operations.find((o) => o.method === "PATCH" && o.path === `${createOp.path}/{id}`);
  const result: Record<string, unknown> = { id: assetId, type: resourceType, fileName, bytes: bytes.length, chunks: operations.length, md5 };
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

  // Optionally poll until Apple has processed the asset.
  const getOp = catalog.operations.find((o) => o.method === "GET" && o.path === `${createOp.path}/{id}`);
  if (input.waitForProcessing !== false && getOp) {
    for (let i = 0; i < 15; i++) {
      const res = await client.request({ method: "GET", path: `${createOp.path}/${encodeURIComponent(assetId)}` });
      const attrs = res.kind === "json" ? res.data.data?.attributes ?? {} : {};
      const state = attrs.assetDeliveryState ?? attrs.deliveryState;
      if (state) result.deliveryState = state;
      if (!state || ["COMPLETE", "FAILED"].includes(state.state)) break;
      await sleep(2000);
    }
  }
  return result;
}
