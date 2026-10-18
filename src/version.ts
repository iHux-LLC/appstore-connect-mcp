import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// package.json ships next to dist/ in both the npm package and the Claude Desktop bundle.
const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"));

export const VERSION: string = pkg.version;
export const PACKAGE_NAME: string = pkg.name;
/** What users type to run the published server, e.g. in error messages. */
export const NPX_COMMAND = `npx -y ${PACKAGE_NAME}`;
