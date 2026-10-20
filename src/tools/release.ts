import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveVersion } from "../media.js";
import { flat, runJson, runOperation, safe, text, type ToolContext } from "./context.js";

const PLATFORMS = ["IOS", "MAC_OS", "TV_OS", "VISION_OS"] as const;
// App info (name, subtitle, privacy URLs) can only change while a new version is being prepared.
const EDITABLE_APP_INFO = ["PREPARE_FOR_SUBMISSION", "DEVELOPER_REJECTED", "REJECTED", "METADATA_REJECTED", "WAITING_FOR_REVIEW", "INVALID_BINARY"];

const versionShape = {
  appId: z.string().optional().describe("App id from asc_list_apps"),
  versionString: z.string().optional().describe("e.g. 2.4.0; defaults to the newest version"),
  versionId: z.string().optional().describe("appStoreVersion id, instead of appId + versionString"),
  platform: z.enum(PLATFORMS).optional().describe("Needed only when the app ships on several platforms"),
};

async function appInfos(ctx: ToolContext, appId: string) {
  const res = await runJson(ctx, "apps_appInfos_getToManyRelated", {
    pathParams: { id: appId },
    query: {
      "fields[appInfos]": ["state", "appStoreState", "appInfoLocalizations"],
      include: "appInfoLocalizations",
      "fields[appInfoLocalizations]": ["locale", "name", "subtitle", "privacyPolicyUrl", "privacyChoicesUrl"],
      "limit[appInfoLocalizations]": 50,
      limit: 10,
    },
  });
  const included = new Map<string, any>((res.included ?? []).map((r: any) => [`${r.type}:${r.id}`, r]));
  return (res.data ?? []).map((info: any) => {
    const state = info.attributes?.state ?? info.attributes?.appStoreState;
    return {
      appInfoId: info.id,
      state,
      editable: EDITABLE_APP_INFO.includes(state),
      localizations: (info.relationships?.appInfoLocalizations?.data ?? []).map((ref: any) => flat(included.get(`${ref.type}:${ref.id}`) ?? ref)),
    };
  });
}

/** Read-only release information. */
export function registerReleaseReadTools(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "asc_list_app_info",
    {
      title: "List app name and subtitle",
      description:
        "Show the app-level store details per language: name, subtitle, privacy policy and privacy choices URLs. Lists both the live app info and the one being edited for the next version, and says which can be changed.",
      inputSchema: { appId: z.string() },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async ({ appId }) => text({ appInfos: await appInfos(ctx, appId) })),
  );
}

