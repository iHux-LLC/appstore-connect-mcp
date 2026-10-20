import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { safeUploadFolder, safeUploadPath } from "./paths.js";
import { describeDelivery, uploadAsset, type DeliveryState, type UploadResult } from "./upload.js";
import { runJson, runOperation, type ToolContext } from "./tools/context.js";

export type MediaKind = "screenshots" | "previews";
export type Owner = "version" | "customProductPage" | "experimentTreatment";

/** Apple's per-set limits. */
export const MAX_PER_SET: Record<MediaKind, number> = { screenshots: 10, previews: 3 };

const EXTENSIONS: Record<MediaKind, string[]> = {
  screenshots: [".png", ".jpg", ".jpeg"],
  previews: [".mov", ".m4v", ".mp4"],
};

const VIDEO_MIME: Record<string, string> = { ".mov": "video/quicktime", ".m4v": "video/x-m4v", ".mp4": "video/mp4" };

// How each kind of localization links to its media sets.
const OWNERS: Record<Owner, { relationship: string; type: string; listOp: string }> = {
  version: { relationship: "appStoreVersionLocalization", type: "appStoreVersionLocalizations", listOp: "appStoreVersionLocalizations" },
  customProductPage: { relationship: "appCustomProductPageLocalization", type: "appCustomProductPageLocalizations", listOp: "appCustomProductPageLocalizations" },
  experimentTreatment: {
    relationship: "appStoreVersionExperimentTreatmentLocalization",
    type: "appStoreVersionExperimentTreatmentLocalizations",
    listOp: "appStoreVersionExperimentTreatmentLocalizations",
  },
};

const KIND = {
  screenshots: {
    setType: "appScreenshotSets",
    itemType: "appScreenshots",
    typeAttr: "screenshotDisplayType",
    setsRel: "appScreenshotSets",
    createSetOp: "appScreenshotSets_createInstance",
    createItemOp: "appScreenshots_createInstance",
    deleteItemOp: "appScreenshots_deleteInstance",
    reorderOp: "appScreenshotSets_appScreenshots_replaceToManyRelationship",
    itemFields: ["fileName", "fileSize", "imageAsset", "assetDeliveryState"],
  },
  previews: {
    setType: "appPreviewSets",
    itemType: "appPreviews",
    typeAttr: "previewType",
    setsRel: "appPreviewSets",
    createSetOp: "appPreviewSets_createInstance",
    createItemOp: "appPreviews_createInstance",
    deleteItemOp: "appPreviews_deleteInstance",
    reorderOp: "appPreviewSets_appPreviews_replaceToManyRelationship",
    itemFields: ["fileName", "fileSize", "previewFrameTimeCode", "mimeType", "assetDeliveryState", "videoDeliveryState"],
  },
} as const;

/**
 * Screenshot sizes Apple accepts per display type (portrait; landscape is the same pair swapped),
 * from Apple's screenshot specifications. Apple remains the authority: an unknown size only warns.
 */
export const SCREENSHOT_SIZES: Record<string, [number, number][]> = {
  APP_IPHONE_67: [[1320, 2868], [1290, 2796], [1260, 2736]],
  APP_IPHONE_65: [[1284, 2778], [1242, 2688]],
  APP_IPHONE_61: [[1206, 2622], [1179, 2556], [1170, 2532], [1125, 2436], [1080, 2340]],
  APP_IPHONE_58: [[1170, 2532], [1125, 2436], [1080, 2340]],
  APP_IPHONE_55: [[1242, 2208]],
  APP_IPHONE_47: [[750, 1334]],
  APP_IPHONE_40: [[640, 1096], [640, 1136]],
  APP_IPHONE_35: [[640, 920], [640, 960]],
  APP_IPAD_PRO_3GEN_129: [[2064, 2752], [2048, 2732]],
  APP_IPAD_PRO_3GEN_11: [[1488, 2266], [1668, 2420], [1668, 2388], [1640, 2360]],
  APP_IPAD_PRO_129: [[2048, 2732]],
  APP_IPAD_105: [[1668, 2224]],
  APP_IPAD_97: [[1536, 2008], [1536, 2048], [768, 1004], [768, 1024]],
  APP_DESKTOP: [[1280, 800], [1440, 900], [2560, 1600], [2880, 1800]],
  APP_APPLE_TV: [[1920, 1080], [3840, 2160]],
  APP_APPLE_VISION_PRO: [[3840, 2160]],
  APP_WATCH_ULTRA: [[422, 514], [410, 502]],
  APP_WATCH_SERIES_10: [[416, 496]],
  APP_WATCH_SERIES_7: [[396, 484]],
  APP_WATCH_SERIES_4: [[368, 448]],
  APP_WATCH_SERIES_3: [[312, 390]],
};

