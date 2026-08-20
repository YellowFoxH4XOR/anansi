import { describe, expect, it } from "vitest";
import { normalizeHtml } from "../packages/core/diagnose/normalize.js";
import { diffHtml, locateValue } from "../packages/core/diagnose/diff.js";
import { buildEvidence } from "../packages/core/diagnose/evidence.js";
import { buildPrompt, PROMPT_MAX } from "../packages/core/diagnose/prompt.js";
import { listingPage, productPage, PRODUCTS } from "../apps/ui/pages.js";
import { parseContract } from "../packages/core/sense/contract.js";
import { readFileSync } from "node:fs";
import type { Incident } from "../packages/core/types.js";

const echo = PRODUCTS.find((p) => p.sku === "echo-speaker")!;
// Every scenario breaks the INDEX now, so that is what Diagnose diffs.
const baseline = listingPage("none");
const renamed = listingPage("cardrename");
const paginated = listingPage("paginate");
const jsLinks = listingPage("jslinks");
const contract = parseContract(readFileSync("contracts/lab-storefront.yaml", "utf8"));
const echoUrl = contract.canaries[0]!.url;

describe("normalize", () => {
  it("strips hydration noise but keeps structure", () => {
    const html = `<div class="wrap css-1x2y3z" nonce="abc123" data-reactid=".0">
      <span id="a1b2c3d4e5f6" class="price sc-9k8j7h">$49.99</span>
      <p>Updated 2026-08-17T09:00:00Z</p></div>`;
    const out = normalizeHtml(html).toString();
    expect(out).not.toContain("nonce");
    expect(out).not.toContain("css-1x2y3z");
    expect(out).not.toContain("sc-9k8j7h");
    expect(out).not.toContain("a1b2c3d4e5f6");
    expect(out).toContain("⟨ts⟩");
    expect(out).toContain('class="price"');
  });
});

describe("diff", () => {
  it("L1: reports the renamed listing tile, collapsed to the smallest subtree", () => {
    const d = diffHtml(baseline, renamed);
    expect(d.removed.some((c) => c.path.includes("div.card"))).toBe(true);
    expect(d.added.some((c) => c.path.includes("div.product-tile"))).toBe(true);
  });

  it("L2: reports the tiles that stopped rendering", () => {
    const d = diffHtml(baseline, paginated);
    // Two of four cards are gone, and a Load more control appeared.
    expect(d.removed.length).toBeGreaterThan(0);
    expect(paginated).toContain("load-more");
  });

  it("L3: the DOM diff is EMPTY, and the page is still broken", () => {
    // The hardest scenario to see, asserted as the limit it is. The diff
    // compares element paths — tag and class — and L3 changes neither: the
    // anchors are all present and all still match a.card-link. Only the href
    // they carry is gone, and a path-based diff cannot express that.
    //
    // This is precisely why missingUrls exists. A discovery break need not
    // disturb the DOM at all; what it disturbs is which pages get collected.
    const d = diffHtml(baseline, jsLinks);
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
    expect(jsLinks).toContain('href="#"');
    expect((jsLinks.match(/class="card-link"/g) ?? []).length).toBe(4);
  });

  it("locateValue finds a product title on the index", () => {
    const hits = locateValue(baseline, "Echo Portable Speaker");
    expect(hits.length).toBeGreaterThan(0);
  });
});

describe("evidence → prompt", () => {
  const incident: Incident = {
    kind: "incident",
    scraper: "lab-storefront",
    route: "heal",
    signals: [
      { signal: "fill_rate", url: echoUrl, detail: "4 page(s) the last good run collected were not collected at all" },
    ],
    records: [],
    snapshot_refs: [],
  };

  it("builds an evidence pack naming the moved block and the true value's location", () => {
    const ev = buildEvidence(incident, contract, baseline, renamed);
    // A discovery break names pages, not fields: nothing about a field is
    // wrong, and claiming otherwise would send the healer looking in the wrong
    // place.
    expect(ev.failing_fields).toEqual([]);
    expect(ev.dom_diff!.added.some((c) => c.path.includes("product-tile"))).toBe(true);
    // The index still renders every product title, so a known-good value can be
    // located there — which is what tells the healer the data did not move, the
    // container did.
    const withKnown = buildEvidence(incident, contract, baseline, renamed, [], {
      [echoUrl]: { title: "Echo Portable Speaker" },
    });
    expect(withKnown.value_locations.some((l) => l.found_at.length > 0)).toBe(true);
  });

  it("prompt stays under the 1000-char CLI cap and cites the located change", () => {
    const ev = buildEvidence(incident, contract, baseline, renamed);
    const p = buildPrompt(ev);
    expect(p.length).toBeLessThanOrEqual(PROMPT_MAX);
    expect(p.toLowerCase()).toContain("tile");
    expect(p.toLowerCase()).toContain("page");
  });

  it("diagnoses with no baseline page at all, from known-good values alone", () => {
    // The majority case: Studio's HTML tag is opt-in, so most collectors have no
    // historical page anywhere. Requiring one confined healing to the few that do.
    const ev = buildEvidence(incident, contract, undefined, renamed, [], {
      [echoUrl]: { title: "Echo Portable Speaker" },
    });

    expect(ev.dom_diff).toBeUndefined();
    // The line the healer can actually act on survives the loss of the diff.
    expect(ev.value_locations.some((l) => l.field === "title" && l.found_at.length > 0)).toBe(true);

    const p = buildPrompt(ev);
    expect(p.length).toBeLessThanOrEqual(PROMPT_MAX);
    expect(p).toContain("Echo Portable Speaker");
    // No baseline means nothing may be claimed about what was removed.
    expect(p).not.toContain("no longer exists");
  });

  it("does not repeat a value pinned by a golden and observed in a run", () => {
    const ev = buildEvidence(incident, contract, baseline, renamed, [], {
      [contract.canaries[0]!.url]: { price: 49.99 },
    });
    const priceLocs = ev.value_locations.filter((l) => l.field === "price");
    expect(priceLocs).toHaveLength(1);
  });

  it("prompt survives a pathologically large evidence pack", () => {
    const ev = buildEvidence(incident, contract, baseline, renamed, [
      "x".repeat(5000),
    ]);
    ev.dom_diff!.added = Array.from({ length: 50 }, (_, i) => ({
      path: `div.a${i} > div.b${i} > div.${"long".repeat(40)}${i}`,
      text: "t".repeat(200),
    }));
    expect(buildPrompt(ev).length).toBeLessThanOrEqual(PROMPT_MAX);
  });
});
