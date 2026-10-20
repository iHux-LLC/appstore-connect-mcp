import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface Param {
  name: string;
  in: "path" | "query";
  type: string;
  required?: boolean;
  enum?: string[];
  description?: string;
  deprecated?: boolean;
}

export interface Operation {
  id: string;
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  path: string;
  tags: string[];
  summary: string;
  params: Param[];
  deprecated?: boolean;
  body?: string;
  response?: string;
  responseType?: string;
}

export interface CatalogData {
  specVersion: string;
  baseUrl: string;
  operations: Operation[];
  bodySchemas: Record<string, any>;
}

// Words people use that differ from Apple's resource names.
const SYNONYMS: Record<string, string[]> = {
  testflight: ["beta"],
  tester: ["betatester"],
  xcode: ["ci"],
  cloud: ["ci"],
  workflow: ["ci"],
  iap: ["inapppurchase"],
  purchase: ["inapppurchase"],
  rating: ["customerreview"],
  reply: ["customerreviewresponse"],
  screenshot: ["appscreenshot", "appscreenshotset"],
  preview: ["apppreview", "apppreviewset"],
  metadata: ["localization"],
  description: ["localization"],
  keyword: ["localization"],
  certificate: ["certificate"],
  provisioning: ["profile"],
  device: ["device"],
  price: ["pricepoint", "priceschedule"],
  pricing: ["price", "pricepoint", "priceschedule"],
  release: ["phasedrelease", "appstoreversion"],
  submit: ["reviewsubmission"],
  submission: ["reviewsubmission"],
  sales: ["salesreport"],
  finance: ["financereport"],
  analytics: ["analyticsreport"],
  subscription: ["subscription"],
  list: ["getcollection", "gettomanyrelated"],
  create: ["createinstance"],
  update: ["updateinstance"],
  delete: ["deleteinstance"],
};

function stem(word: string): string {
  if (word.length > 4 && word.endsWith("ies")) return word.slice(0, -3) + "y";
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

function splitWords(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

interface IndexEntry {
  op: Operation;
  strong: Set<string>; // operationId + resource names
  medium: Set<string>; // path segments + tags
  weak: Set<string>; // parameter names
}

function tokensOf(text: string): string[] {
  const words = splitWords(text).map(stem);
  // Also index the joined form of each camelCase identifier, e.g. "customerReviews" -> "customerreview".
  const joined = text
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => stem(w.toLowerCase()));
  return [...words, ...joined];
}

export class Catalog {
  readonly data: CatalogData;
  private readonly byId = new Map<string, Operation>();
  private readonly index: IndexEntry[];
  // Inverse document frequency, so rare words ("pricing") outweigh ubiquitous ones ("app").
  private readonly idf = new Map<string, number>();

  constructor(data: CatalogData) {
    this.data = data;
    for (const op of data.operations) this.byId.set(op.id, op);
    this.index = data.operations.map((op) => ({
      op,
      strong: new Set(tokensOf(op.id.replace(/_/g, " "))),
      medium: new Set([...tokensOf(op.path), ...op.tags.flatMap(tokensOf)]),
      weak: new Set(op.params.flatMap((p) => tokensOf(p.name))),
    }));
    const df = new Map<string, number>();
    for (const e of this.index) for (const t of new Set([...e.strong, ...e.medium])) df.set(t, (df.get(t) ?? 0) + 1);
    const n = this.index.length;
    for (const [t, count] of df) this.idf.set(t, Math.log(1 + n / count));
  }

  static load(): Catalog {
    const here = dirname(fileURLToPath(import.meta.url));
    const file = join(here, "..", "catalog", "catalog.json");
    return new Catalog(JSON.parse(readFileSync(file, "utf8")));
  }

  get operations(): Operation[] {
    return this.data.operations;
  }

  get(id: string): Operation | undefined {
    return this.byId.get(id);
  }

  require(id: string): Operation {
    const op = this.byId.get(id);
    if (op) return op;
    const close = this.search(id.replace(/_/g, " "), { limit: 5 }).map((r) => r.id);
    throw new Error(
      `Unknown operationId "${id}".` + (close.length ? ` Did you mean: ${close.join(", ")}?` : "") +
        " Use asc_search_operations to find the right one.",
    );
  }

  bodySchema(name: string): any {
    return this.data.bodySchemas[name];
  }

  groups(): { tag: string; operations: number }[] {
    const counts = new Map<string, number>();
    for (const op of this.data.operations) for (const t of op.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
    return [...counts.entries()].map(([tag, operations]) => ({ tag, operations })).sort((a, b) => a.tag.localeCompare(b.tag));
  }

  search(
    query: string,
    opts: { method?: string; tag?: string; limit?: number; includeDeprecated?: boolean } = {},
  ): Operation[] {
    const limit = opts.limit ?? 15;
    const rawTerms = splitWords(query).map(stem);
    const compact = stem(query.replace(/[^A-Za-z0-9]/g, "").toLowerCase());
    const terms = new Set(rawTerms);
    for (const t of rawTerms) for (const s of SYNONYMS[t] ?? []) terms.add(s);
    if (compact) terms.add(compact);
    // Adjacent words joined, so "app price" also matches the compound "appPriceSchedules".
    for (let i = 0; i + 1 < rawTerms.length; i++) {
      for (const right of [rawTerms[i + 1], ...(SYNONYMS[rawTerms[i + 1]] ?? [])]) terms.add(rawTerms[i] + right);
    }

    const scored: { op: Operation; score: number }[] = [];
    for (const entry of this.index) {
      const { op } = entry;
      if (opts.method && op.method !== opts.method.toUpperCase()) continue;
      if (opts.tag && !op.tags.some((t) => t.toLowerCase() === opts.tag!.toLowerCase())) continue;
      if (op.deprecated && !opts.includeDeprecated) continue;
      if (op.id.toLowerCase() === query.trim().toLowerCase()) {
        scored.push({ op, score: 1000 });
        continue;
      }
      let score = 0;
      let matchedRaw = 0;
      for (const term of terms) {
        let s = 0;
        if (entry.strong.has(term)) s = 4;
        else if (entry.medium.has(term)) s = 2;
        else if (entry.weak.has(term)) s = 0.5;
        else if (term.length >= 4 && [...entry.strong].some((t) => t.includes(term))) s = 1.5;
        score += s * (this.idf.get(term) ?? Math.log(1 + this.index.length));
        if (s > 0 && rawTerms.includes(term)) matchedRaw++;
      }
      if (score === 0) continue;
      // Prefer operations matching every word the user typed, and top-level resources over deep relationship routes.
      if (rawTerms.length > 1 && matchedRaw === rawTerms.length) score += 6;
      score -= op.path.split("/").length * 0.3;
      if (op.id.endsWith("Relationship")) score -= 2;
      scored.push({ op, score });
    }
    return scored
      .sort((a, b) => b.score - a.score || a.op.id.localeCompare(b.op.id))
      .slice(0, limit)
      .map((s) => s.op);
  }
}