function sizeMatches(type: string, w: number, h: number): boolean {
  // iMessage sets use the same sizes as the matching app sets.
  const sizes = SCREENSHOT_SIZES[type.replace(/^IMESSAGE_/, "")] ?? [];
  return sizes.some(([a, b]) => (a === w && b === h) || (a === h && b === w));
}

/** Display types whose accepted sizes include w×h (in either orientation). */
export function displayTypesForSize(w: number, h: number): string[] {
  return Object.keys(SCREENSHOT_SIZES).filter((t) => sizeMatches(t, w, h));
}

/** Reads width and height from a PNG or JPEG header without decoding the image. */
export function imageSize(path: string): { width: number; height: number } | undefined {
  const buf = readFileSync(path);
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      const length = buf.readUInt16BE(i + 2);
      // SOF0–SOF15 carry the frame size, except DHT (C4), JPG (C8) and DAC (CC).
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      i += 2 + length;
    }
  }
  return undefined;
}

/** Expands files and/or a folder into an ordered list of media files, checking each exists. */
export function collectFiles(kind: MediaKind, files: string[] = [], folder?: string): string[] {
  const out = files.map((f) => safeUploadPath(f, EXTENSIONS[kind]));
  if (folder) {
    const dir = safeUploadFolder(folder);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`Folder not found: ${dir}`);
    const names = readdirSync(dir)
      .filter((n) => !n.startsWith(".") && EXTENSIONS[kind].includes(extname(n).toLowerCase()))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    if (!names.length) throw new Error(`No ${EXTENSIONS[kind].join("/")} files in ${dir}.`);
    out.push(...names.map((n) => join(dir, n)));
  }
  if (!out.length) throw new Error("Pass files or a folder.");
  for (const f of out) {
    if (!existsSync(f) || !statSync(f).isFile()) throw new Error(`File not found: ${f}`);
  }
  return out;
}

const LOCALE_FOLDER = /^[a-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*$/i;

export interface MediaPlan {
  /** Same files for every chosen language. */
  shared?: string[];
  /** Folder-per-language mode: each language's own files, keyed by the subfolder name. */
  perLocale?: Map<string, string[]>;
}

/**
 * Reads the files to upload. A folder whose entries are language subfolders (en-US/, de-DE/, ...)
 * gives each language its own files; otherwise the files go to every chosen language.
 */
export function collectMedia(kind: MediaKind, files: string[] = [], folder?: string): MediaPlan {
  if (folder && !files.length) {
    const dir = safeUploadFolder(folder);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`Folder not found: ${dir}`);
    const entries = readdirSync(dir).filter((n) => !n.startsWith("."));
    const subfolders = entries.filter((n) => statSync(join(dir, n)).isDirectory());
    const media = entries.filter((n) => EXTENSIONS[kind].includes(extname(n).toLowerCase()));
    if (subfolders.length && media.length) {
      throw new Error(`${dir} mixes files and subfolders. Use either a folder of files, or one subfolder per language (en-US/, de-DE/, ...).`);
    }
    if (subfolders.length) {
      const bad = subfolders.filter((n) => !LOCALE_FOLDER.test(n));
      if (bad.length) throw new Error(`Subfolders must be named after languages, e.g. en-US or de-DE; these aren't: ${bad.join(", ")}.`);
      const perLocale = new Map<string, string[]>();
      for (const name of subfolders.sort()) perLocale.set(name, collectFiles(kind, [], join(dir, name)));
      return { perLocale };
    }
  }
  return { shared: collectFiles(kind, files, folder) };
}

/** How many files a localization's set of this type already holds (0 when there's no set yet). */
export async function countInSet(ctx: ToolContext, owner: Owner, localizationId: string, kind: MediaKind, setType: string): Promise<number> {
  return (await listSets(ctx, owner, localizationId, kind)).find((s) => s.type === setType)?.items.length ?? 0;
}

