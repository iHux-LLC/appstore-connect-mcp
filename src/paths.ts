import { homedir } from "node:os";
import { extname, isAbsolute, join, resolve, sep } from "node:path";

// The model picks these paths, so they are checked like untrusted input: a confused or
// manipulated model must not be able to overwrite dotfiles or upload keys and keychains.

/** File types the tools may write (API responses and reports). */
export const WRITABLE_EXTENSIONS = [".json", ".tsv", ".txt", ".csv", ".gz", ".zip"];

/** File types Apple's upload endpoints accept: images, video, documents, builds, archives. */
export const UPLOADABLE_EXTENSIONS = [
  ".png", ".jpg", ".jpeg", ".heic", ".gif",
  ".mov", ".m4v", ".mp4",
  ".pdf", ".geojson",
  ".ipa", ".pkg", ".zip", ".aar", ".plist",
];

export function expandHome(path: string): string {
  return path.replace(/^~(?=$|[\\/])/, homedir());
}

/** Where a bare file name passed as saveTo is written. */
export function downloadsDir(): string {
  return join(homedir(), "Downloads", "appstore-connect");
}

/** Explains why a path is off limits, or returns undefined when it's fine. */
function forbiddenReason(full: string): string | undefined {
  const parts = full.split(/[\\/]+/).filter(Boolean);
  const hidden = parts.find((p) => p.startsWith(".") && p !== "." && p !== "..");
  if (hidden) return `it is inside the hidden folder "${hidden}"`;
  const library = join(homedir(), "Library");
  if (full === library || full.startsWith(library + sep)) return "it is inside ~/Library";
  return undefined;
}

function checkExtension(full: string, allowed: string[], what: string): void {
  const ext = extname(full).toLowerCase();
  if (!allowed.includes(ext)) {
    throw new Error(`${what} must be one of ${allowed.join(", ")} (got "${ext || "no extension"}"): ${full}`);
  }
}

/**
 * Resolves a saveTo path. Bare names go to ~/Downloads/appstore-connect; any path must avoid
 * hidden folders and ~/Library and use a data file type. Callers must also refuse to overwrite.
 */
export function safeOutputPath(path: string): string {
  const expanded = expandHome(path.trim());
  const full = isAbsolute(expanded) ? resolve(expanded) : resolve(downloadsDir(), expanded);
  const reason = forbiddenReason(full);
  if (reason) throw new Error(`Refusing to write ${full}: ${reason}. Choose a normal folder, e.g. ~/Downloads.`);
  checkExtension(full, WRITABLE_EXTENSIONS, "Saved files");
  return full;
}

/** Resolves a file the user wants uploaded to Apple, refusing hidden folders, ~/Library and non-media types. */
export function safeUploadPath(path: string, allowed: string[] = UPLOADABLE_EXTENSIONS): string {
  const full = resolve(expandHome(path.trim()));
  const reason = forbiddenReason(full);
  if (reason) throw new Error(`Refusing to upload ${full}: ${reason}.`);
  checkExtension(full, allowed, "Uploaded files");
  return full;
}

/** Resolves a folder of media to upload, with the same hidden-folder and ~/Library rules. */
export function safeUploadFolder(path: string): string {
  const full = resolve(expandHome(path.trim()));
  const reason = forbiddenReason(full);
  if (reason) throw new Error(`Refusing to read ${full}: ${reason}.`);
  return full;
}
