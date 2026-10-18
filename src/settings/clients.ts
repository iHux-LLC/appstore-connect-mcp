import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir, platform } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { PACKAGE_NAME } from "../version.js";
import { writePrivate } from "./store.js";

export const SERVER_NAME = "appstore-connect";
/** The `name` in manifest.json, used to spot our Claude Desktop extension. */
export const EXTENSION_NAME = "appstore-connect-mcp";

export type ClientId = "claude-code" | "claude-desktop" | "cursor";

export interface ClientStatus {
  id: ClientId;
  name: string;
  detected: boolean;
  installed: boolean;
  configPath?: string;
  note?: string;
  /** ASC_* variables set in this client's own entry; they override the settings file. */
  pinnedEnv?: string[];
  /** Set when the client manages the install itself (the Claude Desktop extension). */
  managedBy?: "extension";
}

export interface ServerEntry {
  command: string;
  args: string[];
}

/** Runs a command; injectable so tests never touch the real `claude` CLI. */
export type Runner = (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
const run: Runner = promisify(execFile) as unknown as Runner;

function findOnPath(cmd: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(dir, cmd);
    if (dir && existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Launches the published package through npx. node and npm's npx script are called by absolute
 * path because GUI apps often can't find `npx` (or the `node` its shebang needs) on their PATH.
 */
function npxEntry(env: NodeJS.ProcessEnv): ServerEntry {
  const args = ["-y", PACKAGE_NAME];
  if (platform() !== "win32") {
    // Inside the Desktop extension, process.execPath is Claude's bundled runtime, not the user's node.
    const node = env.ASC_RUNTIME === "mcpb" ? findOnPath("node") : process.execPath;
    const npx = node ? join(dirname(node), "npx") : undefined;
    if (node && npx && existsSync(npx)) {
      const cli = realpathSync(npx);
      if (cli.endsWith("npx-cli.js")) return { command: node, args: [cli, ...args] };
    }
  }
  return { command: "npx", args };
}

/** How clients should launch this server. */
export function serverEntry(env: NodeJS.ProcessEnv = process.env): ServerEntry {
  const script = resolve(dirname(fileURLToPath(import.meta.url)), "..", "index.js");
  // Copies inside the Desktop extension or the npx cache can move or vanish, so point at the published package.
  if (env.ASC_RUNTIME === "mcpb" || /[\\/]_npx[\\/]/.test(script)) return npxEntry(env);
  // The absolute node path avoids "node not found" in GUI apps that don't load the shell profile.
  return { command: process.execPath, args: [script] };
}

function desktopConfigPath(): string {
  const home = homedir();
  if (platform() === "darwin") return join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  if (platform() === "win32") return join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
  return join(home, ".config", "Claude", "claude_desktop_config.json");
}

function cursorConfigPath(): string {
  return join(homedir(), ".cursor", "mcp.json");
}

function pinnedEnv(entry: any): string[] | undefined {
  const keys = Object.keys(entry?.env ?? {}).filter((k) => k.startsWith("ASC_"));
  return keys.length ? keys : undefined;
}

function readJson(path: string): any {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${path} is not valid JSON, so it was left untouched. Fix or remove it, then try again.`);
  }
}

/** Adds or removes our entry in a JSON config with an `mcpServers` map, keeping a timestamped backup. */
function editJsonConfig(path: string, entry: ServerEntry | undefined): string | undefined {
  const config = readJson(path);
  let backup: string | undefined;
  if (existsSync(path)) {
    backup = `${path}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    copyFileSync(path, backup);
  }
  config.mcpServers ??= {};
  if (entry) config.mcpServers[SERVER_NAME] = entry;
  else delete config.mcpServers[SERVER_NAME];
  mkdirSync(dirname(path), { recursive: true });
  writePrivate(path, JSON.stringify(config, null, 2) + "\n");
  return backup;
}

async function claudeCodeStatus(runner: Runner): Promise<ClientStatus> {
  const base = { id: "claude-code" as const, name: "Claude Code" };
  try {
    await runner("claude", ["--version"]);
  } catch {
    return { ...base, detected: false, installed: false, note: "The `claude` command was not found on PATH" };
  }
  try {
    await runner("claude", ["mcp", "get", SERVER_NAME]);
    // User-scope servers live in ~/.claude.json; read it only to spot env overrides.
    let pinned: string[] | undefined;
    try {
      pinned = pinnedEnv(readJson(join(homedir(), ".claude.json")).mcpServers?.[SERVER_NAME]);
    } catch {
      pinned = undefined;
    }
    return { ...base, detected: true, installed: true, pinnedEnv: pinned };
  } catch {
    return { ...base, detected: true, installed: false };
  }
}

/** True when our .mcpb extension is installed in Claude Desktop. */
function desktopExtensionInstalled(): boolean {
  try {
    const registry = readJson(join(dirname(desktopConfigPath()), "extensions-installations.json"));
    return Object.values<any>(registry.extensions ?? {}).some((e) => e?.manifest?.name === EXTENSION_NAME);
  } catch {
    return false;
  }
}

function jsonClientStatus(id: ClientId, name: string, path: string): ClientStatus {
  const detected = existsSync(dirname(path));
  if (id === "claude-desktop" && desktopExtensionInstalled()) {
    return { id, name, detected: true, installed: true, configPath: path, managedBy: "extension" };
  }
  let entry: any;
  try {
    entry = readJson(path).mcpServers?.[SERVER_NAME];
  } catch {
    return { id, name, detected, installed: false, configPath: path, note: "Config file is not valid JSON" };
  }
  return { id, name, detected, installed: Boolean(entry), configPath: path, pinnedEnv: pinnedEnv(entry) };
}

export async function clientStatuses(runner: Runner = run): Promise<ClientStatus[]> {
  return [
    await claudeCodeStatus(runner),
    jsonClientStatus("claude-desktop", "Claude Desktop", desktopConfigPath()),
    jsonClientStatus("cursor", "Cursor", cursorConfigPath()),
  ];
}

const EXTENSION_MANAGED =
  "It's installed as a Claude Desktop extension. Manage it in Claude Desktop → Settings → Extensions.";

export interface InstallResult {
  client: ClientId;
  installed: boolean;
  backup?: string;
  restartNeeded: boolean;
}

export async function installClient(id: ClientId, runner: Runner = run): Promise<InstallResult> {
  const entry = serverEntry();
  if (id === "claude-code") {
    // Re-adding fails if it exists, so remove first; a missing entry is fine.
    await runner("claude", ["mcp", "remove", SERVER_NAME, "--scope", "user"]).catch(() => undefined);
    await runner("claude", ["mcp", "add", SERVER_NAME, "--scope", "user", "--", entry.command, ...entry.args]);
    return { client: id, installed: true, restartNeeded: false };
  }
  if (id === "claude-desktop" && desktopExtensionInstalled()) throw new Error(EXTENSION_MANAGED);
  const path = id === "claude-desktop" ? desktopConfigPath() : cursorConfigPath();
  return { client: id, installed: true, backup: editJsonConfig(path, entry), restartNeeded: true };
}

export async function uninstallClient(id: ClientId, runner: Runner = run): Promise<InstallResult> {
  if (id === "claude-code") {
    await runner("claude", ["mcp", "remove", SERVER_NAME, "--scope", "user"]);
    return { client: id, installed: false, restartNeeded: false };
  }
  if (id === "claude-desktop" && desktopExtensionInstalled()) throw new Error(EXTENSION_MANAGED);
  const path = id === "claude-desktop" ? desktopConfigPath() : cursorConfigPath();
  if (!existsSync(path)) return { client: id, installed: false, restartNeeded: false };
  return { client: id, installed: false, backup: editJsonConfig(path, undefined), restartNeeded: true };
}
