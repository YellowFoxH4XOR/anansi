// Live-Lab adapter — REHEARSAL MODE for the hosted deployment.
//
// It runs the same selectors the hand-authored Studio scraper uses
// (scraper/lab-scraper.js) over a plain HTTP fetch of the deployed Mutation
// Lab, so sense → diagnose → verify all execute against real, live DOM. What
// it does NOT do is call Bright Data: heal responses are synthesised locally
// and every one of them is stamped SIMULATED so nothing downstream — console,
// audit log, incident record — can present a rehearsal as a platform heal.
//
// Why it exists: the fake adapter replays banked fixtures and answers
// `dead_page` for any URL it has no script for, so a hosted agent running
// `fake` fills the console with meaningless incidents. Rehearsal mode gives the
// hosted console a genuinely working loop (break the Lab from /__control →
// watch sense/diagnose/verify react) before the Bright Data account is wired,
// and it is the demo fallback if the live platform path misbehaves.
//
// The graded submission path remains the real CLI adapter (ANANSI_ADAPTER
// unset). See docs/deploy-coolify.md for the switch.

import { parse, type HTMLElement } from "node-html-parser";
import type { BrightDataAdapter, HealOpts, HealResponse, RawRow } from "./types.js";

export const SIMULATED = "[SIMULATED HEAL — rehearsal mode, no Bright Data call, no credits spent]";

// The naive selectors, straight from scraper/lab-scraper.js: the first .price
// anywhere on the page. M1 nulls it, M2 makes it silently wrong — the demo.
const NAIVE = { title: "h1.title", price: ".price", availability: ".availability" };

// What a heal proposes: scope the price to the product's own price block and
// accept the renamed / re-nested variants. Fixes M1, M2 and S2 alike.
const HEALED = {
  title: ".product h1.title",
  price: ".product .price-block .price, .product .price-block .price-now, .product .price-block [data-testid=price-value]",
  availability: ".product .availability",
};

function textOf(root: HTMLElement, sel: string): string | null {
  const el = root.querySelector(sel);
  const t = el?.text.trim();
  return t ? t : null;
}

function moneyOf(root: HTMLElement, sel: string): number | null {
  const t = textOf(root, sel);
  if (t == null) return null;
  const digits = t.replace(/[^0-9.]/g, "");
  const n = digits ? Number.parseFloat(digits) : Number.NaN;
  return Number.isFinite(n) ? n : null;
}

/** Mirrors the Studio parser's collect() validator: a null required field is a
 *  parse failure at the platform layer, not a quiet null row. */
function validate(fields: Record<string, unknown>): string | null {
  const title = fields.title as string | null;
  const price = fields.price as number | null;
  if (!title || title.length < 3) return "title missing";
  if (price == null || price <= 0) return "price missing";
  if (!fields.availability) return "availability missing";
  return null;
}

