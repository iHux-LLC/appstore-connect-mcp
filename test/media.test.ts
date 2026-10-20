import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkScreenshotSizes, collectFiles, displayTypesForSize, imageSize } from "../src/media.js";
import { connect, json, resultText } from "./helpers.js";

// ---------- fixtures ----------

function png(width: number, height: number): Buffer {
  const buf = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12);
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

function jpeg(width: number, height: number): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, ...Buffer.from("JFIF\0"), 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const sof = Buffer.alloc(19);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof]);
}

function dir(files: Record<string, Buffer>): string {
  const d = mkdtempSync(join(tmpdir(), "asc-media-"));
  for (const [name, data] of Object.entries(files)) writeFileSync(join(d, name), data);
  return d;
}

// ---------- a small stateful App Store Connect ----------

interface Item { id: string; fileName: string; md5?: string; state: string; kind: "screenshots" | "previews"; errors?: any[] }
interface MediaSetState { id: string; kind: "screenshots" | "previews"; type: string; loc: string; items: string[] }

function fakeApple(opts: { versionState?: string; failFiles?: string[]; videoProcessing?: boolean } = {}) {
  const sets: MediaSetState[] = [];
  const items = new Map<string, Item>();
  const calls: string[] = [];
  let n = 0;
  const locs = [{ id: "loc-en", locale: "en-US" }, { id: "loc-de", locale: "de-DE" }];
  const T = {
    screenshots: { set: "appScreenshotSets", item: "appScreenshots", attr: "screenshotDisplayType" },
    previews: { set: "appPreviewSets", item: "appPreviews", attr: "previewType" },
  } as const;

  const itemJson = (it: Item) => ({
    type: T[it.kind].item,
    id: it.id,
    attributes: {
      fileName: it.fileName,
      assetDeliveryState: { state: it.kind === "previews" && it.state !== "FAILED" && it.state !== "AWAITING_UPLOAD" ? "COMPLETE" : it.state, errors: it.errors ?? [] },
      ...(it.kind === "previews" ? { videoDeliveryState: { state: it.state } } : {}),
    },
  });

  const handler = (req: { method: string; url: URL; body?: any }): Response => {
    const { method, url } = req;
    const p = url.pathname;
    if (url.host === "upload.example.com") return new Response(null, { status: 200 });
    calls.push(`${method} ${p}`);
    let m: RegExpMatchArray | null;

    if (method === "GET" && /^\/v1\/apps\/[^/]+\/appStoreVersions$/.test(p)) {
      return json({
        data: [{ type: "appStoreVersions", id: "v1", attributes: { versionString: "2.0", platform: "IOS", appVersionState: opts.versionState ?? "PREPARE_FOR_SUBMISSION", createdDate: "2026-10-01" } }],
      });
    }
    if (method === "GET" && p === "/v1/appStoreVersions/v1/appStoreVersionLocalizations") {
      return json({ data: locs.map((l) => ({ type: "appStoreVersionLocalizations", id: l.id, attributes: { locale: l.locale } })) });
    }
    if (method === "GET" && (m = p.match(/^\/v1\/appStoreVersionLocalizations\/([^/]+)\/(appScreenshotSets|appPreviewSets)$/))) {
      const kind = m[2] === "appScreenshotSets" ? "screenshots" : "previews";
      const mine = sets.filter((s) => s.loc === m![1] && s.kind === kind);
      return json({
        data: mine.map((s) => ({
          type: T[kind].set,
          id: s.id,
          attributes: { [T[kind].attr]: s.type },
          relationships: { [T[kind].item]: { data: s.items.map((id) => ({ type: T[kind].item, id })) } },
        })),
        included: mine.flatMap((s) => s.items.map((id) => itemJson(items.get(id)!))),
      });
    }
    if (method === "POST" && (m = p.match(/^\/v1\/(appScreenshotSets|appPreviewSets)$/))) {
      const kind = m[1] === "appScreenshotSets" ? "screenshots" : "previews";
      const rel = Object.values<any>(req.body.data.relationships)[0].data;
      const set: MediaSetState = { id: `set-${++n}`, kind, type: req.body.data.attributes[T[kind].attr], loc: rel.id, items: [] };
      sets.push(set);
      return json({ data: { type: T[kind].set, id: set.id, attributes: {} } }, 201);
    }
    if (method === "POST" && (m = p.match(/^\/v1\/(appScreenshots|appPreviews)$/))) {
      const kind = m[1] === "appScreenshots" ? "screenshots" : "previews";
      const setId = Object.values<any>(req.body.data.relationships)[0].data.id;
      const { fileName, fileSize } = req.body.data.attributes;
      const it: Item = { id: `item-${++n}`, fileName, state: "AWAITING_UPLOAD", kind };
      items.set(it.id, it);
      sets.find((s) => s.id === setId)!.items.push(it.id);
      const base = itemJson(it);
      return json(
        {
          data: {
            ...base,
            attributes: {
              ...base.attributes,
              ...req.body.data.attributes,
              uploadOperations: [{ method: "PUT", url: `https://upload.example.com/${it.id}`, offset: 0, length: fileSize, requestHeaders: [] }],
            },
          },
        },
        201,
      );
    }
    if (method === "PATCH" && (m = p.match(/^\/v1\/(appScreenshots|appPreviews)\/([^/]+)$/))) {
      const it = items.get(m[2])!;
      it.md5 = req.body.data.attributes.sourceFileChecksum;
      if (opts.failFiles?.includes(it.fileName)) {
        it.state = "FAILED";
        it.errors = [{ code: "IMAGE_INCORRECT_DIMENSIONS", description: "The dimensions are wrong." }];
      } else {
        it.state = it.kind === "previews" && opts.videoProcessing ? "PROCESSING" : "COMPLETE";
      }
      return json({ data: itemJson(it) });
    }
    if (method === "GET" && (m = p.match(/^\/v1\/(appScreenshots|appPreviews)\/([^/]+)$/))) {
      return json({ data: itemJson(items.get(m[2])!) });
    }
    if (method === "DELETE" && (m = p.match(/^\/v1\/(appScreenshots|appPreviews)\/([^/]+)$/))) {
      for (const s of sets) s.items = s.items.filter((id) => id !== m![2]);
      items.delete(m[2]);
      return new Response(null, { status: 204 });
    }
    if (method === "PATCH" && (m = p.match(/^\/v1\/(appScreenshotSets|appPreviewSets)\/([^/]+)\/relationships\/(appScreenshots|appPreviews)$/))) {
      const set = sets.find((s) => s.id === m![2])!;
      const ids: string[] = req.body.data.map((d: any) => d.id);
      // Assume, like Apple, that a reorder must list every file in the set.
      if (ids.length !== set.items.length || !set.items.every((id) => ids.includes(id))) {
        return json({ errors: [{ status: "409", title: "Reorder must list every item" }] }, 409);
      }
      set.items = ids;
      return new Response(null, { status: 204 });
    }
    return json({ errors: [{ status: "404", title: `unhandled ${method} ${p}` }] }, 404);
  };

  const fetchImpl = (async (input: any, init: any = {}) => {
    const url = new URL(String(input));
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    return handler({ method: (init.method ?? "GET").toUpperCase(), url, body });
  }) as typeof fetch;

  const order = (loc: string, kind: "screenshots" | "previews") =>
    (sets.find((s) => s.loc === loc && s.kind === kind)?.items ?? []).map((id) => items.get(id)!.fileName);
  return { fetchImpl, sets, items, calls, order };
}

