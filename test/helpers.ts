import { generateKeyPairSync } from "node:crypto";
import { gzipSync } from "node:zlib";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig, type Mode } from "../src/config.js";
import { createServer, type ServerOptions } from "../src/server.js";

export const keyPair = generateKeyPairSync("ec", { namedCurve: "P-256" });
export const privatePem = keyPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

export function testConfig(mode: Mode = "readonly") {
  return loadConfig({ ASC_KEY_ID: "ABC123DEFG", ASC_ISSUER_ID: "issuer-uuid", ASC_PRIVATE_KEY: privatePem, ASC_MODE: mode }, {});
}

export interface Recorded {
  method: string;
  url: URL;
  body?: any;
  headers: Record<string, string>;
}

/** A fake fetch that records calls and answers from a handler (default: an empty JSON:API body). */
export function mockFetch(handler?: (req: Recorded) => Response | undefined) {
  const calls: Recorded[] = [];
  const fn = (async (input: any, init: any = {}) => {
    const url = new URL(String(input));
    const rec: Recorded = {
      method: (init.method ?? "GET").toUpperCase(),
      url,
      headers: init.headers ?? {},
      body: typeof init.body === "string" ? JSON.parse(init.body) : init.body,
    };
    calls.push(rec);
    const custom = handler?.(rec);
    if (custom) return custom;
    if (rec.method === "GET" && /\/v\d+\/[A-Za-z]+\/[^/]+$/.test(url.pathname)) {
      return json({ data: { type: "x", id: "1", attributes: {} } });
    }
    if (rec.method === "GET") return json({ data: [], links: {} });
    return json({ data: { type: rec.body?.data?.type ?? "x", id: "new-id", attributes: {} } }, rec.method === "POST" ? 201 : 200);
  }) as typeof fetch;
  return { fn, calls };
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

export function gzipTsv(text: string) {
  return new Response(gzipSync(Buffer.from(text)), { status: 200, headers: { "content-type": "application/a-gzip" } });
}

export async function connect(mode: Mode, fetchImpl: typeof fetch, opts: Omit<ServerOptions, "fetchImpl"> = {}) {
  const { server } = createServer(testConfig(mode), { fetchImpl, ...opts });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(clientT);
  return client;
}

export function resultText(res: any): string {
  return res.content?.[0]?.text ?? "";
}
