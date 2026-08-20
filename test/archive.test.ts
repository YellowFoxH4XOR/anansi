// The free HTML archive.
//
// The status→error_code mapping is harvested from the deleted rehearsal
// adapter: it was the only code in the tree that put HTTP responses onto the
// platform's own error taxonomy, and the archive needs exactly that so a 403 we
// hit ourselves is never mistaken for a page shape worth healing.

import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archivePages, httpPageFetcher, looksLikeChallenge, originRewriter, viaOrigin } from "../apps/agent/archive.js";
import { Store } from "../packages/adapters/store/index.js";
import { routeErrorCode } from "../packages/core/sense/triage.js";
import { productPage, PRODUCTS } from "../apps/ui/pages.js";

/** A bot-check interstitial, as an anti-bot vendor serves one.
 *
 *  A fixture rather than a Lab page: the archive must recognise a challenge from
 *  ANY origin, and the Lab no longer serves one of its own. What matters is the
 *  shape — a short body, no product markup, and a "checking your browser" tell. */
function challengePage(): string {
  return `<!doctype html><html lang="en"><head><title>Access denied</title></head><body>
<div class="challenge-card">
  <h1>Checking your browser before accessing loomcart</h1>
  <p>Automated traffic detected from your network. This check is automatic.</p>
  <div>Ray ID LC-4403 &middot; Performance &amp; security by LoomShield</div>
</div></body></html>`;
}

const echo = PRODUCTS.find((p) => p.sku === "echo-speaker")!;
const URL_ECHO = "https://lab.test/product/echo-speaker";

function serve(html: string, status = 200): typeof fetch {
  return (async () => new Response(html, { status })) as unknown as typeof fetch;
}

const fetcher = (html: string, status = 200) => httpPageFetcher({ fetchImpl: serve(html, status) });

