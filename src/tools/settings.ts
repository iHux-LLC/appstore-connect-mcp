import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { openBrowser, startSettingsServer, type SettingsServer } from "../settings/web.js";
import { NPX_COMMAND } from "../version.js";
import { safe, text } from "./context.js";

export function registerSettingsTool(server: McpServer, env: NodeJS.ProcessEnv, open: (url: string) => void = openBrowser) {
  let page: SettingsServer | undefined;

  server.registerTool(
    "asc_open_settings",
    {
      title: "Open App Store Connect settings",
      description:
        "Open the local settings page in the user's browser, where they add or replace their API key, choose the access mode (read-only, write, full) and add this server to Claude Code, Claude Desktop or Cursor. " +
        "Use it when credentials are missing or rejected, or when the user wants writes enabled. Only the user can change settings there.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safe(async () => {
      if (!page) {
        page = await startSettingsServer({ env });
        page.closed.then(() => (page = undefined));
      }
      // The URL carries the session token, so it goes to the browser only, never back to the model.
      open(page.url);
      return text(
        "Opened the App Store Connect settings page in the user's browser. Ask them to finish there; changes apply to this session automatically. " +
          `If no browser window appeared, they can run \`${NPX_COMMAND} settings\` in a terminal.`,
      );
    }),
  );
}
