// The split diff has one job: point at the element that changed. It is the
// evidence a human uses to decide whether a proposed fix is honest, so a view
// that highlights the whole page to report a renamed span is worse than none —
// it looks like a thorough answer and reads as noise.

import { describe, expect, it } from "vitest";
import { normalizeHtml } from "../packages/core/diagnose/normalize.js";
import { listingPage } from "../apps/ui/pages.js";


/** Mirrors apps/console/server.ts diffPayload(). */
const pretty = (html: string) =>
  normalizeHtml(html)
    .toString()
    .replace(/>\s*</g, ">\n<")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n");

describe("split-diff line granularity", () => {
  it("puts each element on its own line instead of collapsing the document", () => {
    const lines = pretty(listingPage("none")).split("\n");
    // Before the fix this was 10 lines with a 1182-char <main>.
    expect(lines.length).toBeGreaterThan(40);
    expect(Math.max(...lines.map((l) => l.length))).toBeLessThan(400);
  });

  it("reports only the renamed tile lines as changed", () => {
    const before = pretty(listingPage("none")).split("\n");
    const after = pretty(listingPage("cardrename")).split("\n");
    expect(after.length).toBe(before.length);

    const changed = before.flatMap((l, i) => (l === after[i] ? [] : [[l, after[i]!] as const]));
    expect(changed).toHaveLength(4); // one per card
    expect(changed.every(([a]) => a.includes('class="card"'))).toBe(true);
    expect(changed.every(([, b]) => b!.includes('class="product-tile"'))).toBe(true);
  });

  it("keeps a value on the line of the element that holds it", () => {
    // Splitting inside text would tear "$49.99" away from its span and make the
    // diff unreadable for exactly the case it exists to explain.
    const line = pretty(listingPage("none"))
      .split("\n")
      .find((l) => l.includes('class="price"'))!;
    expect(line).toContain("49.99");
  });
});