let originalFetch: typeof fetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function setup(mode: "write" | "full", apple = fakeApple()) {
  globalThis.fetch = apple.fetchImpl; // chunk PUTs use the global fetch
  return { apple, client: await connect(mode, apple.fetchImpl) };
}

const IPHONE_69 = () => png(1290, 2796);

// ---------- pure helpers ----------

describe("image checks", () => {
  it("reads PNG and JPEG sizes", () => {
    const d = dir({ "a.png": png(1290, 2796), "b.jpg": jpeg(2048, 2732) });
    expect(imageSize(join(d, "a.png"))).toEqual({ width: 1290, height: 2796 });
    expect(imageSize(join(d, "b.jpg"))).toEqual({ width: 2048, height: 2732 });
  });

  it("detects the device from the image size, in either orientation", () => {
    expect(displayTypesForSize(1290, 2796)).toEqual(["APP_IPHONE_67"]);
    expect(displayTypesForSize(2796, 1290)).toEqual(["APP_IPHONE_67"]);
    const d = dir({ "1.png": IPHONE_69() });
    expect(checkScreenshotSizes([join(d, "1.png")]).displayType).toBe("APP_IPHONE_67");
  });

  it("refuses a screenshot made for a different device", () => {
    const d = dir({ "ipad.png": png(2064, 2752) });
    expect(() => checkScreenshotSizes([join(d, "ipad.png")], "APP_IPHONE_67")).toThrow(/APP_IPAD_PRO_3GEN_129 size, not APP_IPHONE_67/);
  });

  it("only warns about sizes it doesn't know", () => {
    const d = dir({ "odd.png": png(1000, 2000) });
    const r = checkScreenshotSizes([join(d, "odd.png")], "APP_IPHONE_67");
    expect(r.warnings[0]).toMatch(/1000×2000, not a size we know/);
    expect(() => checkScreenshotSizes([join(d, "odd.png")])).toThrow(/Pass displayType/);
  });

  it("takes a folder in natural name order and rejects other file types", () => {
    const d = dir({ "10.png": IPHONE_69(), "2.png": IPHONE_69(), "1.png": IPHONE_69(), ".DS_Store": Buffer.from("x"), "notes.txt": Buffer.from("x") });
    expect(collectFiles("screenshots", [], d).map((f) => f.split("/").pop())).toEqual(["1.png", "2.png", "10.png"]);
    expect(() => collectFiles("screenshots", [join(d, "notes.txt")])).toThrow(/must be one of .png, .jpg, .jpeg \(got ".txt"\)/);
    expect(() => collectFiles("previews", [], d)).toThrow(/No .mov\/.m4v\/.mp4 files/);
  });
});

