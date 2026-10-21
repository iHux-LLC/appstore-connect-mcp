import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { parseAccess, type Access } from "./permissions.js";
import { readStored, type StoredSettings } from "./settings/store.js";
import { NPX_COMMAND } from "./version.js";

export type Mode = "readonly" | "write" | "full";
export type Source = "env" | "settings";

export interface Config {
  keyId?: string;
  issuerId?: string;
  privateKeyPath?: string;
  privateKeyInline?: string;
  mode: Mode;
  /** Per-area levels from the settings page; missing areas follow the mode. */
  access: Access;
  maxResponseChars: number;
  /** Where each value came from, so status output can explain what overrides what. */
  sources: { keyId?: Source; issuerId?: Source; privateKey?: Source; mode?: Source };
}

export class ConfigError extends Error {}

export const MODES: Mode[] = ["readonly", "write", "full"];

export function parseMode(raw: string, origin: string): Mode {
  const mode = raw.trim().toLowerCase();
  if (!MODES.includes(mode as Mode)) throw new ConfigError(`${origin} must be one of ${MODES.join(", ")} (got "${raw}").`);
  return mode as Mode;
}

/** Environment variables win over the settings file, field by field. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, stored: StoredSettings = readStored(env)): Config {
  const sources: Config["sources"] = {};
  const pick = <T>(field: keyof Config["sources"], fromEnv: T | undefined, fromFile: T | undefined): T | undefined => {
    if (fromEnv !== undefined) sources[field] = "env";
    else if (fromFile !== undefined) sources[field] = "settings";
    return fromEnv ?? fromFile;
  };
  const envMode = env.ASC_MODE?.trim() ? parseMode(env.ASC_MODE, "ASC_MODE") : undefined;
  const fileMode = stored.mode ? parseMode(stored.mode, "mode in the settings file") : undefined;
  const envInline = env.ASC_PRIVATE_KEY || undefined;
  const envPath = env.ASC_PRIVATE_KEY_PATH?.trim() || undefined;
  const maxChars = Number(env.ASC_MAX_RESPONSE_CHARS ?? 60000);
  const config: Config = {
    keyId: pick("keyId", env.ASC_KEY_ID?.trim() || undefined, stored.keyId),
    issuerId: pick("issuerId", env.ASC_ISSUER_ID?.trim() || undefined, stored.issuerId),
    privateKeyInline: envInline,
    privateKeyPath: envInline ? undefined : pick("privateKey", envPath, stored.privateKeyPath),
    mode: pick("mode", envMode, fileMode) ?? "readonly",
    access: parseAccess(stored.access),
    maxResponseChars: Number.isFinite(maxChars) && maxChars > 1000 ? maxChars : 60000,
    sources,
  };
  if (envInline) sources.privateKey = "env";
  return config;
}

const SETUP_HINT =
  `Ask Claude to open the App Store Connect settings, or run \`${NPX_COMMAND} settings\`, to add your API key. ` +
  "Create a key at App Store Connect > Users and Access > Integrations > App Store Connect API.";

export function readPrivateKey(config: Config): string {
  let pem: string;
  if (config.privateKeyInline) {
    // Env vars often carry the PEM with literal "\n" sequences.
    pem = config.privateKeyInline.replace(/\\n/g, "\n");
  } else if (config.privateKeyPath) {
    const path = config.privateKeyPath.replace(/^~(?=$|\/)/, homedir());
    try {
      pem = readFileSync(path, "utf8");
    } catch (err) {
      throw new ConfigError(`Could not read ASC_PRIVATE_KEY_PATH "${path}": ${(err as Error).message}`);
    }
  } else {
    throw new ConfigError(`No private key configured. ${SETUP_HINT}`);
  }
  if (!pem.includes("BEGIN PRIVATE KEY")) {
    throw new ConfigError("The private key is not a PKCS#8 PEM (expected the contents of an AuthKey_XXXX.p8 file).");
  }
  return pem;
}

export function requireCredentials(config: Config): { keyId: string; issuerId: string } {
  const missing = [!config.keyId && "ASC_KEY_ID", !config.issuerId && "ASC_ISSUER_ID"].filter(Boolean);
  if (missing.length) throw new ConfigError(`Missing ${missing.join(" and ")}. ${SETUP_HINT}`);
  return { keyId: config.keyId!, issuerId: config.issuerId! };
}

export function methodAllowed(method: string, mode: Mode): boolean {
  const m = method.toUpperCase();
  if (m === "GET") return true;
  if (m === "DELETE") return mode === "full";
  return mode === "write" || mode === "full";
}

export function assertMethodAllowed(method: string, mode: Mode): void {
  if (methodAllowed(method, mode)) return;
  const needed = method.toUpperCase() === "DELETE" ? "full" : "write";
  throw new ConfigError(
    `${method.toUpperCase()} requests are blocked because the access mode is "${mode}". ` +
      `To allow them, switch the mode to "${needed}" in the settings page (asc_open_settings, or run \`${NPX_COMMAND} mode ${needed}\`). Only the user can change this.`,
  );
}