export type LiveLabOptions = {
  /** Canary URLs, used to build heal preview rows. */
  canaries?: string[];
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

export class LiveLabBrightData implements BrightDataAdapter {
  readonly calls: { op: string; args: unknown[] }[] = [];
  /** Flips to true on approve() — the promoted "fix" is the healed selector set. */
  private healed = false;
  private pendingFix = false;
  private readonly canaries: string[];
  private readonly timeoutMs: number;
  private readonly doFetch: typeof fetch;

  constructor(opts: LiveLabOptions = {}) {
    this.canaries = opts.canaries ?? [];
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.doFetch = opts.fetchImpl ?? fetch;
  }

  /** Parse one page exactly as the scraper would, honouring the current fix state. */
  private extract(html: string, healed: boolean): { fields: Record<string, unknown>; errorCode?: string } {
    const sel = healed ? HEALED : NAIVE;
    const root = parse(html);

    // M3 · cookie wall. A headless browser blocks on wait('.price-block') and
    // the platform reports wait_element_timeout; a raw fetch would happily read
    // the hidden markup, so the wall is detected explicitly. The healed parser
    // reads straight through it — that is the close_popup() interaction a real
    // heal would add.
    const walled = root.querySelector("#consent-overlay") != null;
    if (walled && !healed) return { fields: {}, errorCode: "wait_element_timeout" };

    const price = moneyOf(root, sel.price);
    const fields: Record<string, unknown> = {
      title: textOf(root, sel.title),
      // The price the customer actually pays — what every golden pins.
      price,
      // Deliberately null: .was is the struck-through ORIGINAL, so collecting
      // it here would break the contract invariant sale_price <= price on any
      // discounted canary (see scraper/lab-scraper.js for the same reasoning).
      sale_price: null,
      availability: textOf(root, sel.availability),
    };
    const invalid = validate(fields);
    return invalid ? { fields, errorCode: "parse_error" } : { fields };
  }

  private async fetchRow(url: string, healed: boolean): Promise<RawRow> {
    let res: Response;
    let html: string;
    try {
      res = await this.doFetch(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: { "user-agent": "anansi-rehearsal/1.0", "cache-control": "no-cache" },
      });
      html = await res.text();
    } catch (e) {
      // Unreachable / timed out → transient, routes to the retry lane.
      return { url, error_code: `net_err_${(e as Error).name.toLowerCase()}` };
    }

    // Platform error taxonomy (core/sense/triage.ts): 403 is an access problem
    // and must never be healed; 404 marks the URL dead; 5xx is transient.
    if (res.status === 403) return { url, _snapshot_html: html, error_code: "blocked" };
    if (res.status === 404) return { url, error_code: "dead_page" };
    if (res.status >= 500) return { url, error_code: String(res.status) };
    if (!res.ok) return { url, _snapshot_html: html, error_code: "parse_error" };

    const { fields, errorCode } = this.extract(html, healed);
    // The snapshot rides along even on a parse failure — a broken page's DOM is
    // exactly the evidence the diff pipeline needs.
    return { url, _snapshot_html: html, ...fields, ...(errorCode ? { error_code: errorCode } : {}) };
  }

  async runSync(_collectorId: string, url: string): Promise<RawRow> {
    this.calls.push({ op: "runSync", args: [_collectorId, url] });
    return this.fetchRow(url, this.healed);
  }

  async runBatch(_collectorId: string, urls: string[]): Promise<RawRow[]> {
    this.calls.push({ op: "runBatch", args: [_collectorId, urls] });
    const out: RawRow[] = [];
    for (const u of urls) out.push(await this.fetchRow(u, this.healed));
    return out;
  }

  /** Synthesises the platform's awaiting_approval response. Preview rows are
   *  really re-fetched with the healed selectors, so the V1 gate does real work
   *  on real DOM rather than grading a canned fixture. */
  async heal(collectorId: string, prompt: string, opts: HealOpts = {}): Promise<HealResponse> {
    this.calls.push({ op: "heal", args: [collectorId, prompt, opts] });
    if (prompt.length > 1000) throw new Error(`heal prompt ${prompt.length} chars > CLI cap 1000`);

    const preview: RawRow[] = [];
    for (const u of this.canaries) preview.push(await this.fetchRow(u, true));
    this.pendingFix = true;

    return {
      status: "awaiting_approval",
      preview_result: preview,
      diff_summary: [
        SIMULATED,
        "--- parser.js (current)",
        "+++ parser.js (proposed)",
        "@@",
        `-  price: priceText('${NAIVE.price}'),`,
        "+  // Scope the price to the product's own price block and accept the",
        "+  // renamed / re-nested variants of the price node.",
        `+  price: priceText('${HEALED.price}'),`,
      ].join("\n"),
      next_step: `brightdata scraper approve ${collectorId}`,
    };
  }

  async approve(collectorId: string): Promise<void> {
    this.calls.push({ op: "approve", args: [collectorId] });
    if (this.pendingFix) {
      this.healed = true;
      this.pendingFix = false;
    }
  }

  async reject(collectorId: string): Promise<void> {
    this.calls.push({ op: "reject", args: [collectorId] });
    this.pendingFix = false;
  }

  /** No budget concept in rehearsal — null disables the scheduler's spend guard. */
  async budgetBalance(): Promise<number | null> {
    return null;
  }
}
