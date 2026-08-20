// The single seam to Bright Data's WRITE side (architecture rule 2): heal,
// approve, reject. Reads go through brightdata/api.ts instead.
//
// There is deliberately no run/trigger method. ANANSI is a monitor: Bright Data
// owns the schedule, and the absence of a trigger from this interface is what
// makes "ANANSI never starts a collection" a compile error rather than a
// convention someone can forget.

// The scraper's own declared shape, straight from collectors_list. This is what
// makes the fleet self-describing: a scraper built in Studio arrives with its
// field names and types already attached, so ANANSI needs no per-scraper file to
// know what that scraper is supposed to produce.
//
// `active: false` fields are columns the author switched off — declared but never
// emitted — so they are not part of the shape.
export type OutputSchema = {
  type?: string;
  fields?: Record<string, { type?: string; active?: boolean }>;
};

// The contract a scraper declares about itself.
//
// ANANSI's first job is "did this collector break", not "is this value right".
// Breakage is answerable from the platform alone: output_schema names the fields
// the scraper is supposed to emit and their types, for every collector, with no
// YAML written and nothing pinned by hand. Goldens answer the second question,
// they need a human who knows the correct value, and requiring them scoped the
// whole system to scrapers somebody had already hand-configured.
//
// No `required`: the schema does not say which fields may legitimately be empty,
// and guessing would fail a good heal over an optional field. Types are asserted
// because the platform states them.
export function contractFieldsFromSchema(schema?: OutputSchema): Record<string, { type: "string" | "number"; required: boolean }> {
  const out: Record<string, { type: "string" | "number"; required: boolean }> = {};
  for (const [name, spec] of Object.entries(schema?.fields ?? {})) {
    if (spec.active === false) continue;
    if (META_SCHEMA_TYPES.has(spec.type ?? "")) continue;
    out[name] = { type: spec.type === "number" ? "number" : "string", required: false };
  }
  return out;
}

// One raw output row, from a heal preview or from a collected dataset.
//
// Nothing here may be keyed on a field NAME the scraper author chose. Studio
// surfaces tag_html('whatever') under the tag's own name, so `page_html` is one
// account's spelling, not a platform contract. Names that ARE platform-owned
// (`input`, `error`) are declared; everything else is found by value shape or by
// its declared type in output_schema.
export type RawRow = {
  url?: string;
  // Dataset rows attribute the collected page as `input` or `prime_input`.
  // Observed live as an OBJECT — {"input":{"url":"…"}} — not the string the
  // previous type claimed. A scraper that emits no `url` field would otherwise
  // have handed an object downstream as its identity.
  input?: string | { url?: string };
  prime_input?: string | { url?: string };
  // Our own convention for the fake adapter and heal previews, which have no
  // output_schema to consult. Real datasets are matched on shape instead.
  _snapshot_html?: string;
  // Per-input failures arrive on the row under BOTH names depending on the
  // scraper; a row carrying only `error` was previously read as a clean row.
  error?: string;
  error_code?: string;
  [field: string]: unknown;
};

// Platform-owned output_schema types. These are Bright Data's own columns, not
// scraped values, whatever the author named them — so they never reach the
// contract. Sourced from a live collectors_list payload.
export const META_SCHEMA_TYPES = new Set([
  "input", "prime_input", "error", "error_code", "warning", "warning_code",
  "timestamp", "requested_timestamp", "status_code", "page_id", "job_id",
  "collector_id", "collector_queue", "reparse_file", "crawl_type",
  "html_snapshot", "screenshot_snapshot", "warc_snapshot",
]);

// A whole HTML document sitting in a string field. Used to strip snapshots from
// `fields` without knowing what the author called them — the check the old
// name-matching was standing in for.
const HTML_DOC = /^\s*<(!doctype|html)\b/i;

export function isHtmlDocument(v: unknown): v is string {
  return typeof v === "string" && HTML_DOC.test(v);
}

