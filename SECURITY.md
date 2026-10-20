# Security

## Reporting a vulnerability

Please **don't open a public issue** for security problems.

Report them privately through GitHub: open the [Security tab](https://github.com/iHux-LLC/appstore-connect-mcp/security) and choose **Report a vulnerability**. Include what you found, how to reproduce it, and the version (`npx -y @ihux/appstore-connect-mcp --version`).

We aim to reply within 3 working days and to ship a fix for confirmed issues as a patch release, crediting you unless you prefer otherwise.

## Supported versions

Only the latest release gets security fixes. Clients installed with `@latest` pick them up on their next start.

## What the server protects, and how

| Area | Protection |
|---|---|
| **API key** | Stays on your computer in `~/.config/appstore-connect-mcp/` (folders `700`, files `600`). Only short-lived signed tokens (20 minutes) are sent, and only to `api.appstoreconnect.apple.com`. Client configs hold no secrets. |
| **What Claude may change** | The access mode (read-only, write, full) is set by you on the settings page or in the terminal. No tool can change it, and write tools are hidden in read-only mode. |
| **Settings page** | Listens on `127.0.0.1` only, needs a one-time token, checks the `Host` header, sends a strict Content-Security-Policy, and closes after 15 minutes idle. The token never reaches the model. |
| **Files Claude saves** | Always new files: never overwrites, only data file types (`.json`, `.tsv`, `.txt`, `.csv`, `.gz`, `.zip`), never inside hidden folders or `~/Library`. |
| **Files Claude uploads** | Only media, documents and builds Apple accepts, never from hidden folders or `~/Library`, so keys and keychains can't be sent. |
| **Analytics downloads** | Fetched only from links Apple's API returned in the same call, over HTTPS, without credentials, with checksum verification. |
| **Untrusted text** | Customer reviews and other public text are labelled as untrusted, and the model is told never to act on instructions inside them. |

## Out of scope

- An AI client that can run shell commands (for example Claude Code with your approval) can read or change files in your settings folder. Review such commands before approving them.
- Actions your API key's role allows in App Store Connect itself: give the key the narrowest role you need.
