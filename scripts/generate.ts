// Turns Apple's App Store Connect OpenAPI spec into the compact catalog the server loads at runtime.
// Run with `npm run generate` (Node >= 22.18 strips the TypeScript types natively).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const spec = JSON.parse(readFileSync(join(root, "spec/openapi.oas.json"), "utf8"));

type Json = any;

const METHODS = ["get", "post", "patch", "put", "delete"] as const;
const KEEP_KEYS = new Set([
  "type", "properties", "required", "enum", "items", "nullable", "format",
  "oneOf", "anyOf", "allOf", "additionalProperties", "description",
  "maxLength", "minLength", "maximum", "minimum", "maxItems", "minItems", "deprecated",
]);

function deref(ref: string): Json {
  return ref.replace(/^#\//, "").split("/").reduce((o: Json, k: string) => o[k], spec);
}

// Inline every $ref and drop keys that only add noise (titles, examples).
function resolveSchema(schema: Json, seen: string[] = [], depth = 0): Json {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map((s) => resolveSchema(s, seen, depth));
  if (schema.$ref) {
    if (seen.includes(schema.$ref) || depth > 14) return { type: "object", description: `(recursive ${schema.$ref.split("/").pop()})` };
    return resolveSchema(deref(schema.$ref), [...seen, schema.$ref], depth + 1);
  }
  const out: Json = {};
  for (const [k, v] of Object.entries(schema)) {
    if (!KEEP_KEYS.has(k)) continue;
    if (k === "properties") {
      out.properties = Object.fromEntries(
        Object.entries(v as Json).map(([pk, pv]) => [pk, resolveSchema(pv, seen, depth + 1)]),
      );
    } else if (k === "items" || k === "additionalProperties" || k === "oneOf" || k === "anyOf" || k === "allOf") {
      out[k] = typeof v === "object" ? resolveSchema(v, seen, depth + 1) : v;
    } else {
      out[k] = v;
    }
  }
  return out;
}

function paramType(schema: Json): string {
  const s = schema?.$ref ? deref(schema.$ref) : schema;
  if (!s) return "string";
  if (s.type === "array") return `${paramType(s.items)}[]`;
  return s.type ?? "string";
}

function paramEnum(schema: Json): string[] | undefined {
  const s = schema?.$ref ? deref(schema.$ref) : schema;
  if (!s) return undefined;
  if (s.type === "array") return paramEnum(s.items);
  return s.enum;
}

// Apple's spec has no summaries, so derive one from the operationId, e.g.
// "apps_builds_getToManyRelated" -> "List the builds related to an app".
function humanize(word: string): string {
  return word.replace(/V\d+$/, "").replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
}
function summarize(operationId: string, method: string, path: string): string {
  const parts = operationId.split("_");
  const action = parts[parts.length - 1];
  const resource = humanize(parts[0]);
  const related = parts.length > 2 ? humanize(parts.slice(1, -1).join(" ")) : "";
  switch (action) {
    case "getCollection": return `List ${resource}`;
    case "getInstance": return `Get one ${resource} resource by id`;
    case "createInstance": return `Create a resource in ${resource}`;
    case "updateInstance": return `Update a resource in ${resource}`;
    case "deleteInstance": return `Delete a resource in ${resource}`;
    case "getToManyRelated": return `List the ${related} related to the given ${resource} resource`;
    case "getToOneRelated": return `Get the ${related} related to the given ${resource} resource`;
    case "getToManyRelationship": return `List the ids of ${related} linked to the given ${resource} resource`;
    case "getToOneRelationship": return `Get the id of the ${related} linked to the given ${resource} resource`;
    case "createToManyRelationship": return `Link ${related} to the given ${resource} resource`;
    case "replaceToManyRelationship": return `Replace the ${related} linked to the given ${resource} resource`;
    case "updateToOneRelationship": return `Set the ${related} linked to the given ${resource} resource`;
    case "deleteToManyRelationship": return `Unlink ${related} from the given ${resource} resource`;
    default: return `${method.toUpperCase()} ${path} (${humanize(action)})`;
  }
}

const operations: Json[] = [];
const bodySchemas: Record<string, Json> = {};

for (const [path, item] of Object.entries<Json>(spec.paths)) {
  for (const method of METHODS) {
    const op = item[method];
    if (!op) continue;
    const rawParams: Json[] = [...(item.parameters ?? []), ...(op.parameters ?? [])];
    const params = rawParams.map((p) => {
      const out: Json = { name: p.name, in: p.in, type: paramType(p.schema) };
      if (p.required) out.required = true;
      const e = paramEnum(p.schema);
      if (e) out.enum = e;
      // Apple's generated descriptions ("filter by attribute 'x'") repeat the name; keep only the useful ones.
      if (p.description && !/^(filter by|the fields to include|comma-separated list|maximum number|the id of the requested)/i.test(p.description)) {
        out.description = p.description;
      }
      if (p.deprecated) out.deprecated = true;
      return out;
    });

    let body: string | undefined;
    const bodyRef = op.requestBody?.content?.["application/json"]?.schema?.$ref;
    if (bodyRef) {
      body = bodyRef.split("/").pop();
      if (!bodySchemas[body!]) bodySchemas[body!] = resolveSchema({ $ref: bodyRef });
    }

    const okStatus = Object.keys(op.responses ?? {}).find((s) => s.startsWith("2"));
    const okContent = okStatus ? op.responses[okStatus].content : undefined;
    const contentType = okContent ? Object.keys(okContent)[0] : undefined;
    const responseRef = contentType ? okContent[contentType].schema?.$ref : undefined;

    const entry: Json = {
      id: op.operationId,
      method: method.toUpperCase(),
      path,
      tags: op.tags ?? [],
      summary: summarize(op.operationId, method, path),
      params,
    };
    if (op.deprecated) entry.deprecated = true;
    if (body) entry.body = body;
    if (contentType && contentType !== "application/json") entry.responseType = contentType;
    if (responseRef) entry.response = responseRef.split("/").pop();
    operations.push(entry);
  }
}

operations.sort((a, b) => a.id.localeCompare(b.id));

const catalog = {
  specVersion: spec.info.version,
  baseUrl: spec.servers?.[0]?.url?.replace(/\/$/, "") ?? "https://api.appstoreconnect.apple.com",
  operations,
  bodySchemas,
};

mkdirSync(join(root, "catalog"), { recursive: true });
writeFileSync(join(root, "catalog/catalog.json"), JSON.stringify(catalog));
console.log(
  `catalog: ${operations.length} operations, ${Object.keys(bodySchemas).length} request schemas, spec ${spec.info.version}`,
);