// ---------- tools ----------

describe("asc_upload_screenshots", () => {
  it("creates the sets, uploads in order to every language, and reports progress", async () => {
    const { apple, client } = await setup("write");
    const d = dir({ "1.png": IPHONE_69(), "2.png": IPHONE_69(), "10.png": IPHONE_69() });
    const progress: number[] = [];
    const res: any = await client.callTool(
      { name: "asc_upload_screenshots", arguments: { appId: "A", locales: ["*"], folder: d } },
      undefined,
      { onprogress: (p) => progress.push(p.progress) },
    );
    expect(res.isError, resultText(res)).toBeFalsy();
    const out = JSON.parse(resultText(res));
    expect(out.displayType).toBe("APP_IPHONE_67");
    expect(out.results.map((r: any) => [r.locale, r.set.created, r.files.every((f: any) => f.state === "COMPLETE")])).toEqual([
      ["en-US", true, true],
      ["de-DE", true, true],
    ]);
    expect(apple.order("loc-en", "screenshots")).toEqual(["1.png", "2.png", "10.png"]);
    expect(apple.order("loc-de", "screenshots")).toEqual(["1.png", "2.png", "10.png"]);
    expect(progress).toEqual([1, 2, 3, 4, 5, 6]);
    const committed = [...apple.items.values()][0];
    expect(committed.md5).toBe(createHash("md5").update(IPHONE_69()).digest("hex"));
  });

  it("adds after existing screenshots, and enforces the 10-per-set limit before uploading", async () => {
    const { apple, client } = await setup("write");
    await client.callTool({ name: "asc_upload_screenshots", arguments: { appId: "A", locales: ["en-US"], folder: dir({ "a.png": IPHONE_69(), "b.png": IPHONE_69() }) } });
    await client.callTool({ name: "asc_upload_screenshots", arguments: { appId: "A", locales: ["en-US"], folder: dir({ "c.png": IPHONE_69() }) } });
    expect(apple.order("loc-en", "screenshots")).toEqual(["a.png", "b.png", "c.png"]);

    const many = dir(Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`m${i}.png`, IPHONE_69()])));
    const posts = apple.calls.filter((c) => c === "POST /v1/appScreenshots").length;
    const res: any = await client.callTool({ name: "asc_upload_screenshots", arguments: { appId: "A", locales: ["en-US"], folder: many } });
    expect(res.isError).toBe(true);
    expect(resultText(res)).toMatch(/at most 10 screenshots; it has 3 and you're adding 8/);
    expect(apple.calls.filter((c) => c === "POST /v1/appScreenshots").length).toBe(posts);
  });

  it("requires full mode for replace and says so before uploading anything", async () => {
    const { apple, client } = await setup("write");
    const res: any = await client.callTool({
      name: "asc_upload_screenshots",
      arguments: { appId: "A", locales: ["en-US"], files: [join(dir({ "a.png": IPHONE_69() }), "a.png")], replace: true },
    });
    expect(res.isError).toBe(true);
    expect(resultText(res)).toMatch(/needs the "full" access mode/);
    expect(apple.calls.some((c) => c.startsWith("POST"))).toBe(false);
  });

  it("replaces the old screenshots only once every new one processed", async () => {
    const { apple, client } = await setup("full");
    await client.callTool({ name: "asc_upload_screenshots", arguments: { appId: "A", locales: ["en-US"], folder: dir({ "old1.png": IPHONE_69(), "old2.png": IPHONE_69() }) } });
    const res: any = await client.callTool({
      name: "asc_upload_screenshots",
      arguments: { appId: "A", locales: ["en-US"], folder: dir({ "new1.png": IPHONE_69(), "new2.png": IPHONE_69() }), replace: true },
    });
    expect(res.isError, resultText(res)).toBeFalsy();
    expect(JSON.parse(resultText(res)).results[0].removedOld).toBe(2);
    expect(apple.order("loc-en", "screenshots")).toEqual(["new1.png", "new2.png"]);
  });

  it("keeps the old screenshots when a new one fails, and explains why", async () => {
    const apple = fakeApple({ failFiles: ["bad.png"] });
    const { client } = await setup("full", apple);
    await client.callTool({ name: "asc_upload_screenshots", arguments: { appId: "A", locales: ["en-US"], folder: dir({ "old.png": IPHONE_69() }) } });
    const res: any = await client.callTool({
      name: "asc_upload_screenshots",
      arguments: { appId: "A", locales: ["en-US"], folder: dir({ "bad.png": IPHONE_69(), "good.png": IPHONE_69() }), replace: true },
    });
    const r = JSON.parse(resultText(res)).results[0];
    expect(r.files.find((f: any) => f.file === "bad.png")).toMatchObject({ state: "FAILED", problem: "IMAGE_INCORRECT_DIMENSIONS: The dimensions are wrong." });
    expect(r.removedOld).toBeUndefined();
    expect(r.notes.join(" ")).toMatch(/Kept the existing files/);
    expect(apple.order("loc-en", "screenshots")).toEqual(["old.png", "bad.png", "good.png"]);
  });

  it("refuses a version that can no longer change", async () => {
    const { client } = await setup("write", fakeApple({ versionState: "READY_FOR_DISTRIBUTION" }));
    const res: any = await client.callTool({ name: "asc_upload_screenshots", arguments: { appId: "A", locales: ["en-US"], folder: dir({ "a.png": IPHONE_69() }) } });
    expect(resultText(res)).toMatch(/is READY_FOR_DISTRIBUTION, so its media can't change/);
  });

  it("asks for locales and lists the version's languages", async () => {
    const { client } = await setup("write");
    const res: any = await client.callTool({ name: "asc_upload_screenshots", arguments: { appId: "A", folder: dir({ "a.png": IPHONE_69() }) } });
    expect(resultText(res)).toMatch(/Pass locales[\s\S]*en-US, de-DE/);
    const missing: any = await client.callTool({ name: "asc_upload_screenshots", arguments: { appId: "A", locales: ["fr-FR"], folder: dir({ "a.png": IPHONE_69() }) } });
    expect(resultText(missing)).toMatch(/no fr-FR localization/);
  });
});

