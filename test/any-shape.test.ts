// One code path, every dataset shape this account actually serves.
//
// Three collectors, three answers from the SAME /dca/dataset endpoint, each of
// which broke ANANSI in a different way before this existed. Nothing here reads
// output_schema: a row is a tree, and what matters is the leaves it fills.

import { describe, expect, it } from "vitest";
import { BrightDataApi } from "../packages/adapters/brightdata/api.js";
import { splitRow } from "../packages/adapters/brightdata/types.js";
import { flattenRow, rowShape, droppedPaths, locatableValues } from "../packages/core/sense/rows.js";

const body = (payload: string, type = "application/json") =>
  new BrightDataApi("k", (async () => ({
    ok: true,
    status: 200,
    headers: { get: () => type },
    json: async () => JSON.parse(payload),
    text: async () => payload,
  })) as never);

// Verbatim shapes, one per collector on the account.
const FLAT = { title: "Echo Portable Speaker", price: 49.99, availability: "in stock", input: { url: "https://lab/p/1" } };
const NESTED = { quotes: [{ text: "a quote", author: "Someone", tags: ["x"] }], input: { url: "http://quotes/" } };
const PRICED = { product_title: "Echo Portable Speaker", price: { value: 49.99, currency: "USD", symbol: "$" }, input: { url: "https://lab/p/1" } };

describe("every dataset encoding lands as rows", () => {
  it("a JSON array", async () => {
    expect(await body(JSON.stringify([FLAT])).dataset("j")).toHaveLength(1);
  });

  it("a bare object — one record per run", async () => {
    expect(await body(JSON.stringify(NESTED)).dataset("j")).toHaveLength(1);
  });

  it("JSONL — one record per line, no enclosing array", async () => {
    // Surfaced live as "Unexpected non-whitespace character after JSON at
    // position 426" and deferred the job on every poll.
    const jsonl = [PRICED, PRICED, PRICED].map((r) => JSON.stringify(r)).join("\n");
    const rows = await body(jsonl, "application/jsonl").dataset("j");
    expect(rows).toHaveLength(3);
  });

  it("refuses a half-parsed body rather than reading it as a short result", async () => {
    // A truncated response read as "2 rows" is a silent lie about how much the
    // run collected, which is worse than an error.
    const truncated = `${JSON.stringify(PRICED)}\n${JSON.stringify(PRICED)}\n{"product_ti`;
    await expect(body(truncated).dataset("j")).rejects.toThrow(/neither JSON nor JSONL/);
  });
});

describe("a row is read by its leaves, never by its declared types", () => {
  it("finds the number inside a structured price", () => {
    // Declared `price`, arrives as an object. Asserting number here failed every
    // clean run of that scraper; flattening simply reaches the value.
    const leaves = flattenRow(splitRow(PRICED).fields);
    expect(leaves.find((l) => l.path === "price.value")?.value).toBe(49.99);
    expect(leaves.find((l) => l.path === "price.currency")?.value).toBe("USD");
  });

  it("collapses list indices so a longer list is not a changed shape", () => {
    const one = rowShape(splitRow(NESTED).fields);
    const three = rowShape(
      splitRow({ ...NESTED, quotes: [NESTED.quotes[0]!, NESTED.quotes[0]!, NESTED.quotes[0]!] }).fields,
    );
    expect([...one].sort()).toEqual([...three].sort());
    expect([...one]).toContain("quotes[].text");
  });

  it("attributes all three shapes by their nested input url", () => {
    for (const row of [FLAT, NESTED, PRICED]) expect(splitRow(row).url).toMatch(/^https?:\/\//);
  });

  it("names the exact path that stopped filling, at any depth", () => {
    const before = rowShape(splitRow(PRICED).fields);
    const broken = { ...PRICED, price: { currency: "USD", symbol: "$" } }; // value gone
    expect(droppedPaths(before, rowShape(splitRow(broken).fields))).toEqual(["price.value"]);
  });

  it("skips values too short to mean anything when located in a page", () => {
    const paths = locatableValues({ ok: true, n: 7, sku: "A1", title: "Echo Portable Speaker" }).map((l) => l.path);
    expect(paths).toEqual(["title"]);
  });
});