describe("archive fetch · transport failures map onto the error taxonomy", () => {
  it("403 → blocked → infra lane, never healed", async () => {
    const cap = await fetcher(challengePage(), 403)(URL_ECHO);
    expect(cap.error_code).toBe("blocked");
    expect(routeErrorCode(cap.error_code!)).toBe("infra");
  });

  it("404 → dead_page → dead lane", async () => {
    const cap = await fetcher("not found", 404)(URL_ECHO);
    expect(routeErrorCode(cap.error_code!)).toBe("dead");
  });

  it("503 → retry lane", async () => {
    const cap = await fetcher("boom", 503)(URL_ECHO);
    expect(routeErrorCode(cap.error_code!)).toBe("retry");
  });

  it("an unreachable target is transient, not a heal trigger", async () => {
    const fetchPage = httpPageFetcher({
      fetchImpl: (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    });
    const cap = await fetchPage(URL_ECHO);
    expect(cap.error_code).toMatch(/^net_err_/);
    expect(routeErrorCode(cap.error_code!)).toBe("retry");
  });

  it("captures a healthy page at full confidence", async () => {
    const cap = await fetcher(productPage(echo))(URL_ECHO);
    expect(cap.status).toBe(200);
    expect(cap.low_confidence).toBe(false);
    expect(cap.error_code).toBeUndefined();
  });
});

describe("archive fetch · a plain GET is not browser rendering", () => {
  it("marks a challenge page low-confidence rather than passing it off as the product page", async () => {
    // Diffing against a captcha describes OUR block, not the scraper's failure,
    // and would produce a confident, wrong heal prompt.
    const cap = await fetcher("<html><body>Please complete the CAPTCHA to continue</body></html>")(URL_ECHO);
    expect(cap.low_confidence).toBe(true);
  });

  it("marks a suspiciously tiny body low-confidence", async () => {
    expect((await fetcher("<html>ok</html>")(URL_ECHO)).low_confidence).toBe(true);
  });

  it("detects the challenge markers a proxy would have got past", () => {
    expect(looksLikeChallenge("<h1>Access Denied</h1>")).toBe(true);
    expect(looksLikeChallenge(productPage(echo))).toBe(false);
  });
});

describe("archivePages", () => {
  const store = () => new Store(mkdtempSync(join(tmpdir(), "anansi-archive-")));

  it("stores each page and returns a ref per url", async () => {
    const s = store();
    await s.init();
    const { refs } = await archivePages([URL_ECHO], s, fetcher(productPage(echo)), {
      maxUrls: 8,
      floorMs: 1000,
    });
    expect(await s.snapshot(refs[URL_ECHO]!)).toContain("Echo Portable Speaker");
  });

  it("stores no ref for a fetch that produced no page", async () => {
    // An empty snapshot diffs as "the whole page vanished", which is a lie the
    // heal prompt would repeat.
    const s = store();
    await s.init();
    const fetchPage = httpPageFetcher({
      fetchImpl: (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    });
    const { refs, captures } = await archivePages([URL_ECHO], s, fetchPage, { maxUrls: 8, floorMs: 0 });
    expect(refs).toEqual({});
    expect(captures[0]!.low_confidence).toBe(true);
  });

  it("respects the per-url floor so ANANSI does not become a scraper", async () => {
    const s = store();
    await s.init();
    const asked: string[] = [];
    const fetchPage = async (url: string) => {
      asked.push(url);
      return { url, html: productPage(echo), status: 200, bytes: 9000, low_confidence: false, fetched_ms: 1000 };
    };
    const seen = new Map<string, number>();
    const opts = { maxUrls: 8, floorMs: 60_000 };
    await archivePages([URL_ECHO], s, fetchPage, opts, seen, () => 1000);
    await archivePages([URL_ECHO], s, fetchPage, opts, seen, () => 2000);
    expect(asked).toHaveLength(1);
  });

  it("forces a fresh capture on a failure, floor or no floor", async () => {
    const s = store();
    await s.init();
    const asked: string[] = [];
    const fetchPage = async (url: string) => {
      asked.push(url);
      return { url, html: productPage(echo), status: 200, bytes: 9000, low_confidence: false, fetched_ms: 1000 };
    };
    const seen = new Map<string, number>();
    await archivePages([URL_ECHO], s, fetchPage, { maxUrls: 8, floorMs: 60_000 }, seen, () => 1000);
    await archivePages([URL_ECHO], s, fetchPage, { maxUrls: 8, floorMs: 60_000, force: true }, seen, () => 2000);
    expect(asked).toHaveLength(2);
  });

  it("caps how many urls one job may archive", async () => {
    const s = store();
    await s.init();
    const asked: string[] = [];
    const fetchPage = async (url: string) => {
      asked.push(url);
      return { url, html: "x".repeat(1000), status: 200, bytes: 1000, low_confidence: false, fetched_ms: 1 };
    };
    const urls = Array.from({ length: 20 }, (_, i) => `https://lab.test/p/${i}`);
    await archivePages(urls, s, fetchPage, { maxUrls: 3, floorMs: 0 });
    expect(asked).toHaveLength(3);
  });
});

describe("archive · a low-confidence capture is withheld, not merely labelled", () => {
  // archive.ts promises in its own header that a heal prompt is "never generated
  // from a captcha page". Before this, low_confidence was computed, logged, and
  // then ignored: archivePages() still saved the snapshot, driveIncident() still
  // read it as `current`, and the model was handed our block described as the
  // scraper's failure. The flag has to WITHHOLD the ref, not annotate it.
  const store = () => new Store(mkdtempSync(join(tmpdir(), "anansi-archive-")));

  it("produces no ref for a challenge page", async () => {
    const s = store();
    await s.init();
    const { refs, captures } = await archivePages([URL_ECHO], s, fetcher(challengePage()), { maxUrls: 8, floorMs: 0 });
    expect(captures[0]!.low_confidence).toBe(true);
    // No ref means driveIncident() reports "missing snapshots" and quarantines
    // for a human — the honest outcome — instead of healing off a captcha.
    expect(refs).toEqual({});
  });

  it("produces no ref for a 403, and still reports the routable code", async () => {
    const s = store();
    await s.init();
    const { refs, captures } = await archivePages([URL_ECHO], s, fetcher(challengePage(), 403), { maxUrls: 8, floorMs: 0 });
    expect(refs).toEqual({});
    expect(captures[0]!.error_code).toBe("blocked");
  });

  it("still archives a page it can trust", async () => {
    const s = store();
    await s.init();
    const { refs } = await archivePages([URL_ECHO], s, fetcher(productPage(echo)), { maxUrls: 8, floorMs: 0 });
    expect(Object.keys(refs)).toEqual([URL_ECHO]);
  });
});

describe("archive · the internal origin never escapes the fetch", () => {
  // The bug this pins: ANANSI_LAB_BASE used to rewrite contract.canaries[].url
  // at load time. That string is the join key evaluate() matches dataset rows
  // against, and Bright Data collects the PUBLIC url — so every golden silently
  // stopped running and a broken page reported clean. The origin swap belongs to
  // the fetch and to nothing else.
  const rewrite = originRewriter(["lab.test"], "http://lab:4600");

  it("redirects a canary host onto the compose network", () => {
    expect(rewrite("https://lab.test/product/echo-speaker")).toBe("http://lab:4600/product/echo-speaker");
    expect(rewrite("https://lab.test/p?sku=1")).toBe("http://lab:4600/p?sku=1");
  });

  it("leaves every other host alone", () => {
    expect(rewrite("https://books.toscrape.com/x")).toBe("https://books.toscrape.com/x");
  });

  it("is a no-op when no base is configured", () => {
    expect(originRewriter(["lab.test"], undefined)("https://lab.test/a")).toBe("https://lab.test/a");
  });

  it("fetches the internal url but reports the public one", async () => {
    const asked: string[] = [];
    const inner = async (url: string) => {
      asked.push(url);
      return { url, html: "<html>x</html>", status: 200, bytes: 14, low_confidence: false, fetched_ms: 1 };
    };
    const cap = await viaOrigin(inner, rewrite)(URL_ECHO);
    expect(asked).toEqual(["http://lab:4600/product/echo-speaker"]);
    // The capture — and therefore the snapshot ref keyed off it — keeps the URL
    // the contract and the dataset both use.
    expect(cap.url).toBe(URL_ECHO);
  });
});
