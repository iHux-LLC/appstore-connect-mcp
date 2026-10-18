import { describe, expect, it } from "vitest";
import { decodeProtectedHeader, jwtVerify } from "jose";
import { TokenProvider } from "../src/auth.js";
import { Catalog } from "../src/catalog.js";
import { AscClient } from "../src/client.js";
import { ConfigError, loadConfig, methodAllowed } from "../src/config.js";
import { compactJson, fitToBudget, parseTsv } from "../src/format.js";
import { prepareRequest, ValidationError } from "../src/validate.js";
import { json, keyPair, mockFetch, testConfig } from "./helpers.js";

const catalog = Catalog.load();

describe("auth", () => {
  it("signs an ES256 JWT Apple accepts and caches it", async () => {
    const tokens = new TokenProvider(testConfig());
    const token = await tokens.getToken();
    const header = decodeProtectedHeader(token);
    expect(header).toMatchObject({ alg: "ES256", kid: "ABC123DEFG", typ: "JWT" });
    const { payload } = await jwtVerify(token, keyPair.publicKey, { audience: "appstoreconnect-v1", issuer: "issuer-uuid" });
    expect(payload.exp! - payload.iat!).toBeLessThanOrEqual(20 * 60);
    expect(await tokens.getToken()).toBe(token);
  });

  it("explains missing credentials", async () => {
    const tokens = new TokenProvider(loadConfig({}));
    await expect(tokens.getToken()).rejects.toThrow(/ASC_KEY_ID and ASC_ISSUER_ID/);
  });

  it("accepts a PEM with escaped newlines", async () => {
    const escaped = testConfig().privateKeyInline!.replace(/\n/g, "\\n");
    const tokens = new TokenProvider(loadConfig({ ASC_KEY_ID: "K", ASC_ISSUER_ID: "I", ASC_PRIVATE_KEY: escaped }));
    await expect(tokens.getToken()).resolves.toMatch(/^ey/);
  });
});

describe("config modes", () => {
  it("defaults to readonly and gates methods", () => {
    expect(loadConfig({}).mode).toBe("readonly");
    expect(methodAllowed("GET", "readonly")).toBe(true);
    expect(methodAllowed("POST", "readonly")).toBe(false);
    expect(methodAllowed("PATCH", "write")).toBe(true);
    expect(methodAllowed("DELETE", "write")).toBe(false);
    expect(methodAllowed("DELETE", "full")).toBe(true);
  });

  it("rejects an unknown mode", () => {
    expect(() => loadConfig({ ASC_MODE: "yolo" })).toThrow(ConfigError);
  });
});

describe("catalog", () => {
  it("covers the whole spec", () => {
    expect(catalog.operations.length).toBeGreaterThan(1200);
    expect(new Set(catalog.operations.map((o) => o.id)).size).toBe(catalog.operations.length);
  });

  it.each([
    ["customer reviews", "customerReview"],
    ["testflight testers", "betaTester"],
    ["xcode cloud workflows", "ciWorkflow"],
    ["subscription price", "subscriptionPrice"],
    ["app screenshots", "appScreenshot"],
  ])("search %s finds %s", (query, expected) => {
    const ids = catalog.search(query, { limit: 5 }).map((o) => o.id);
    expect(ids.some((id) => id.toLowerCase().includes(expected.toLowerCase()))).toBe(true);
  });

  it("ranks an exact operationId first", () => {
    expect(catalog.search("apps_builds_getToManyRelated")[0].id).toBe("apps_builds_getToManyRelated");
  });

  it("suggests close ids for a typo", () => {
    expect(() => catalog.require("apps_getColection")).toThrow(/Did you mean/);
  });
});

