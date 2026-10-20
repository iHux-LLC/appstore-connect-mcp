import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  checkScreenshotSizes,
  collectMedia,
  countInSet,
  listSets,
  MAX_PER_SET,
  type MediaPlan,
  resolveVersion,
  uploadToLocalization,
  versionLocalizations,
  type MediaKind,
  type Owner,
} from "../media.js";
import { mapLimit } from "../upload.js";
import { safe, text, type ToolContext } from "./context.js";

const PLATFORMS = ["IOS", "MAC_OS", "TV_OS", "VISION_OS"] as const;
// App Store versions in these states accept media changes.
const EDITABLE = ["PREPARE_FOR_SUBMISSION", "DEVELOPER_REJECTED", "REJECTED", "METADATA_REJECTED", "INVALID_BINARY"];

const versionShape = {
  appId: z.string().optional().describe("App id from asc_list_apps"),
  versionString: z.string().optional().describe("e.g. 2.4.0; defaults to the newest version"),
  versionId: z.string().optional().describe("appStoreVersion id, instead of appId + versionString"),
  platform: z.enum(PLATFORMS).optional().describe("Needed only when the app ships on several platforms"),
};

const targetShape = {
  target: z
    .enum(["version", "customProductPage", "experimentTreatment"])
    .optional()
    .describe("Where the media goes: the version's product page (default), a custom product page, or a product page optimization treatment"),
  localizationIds: z
    .array(z.string())
    .optional()
    .describe("For customProductPage / experimentTreatment: the localization ids to update (find them with asc_search_operations)"),
};

type Progress = { _meta?: { progressToken?: string | number }; sendNotification: (n: any) => Promise<void> };

function progressReporter(extra: Progress, total: number) {
  let done = 0;
  const token = extra?._meta?.progressToken;
  return (message: string) => {
    done++;
    if (token === undefined) return;
    // Progress also keeps clients that reset their timeout on progress from giving up on long videos.
    extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: done, total, message } }).catch(() => undefined);
  };
}

interface Targets {
  owner: Owner;
  version?: Awaited<ReturnType<typeof resolveVersion>>;
  localizations: { id: string; locale?: string }[];
}

async function resolveTargets(ctx: ToolContext, args: any, forWrite: boolean): Promise<Targets> {
  const owner: Owner = args.target ?? "version";
  if (owner !== "version") {
    if (!args.localizationIds?.length) throw new Error(`Pass localizationIds for target ${owner}.`);
    return { owner, localizations: args.localizationIds.map((id: string) => ({ id })) };
  }
  const version = await resolveVersion(ctx, args);
  if (forWrite && version.state && !EDITABLE.includes(version.state)) {
    throw new Error(
      `Version ${version.versionString} (${version.platform}) is ${version.state}, so its media can't change. ` +
        "Create a new version first (asc_create_app_store_version), or pass the versionString of an editable one.",
    );
  }
  if (forWrite && !args.locales?.length) {
    const all = await versionLocalizations(ctx, version.id);
    throw new Error(`Pass locales, e.g. ["en-US"], or ["*"] for every language. This version has: ${all.map((l) => l.locale).join(", ")}.`);
  }
  return { owner, version, localizations: await versionLocalizations(ctx, version.id, args.locales) };
}

function enumFrom(ctx: ToolContext, schema: string, attr: string): [string, ...string[]] {
  return ctx.catalog.bodySchema(schema).properties.data.properties.attributes.properties[attr].enum;
}

