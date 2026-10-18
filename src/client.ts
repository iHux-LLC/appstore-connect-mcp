import { gunzipSync } from "node:zlib";
import type { TokenProvider } from "./auth.js";
import type { Config } from "./config.js";
import { assertMethodAllowed } from "./config.js";

export const API_HOST = "api.appstoreconnect.apple.com";

export interface RequestOptions {
  method: string;
  /** Path such as "/v1/apps", or a full https://api.appstoreconnect.apple.com URL (e.g. a links.next value). */
  path: string;
  query?: Record<string, string>;
  body?: unknown;
}

export type ApiResult =
  | { kind: "json"; status: number; data: any; rateLimit?: string }
  | { kind: "empty"; status: number; rateLimit?: string }
  | { kind: "binary"; status: number; contentType: string; bytes: Buffer; rateLimit?: string };

export class AscApiError extends Error {
  constructor(
    readonly status: number,
    readonly errors: any[],
    message: string,
  ) {
    super(message);
  }
}

function formatErrors(status: number, payload: any, raw: string): AscApiError {
  const errors: any[] = Array.isArray(payload?.errors) ? payload.errors : [];
  const lines = errors.map((e) => {
    const src = e.source?.pointer ?? e.source?.parameter;
    return `- [${e.code ?? e.status ?? status}] ${e.title ?? ""}${e.detail ? `: ${e.detail}` : ""}${src ? ` (at ${src})` : ""}`;
  });
  const hint =
    status === 401
      ? "\nCheck ASC_KEY_ID, ASC_ISSUER_ID and the .p8 key; the key may have been revoked."
      : status === 403
        ? "\nThe API key's role does not allow this action, or the resource belongs to another team."
        : status === 429
          ? "\nRate limit reached (Apple allows about 3,600 requests per hour). Try again later."
          : "";
  const body = lines.length ? lines.join("\n") : raw.slice(0, 500) || "(no response body)";
  return new AscApiError(status, errors, `App Store Connect returned HTTP ${status}:\n${body}${hint}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class AscClient {
  constructor(
    private readonly config: Config,
    private readonly tokens: TokenProvider,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly baseUrl = `https://${API_HOST}`,
  ) {}

  buildUrl(path: string, query?: Record<string, string>): URL {
    const url = path.startsWith("http") ? new URL(path) : new URL(path, this.baseUrl);
    const base = new URL(this.baseUrl);
    if (url.host !== base.host || url.protocol !== "https:") {
      throw new Error(`Refusing to send App Store Connect credentials to ${url.origin}; only ${base.origin} is allowed.`);
    }
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
    return url;
  }

  async request(opts: RequestOptions): Promise<ApiResult> {
    assertMethodAllowed(opts.method, this.config.mode);
    const url = this.buildUrl(opts.path, opts.query);
    const method = opts.method.toUpperCase();
    const idempotent = method === "GET" || method === "DELETE";
    let refreshed = false;

    for (let attempt = 0; ; attempt++) {
      const token = await this.tokens.getToken(refreshed);
      const res = await this.fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json, application/a-gzip",
          ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
      const rateLimit = res.headers.get("x-rate-limit") ?? undefined;

      if (res.status === 401 && !refreshed) {
        refreshed = true;
        continue;
      }
      const retryable = res.status === 429 || (idempotent && res.status >= 500);
      if (retryable && attempt < 3) {
        const retryAfter = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 30) * 1000 : 500 * 2 ** attempt);
        continue;
      }

      const contentType = res.headers.get("content-type") ?? "";
      if (!res.ok) {
        const raw = await res.text();
        let payload: any;
        try {
          payload = JSON.parse(raw);
        } catch {
          payload = undefined;
        }
        throw formatErrors(res.status, payload, raw);
      }
      if (res.status === 204) return { kind: "empty", status: res.status, rateLimit };
      if (contentType.includes("json")) {
        const text = await res.text();
        return text ? { kind: "json", status: res.status, data: JSON.parse(text), rateLimit } : { kind: "empty", status: res.status, rateLimit };
      }
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length === 0) return { kind: "empty", status: res.status, rateLimit };
      return { kind: "binary", status: res.status, contentType, bytes, rateLimit };
    }
  }

  /** Follows links.next until there are no more pages or maxItems is reached. */
  async requestAll(opts: RequestOptions, maxItems: number): Promise<ApiResult> {
    const first = await this.request(opts);
    if (first.kind !== "json" || !Array.isArray(first.data?.data)) return first;
    const merged = first.data;
    const included = new Map<string, any>();
    for (const inc of merged.included ?? []) included.set(`${inc.type}:${inc.id}`, inc);
    let next: string | undefined = merged.links?.next;
    let pages = 1;
    while (next && merged.data.length < maxItems) {
      const page = await this.request({ method: "GET", path: next });
      if (page.kind !== "json") break;
      merged.data.push(...(page.data.data ?? []));
      for (const inc of page.data.included ?? []) included.set(`${inc.type}:${inc.id}`, inc);
      next = page.data.links?.next;
      pages++;
    }
    // Whole pages are kept, so following links.next later never skips items.
    if (included.size) merged.included = [...included.values()];
    merged.links = { ...merged.links, next };
    merged.meta = { ...merged.meta, fetchedPages: pages, fetchedItems: merged.data.length };
    return first;
  }
}

export function decodeBinary(bytes: Buffer): Buffer {
  return bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes;
}