describe("asc_upload_previews", () => {
  it("uploads a video with its type and poster frame and waits for video processing", async () => {
    const { apple, client } = await setup("write");
    const d = dir({ "promo.mov": Buffer.alloc(64, 1) });
    const res: any = await client.callTool({
      name: "asc_upload_previews",
      arguments: { appId: "A", locales: ["en-US"], previewType: "IPHONE_67", files: [join(d, "promo.mov")], previewFrameTimeCode: "00:00:05:00" },
    });
    expect(res.isError, resultText(res)).toBeFalsy();
    const out = JSON.parse(resultText(res));
    expect(out.results[0].files[0]).toMatchObject({ file: "promo.mov", state: "COMPLETE" });
    expect(apple.order("loc-en", "previews")).toEqual(["promo.mov"]);
    expect(apple.calls).toContain(`GET /v1/appPreviews/${out.results[0].files[0].id}`);
  });

  it("reports still-processing videos instead of waiting forever", async () => {
    const { client } = await setup("write", fakeApple({ videoProcessing: true }));
    const d = dir({ "promo.mp4": Buffer.alloc(64, 1) });
    const res: any = await client.callTool({
      name: "asc_upload_previews",
      arguments: { appId: "A", locales: ["en-US"], previewType: "IPHONE_67", files: [join(d, "promo.mp4")], waitSeconds: 0 },
    });
    const r = JSON.parse(resultText(res)).results[0];
    expect(r.files[0].state).toBe("PROCESSING");
    expect(r.notes.join(" ")).toMatch(/still processing/);
  });

  it("rejects a bad poster frame format", async () => {
    const { client } = await setup("write");
    const res: any = await client.callTool({
      name: "asc_upload_previews",
      arguments: { appId: "A", locales: ["en-US"], previewType: "IPHONE_67", folder: "/tmp", previewFrameTimeCode: "5s" },
    });
    expect(res.isError).toBe(true);
  });
});

describe("asc_list_media", () => {
  it("shows every language's sets with files in order", async () => {
    const { client } = await setup("write");
    await client.callTool({ name: "asc_upload_screenshots", arguments: { appId: "A", locales: ["en-US"], folder: dir({ "1.png": IPHONE_69(), "2.png": IPHONE_69() }) } });
    const out = JSON.parse(resultText(await client.callTool({ name: "asc_list_media", arguments: { appId: "A" } })));
    expect(out.version).toMatchObject({ versionString: "2.0", platform: "IOS" });
    const en = out.localizations.find((l: any) => l.locale === "en-US");
    expect(en.screenshotSets[0]).toMatchObject({ type: "APP_IPHONE_67", count: 2 });
    expect(en.screenshotSets[0].items.map((i: any) => [i.fileName, i.state])).toEqual([
      ["1.png", "COMPLETE"],
      ["2.png", "COMPLETE"],
    ]);
    expect(out.localizations.find((l: any) => l.locale === "de-DE").screenshotSets).toEqual([]);
  });
});
