import { describe, expect, it } from "vitest";
import { normalizeHtml } from "../packages/core/diagnose/normalize.js";
import { diffHtml, locateValue } from "../packages/core/diagnose/diff.js";
import { buildEvidence } from "../packages/core/diagnose/evidence.js";
import { buildPrompt, PROMPT_MAX } from "../packages/core/diagnose/prompt.js";
import { productPage, PRODUCTS } from "../apps/ui/pages.js";
import { parseContract } from "../packages/core/sense/contract.js";
import { readFileSync } from "node:fs";
import type { Incident } from "../packages/core/types.js";

const echo = PRODUCTS.find((p) => p.sku === "echo-speaker")!;
const baseline = productPage(echo, "none");
const renamed = productPage(echo, "rename");
const injected = productPage(echo, "inject");
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
  it("M1: reports the removed .price and added .price-now, collapsed to the smallest subtree", () => {
    const d = diffHtml(baseline, renamed);
    expect(d.removed.some((c) => c.path.endsWith("span.price"))).toBe(true);
    expect(d.added.some((c) => c.path.endsWith("span.price-now"))).toBe(true);
  });

  it("M2: reports the injected cross-sell block as an addition", () => {
    const d = diffHtml(baseline, injected);
    expect(d.added.some((c) => c.path.includes("aside.crosssell"))).toBe(true);
    expect(d.removed.length).toBe(0); // nothing was removed — that's the silent part
  });

  it("locateValue finds where the true price still renders", () => {
    const hits = locateValue(injected, "$49.99");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => h.path.includes("div.price-block"))).toBe(true);
  });
});

describe("evidence → prompt", () => {
  const incident: Incident = {
    kind: "incident",
    scraper: "lab-storefront",
    route: "heal",
    signals: [
      { signal: "golden_band", field: "price", url: echoUrl, detail: "12.99 outside band 42.49–57.49 (pinned 49.99 ± 15%)" },
    ],
    records: [],
    snapshot_refs: [],
  };

  it("builds an evidence pack naming the injected block and the true value's location", () => {
    const ev = buildEvidence(incident, contract, baseline, injected);
    expect(ev.failing_fields).toEqual(["price"]);
    expect(ev.dom_diff!.added.some((c) => c.path.includes("crosssell"))).toBe(true);
    expect(ev.value_locations.some((l) => l.field === "price" && l.found_at.length > 0)).toBe(true);
  });

  it("prompt stays under the 1000-char CLI cap and cites the located change", () => {
    const ev = buildEvidence(incident, contract, baseline, injected);
    const p = buildPrompt(ev);
    expect(p.length).toBeLessThanOrEqual(PROMPT_MAX);
    expect(p).toContain("price");
    expect(p.toLowerCase()).toContain("crosssell");
  });

  it("diagnoses with no baseline page at all, from known-good values alone", () => {
    // The majority case: Studio's HTML tag is opt-in, so most collectors have no
    // historical page anywhere. Requiring one confined healing to the few that do.
    const ev = buildEvidence(incident, contract, undefined, injected, [], {
      [contract.canaries[0]!.url]: { price: 49.99, title: "Echo Portable Speaker" },
    });

    expect(ev.dom_diff).toBeUndefined();
    // The line the healer can actually act on survives the loss of the diff.
    expect(ev.value_locations.some((l) => l.field === "price" && l.found_at.length > 0)).toBe(true);

    const p = buildPrompt(ev);
    expect(p.length).toBeLessThanOrEqual(PROMPT_MAX);
    expect(p).toContain("price");
    // No baseline means nothing may be claimed about what was removed.
    expect(p).not.toContain("no longer exists");
  });

  it("does not repeat a value pinned by a golden and observed in a run", () => {
    const ev = buildEvidence(incident, contract, baseline, injected, [], {
      [contract.canaries[0]!.url]: { price: 49.99 },
    });
    const priceLocs = ev.value_locations.filter((l) => l.field === "price");
    expect(priceLocs).toHaveLength(1);
  });

  it("prompt survives a pathologically large evidence pack", () => {
    const ev = buildEvidence(incident, contract, baseline, injected, [
      "x".repeat(5000),
    ]);
    ev.dom_diff!.added = Array.from({ length: 50 }, (_, i) => ({
      path: `div.a${i} > div.b${i} > div.${"long".repeat(40)}${i}`,
      text: "t".repeat(200),
    }));
    expect(buildPrompt(ev).length).toBeLessThanOrEqual(PROMPT_MAX);
  });
});
