import { Ajv, type ValidateFunction } from "ajv";
import type { Catalog, Operation, Param } from "./catalog.js";

export type QueryValue = string | number | boolean | (string | number | boolean)[];

export interface CallInput {
  pathParams?: Record<string, string | number>;
  query?: Record<string, QueryValue | undefined>;
  body?: unknown;
}

export interface PreparedRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  body?: unknown;
}

export class ValidationError extends Error {}

const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
const compiled = new Map<string, ValidateFunction>();

function bodyValidator(catalog: Catalog, name: string): ValidateFunction | undefined {
  if (compiled.has(name)) return compiled.get(name);
  const schema = catalog.bodySchema(name);
  if (!schema) return undefined;
  const fn = ajv.compile(schema);
  compiled.set(name, fn);
  return fn;
}

function closest(name: string, candidates: string[]): string[] {
  const needle = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  return candidates
    .filter((c) => {
      const hay = c.toLowerCase().replace(/[^a-z0-9]/g, "");
      return hay.includes(needle) || needle.includes(hay);
    })
    .slice(0, 6);
}

function serializeQuery(param: Param, value: QueryValue): string {
  const list = Array.isArray(value) ? value : param.type.endsWith("[]") && typeof value === "string" ? value.split(",") : [value];
  const items = list.map((v) => String(v).trim()).filter((v) => v.length > 0);
  if (param.enum) {
    const bad = items.filter((v) => !param.enum!.includes(v));
    if (bad.length) {
      const shown = param.enum.length > 40 ? `${param.enum.slice(0, 40).join(", ")}, …` : param.enum.join(", ");
      throw new ValidationError(`Invalid value(s) ${bad.map((b) => `"${b}"`).join(", ")} for ${param.name}. Allowed: ${shown}`);
    }
  }
  if (!param.type.endsWith("[]") && items.length > 1) {
    throw new ValidationError(`${param.name} takes a single value, got ${items.length}.`);
  }
  return items.join(",");
}

export function prepareRequest(catalog: Catalog, op: Operation, input: CallInput): PreparedRequest {
  const errors: string[] = [];

  let path = op.path;
  const pathParams = op.params.filter((p) => p.in === "path");
  for (const p of pathParams) {
    const value = input.pathParams?.[p.name];
    if (value === undefined || value === "") {
      errors.push(`Missing path parameter "${p.name}" for ${op.path}.`);
      continue;
    }
    path = path.replace(`{${p.name}}`, encodeURIComponent(String(value)));
  }
  for (const k of Object.keys(input.pathParams ?? {})) {
    if (!pathParams.some((p) => p.name === k)) errors.push(`"${k}" is not a path parameter of ${op.id}.`);
  }

  const query: Record<string, string> = {};
  const queryParams = op.params.filter((p) => p.in === "query");
  for (const [name, value] of Object.entries(input.query ?? {})) {
    if (value === undefined || value === null) continue;
    const param = queryParams.find((p) => p.name === name);
    if (!param) {
      const hint = closest(name, queryParams.map((p) => p.name));
      errors.push(
        `Unknown query parameter "${name}" for ${op.id}.` +
          (hint.length ? ` Similar: ${hint.join(", ")}.` : " Use asc_describe_operation to list the valid ones."),
      );
      continue;
    }
    try {
      const serialized = serializeQuery(param, value);
      if (serialized !== "") query[name] = serialized;
    } catch (err) {
      errors.push((err as Error).message);
    }
  }
  for (const p of queryParams) {
    if (p.required && query[p.name] === undefined) errors.push(`Missing required query parameter "${p.name}".`);
  }

  if (op.body) {
    if (input.body === undefined) {
      errors.push(`${op.id} needs a JSON body (${op.body}). Use asc_describe_operation to see its schema.`);
    } else {
      const validate = bodyValidator(catalog, op.body);
      if (validate && !validate(input.body)) {
        for (const e of validate.errors ?? []) {
          const where = e.instancePath || "(body)";
          const extra = e.keyword === "enum" ? ` (allowed: ${(e.params as any).allowedValues.join(", ")})` : "";
          errors.push(`body${where === "(body)" ? "" : where}: ${e.message}${extra}`);
        }
      }
    }
  } else if (input.body !== undefined) {
    errors.push(`${op.id} does not take a request body.`);
  }

  if (errors.length) throw new ValidationError(`Request for ${op.id} is invalid:\n- ${errors.join("\n- ")}`);
  return { method: op.method, path, query, body: op.body ? input.body : undefined };
}
