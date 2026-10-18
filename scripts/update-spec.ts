// Downloads the latest App Store Connect OpenAPI spec from Apple into spec/openapi.oas.json.
import { writeFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const SPEC_URL = "https://developer.apple.com/sample-code/app-store-connect/app-store-connect-openapi-specification.zip";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const res = await fetch(SPEC_URL);
if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);

const work = mkdtempSync(join(tmpdir(), "asc-spec-"));
try {
  const zip = join(work, "spec.zip");
  writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
  execFileSync("unzip", ["-o", "-q", zip, "openapi.oas.json", "-d", work]);
  const spec = readFileSync(join(work, "openapi.oas.json"), "utf8");
  const version = JSON.parse(spec).info.version;
  mkdirSync(join(root, "spec"), { recursive: true });
  writeFileSync(join(root, "spec/openapi.oas.json"), spec);
  console.log(`spec updated to ${version}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
