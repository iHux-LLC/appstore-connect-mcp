#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, parseMode } from "./config.js";
import { createServer } from "./server.js";
import { clientStatuses, installClient, uninstallClient, type ClientId } from "./settings/clients.js";
import { keyIdFromFileName, permissionWarning, readStored, saveKey, settingsFile, updateStored } from "./settings/store.js";
import { openBrowser, startSettingsServer } from "./settings/web.js";
import { NPX_COMMAND, PACKAGE_NAME, VERSION } from "./version.js";

const HELP = `${PACKAGE_NAME} ${VERSION}: App Store Connect API for Claude Code, Claude Desktop and Cursor
By iHux · https://github.com/iHux-LLC/appstore-connect-mcp

Usage: ${NPX_COMMAND} [command]

  (no command)        Run the MCP server (what your MCP client launches)
  settings            Open the settings page in your browser
  status              Show the current settings and client installs
  mode <mode>         Set the access mode: readonly | write | full
  install [client]    Add the server to claude-code, claude-desktop, cursor (default: all found)
  uninstall <client>  Remove it from a client
  set-key --key-file <AuthKey_X.p8> --issuer-id <id> [--key-id <id>]
                      Save credentials without the settings page

Settings live in ${settingsFile()}`;

const CLIENTS: ClientId[] = ["claude-code", "claude-desktop", "cursor"];

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function parseClient(value: string | undefined): ClientId {
  if (!value || !CLIENTS.includes(value as ClientId)) throw new Error(`Client must be one of ${CLIENTS.join(", ")}.`);
  return value as ClientId;
}

async function serve() {
  // Credentials are checked lazily on the first API call, so the server still starts and
  // can point the user to the settings page instead of failing silently inside the client.
  const config = loadConfig();
  const { server } = createServer(config, { watch: true });
  await server.connect(new StdioServerTransport());
  console.error(`appstore-connect-mcp ${VERSION} running (mode: ${config.mode})`);
}

async function status() {
  const config = loadConfig();
  const file = settingsFile();
  const src = (s?: string) => (s === "env" ? " (from environment)" : "");
  console.log(`Settings file   ${file}`);
  console.log(`Key ID          ${config.keyId ?? "not set"}${src(config.sources.keyId)}`);
  console.log(`Issuer ID       ${config.issuerId ?? "not set"}${src(config.sources.issuerId)}`);
  console.log(`Private key     ${config.privateKeyInline ? "inline (ASC_PRIVATE_KEY)" : config.privateKeyPath ?? "not set"}${src(config.sources.privateKey)}`);
  console.log(`Access mode     ${config.mode}${src(config.sources.mode)}`);
  for (const path of [file, readStored().privateKeyPath]) {
    const warning = path ? permissionWarning(path) : undefined;
    if (warning) console.log(`Warning         ${warning}`);
  }
  console.log("\nClients");
  for (const c of await clientStatuses()) {
    const state = c.installed ? "installed" : c.detected ? "found, not installed" : "not found";
    const pinned = c.pinnedEnv ? `  (its config sets ${c.pinnedEnv.join(", ")}, which overrides the settings file)` : "";
    console.log(`  ${c.name.padEnd(15)} ${state}${pinned}`);
  }
}

async function settings() {
  const page = await startSettingsServer();
  console.log(`Settings page: ${page.url}\nOpening your browser… (press Ctrl+C to stop)`);
  openBrowser(page.url);
  await page.closed;
  console.log("Settings page closed.");
}

async function main(args: string[]) {
  const [command, ...rest] = args;
  switch (command) {
    case undefined:
    case "serve":
      return serve();
    case "settings":
    case "setup":
      return settings();
    case "status":
      return status();
    case "mode": {
      const mode = parseMode(rest[0] ?? "", "Mode");
      updateStored({ mode });
      console.log(`Access mode set to ${mode}. Running servers pick it up within a second.`);
      if (process.env.ASC_MODE) console.log("Note: ASC_MODE is set in this shell; a client config that sets it too will override this.");
      return;
    }
    case "install": {
      const targets = rest[0] ? [parseClient(rest[0])] : (await clientStatuses()).filter((c) => c.detected).map((c) => c.id);
      if (!targets.length) console.log("No supported clients found. Name one explicitly: install claude-code | claude-desktop | cursor");
      for (const id of targets) {
        const r = await installClient(id);
        console.log(`Installed in ${id}${r.backup ? ` (backup: ${r.backup})` : ""}${r.restartNeeded ? "; restart it to load the server" : ""}`);
      }
      return;
    }
    case "uninstall": {
      const r = await uninstallClient(parseClient(rest[0]));
      console.log(`Removed from ${r.client}${r.backup ? ` (backup: ${r.backup})` : ""}`);
      return;
    }
    case "set-key": {
      const keyFile = flag(rest, "--key-file");
      const issuerId = flag(rest, "--issuer-id");
      if (!keyFile || !issuerId) throw new Error("set-key needs --key-file and --issuer-id.");
      const keyId = flag(rest, "--key-id") ?? keyIdFromFileName(keyFile);
      if (!keyId) throw new Error("Could not read the Key ID from the file name; pass --key-id.");
      const privateKeyPath = saveKey(readFileSync(keyFile, "utf8"), keyId);
      updateStored({ keyId: keyId.toUpperCase(), issuerId, privateKeyPath });
      console.log(`Saved. Key copied to ${privateKeyPath} (readable only by you). Run \`status\` to check, or open \`settings\` to test it.`);
      return;
    }
    case "-v":
    case "--version":
      console.log(VERSION);
      return;
    case "-h":
    case "--help":
    case "help":
      console.log(HELP);
      return;
    default:
      throw new Error(`Unknown command "${command}".\n\n${HELP}`);
  }
}

main(process.argv.slice(2)).catch((err) => {
  console.error(`appstore-connect-mcp: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