/** Release and distribution shortcuts. They are disabled (hidden) in read-only mode. */
export function registerReleaseWriteTools(server: McpServer, ctx: ToolContext): RegisteredTool[] {
  const tools: RegisteredTool[] = [];

  tools.push(
    server.registerTool(
      "asc_release_version",
      {
        title: "Release an approved version",
        description:
          "Release an App Store version that Apple approved and that is waiting for a manual release (Pending Developer Release). " +
          "This publishes it to customers and can't be undone: confirm with the user first.",
        inputSchema: versionShape,
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      },
      safe(async (args: any) => {
        const version = await resolveVersion(ctx, args);
        if (version.state !== "PENDING_DEVELOPER_RELEASE") {
          throw new Error(
            `Version ${version.versionString} (${version.platform}) is ${version.state ?? "in an unknown state"}; only a version in PENDING_DEVELOPER_RELEASE can be released manually.`,
          );
        }
        const res = await runJson(ctx, "appStoreVersionReleaseRequests_createInstance", {
          body: {
            data: {
              type: "appStoreVersionReleaseRequests",
              relationships: { appStoreVersion: { data: { type: "appStoreVersions", id: version.id } } },
            },
          },
        });
        return text({ released: true, version: { versionString: version.versionString, platform: version.platform }, releaseRequestId: res.data?.id });
      }),
    ),
  );

  const PHASED_STATE = { pause: "PAUSED", resume: "ACTIVE", complete: "COMPLETE" } as const;
  tools.push(
    server.registerTool(
      "asc_phased_release",
      {
        title: "Manage a phased release",
        description:
          "Control the 7-day phased release of an App Store version: enable it before the version is released, then pause, resume, or complete it (complete releases to everyone at once). " +
          "Use status to see the current day and state. disable removes it before release and needs the full access mode.",
        inputSchema: {
          ...versionShape,
          action: z.enum(["status", "enable", "pause", "resume", "complete", "disable"]),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      },
      safe(async (args: any) => {
        const version = await resolveVersion(ctx, args);
        const current = await runJson(ctx, "appStoreVersions_appStoreVersionPhasedRelease_getToOneRelated", {
          pathParams: { id: version.id },
          query: { "fields[appStoreVersionPhasedReleases]": ["phasedReleaseState", "startDate", "currentDayNumber", "totalPauseDuration"] },
        }).catch((err) => {
          // Apple answers 404 when the version has no phased release.
          if ((err as any).status === 404) return { data: null };
          throw err;
        });
        const phased = current.data ? flat(current.data) : undefined;
        const about = { versionString: version.versionString, platform: version.platform, versionState: version.state };

        if (args.action === "status") return text({ version: about, phasedRelease: phased ?? null });
        if (args.action === "enable") {
          if (phased) return text({ version: about, phasedRelease: phased, note: "A phased release is already set up." });
          const res = await runJson(ctx, "appStoreVersionPhasedReleases_createInstance", {
            body: {
              data: {
                type: "appStoreVersionPhasedReleases",
                attributes: { phasedReleaseState: "INACTIVE" },
                relationships: { appStoreVersion: { data: { type: "appStoreVersions", id: version.id } } },
              },
            },
          });
          return text({ version: about, phasedRelease: flat(res.data), note: "It starts on day 1 when the version is released." });
        }
        if (!phased) throw new Error(`Version ${version.versionString} has no phased release. Use action "enable" first.`);
        if (args.action === "disable") {
          await runOperation(ctx, "appStoreVersionPhasedReleases_deleteInstance", { pathParams: { id: phased.id as string } });
          return text({ version: about, phasedRelease: null, note: "Phased release removed; the version will release to everyone at once." });
        }
        const state = PHASED_STATE[args.action as keyof typeof PHASED_STATE];
        const res = await runJson(ctx, "appStoreVersionPhasedReleases_updateInstance", {
          pathParams: { id: phased.id as string },
          body: { data: { type: "appStoreVersionPhasedReleases", id: phased.id, attributes: { phasedReleaseState: state } } },
        });
        return text({ version: about, phasedRelease: flat(res.data) });
      }),
    ),
  );

  tools.push(
    server.registerTool(
      "asc_distribute_build",
      {
        title: "Distribute a TestFlight build",
        description:
          "Give a build to TestFlight groups. Optionally set the \"What to Test\" notes per language and submit the build for beta review, which external groups need before their testers get it. " +
          "Get build ids from asc_list_builds and group ids from asc_list_beta_groups.",
        inputSchema: {
          buildId: z.string(),
          betaGroupIds: z.array(z.string()).optional().describe("Groups to add the build to"),
          whatToTest: z
            .record(z.string(), z.string().max(4000))
            .optional()
            .describe("Notes per locale, e.g. {\"en-US\": \"Try the new export button\"}"),
          submitForBetaReview: z.boolean().optional().describe("Submit for beta review if it hasn't been yet (needed for external groups)"),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      },
      safe(async ({ buildId, betaGroupIds, whatToTest, submitForBetaReview }: any) => {
        if (!betaGroupIds?.length && !whatToTest && !submitForBetaReview) {
          throw new Error("Pass betaGroupIds, whatToTest and/or submitForBetaReview.");
        }
        const result: Record<string, unknown> = { buildId };

        // Notes first: beta review reads them.
        if (whatToTest) {
          const existing = await runJson(ctx, "builds_betaBuildLocalizations_getToManyRelated", {
            pathParams: { id: buildId },
            query: { "fields[betaBuildLocalizations]": ["locale", "whatsNew"], limit: 50 },
          });
          const byLocale = new Map<string, string>((existing.data ?? []).map((l: any) => [String(l.attributes?.locale).toLowerCase(), l.id]));
          const notes: string[] = [];
          for (const [locale, whatsNew] of Object.entries<string>(whatToTest)) {
            const id = byLocale.get(locale.toLowerCase());
            if (id) {
              await runJson(ctx, "betaBuildLocalizations_updateInstance", {
                pathParams: { id },
                body: { data: { type: "betaBuildLocalizations", id, attributes: { whatsNew } } },
              });
            } else {
              await runJson(ctx, "betaBuildLocalizations_createInstance", {
                body: {
                  data: {
                    type: "betaBuildLocalizations",
                    attributes: { locale, whatsNew },
                    relationships: { build: { data: { type: "builds", id: buildId } } },
                  },
                },
              });
            }
            notes.push(locale);
          }
          result.whatToTest = notes;
        }

        if (submitForBetaReview) {
          const existing = await runJson(ctx, "betaAppReviewSubmissions_getCollection", {
            query: { "filter[build]": buildId, "fields[betaAppReviewSubmissions]": ["betaReviewState", "submittedDate"], limit: 1 },
          });
          if (existing.data?.length) {
            result.betaReview = { ...flat(existing.data[0]), note: "Already submitted" };
          } else {
            const res = await runJson(ctx, "betaAppReviewSubmissions_createInstance", {
              body: { data: { type: "betaAppReviewSubmissions", relationships: { build: { data: { type: "builds", id: buildId } } } } },
            });
            result.betaReview = flat(res.data);
          }
        }

        if (betaGroupIds?.length) {
          for (const groupId of betaGroupIds) {
            await runOperation(ctx, "betaGroups_builds_createToManyRelationship", {
              pathParams: { id: groupId },
              body: { data: [{ type: "builds", id: buildId }] },
            });
          }
          result.addedToGroups = betaGroupIds;
        }
        return text(result);
      }),
    ),
  );

  tools.push(
    server.registerTool(
      "asc_update_app_info",
      {
        title: "Update app name and subtitle",
        description:
          "Change the app's name, subtitle or privacy URLs for one language. Edits the app info being prepared for the next version; changes go live when that version is released. " +
          "Fails clearly if no version is being prepared. See current values with asc_list_app_info.",
        inputSchema: {
          appId: z.string(),
          locale: z.string().describe("e.g. en-US"),
          name: z.string().min(2).max(30).optional(),
          subtitle: z.string().max(30).optional(),
          privacyPolicyUrl: z.string().url().optional(),
          privacyChoicesUrl: z.string().url().optional(),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      },
      safe(async ({ appId, locale, ...fields }: any) => {
        const attributes = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
        if (!Object.keys(attributes).length) throw new Error("Pass at least one of name, subtitle, privacyPolicyUrl, privacyChoicesUrl.");
        const infos = await appInfos(ctx, appId);
        const editable = infos.find((i: any) => i.editable);
        if (!editable) {
          throw new Error(
            `No app info can be edited right now (states: ${infos.map((i: any) => i.state).join(", ")}). ` +
              "Create a new App Store version first (asc_create_app_store_version); its app info becomes editable.",
          );
        }
        const loc = editable.localizations.find((l: any) => String(l.locale).toLowerCase() === locale.toLowerCase());
        if (!loc) {
          throw new Error(`No ${locale} localization. Available: ${editable.localizations.map((l: any) => l.locale).join(", ")}.`);
        }
        const res = await runJson(ctx, "appInfoLocalizations_updateInstance", {
          pathParams: { id: loc.id },
          body: { data: { type: "appInfoLocalizations", id: loc.id, attributes } },
        });
        return text({ appInfoId: editable.appInfoId, localization: flat(res.data) });
      }),
    ),
  );

  return tools;
}