/**
 * Checks every screenshot against the display type. A size that belongs to a different device
 * is an error (the most common mistake); a size we don't know only warns, since Apple decides.
 * With no display type given, it is inferred from the first image when unambiguous.
 */
export function checkScreenshotSizes(files: string[], displayType?: string): { displayType: string; warnings: string[] } {
  const warnings: string[] = [];
  const sizes = files.map((f) => ({ f, size: imageSize(f) }));
  let type = displayType;
  if (!type) {
    const first = sizes[0].size;
    const candidates = first ? displayTypesForSize(first.width, first.height) : [];
    if (candidates.length !== 1) {
      const dims = first ? `${first.width}×${first.height}` : "an unreadable size";
      throw new Error(
        `Can't tell the device from ${dims}${candidates.length ? ` (matches ${candidates.join(", ")})` : ""}. Pass displayType, e.g. APP_IPHONE_67.`,
      );
    }
    type = candidates[0];
  }
  for (const { f, size } of sizes) {
    if (!size) {
      warnings.push(`Couldn't read the size of ${f}; Apple will check it.`);
      continue;
    }
    if (sizeMatches(type, size.width, size.height)) continue;
    const others = displayTypesForSize(size.width, size.height);
    if (others.length) {
      throw new Error(`${f} is ${size.width}×${size.height}, which is a ${others.join(" / ")} size, not ${type}. Pick the matching displayType.`);
    }
    warnings.push(`${f} is ${size.width}×${size.height}, not a size we know for ${type}; Apple may reject it.`);
  }
  return { displayType: type, warnings };
}

export interface VersionRef {
  appId?: string;
  versionId?: string;
  versionString?: string;
  platform?: string;
}

/** Finds the App Store version: by id, by version string, or the newest one on the platform. */
export async function resolveVersion(ctx: ToolContext, ref: VersionRef): Promise<{ id: string; versionString: string; platform: string; state?: string }> {
  if (ref.versionId) {
    const v = await runJson(ctx, "appStoreVersions_getInstance", {
      pathParams: { id: ref.versionId },
      query: { "fields[appStoreVersions]": ["versionString", "platform", "appVersionState"] },
    });
    return { id: v.data.id, versionString: v.data.attributes?.versionString, platform: v.data.attributes?.platform, state: v.data.attributes?.appVersionState };
  }
  if (!ref.appId) throw new Error("Pass appId (with an optional versionString), or versionId.");
  const res = await runJson(ctx, "apps_appStoreVersions_getToManyRelated", {
    pathParams: { id: ref.appId },
    query: {
      "filter[versionString]": ref.versionString,
      "filter[platform]": ref.platform,
      "fields[appStoreVersions]": ["versionString", "platform", "appVersionState", "createdDate"],
      limit: 50,
    },
  });
  const versions = (res.data ?? [])
    .map((v: any) => ({ id: v.id, ...v.attributes }))
    .sort((a: any, b: any) => String(b.createdDate ?? "").localeCompare(String(a.createdDate ?? "")));
  const platforms = [...new Set(versions.map((v: any) => v.platform))];
  if (!versions.length) throw new Error(`No App Store version found${ref.versionString ? ` for ${ref.versionString}` : ""}.`);
  if (!ref.platform && platforms.length > 1) throw new Error(`This app has versions on ${platforms.join(", ")}; pass platform.`);
  const v = versions[0];
  return { id: v.id, versionString: v.versionString, platform: v.platform, state: v.appVersionState };
}

/** Lists a version's localizations, optionally limited to some locales ("*" or none means all). */
export async function versionLocalizations(ctx: ToolContext, versionId: string, locales?: string[]): Promise<{ id: string; locale: string }[]> {
  const res = await runJson(ctx, "appStoreVersions_appStoreVersionLocalizations_getToManyRelated", {
    pathParams: { id: versionId },
    query: { "fields[appStoreVersionLocalizations]": ["locale"], limit: 200 },
  });
  const all: { id: string; locale: string }[] = (res.data ?? []).map((l: any) => ({ id: l.id, locale: l.attributes?.locale }));
  if (!locales?.length || locales.includes("*")) return all;
  const missing = locales.filter((loc) => !all.some((l) => l.locale.toLowerCase() === loc.toLowerCase()));
  if (missing.length) {
    throw new Error(`This version has no ${missing.join(", ")} localization. It has: ${all.map((l) => l.locale).join(", ")}. Add the language in App Store Connect first.`);
  }
  return all.filter((l) => locales.some((loc) => loc.toLowerCase() === l.locale.toLowerCase()));
}

