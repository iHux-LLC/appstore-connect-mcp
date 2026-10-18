import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Never read or write the developer's real settings or client configs.
const home = mkdtempSync(join(tmpdir(), "asc-home-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
delete process.env.XDG_CONFIG_HOME;
delete process.env.APPDATA;
for (const k of Object.keys(process.env)) if (k.startsWith("ASC_")) delete process.env[k];