describe("request validation", () => {
  const listBuilds = catalog.require("builds_getCollection");

  it("joins arrays and fills path params", () => {
    const req = prepareRequest(catalog, catalog.require("apps_builds_getToManyRelated"), {
      pathParams: { id: "123" },
      query: { "fields[builds]": ["version", "processingState"], limit: 10 },
    });
    expect(req.path).toBe("/v1/apps/123/builds");
    expect(req.query).toEqual({ "fields[builds]": "version,processingState", limit: "10" });
  });

  it("rejects unknown params with a suggestion", () => {
    expect(() => prepareRequest(catalog, listBuilds, { query: { "filter[apps]": "1" } })).toThrow(/Similar: filter\[app\]/);
  });

  it("rejects invalid enum values", () => {
    expect(() => prepareRequest(catalog, listBuilds, { query: { "filter[processingState]": "DONE" } })).toThrow(/Allowed: PROCESSING/);
  });

  it("requires path params and required query params", () => {
    expect(() => prepareRequest(catalog, catalog.require("apps_getInstance"), {})).toThrow(/Missing path parameter "id"/);
    expect(() => prepareRequest(catalog, catalog.require("financeReports_getCollection"), {})).toThrow(/filter\[vendorNumber\]/);
  });

  it("validates bodies against the spec", () => {
    const op = catalog.require("betaTesters_createInstance");
    expect(() => prepareRequest(catalog, op, { body: { data: { type: "betaTesters", attributes: {} } } })).toThrow(ValidationError);
    expect(() =>
      prepareRequest(catalog, op, { body: { data: { type: "betaTesters", attributes: { email: "a@b.co" } } } }),
    ).not.toThrow();
  });

  it("accepts nullable attributes", () => {
    const op = catalog.require("appStoreVersionLocalizations_updateInstance");
    expect(() =>
      prepareRequest(catalog, op, { pathParams: { id: "1" }, body: { data: { type: "appStoreVersionLocalizations", id: "1", attributes: { whatsNew: null } } } }),
    ).not.toThrow();
  });
});

describe("client", () => {
  it("blocks writes in readonly mode before any network call", async () => {
    const { fn, calls } = mockFetch();
    const client = new AscClient(testConfig("readonly"), new TokenProvider(testConfig()), fn);
    await expect(client.request({ method: "POST", path: "/v1/betaTesters", body: {} })).rejects.toThrow(/access mode is "readonly"/);
    expect(calls).toHaveLength(0);
  });

  it("never sends the token to another host", async () => {
    const { fn, calls } = mockFetch();
    const client = new AscClient(testConfig(), new TokenProvider(testConfig()), fn);
    await expect(client.request({ method: "GET", path: "https://evil.example.com/v1/apps" })).rejects.toThrow(/Refusing/);
    expect(calls).toHaveLength(0);
  });

  it("retries on 429 and formats Apple errors", async () => {
    let n = 0;
    const { fn } = mockFetch(() => (n++ === 0 ? json({ errors: [] }, 429, { "retry-after": "0" }) : undefined));
    const client = new AscClient(testConfig(), new TokenProvider(testConfig()), fn);
    await expect(client.request({ method: "GET", path: "/v1/apps" })).resolves.toMatchObject({ kind: "json" });

    const { fn: failing } = mockFetch(() =>
      json({ errors: [{ status: "409", code: "ENTITY_ERROR.ATTRIBUTE.INVALID", title: "Invalid", detail: "bad version", source: { pointer: "/data/attributes/versionString" } }] }, 409),
    );
    const c2 = new AscClient(testConfig("write"), new TokenProvider(testConfig()), failing);
    await expect(c2.request({ method: "POST", path: "/v1/appStoreVersions", body: {} })).rejects.toThrow(/HTTP 409[\s\S]*bad version[\s\S]*versionString/);
  });

  it("follows pagination with fetchAll", async () => {
    const { fn } = mockFetch((req) =>
      req.url.searchParams.get("cursor")
        ? json({ data: [{ type: "apps", id: "2" }], links: {} })
        : json({ data: [{ type: "apps", id: "1" }], links: { next: "https://api.appstoreconnect.apple.com/v1/apps?cursor=abc" } }),
    );
    const client = new AscClient(testConfig(), new TokenProvider(testConfig()), fn);
    const res: any = await client.requestAll({ method: "GET", path: "/v1/apps" }, 100);
    expect(res.data.data.map((d: any) => d.id)).toEqual(["1", "2"]);
    expect(res.data.links.next).toBeUndefined();
  });
});

describe("formatting", () => {
  it("strips JSON:API links", () => {
    const out = compactJson({
      data: [{ type: "apps", id: "1", attributes: { name: "A" }, links: { self: "x" }, relationships: { builds: { links: { related: "y" } } } }],
      links: { self: "s", next: "n" },
      meta: { paging: { total: 1 } },
    });
    expect(out).toEqual({ data: [{ type: "apps", id: "1", attributes: { name: "A" } }], meta: { paging: { total: 1 } }, nextUrl: "n" });
  });

  it("trims lists to fit the budget", () => {
    const big = { data: Array.from({ length: 500 }, (_, i) => ({ id: String(i), attributes: { text: "x".repeat(200) } })) };
    const text = fitToBudget(big, 10000);
    expect(text.length).toBeLessThanOrEqual(10000);
    expect(JSON.parse(text).truncated).toMatch(/of 500 items/);
  });

  it("parses TSV reports", () => {
    expect(parseTsv("A\tB\n1\t2\n3\t\n")).toEqual({ columns: ["A", "B"], rows: [{ A: "1", B: "2" }, { A: "3" }] });
  });
});