export interface MediaSet {
  id: string;
  type: string;
  items: Record<string, unknown>[];
}

/** Lists a localization's screenshot or preview sets with their files, in order. */
export async function listSets(ctx: ToolContext, owner: Owner, localizationId: string, kind: MediaKind): Promise<MediaSet[]> {
  const k = KIND[kind];
  const res = await runJson(ctx, `${OWNERS[owner].listOp}_${k.setsRel}_getToManyRelated`, {
    pathParams: { id: localizationId },
    query: {
      include: k.itemType,
      [`fields[${k.setType}]`]: [k.typeAttr, k.itemType],
      [`fields[${k.itemType}]`]: [...k.itemFields],
      [`limit[${k.itemType}]`]: 50,
      limit: 50,
    },
  });
  const included = new Map<string, any>((res.included ?? []).map((r: any) => [`${r.type}:${r.id}`, r]));
  return (res.data ?? []).map((set: any) => ({
    id: set.id,
    type: set.attributes?.[k.typeAttr],
    items: (set.relationships?.[k.itemType]?.data ?? []).map((ref: any) => summarizeItem(included.get(`${ref.type}:${ref.id}`) ?? ref)),
  }));
}

function summarizeItem(r: any): Record<string, unknown> {
  const a = r.attributes ?? {};
  const out: Record<string, unknown> = { id: r.id };
  if (a.fileName) out.fileName = a.fileName;
  if (a.imageAsset?.width) out.size = `${a.imageAsset.width}×${a.imageAsset.height}`;
  if (a.previewFrameTimeCode) out.posterFrame = a.previewFrameTimeCode;
  const state = a.videoDeliveryState?.state ?? a.assetDeliveryState?.state;
  if (state) out.state = state;
  const problem = describeDelivery(a.videoDeliveryState) ?? describeDelivery(a.assetDeliveryState);
  if (problem) out.problem = problem;
  return out;
}

async function findOrCreateSet(ctx: ToolContext, owner: Owner, localizationId: string, kind: MediaKind, setType: string): Promise<MediaSet & { created?: boolean }> {
  const existing = (await listSets(ctx, owner, localizationId, kind)).find((s) => s.type === setType);
  if (existing) return existing;
  const k = KIND[kind];
  const o = OWNERS[owner];
  const created = await runJson(ctx, k.createSetOp, {
    body: {
      data: {
        type: k.setType,
        attributes: { [k.typeAttr]: setType },
        relationships: { [o.relationship]: { data: { type: o.type, id: localizationId } } },
      },
    },
  });
  return { id: created.data.id, type: setType, items: [], created: true };
}

/** Waits for a preview's video processing, which continues after the upload itself completes. */
async function waitForVideo(ctx: ToolContext, id: string, deadline: number): Promise<DeliveryState | undefined> {
  let state: DeliveryState | undefined;
  for (let attempt = 0; ; attempt++) {
    const res = await runJson(ctx, "appPreviews_getInstance", {
      pathParams: { id },
      query: { "fields[appPreviews]": ["videoDeliveryState", "assetDeliveryState"] },
    });
    state = res.data?.attributes?.videoDeliveryState ?? res.data?.attributes?.assetDeliveryState;
    if (!state?.state || ["COMPLETE", "FAILED"].includes(state.state) || Date.now() >= deadline) return state;
    await new Promise((r) => setTimeout(r, Math.min(3000 + attempt * 1000, 10000, Math.max(0, deadline - Date.now()))));
  }
}

export interface UploadToLocalizationInput {
  owner: Owner;
  localizationId: string;
  locale?: string;
  kind: MediaKind;
  setType: string;
  files: string[];
  replace?: boolean;
  waitSeconds: number;
  previewFrameTimeCode?: string;
  onFileDone?: (fileName: string) => void;
}

