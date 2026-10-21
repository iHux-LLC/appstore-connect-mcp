import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import type { Mode } from "../config.js";
import type { Access } from "../permissions.js";

/** What the settings file holds. Secrets live in the key file it points to, never in client configs. */
export interface StoredSettings {
  keyId?: string;
  issuerId?: string;
  privateKeyPath?: string;
  mode?: Mode;
  /** Per-area levels; an area that isn't listed follows the mode. */
  access?: Access;
}

export function settingsDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.ASC_CONFIG_DIR) return env.ASC_CONFIG_DIR;
  if (platform() === "win32" && env.APPDATA) return join(env.APPDATA, "appstore-connect-mcp");
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "appstore-connect-mcp");
}

export function settingsFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(settingsDir(env), "config.json");
}

export function readStored(env: NodeJS.ProcessEnv = process.env): StoredSettings {
  const file = settingsFile(env);
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`Settings file ${file} is not valid JSON: ${(err as Error).message}`);
  }
}

/** Writes a file readable only by the current user, atomically (write to a temp file, then rename). */
export function writePrivate(path: string, content: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

function ensureDir(env: NodeJS.ProcessEnv): string {
  const dir = settingsDir(env);
  mkdirSync(join(dir, "keys"), { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  chmodSync(join(dir, "keys"), 0o700);
  return dir;
}

/** Merges a change into the settings file; `undefined` leaves a field as it is. */
export function updateStored(change: StoredSettings, env: NodeJS.ProcessEnv = process.env): StoredSettings {
  ensureDir(env);
  const next = { ...readStored(env) };
  for (const [k, v] of Object.entries(change)) if (v !== undefined) (next as any)[k] = v;
  writePrivate(settingsFile(env), JSON.stringify(next, null, 2) + "\n");
  return next;
}

export function keyIdFromFileName(name: string): string | undefined {
  return /AuthKey_([A-Z0-9]{8,12})\.p8$/i.exec(name)?.[1]?.toUpperCase();
}

export function isPrivateKeyPem(pem: string): boolean {
  return /-----BEGIN PRIVATE KEY-----[\s\S]+-----END PRIVATE KEY-----/.test(pem);
}

/** Copies a .p8 key into the settings folder (mode 600) and returns its path. */
export function saveKey(pem: string, keyId: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!isPrivateKeyPem(pem)) throw new Error("That file is not an App Store Connect private key (.p8).");
  if (!/^[A-Z0-9]{8,12}$/i.test(keyId)) throw new Error(`"${keyId}" does not look like a Key ID.`);
  const dir = ensureDir(env);
  const path = join(dir, "keys", `AuthKey_${keyId.toUpperCase()}.p8`);
  writePrivate(path, pem.trim() + "\n");
  return path;
}

/** Returns a warning when a secret file can be read by other users on this machine. */
export function permissionWarning(path: string): string | undefined {
  if (platform() === "win32" || !existsSync(path)) return undefined;
  const mode = statSync(path).mode & 0o777;
  return mode & 0o077 ? `${path} is readable by other users (mode ${mode.toString(8)}); run: chmod 600 "${path}"` : undefined;
}
