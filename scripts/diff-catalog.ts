// Summarises what changed between two catalogs, as Markdown for the spec-update pull request.
// Usage: node scripts/diff-catalog.ts <old catalog.json> <new catalog.json>
import { readFileSync } from "node:fs";

const [oldPath, newPath] = process.argv.slice(2);
if (!oldPath || !newPath) throw new Error("Usage: diff-catalog.ts <old> <new>");
const load = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const before = load(oldPath);
const after = load(newPath);

const byId = (c: any) => new Map<string, any>(c.operations.map((o: any) => [o.id, o]));
const oldOps = byId(before);
const newOps = byId(after);
const added = [...newOps.keys()].filter((id) => !oldOps.has(id)).sort();
const removed = [...oldOps.keys()].filter((id) => !newOps.has(id)).sort();
// An operation counts as changed when its parameters or request body differ.
const changed = [...newOps.keys()]
  .filter((id) => oldOps.has(id))
  .filter((id) => {
    const a = oldOps.get(id);
    const b = newOps.get(id);
    const bodyA = a.body ? JSON.stringify(before.bodySchemas[a.body]) : "";
    const bodyB = b.body ? JSON.stringify(after.bodySchemas[b.body]) : "";
    return JSON.stringify(a.params) !== JSON.stringify(b.params) || bodyA !== bodyB;
  })
  .sort();

const list = (ids: string[], max = 40) =>
  ids.length ? ids.slice(0, max).map((id) => `- \`${id}\``).join("\n") + (ids.length > max ? `\n- …and ${ids.length - max} more` : "") : "_None_";

console.log(`Apple's App Store Connect API spec changed: **${before.specVersion} → ${after.specVersion}** (${before.operations.length} → ${after.operations.length} operations).

### Added operations (${added.length})
${list(added)}

### Removed operations (${removed.length})
${list(removed)}

### Changed parameters or request bodies (${changed.length})
${list(changed)}`);
