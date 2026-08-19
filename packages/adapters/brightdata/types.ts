// The single seam to Bright Data's WRITE side (architecture rule 2): heal,
// approve, reject. Reads go through brightdata/api.ts instead.
//
// There is deliberately no run/trigger method. ANANSI is a monitor: Bright Data
// owns the schedule, and the absence of a trigger from this interface is what
// makes "ANANSI never starts a collection" a compile error rather than a
// convention someone can forget.

// One raw output row, from a heal preview or from a collected dataset.
export type RawRow = {
  url?: string;
  // Dataset rows attribute the collected page as `input` or `prime_input`;
  // heal previews and the fake adapter use `url`.
  input?: string;
  prime_input?: string;
  // Scraper Studio surfaces tag_html('page_html') under the tag's own name, and
  // auto-adds the page URL as page_html_url. Most scrapers collect no snapshot
  // at all, which is why the HTML archive plain-fetches pages itself.
  _snapshot_html?: string;
  page_html?: string;
  page_html_url?: string;
  // Per-input failures arrive on the row under BOTH names depending on the
  // scraper; a row carrying only `error` was previously read as a clean row.
  error?: string;
  error_code?: string;
  [field: string]: unknown;
};

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
export function splitRow(raw: RawRow): {
  snapshotHtml?: string;
  url?: string;
  error_code?: string;
  fields: Record<string, unknown>;
} {
  const { _snapshot_html, page_html, page_html_url, url, input, prime_input, error, error_code, ...fields } = raw;
  return {
    snapshotHtml: _snapshot_html ?? page_html,
    // Dataset rows carry no `url`; the collected page is `input`/`prime_input`.
    // An unattributed row breaks goldens and last-good snapshot lookup alike.
    url: url ?? input ?? prime_input,
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
