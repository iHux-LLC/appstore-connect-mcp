import type { Mode } from "./config.js";

/** Areas the user can fine-tune on the settings page. "core" tools are always available. */
export type Area = "testflight" | "listing" | "release" | "reviews" | "sales" | "analytics" | "api";
export type Level = "off" | "read" | "write";
export type Access = Partial<Record<Area, Level>>;

export const LEVELS: Level[] = ["off", "read", "write"];

export const AREAS: { id: Area; name: string; description: string }[] = [
  { id: "testflight", name: "TestFlight & builds", description: "See builds and beta groups; invite testers and hand out builds." },
  { id: "listing", name: "Store listing & media", description: "Descriptions, keywords, name and subtitle, screenshots and preview videos." },
  { id: "release", name: "Versions, review & release", description: "Create versions, attach builds, submit for review, release and phased release." },
  { id: "reviews", name: "Customer reviews", description: "Read App Store reviews and post replies." },
  { id: "sales", name: "Sales & finance", description: "Sales, subscription and finance reports, including proceeds." },
  { id: "analytics", name: "Analytics", description: "Impressions, downloads, sessions and crash reports; turning analytics on." },
  { id: "api", name: "Full API access", description: "Search and call any of Apple's 1,300+ operations directly, and upload any asset. Reaches every area." },
];

/**
 * Every tool's area, and whether it only reads ("read") or changes things ("write").
 * A test checks that each registered tool appears here, so a new tool can't skip the permissions.
 */
export const TOOL_AREAS: Record<string, { area: Area | "core"; kind: "read" | "write" }> = {
  asc_check_connection: { area: "core", kind: "read" },
  asc_list_apps: { area: "core", kind: "read" },
  asc_app_overview: { area: "core", kind: "read" },
  asc_open_settings: { area: "core", kind: "read" },

  asc_list_builds: { area: "testflight", kind: "read" },
  asc_list_beta_groups: { area: "testflight", kind: "read" },
  asc_invite_beta_tester: { area: "testflight", kind: "write" },
  asc_distribute_build: { area: "testflight", kind: "write" },

  asc_list_version_localizations: { area: "listing", kind: "read" },
  asc_list_app_info: { area: "listing", kind: "read" },
  asc_list_media: { area: "listing", kind: "read" },
  asc_update_version_localization: { area: "listing", kind: "write" },
  asc_update_app_info: { area: "listing", kind: "write" },
  asc_upload_screenshots: { area: "listing", kind: "write" },
  asc_upload_previews: { area: "listing", kind: "write" },

  asc_create_app_store_version: { area: "release", kind: "write" },
  asc_attach_build_to_version: { area: "release", kind: "write" },
  asc_submit_for_review: { area: "release", kind: "write" },
  asc_release_version: { area: "release", kind: "write" },
  asc_phased_release: { area: "release", kind: "write" },

  asc_list_customer_reviews: { area: "reviews", kind: "read" },
  asc_reply_to_customer_review: { area: "reviews", kind: "write" },

  asc_download_sales_report: { area: "sales", kind: "read" },
  asc_download_finance_report: { area: "sales", kind: "read" },

  asc_list_analytics_reports: { area: "analytics", kind: "read" },
  asc_download_analytics_report: { area: "analytics", kind: "read" },
  asc_analytics_setup: { area: "analytics", kind: "write" },

  asc_list_resource_groups: { area: "api", kind: "read" },
  asc_search_operations: { area: "api", kind: "read" },
  asc_describe_operation: { area: "api", kind: "read" },
  asc_call_operation: { area: "api", kind: "read" },
  asc_fetch_url: { area: "api", kind: "read" },
  asc_upload_asset: { area: "api", kind: "write" },
};

/** Whether an area has any tools that write (Sales & finance has none). */
export function areaHasWrites(area: Area): boolean {
  return Object.values(TOOL_AREAS).some((t) => t.area === area && t.kind === "write");
}

/**
 * The level an area actually gets: the user's choice for it (default: as much as the mode
 * allows), capped by the overall mode, since read-only mode never writes.
 */
export function effectiveLevel(area: Area, mode: Mode, access: Access = {}): Level {
  const chosen = access[area] ?? "write";
  if (chosen === "off") return "off";
  if (chosen === "write" && mode !== "readonly" && areaHasWrites(area)) return "write";
  return "read";
}

export function toolAllowed(tool: string, mode: Mode, access: Access = {}): boolean {
  const entry = TOOL_AREAS[tool];
  if (!entry) return false;
  if (entry.area === "core") return true;
  const level = effectiveLevel(entry.area, mode, access);
  return level === "write" || (level === "read" && entry.kind === "read");
}

/** Validates an access map read from the settings file. */
export function parseAccess(raw: unknown): Access {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("access in the settings file must be an object.");
  const out: Access = {};
  for (const [area, level] of Object.entries(raw as Record<string, unknown>)) {
    if (!AREAS.some((a) => a.id === area)) throw new Error(`Unknown area "${area}" in the settings file's access.`);
    if (!LEVELS.includes(level as Level)) throw new Error(`access.${area} must be one of ${LEVELS.join(", ")}.`);
    out[area as Area] = level as Level;
  }
  return out;
}