export function registerMediaTools(server: McpServer, ctx: ToolContext): RegisteredTool[] {
  const displayTypes = enumFrom(ctx, "AppScreenshotSetCreateRequest", "screenshotDisplayType");
  const previewTypes = enumFrom(ctx, "AppPreviewSetCreateRequest", "previewType");

  server.registerTool(
    "asc_list_media",
    {
      title: "List screenshots and app previews",
      description:
        "Show the screenshots and app preview videos of an App Store version, per language and device size: file names in display order, sizes, and Apple's processing state or errors. Use it before and after uploading.",
      inputSchema: {
        ...versionShape,
        ...targetShape,
        locales: z.array(z.string()).optional().describe("Only these locales, e.g. [\"en-US\", \"de-DE\"]; default all"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async (args: any) => {
      const t = await resolveTargets(ctx, args, false);
      const localizations = await mapLimit(t.localizations, 4, async (loc) => {
        const [shots, previews] = await Promise.all([listSets(ctx, t.owner, loc.id, "screenshots"), listSets(ctx, t.owner, loc.id, "previews")]);
        const shape = (sets: typeof shots) => sets.map((s) => ({ setId: s.id, type: s.type, count: s.items.length, items: s.items }));
        return { locale: loc.locale, localizationId: loc.id, screenshotSets: shape(shots), previewSets: shape(previews) };
      });
      return text({
        ...(t.version ? { version: t.version } : {}),
        localizations,
      });
    }),
  );

  const writeAnnotations = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };

  /**
   * Uploads a plan: the same files to every chosen language, or each language's own files.
   * Every check (languages, per-set limits) runs before the first upload, so a problem in one
   * language never leaves the others half done.
   */
  const upload = async (kind: MediaKind, args: any, extra: Progress, setType: string, warnings: string[], plan: MediaPlan) => {
    if (args.replace && ctx.config.mode !== "full") {
      throw new Error(
        'replace removes the current files, which needs the "full" access mode (the user can switch it in the settings page). ' +
          "Without replace, new files are added after the existing ones.",
      );
    }
    if (plan.perLocale && args.locales?.length) {
      throw new Error("The folder has a subfolder per language, which already says where each file goes; don't pass locales as well.");
    }
    const t = await resolveTargets(ctx, plan.perLocale ? { ...args, locales: [...plan.perLocale.keys()] } : args, true);
    const filesFor = (locale?: string): string[] => {
      if (!plan.perLocale) return plan.shared!;
      const key = [...plan.perLocale.keys()].find((k) => k.toLowerCase() === String(locale).toLowerCase());
      return key ? plan.perLocale.get(key)! : [];
    };

    const max = MAX_PER_SET[kind];
    const tooMany: string[] = [];
    for (const loc of t.localizations) {
      const adding = filesFor(loc.locale).length;
      const existing = args.replace ? 0 : await countInSet(ctx, t.owner, loc.id, kind, setType);
      if (existing + adding > max) tooMany.push(`${loc.locale ?? loc.id} has ${existing} and you're adding ${adding}`);
    }
    if (tooMany.length) {
      throw new Error(`A ${setType} set holds at most ${max} ${kind}: ${tooMany.join("; ")}. Nothing was uploaded. Use replace, or remove some first.`);
    }

    const total = t.localizations.reduce((n, loc) => n + filesFor(loc.locale).length, 0);
    const report = progressReporter(extra, total);
    const results = [];
    // One language at a time keeps well inside Apple's rate limit.
    for (const loc of t.localizations) {
      results.push(
        await uploadToLocalization(ctx, {
          owner: t.owner,
          localizationId: loc.id,
          locale: loc.locale,
          kind,
          setType,
          files: filesFor(loc.locale),
          replace: args.replace,
          waitSeconds: args.waitSeconds ?? (kind === "previews" ? 120 : 60),
          previewFrameTimeCode: args.previewFrameTimeCode,
          onFileDone: (f) => report(`${loc.locale ?? loc.id}: ${f.split("/").pop()}`),
        }),
      );
    }
    return text({
      ...(t.version ? { version: { versionString: t.version.versionString, platform: t.version.platform } } : {}),
      [kind === "screenshots" ? "displayType" : "previewType"]: setType,
      ...(plan.perLocale ? { mode: "folder per language" } : {}),
      ...(warnings.length ? { warnings } : {}),
      results,
    });
  };

  const screenshots = server.registerTool(
    "asc_upload_screenshots",
    {
      title: "Upload App Store screenshots",
      description:
        "Upload screenshots for one device size to one or more languages of an App Store version (or a custom product page / experiment). " +
        "Finds or creates the screenshot set, uploads in order, waits for Apple's processing, and keeps the files in the order given. " +
        "Pass files, or a folder (files are taken in name order). A folder with one subfolder per language (en-US/, de-DE/, ...) uploads each language's own screenshots in one call, without locales. " +
        "The device size is detected from the images when displayType is omitted. " +
        "By default files are added after existing ones; replace swaps them out only after every new file processed (needs full mode). Up to 10 per set.",
      inputSchema: {
        ...versionShape,
        ...targetShape,
        locales: z.array(z.string()).optional().describe("Languages to update, e.g. [\"en-US\"], or [\"*\"] for all"),
        displayType: z.enum(displayTypes).optional().describe("Device size, e.g. APP_IPHONE_67 (6.9\" iPhone) or APP_IPAD_PRO_3GEN_129 (13\" iPad); detected from the images if omitted"),
        files: z.array(z.string()).optional().describe("Absolute paths to .png/.jpg files, in display order"),
        folder: z.string().optional().describe("A folder of screenshots in file-name order, or a folder of language subfolders (en-US/, de-DE/) for localized screenshots"),
        replace: z.boolean().optional().describe("Replace the set's current screenshots instead of adding to them"),
        waitSeconds: z.number().int().min(0).max(600).optional().describe("How long to wait for Apple's processing per language (default 60)"),
      },
      annotations: writeAnnotations,
    },
    safe(async (args: any, extra: Progress) => {
      const plan = collectMedia("screenshots", args.files, args.folder);
      // Every language's images must fit the one device size; the first group decides it when not given.
      let displayType: string | undefined = args.displayType;
      const warnings: string[] = [];
      for (const files of plan.perLocale ? plan.perLocale.values() : [plan.shared!]) {
        const checked = checkScreenshotSizes(files, displayType);
        displayType = checked.displayType;
        warnings.push(...checked.warnings);
      }
      return upload("screenshots", args, extra, displayType!, warnings, plan);
    }),
  );

  const previews = server.registerTool(
    "asc_upload_previews",
    {
      title: "Upload App Store preview videos",
      description:
        "Upload app preview videos (.mov/.m4v/.mp4, up to 3 per set) for one device size to one or more languages of an App Store version (or a custom product page / experiment). " +
        "A folder with one subfolder per language uploads each language's own videos. " +
        "Finds or creates the preview set, uploads, waits for Apple's video processing up to waitSeconds, and keeps the order given. " +
        "Videos can take several minutes to process; anything unfinished is reported as PROCESSING and can be checked later with asc_list_media.",
      inputSchema: {
        ...versionShape,
        ...targetShape,
        locales: z.array(z.string()).optional().describe("Languages to update, e.g. [\"en-US\"], or [\"*\"] for all"),
        previewType: z.enum(previewTypes).describe("Device size, e.g. IPHONE_67 or IPAD_PRO_3GEN_129"),
        files: z.array(z.string()).optional().describe("Absolute paths to the videos, in display order"),
        folder: z.string().optional().describe("A folder of videos in file-name order, or a folder of language subfolders (en-US/, de-DE/)"),
        previewFrameTimeCode: z
          .string()
          .regex(/^\d{2}:\d{2}:\d{2}:\d{2}$/)
          .optional()
          .describe("Poster frame as HH:MM:SS:FF, e.g. 00:00:05:00"),
        replace: z.boolean().optional().describe("Replace the set's current previews instead of adding to them"),
        waitSeconds: z.number().int().min(0).max(900).optional().describe("How long to wait for video processing per language (default 120)"),
      },
      annotations: writeAnnotations,
    },
    safe(async (args: any, extra: Progress) => {
      return upload("previews", args, extra, args.previewType, [], collectMedia("previews", args.files, args.folder));
    }),
  );

  return [screenshots, previews];
}
