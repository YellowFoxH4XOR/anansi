// One code path, every dataset shape this account actually serves.
//
// Three collectors, three answers from the SAME /dca/dataset endpoint, each of
// which broke ANANSI in a different way before this existed. Nothing here reads
// output_schema: a row is a tree, and what matters is the leaves it fills.

import { describe, expect, it } from "vitest";
import { BrightDataApi } from "../packages/adapters/brightdata/api.js";
import { splitRow } from "../packages/adapters/brightdata/types.js";
import { flattenRow, rowShape, droppedPaths, locatableValues, expectedPaths, shapeDrift, missingUrls } from "../packages/core/sense/rows.js";

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

describe("the failure that does not fail", () => {
  // A scraper written the ordinary way returns a row whether or not its
  // selectors matched:
  //     let price_text = $('.price').text_sane();
  //     price: price_text ? new Money(+price_text.replace(/[^0-9.]/g,''), 'USD') : null
  // So a renamed class yields a SUCCESSFUL job — success_rate 1, no error code,
  // no failed page — and a row with a hole in it. The platform's counters cannot
  // see that by construction.
  const good = {
    "https://lab/p/1": { product_title: "Echo", price: { value: 49.99, currency: "USD" }, availability: "in stock" },
    "https://lab/p/2": { product_title: "Aurora", price: { value: 29.99, currency: "USD" }, availability: "in stock" },
  };

  it("names the exact path that went null on an otherwise clean run", () => {
    const drift = shapeDrift(good, [
      { url: "https://lab/p/1", fields: { product_title: "Echo", price: null, availability: "in stock" } },
    ]);
    expect(drift.map((d) => d.path).sort()).toEqual(["price.currency", "price.value"]);
  });

  it("flags only the affected url when one item switches template", () => {
    // M2: a promo template ships for one product. Three rows stay perfect, and
    // whatever notices must not accuse them.
    const drift = shapeDrift(good, [
      { url: "https://lab/p/1", fields: { product_title: "Echo", price: { value: 49.99, currency: "USD" }, availability: "in stock" } },
      { url: "https://lab/p/2", fields: { product_title: "Aurora", price: null, availability: "in stock" } },
    ]);
    expect([...new Set(drift.map((d) => d.url))]).toEqual(["https://lab/p/2"]);
  });

  it("treats a field only SOME good rows carried as optional", () => {
    // A sale price on the items actually on sale. Flagging its absence would
    // open an incident every time a promotion ended.
    const mixed = {
      a: { title: "A", price: 1.5, sale_price: 1 },
      b: { title: "B", price: 2.5 },
    };
    expect([...expectedPaths(mixed)].sort()).toEqual(["price", "title"]);
    expect(shapeDrift(mixed, [{ url: "a", fields: { title: "A", price: 1.5 } }])).toEqual([]);
  });

  it("says nothing about a url it has never seen working", () => {
    expect(shapeDrift(good, [{ url: "https://lab/p/NEW", fields: {} }])).toEqual([]);
  });

  it("does not fire on a longer list", () => {
    const before = { u: { quotes: [{ text: "one long enough" }] } };
    const after = [{ url: "u", fields: { quotes: [{ text: "one long enough" }, { text: "another one" }] } }];
    expect(shapeDrift(before, after)).toEqual([]);
  });

  it("cannot see a value that is wrong rather than missing", () => {
    // M5 renders "USD 49,99"; the scraper strips non-digits to "4999" and
    // returns 4999 — a 100x error with the shape fully intact. Stated as a
    // limit rather than left as a surprise: this needs a value check, not a
    // shape check.
    const drifted = shapeDrift(good, [
      { url: "https://lab/p/1", fields: { product_title: "Echo", price: { value: 4999, currency: "USD" }, availability: "in stock" } },
    ]);
    expect(drifted).toEqual([]);
  });
});

describe("a crawl seeded at one url and following links", () => {
  // Verbatim from c_mt1ptxyfr93wwgxl6: seeded at the storefront root, visits
  // four product pages, so every row carries the SAME input.url and differs
  // only in its own product_page_url.
  const rows = ["echo-speaker", "aurora-lamp", "tidal-bottle"].map((sku) => ({
    product_title: sku,
    product_page_url: `https://lab.example.com/product/${sku}`,
    input: { url: "https://lab.example.com" },
  }));

  it("attributes each row to its own page, not to the seed", () => {
    // Keying on the seed collapsed four products into one: the store kept
    // whichever row was written last, so three quarters of the known-good
    // baseline vanished — while still looking attributed.
    const urls = rows.map((r) => splitRow(r).url);
    expect(new Set(urls).size).toBe(3);
    expect(urls[0]).toContain("/product/echo-speaker");
  });

  it("keeps the seed separately so a discovery failure can diagnose the index", () => {
    const split = splitRow(rows[0]!);
    expect(split.url).toContain("/product/echo-speaker");
    expect(split.inputUrl).toBe("https://lab.example.com");
  });

  it("will not adopt an off-host url as a row's identity", () => {
    // An image CDN or an analytics link must not become the page ANANSI archives.
    const r = splitRow({
      title: "x",
      thumbnail: "https://cdn.example.net/img/1.jpg",
      input: { url: "https://lab.example.com" },
    });
    expect(r.url).toBe("https://lab.example.com");
  });

  it("falls back to the seed when a row has no page of its own", () => {
    const r = splitRow({ title: "x", input: { url: "https://shop.example/list" } });
    expect(r.url).toBe("https://shop.example/list");
  });
});

describe("a broken discovery stage", () => {
  // Stage 1 parses the index for links and hands each to stage 2:
  //     const product_cards = $('.card').toArray();
  //     $(card).find('a.card-link').attr('href')  ->  next_stage({url})
  // When that selector misses, stage 2 is never called. The job reports success
  // having collected nothing, and every selector on the pages it never reached
  // still works — so nothing about the product pages is wrong to find.
  const lastGood = [
    "https://lab/product/echo-speaker",
    "https://lab/product/aurora-lamp",
    "https://lab/product/tidal-bottle",
    "https://lab/product/graphite-keyboard",
  ];

  it("L1: names every page when discovery collapses to nothing", () => {
    expect(missingUrls(lastGood, [])).toEqual([...lastGood].sort());
  });

  it("L2: names only the half that stopped being collected", () => {
    const half = lastGood.slice(0, 2).map((url) => ({ url }));
    expect(missingUrls(lastGood, half)).toEqual([...lastGood.slice(2)].sort());
  });

  it("L3: sees it even though the row COUNT is unchanged", () => {
    // Links become href="#", so all four resolve to the index and stage 2
    // scrapes the same page four times. The right number of rows, all of them
    // the wrong page — and shape drift is blind to it, because a url never seen
    // before has nothing to have drifted from.
    const wrong = lastGood.map(() => ({ url: "https://lab/#" }));
    expect(wrong).toHaveLength(4);
    expect(missingUrls(lastGood, wrong)).toEqual([...lastGood].sort());
    expect(shapeDrift({ "https://lab/product/echo-speaker": { title: "Echo" } }, wrong.map((r) => ({ ...r, fields: {} })))).toEqual([]);
  });

  it("says nothing when the same pages come back", () => {
    expect(missingUrls(lastGood, lastGood.map((url) => ({ url })))).toEqual([]);
  });

  it("says nothing before there is a good run to compare against", () => {
    expect(missingUrls([], [{ url: "https://lab/x" }])).toEqual([]);
  });
});