export interface FileOutcome {
  file: string;
  id?: string;
  state: "COMPLETE" | "FAILED" | "PROCESSING" | "ERROR";
  problem?: string;
}

/**
 * Uploads files into one set, then orders them. With replace, the old files are removed only
 * after every new file processed successfully, so a failed upload never empties the set.
 */
export async function uploadToLocalization(ctx: ToolContext, input: UploadToLocalizationInput) {
  const k = KIND[input.kind];
  const max = MAX_PER_SET[input.kind];
  const set = await findOrCreateSet(ctx, input.owner, input.localizationId, input.kind, input.setType);
  const existingIds = set.items.map((i) => i.id as string);
  const total = input.replace ? input.files.length : existingIds.length + input.files.length;
  if (total > max) {
    throw new Error(
      `${input.locale ?? input.localizationId}: a ${input.setType} set holds at most ${max} ${input.kind}; ` +
        `it has ${existingIds.length} and you're adding ${input.files.length}. Use replace, or remove some first.`,
    );
  }
  const deadline = Date.now() + input.waitSeconds * 1000;
  const outcomes: FileOutcome[] = [];
  for (const file of input.files) {
    try {
      const attributes: Record<string, unknown> = {};
      if (input.kind === "previews") {
        attributes.mimeType = VIDEO_MIME[extname(file).toLowerCase()];
        if (input.previewFrameTimeCode) attributes.previewFrameTimeCode = input.previewFrameTimeCode;
      }
      const remaining = Math.max(0, Math.round((deadline - Date.now()) / 1000));
      const r: UploadResult = await uploadAsset(ctx.catalog, ctx.client, {
        createOperationId: k.createItemOp,
        filePath: file,
        relationshipId: set.id,
        attributes,
        waitSeconds: remaining,
      });
      let state = r.deliveryState;
      if (input.kind === "previews" && state?.state === "COMPLETE") state = (await waitForVideo(ctx, r.id, deadline)) ?? state;
      const s = state?.state;
      outcomes.push({
        file,
        id: r.id,
        state: s === "COMPLETE" ? "COMPLETE" : s === "FAILED" ? "FAILED" : "PROCESSING",
        ...(describeDelivery(state) ? { problem: describeDelivery(state) } : {}),
      });
    } catch (err) {
      outcomes.push({ file, state: "ERROR", problem: (err as Error).message });
    }
    input.onFileDone?.(file);
  }

  const uploaded = outcomes.filter((o) => o.id).map((o) => o.id!);
  const allGood = outcomes.every((o) => o.state === "COMPLETE");
  const notes: string[] = [];
  let removed = 0;
  if (input.replace && existingIds.length) {
    if (allGood) {
      for (const id of existingIds) {
        await runOperation(ctx, k.deleteItemOp, { pathParams: { id } });
        removed++;
      }
    } else {
      notes.push("Kept the existing files because not every new file finished processing; remove them once the new ones are COMPLETE.");
    }
  }
  // Apple's reorder replaces the whole list, so build it from what the set holds now:
  // kept files first, then the new ones in the order given, then anything else.
  const current = ((await listSets(ctx, input.owner, input.localizationId, input.kind)).find((s) => s.id === set.id)?.items ?? []).map(
    (i) => i.id as string,
  );
  const wanted = [...existingIds, ...uploaded].filter((id) => current.includes(id));
  const order = [...wanted, ...current.filter((id) => !wanted.includes(id))];
  if (order.length) {
    await runOperation(ctx, k.reorderOp, {
      pathParams: { id: set.id },
      body: { data: order.map((id) => ({ type: k.itemType, id })) },
    });
  }
  if (outcomes.some((o) => o.state === "FAILED" || o.state === "ERROR")) {
    notes.push("Some files failed; see each file's problem. Failed files stay in the set until removed.");
  }
  if (outcomes.some((o) => o.state === "PROCESSING")) {
    notes.push("Some files are still processing at Apple; check later with asc_list_media.");
  }
  return {
    locale: input.locale,
    set: { id: set.id, type: input.setType, ...(set.created ? { created: true } : {}) },
    files: outcomes.map((o) => ({ ...o, file: o.file.split("/").pop() })),
    ...(removed ? { removedOld: removed } : {}),
    order: order.length,
    ...(notes.length ? { notes } : {}),
  };
}

