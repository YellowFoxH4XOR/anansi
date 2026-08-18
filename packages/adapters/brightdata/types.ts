// The single seam to Bright Data (architecture rule 2). Implemented twice:
// real (CLI subprocess) and fake (banked-fixture replay). Nothing else in the
// system may talk to the platform.

// One raw output row from a scraper run. The Lab scraper collect()s two extra
// fields: the tag_html() DOM capture and url (input.url attribution).
export type RawRow = {
  url?: string;
  // Scraper Studio surfaces tag_html('page_html') under the tag's own name, and
  // auto-adds the page URL as page_html_url. The fake and live adapters predate
  // that and emit _snapshot_html. splitRow() below normalises the two.
  _snapshot_html?: string;
  page_html?: string;
  page_html_url?: string;
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
  runSync(collectorId: string, url: string): Promise<RawRow>;
  runBatch(collectorId: string, urls: string[]): Promise<RawRow[]>;
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
export function splitRow(raw: RawRow): {
  snapshotHtml?: string;
  url?: string;
  error_code?: string;
  fields: Record<string, unknown>;
} {
  const { _snapshot_html, page_html, page_html_url, url, error_code, ...fields } = raw;
  return { snapshotHtml: _snapshot_html ?? page_html, url, error_code, fields };
}
