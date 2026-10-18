// Builds the Claude Desktop extension: build/appstore-connect.mcpb.
// The manifest's version and tool list are filled in from package.json and the live server,
// so they can't drift from the code. Run with `npm run bundle`.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const buildDir = join(root, "build");
const stage = join(buildDir, "mcpb");
const output = join(buildDir, "appstore-connect.mcpb");
const run = (cmd: string, args: string[], cwd = root) => execFileSync(cmd, args, { cwd, stdio: "inherit" });

run("npm", ["run", "build"]);

// Only ever clear our own staging folder.
if (!stage.startsWith(root + sep) || !stage.endsWith(`${sep}build${sep}mcpb`)) throw new Error(`Unexpected staging path ${stage}`);
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

for (const path of ["dist", "catalog", "LICENSE", "README.md", "package-lock.json"]) {
  cpSync(join(root, path), join(stage, path), { recursive: true });
}
mkdirSync(join(stage, "assets"));
cpSync(join(root, "assets", "settings.html"), join(stage, "assets", "settings.html"));
cpSync(join(root, "assets", "icon.png"), join(stage, "icon.png"));

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const runtimePkg = {
  name: pkg.name,
  version: pkg.version,
  description: pkg.description,
  type: pkg.type,
  license: pkg.license,
  dependencies: pkg.dependencies,
};
writeFileSync(join(stage, "package.json"), JSON.stringify(runtimePkg, null, 2) + "\n");
run("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], stage);
rmSync(join(stage, "package-lock.json"));

// List every tool, including the write tools that read-only mode hides.
const { createServer } = await import(join(stage, "dist", "server.js"));
const { loadConfig } = await import(join(stage, "dist", "config.js"));
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { server } = createServer(loadConfig({ ASC_MODE: "full" }, {}), { env: { ASC_CONFIG_DIR: join(buildDir, "no-settings") } });
const [clientT, serverT] = InMemoryTransport.createLinkedPair();
await server.connect(serverT);
const client = new Client({ name: "bundle", version: "1" });
await client.connect(clientT);
const { tools } = await client.listTools();
await client.close();

const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
manifest.version = pkg.version;
manifest.tools = tools.map((t: any) => ({ name: t.name, description: t.title ?? t.description.split(". ")[0] }));
writeFileSync(join(stage, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

run("npx", ["mcpb", "validate", join(stage, "manifest.json")]);
if (existsSync(output)) rmSync(output);
run("npx", ["mcpb", "pack", stage, output]);
console.log(`\nBuilt ${output} (version ${pkg.version}, ${tools.length} tools)`);
