# App Store Connect MCP

**The entire App Store Connect API for Claude Code, Claude Desktop and Cursor.** All 1,303 operations in Apple's OpenAPI spec (v4.5.1): apps, builds, TestFlight, metadata and screenshots, pricing, in-app purchases and subscriptions, customer reviews, Game Center, Xcode Cloud, provisioning, analytics and sales/finance reports.

Built and maintained by [iHux](https://github.com/iHux-LLC).

[![CI](https://github.com/iHux-LLC/appstore-connect-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/iHux-LLC/appstore-connect-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@ihux/appstore-connect-mcp)](https://www.npmjs.com/package/@ihux/appstore-connect-mcp)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/iHux-LLC/appstore-connect-mcp?style=social)](https://github.com/iHux-LLC/appstore-connect-mcp)

## Install

### Claude Desktop: one-click extension

1. Download **[appstore-connect.mcpb](https://github.com/iHux-LLC/appstore-connect-mcp/releases/latest/download/appstore-connect.mcpb)** from the latest release.
2. Double-click it, or drag it into **Claude Desktop → Settings → Extensions**, and click **Install**.
3. In a chat, ask Claude to ***"open the App Store Connect settings"*** and add your API key there ([how to get one](#get-an-api-key)).

No terminal and no Node.js install needed; Claude Desktop runs the extension itself.

### Claude Code, Cursor (or Claude Desktop without the extension)

Needs [Node.js](https://nodejs.org) 20 or later. Run:

```bash
npx -y @ihux/appstore-connect-mcp settings
```

A settings page opens in your browser. Add your API key, choose what Claude may do, then click **Install** next to each app you use. Restart Claude Desktop or Cursor afterwards; Claude Code picks it up immediately.

### Get an API key

1. In App Store Connect, open **[Users and Access → Integrations → App Store Connect API](https://appstoreconnect.apple.com/access/integrations/api)**.
2. Create a **Team Key**. Its role sets what the server can do: *Developer* is enough for reading, *App Manager* for most writes, *Finance* for financial reports.
3. Download the `AuthKey_XXXXXXXXXX.p8` file (Apple only lets you download it once) and note the **Issuer ID** shown above the keys list.

Then ask Claude: *"Check my App Store Connect connection"* and *"List my apps"*.

## What you get

Exposing 1,303 tools would overload any MCP client, so the server uses a small set of tools instead:

| Tool | What it does |
|---|---|
| `asc_search_operations` | Finds the right operation among all 1,303 by keyword ("customer reviews", "testflight testers", "subscription prices") |
| `asc_describe_operation` | Shows an operation's parameters, filters, `fields[...]` options and full request-body schema |
| `asc_call_operation` | Calls any operation, checking parameters against Apple's spec first, and can follow pagination |
| `asc_fetch_url` | Follows a `nextUrl` or related link from an earlier response |
| `asc_list_resource_groups` | Lists the 204 resource groups so you can browse the API |
| `asc_upload_asset` | Uploads screenshots, previews, IAP images and similar files with Apple's reserve, upload and commit flow *(write mode)* |

On top of those, shortcuts for common jobs return compact, flattened results:

- **Read:** `asc_check_connection`, `asc_list_apps`, `asc_app_overview`, `asc_list_builds`, `asc_list_customer_reviews`, `asc_list_beta_groups`, `asc_list_version_localizations`, `asc_list_app_info`, `asc_list_media`, `asc_download_sales_report`, `asc_download_finance_report`, `asc_list_analytics_reports`, `asc_download_analytics_report`
- **Write** (only in `write` or `full` mode): `asc_reply_to_customer_review`, `asc_invite_beta_tester`, `asc_distribute_build`, `asc_update_version_localization`, `asc_update_app_info`, `asc_create_app_store_version`, `asc_attach_build_to_version`, `asc_upload_screenshots`, `asc_upload_previews`, `asc_submit_for_review`, `asc_release_version`, `asc_phased_release`, `asc_analytics_setup`

### Releases and TestFlight

- `asc_release_version` releases an approved version that's waiting for a manual release. It refuses any other state.
- `asc_phased_release` turns on a 7-day phased release, and can pause, resume, complete or show it. Removing one needs `full` mode. `asc_app_overview` shows the current day.
- `asc_distribute_build` gives a build to TestFlight groups. It can also set the "What to Test" notes per language and submit the build for beta review, which external groups need. It never submits a build twice. Groups that already receive every build automatically are skipped with a note, and each group's result is reported separately.
- `asc_update_app_info` changes the app's name, subtitle or privacy URLs for one language. It only edits the app info being prepared for the next version, never the live one.

### Analytics reports

Apple's App Store analytics (impressions, page views, downloads, sessions, crashes, and more) come as reports that Apple prepares once you ask for them:

1. `asc_analytics_setup` asks Apple to start producing reports for an app. You only do this once per app, and the first reports appear **after a day or two**.
2. `asc_list_analytics_reports` lists the reports by category (App Store engagement, commerce, app usage, framework usage, performance), and the dates each one is available for.
3. `asc_download_analytics_report` downloads a report by name for a date range (daily, weekly or monthly). It checks each part against Apple's checksum, unzips and merges the parts, and returns the rows or saves them as a TSV file.

Report files are fetched only from the links Apple's API returns in that same call, over HTTPS, without your API key.

### Ratings and reviews

`asc_list_customer_reviews` returns each review's star rating, title, text, country and your reply. It filters by rating, by country, or to reviews you haven't answered. `asc_reply_to_customer_review` posts a reply.

Apple's App Store Connect API doesn't provide an app's overall average rating or the number of ratings, so this server can't show them either.

### Screenshots and app previews

`asc_upload_screenshots` and `asc_upload_previews` handle the whole job in one call. You give an app, a version, one or more languages (or `*` for all), and the files or a folder; files in a folder are taken in name order. Each call then:

- finds or creates the screenshot or preview set for the device size
- uploads the files, reading them from disk in chunks, 4 at a time
- waits for Apple's processing, including video processing for previews
- keeps the files in the order you gave

Before uploading anything, it checks:

- **The device size.** Screenshot sizes are matched against Apple's specifications. A size that belongs to a different device (an iPad image in an iPhone set, say) is refused. If you omit the device size, it's detected from the images.
- **Apple's limits:** 10 screenshots and 3 previews per set.
- **That the version can still be edited.**

**Localized screenshots in one call:** point `folder` at a folder with one subfolder per language. Each language gets its own files, and `locales` isn't needed:

```
shots/
  en-US/  1.png 2.png 3.png
  de-DE/  1.png 2.png 3.png
```

Before anything uploads, the tool checks every language: that it exists on the version, that its images fit the device size, and that it stays within Apple's per-set limit. If any language fails a check, nothing is uploaded.

By default new files are added after the existing ones. `replace: true` swaps them out, but only after every new file has processed successfully, so a failed upload never leaves your product page empty. Replacing needs the `full` access mode, because it removes files.

Apple usually processes screenshots within seconds, but **preview videos often take several minutes**: about 7 minutes for a 16-second clip in testing. The upload tools wait up to `waitSeconds` (2 minutes by default for videos), then report anything unfinished as `PROCESSING` instead of blocking. Ask Claude to check again later, or pass a longer `waitSeconds`.

`asc_list_media` shows what's on a version, per language and device size, including Apple's processing state and any errors. Custom product pages and product page optimization treatments work too: pass `target` and `localizationIds`.

Sales and finance reports arrive gzipped. The server decompresses them and returns the rows; pass `saveTo` to write the full TSV to a file.

## How it works on your machine

```
Claude Code / Claude Desktop / Cursor
        │  launch the server as a background process and talk to it over stdin/stdout
        ▼
appstore-connect-mcp  ── reads ~/.config/appstore-connect-mcp/  (key ID, issuer ID, mode, .p8 key)
        │  signs a 20-minute token with your key; the key itself never leaves your machine
        ▼
api.appstoreconnect.apple.com
```

All three clients share one settings folder. Their own config files only hold the command that launches the server, never secrets.

## The settings page

Open it with `npx -y @ihux/appstore-connect-mcp settings`, or by asking Claude to *"open the App Store Connect settings"*. On it you:

1. **Add your key.** Drop the `.p8` file; the Key ID is read from its name and you enter the Issuer ID. The page tests the key against Apple and saves it only if Apple accepts it. The key is copied into the settings folder, readable only by you.
2. **Choose what Claude may do:** Read-only, Write or Full (see [Access modes](#access-modes)).
3. **Add the server to your apps:** one click each for Claude Code, Claude Desktop and Cursor. Each config file is backed up before it changes.

Claude can open the page, but only you can change anything on it. The page only listens on `127.0.0.1`, needs the one-time token in the URL it opens, and shuts down after 15 minutes idle or when you click **Done**.

### Prefer the terminal?

```bash
npx -y @ihux/appstore-connect-mcp set-key --key-file ~/Downloads/AuthKey_2X9R4HXF34.p8 --issuer-id <issuer-id>
npx -y @ihux/appstore-connect-mcp mode write   # readonly | write | full
npx -y @ihux/appstore-connect-mcp install      # every app found; or: install claude-code | claude-desktop | cursor
npx -y @ihux/appstore-connect-mcp status       # what is set, where it comes from, which apps have it
```

## Access modes

| Mode | Allowed |
|---|---|
| `readonly` *(default)* | GET requests only. Write shortcuts and the upload tool are hidden |
| `write` | Also creates and updates (POST and PATCH): metadata, TestFlight, review replies, submissions, uploads |
| `full` | Also deletes |

Changing the mode takes effect within about a second: running servers watch the settings file and tell the client its tool list has changed. If a client doesn't support that notification, restart it.

**What "only you can change it" means.** No MCP tool can change settings, and the settings page's token never reaches the model. An agent that can run shell commands, such as Claude Code, could still edit files in your settings folder. Claude Code asks for your permission before running those commands, so approve shell commands with care.

## Safety

- **Writes and deletes** need the matching access mode, and only you can change it (see above).
- **Files Claude saves** (`saveTo` on reports and API calls) are always new files. Existing files are never overwritten, and saves only allow `.json`, `.tsv`, `.txt`, `.csv`, `.gz` and `.zip`. Nothing is written inside hidden folders (such as `~/.ssh` or `~/.config`) or `~/Library`. A bare file name goes to `~/Downloads/appstore-connect/`.
- **Files Claude uploads** must be media, documents or builds that Apple accepts (images, videos, PDF, `.ipa` and similar), and can't come from hidden folders or `~/Library`. That keeps keys and keychains from ever being sent.
- **Text from the public**, such as customer reviews and TestFlight feedback, is labelled as untrusted. Claude is told never to act on instructions inside it.

## Advanced: environment variables

Environment variables override the settings file field by field. They are useful in CI or for a different key per client. Set them in the client's `env` block:

| Variable | Value |
|---|---|
| `ASC_KEY_ID`, `ASC_ISSUER_ID` | Key ID and Issuer ID |
| `ASC_PRIVATE_KEY_PATH` / `ASC_PRIVATE_KEY` | Path to the `.p8`, or its PEM contents (`\n` escapes are fine) |
| `ASC_MODE` | `readonly`, `write` or `full`. If set, it pins the mode for that client; the settings page warns when it detects this |
| `ASC_CONFIG_DIR` | Use a different settings folder |
| `ASC_MAX_RESPONSE_CHARS` | Largest response returned inline (default `60000`) |

> Claude Desktop doesn't load your shell profile, so the installer writes the absolute path to `node`. If you install by hand and use nvm, fnm or asdf, use the full path that `which node` prints.

## Example prompts

- "Which of my apps have a version waiting for review?"
- "Show the 1- and 2-star reviews from the last month for MyApp that have no reply yet, and draft replies."
- "List the TestFlight builds of version 2.3 and which are still processing."
- "Invite jane@example.com to the External Testers group."
- "Update the What's New text for en-US and de-DE on version 2.4."
- "Upload the screenshots in ~/Desktop/shots/iphone to version 2.4 for every language, replacing the current ones."
- "Add ~/Desktop/promo.mov as the iPhone app preview for en-US, with the poster frame at 3 seconds."
- "Give build 412 to the Beta Testers group with 'Try the new export flow' as What to Test, and submit it for beta review."
- "Version 3.0 is approved: turn on phased release, then release it."
- "Change the en-US subtitle to 'Edit photos in seconds'."
- "Upload the localized screenshots in ~/Desktop/shots (one folder per language) to version 2.4."
- "Turn on analytics for MyApp." Then, a couple of days later: "How many App Store impressions and downloads did MyApp get last week?"
- "Download last month's sales summary for vendor 8xxxxxxx and total the units by country."
- "Which Xcode Cloud workflows failed this week?" (uses the generic tools)

## Development

```bash
git clone https://github.com/iHux-LLC/appstore-connect-mcp.git
cd appstore-connect-mcp
npm install            # also builds dist/
node dist/index.js settings
```

### Keeping up with Apple

When Apple publishes a new API version:

```bash
npm run update-spec   # downloads the latest spec and regenerates catalog/catalog.json
npm run build
```

New endpoints become available through `asc_search_operations` and `asc_call_operation` without any code changes.

### Commands

```bash
npm test           # unit and integration tests, with Apple's API mocked
npm run typecheck
npm run generate   # rebuild the catalog from spec/openapi.oas.json
npm run bundle     # build the Claude Desktop extension into build/appstore-connect.mcpb
```

### Code layout

| Path | Purpose |
|---|---|
| `scripts/generate.ts` | Turns Apple's spec into `catalog/catalog.json` (operations, parameters and request schemas with refs resolved) |
| `src/auth.ts` | ES256 JWT signing; tokens are cached and re-signed before the 20-minute limit |
| `src/client.ts` | HTTP client: mode checks, retries on 429 and 5xx, Apple error formatting, pagination; only sends the token to `api.appstoreconnect.apple.com` |
| `src/validate.ts` | Checks path, query and body against the spec before each request |
| `src/format.ts` | Strips JSON:API links, keeps responses within the size budget, decodes gzipped TSV reports |
| `src/upload.ts` | Generic asset upload for all 27 upload-capable resource types |
| `src/settings/store.ts` | The settings folder: atomic writes with owner-only permissions |
| `src/settings/web.ts`, `assets/settings.html` | The local settings page and its API |
| `src/settings/clients.ts` | Detects Claude Code, Claude Desktop and Cursor, and installs the server with backups |
| `manifest.json`, `scripts/bundle.ts` | Claude Desktop extension: manifest and build script (fills in version and tool list) |
| `src/index.ts` | CLI: `settings`, `status`, `mode`, `install`, `uninstall`, `set-key`; with no command it runs the MCP server |
| `src/tools/` | MCP tool definitions |

### Releasing

1. Bump `version` in `package.json` and commit.
2. Tag and push: `git tag v0.3.0 && git push origin v0.3.0`.
3. The release workflow runs the tests, attaches `appstore-connect.mcpb` to a new GitHub Release, and publishes `@ihux/appstore-connect-mcp` to npm.

If a step fails, fix the cause and re-run the workflow; it skips what already succeeded. To publish an existing tag to npm on its own, run **Actions → Publish to npm** with the tag. The `NPM_TOKEN` secret must be a granular token with publish rights to `@ihux` and **Bypass 2FA** enabled.

## Not covered

- The **App Store Server API** (transactions, refunds, server notifications). It is a separate API with its own keys.

---

If this saves you time in App Store Connect, a ⭐ on [GitHub](https://github.com/iHux-LLC/appstore-connect-mcp) helps other developers find it. Built by [iHux](https://github.com/iHux-LLC).

## License

[MIT](LICENSE) © 2026 iHux LLC. Not affiliated with or endorsed by Apple. App Store Connect is a trademark of Apple Inc.