// `input` is a string on heal previews and an object on dataset rows.
function asUrl(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (v && typeof v === "object") {
    const u = (v as { url?: unknown }).url;
    if (typeof u === "string") return u;
  }
  return undefined;
}

export type HealResponse = {
  status: "awaiting_approval" | "approved" | "failed" | string;
  preview_result?: RawRow[] | RawRow;
  diff_summary?: string;
  view_url?: string;
  next_step?: string;
  raw?: unknown;
};

export type HealOpts = {
  url?: string; // cosmetic (woven into next_step only) but kept for operator ergonomics
  timeoutSec?: number; // ALWAYS ≥ 1800 — CLI default 600s is under the 25-min worst case
  maxRetries?: number; // heal documents retry for the 3-concurrent AI-generation cap
};

export interface BrightDataAdapter {
  heal(collectorId: string, prompt: string, opts?: HealOpts): Promise<HealResponse>;
  approve(collectorId: string): Promise<void>;
  reject(collectorId: string): Promise<void>;
  budgetBalance(): Promise<number | null>;
}

export function previewRows(h: HealResponse): RawRow[] {
  if (h.preview_result == null) return [];
  return Array.isArray(h.preview_result) ? h.preview_result : [h.preview_result];
}

// Splits a raw row into its snapshot, its identity, and the scraped fields.
//
// Every snapshot key is stripped from `fields` on purpose: those fields are what
// the contract is evaluated against, and a 15KB HTML document arriving as if it
// were a scraped value would corrupt fill-rate, PII and invariant checks alike.
// `error` is stripped for the same reason — a failure message is not a value.
export function splitRow(raw: RawRow, schema?: OutputSchema): {
  snapshotHtml?: string;
  url?: string;
  error_code?: string;
  fields: Record<string, unknown>;
} {
  const { _snapshot_html, url, input, prime_input, error, error_code, ...rest } = raw;

  // Two name-independent passes, because the author owns every name here.
  // Without them a scraper whose HTML tag is called `html_dump` does not merely
  // lose its snapshot: the document lands in `fields` and is scored as a scraped
  // value, corrupting fill-rate, PII scanning and invariants at once.
  let snapshotHtml = _snapshot_html;
  // Studio publishes a tag_html('x') as `x` and auto-adds its page address as
  // `x_url`. Deriving the companion from the snapshot field we just FOUND keeps
  // that name-independent: whatever the author called the tag, its `_url` twin
  // is platform bookkeeping rather than a scraped value.
  const snapshotKeys = Object.entries(rest)
    .filter(([, v]) => isHtmlDocument(v))
    .map(([k]) => k);
  const companions = new Set(snapshotKeys.map((k) => `${k}_url`));

  const fields: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(rest)) {
    if (META_SCHEMA_TYPES.has(schema?.fields?.[name]?.type ?? "")) continue;
    if (companions.has(name)) continue;
    if (isHtmlDocument(value)) {
      snapshotHtml ??= value;
      continue;
    }
    fields[name] = value;
  }

  return {
    snapshotHtml,
    // Dataset rows carry no `url`; the collected page is `input`/`prime_input`,
    // and arrives as {"url": …} rather than a bare string. An unattributed row
    // breaks goldens and last-good snapshot lookup alike.
    url: asUrl(url) ?? asUrl(input) ?? asUrl(prime_input),
    // `error` without `error_code` is a real shape: keep the failure rather than
    // letting the row pass as healthy because one of two field names was absent.
    error_code: error_code ?? codeFromError(error),
    fields,
  };
}

// The platform sometimes puts the code itself in `error` and sometimes a prose
// message. A message is not a routable code, so it degrades to `row_error`,
// which triage treats as unknown — transient — rather than spending a heal on a
// sentence nobody parsed.
function codeFromError(error: string | undefined): string | undefined {
  if (!error) return undefined;
  return /^[a-z0-9_]{1,40}$/i.test(error.trim()) ? error.trim() : "row_error";
}
