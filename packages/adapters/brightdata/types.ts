// The single seam to Bright Data (architecture rule 2). Implemented twice:
// real (CLI subprocess) and fake (banked-fixture replay). Nothing else in the
// system may talk to the platform.

// One raw output row from a scraper run. The Lab scraper collect()s two extra
// fields: _snapshot_html (the tag_html capture) and url (input.url attribution).
export type RawRow = {
  url?: string;
  _snapshot_html?: string;
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
