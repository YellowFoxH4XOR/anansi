# Mutation Lab spec

A small, deliberately fragile storefront we deploy ourselves, with buttons that break it in
controlled ways. It converts "trust me, sites change" into "watch it change." Hosted live,
one-click mutation links in the README — judging is async, so the Lab must sell itself in the
video and survive a judge poking it days later.

## Build

- Plain Express (or Next.js) app on Vercel. **No client framework needed** — server-rendered
  HTML makes mutations trivial and scraping deterministic. Verified: Bright Data's infra
  reaches vercel.app fine (their own demo shop is on Vercel; bot protection is opt-in).
- ~4 product pages + 1 listing page. Realistic markup: nested divs, a price block, images.
- Mutation state in a real KV (Upstash/Vercel KV) — **never a JSON file**: Vercel lambdas
  have per-instance ephemeral filesystems, so the `/__control` write and the crawler's read
  land on different instances and mutations intermittently vanish (a flaky, undebuggable
  demo failure). Read the KV on every request; send `Cache-Control: no-store` on every Lab
  page including `/__control`. Verify on D1 with two rapid curls after a mutation flip.
  State: `{mutation: "none" | "rename" | "salevariant" | "renest" | "hashed" | "locale" |
  "cardrename" | "paginate" | "jslinks"}`.
- `/__control` — the control panel: one button per mutation + RESET. Also accepts
  `?mutate=rename` links so the README can deep-link each scenario.
- Every page renders according to current mutation state. Reset returns to baseline instantly.

## Shipping mutations (Tier 1)

### M1 · Rename the class — the baseline
- Before: `<span class="price">$49.99</span>`
- After:  `<span class="price-now">$49.99</span>`
- Expect: signal 2/3 (null price) → diagnosis names the selector move → heal proposes new
  selector → verify passes → promoted. The whole loop, legible.

### M2 · One item on sale — partial breakage, the hardest kind to notice
- After: a single product (`aurora-lamp`) renders the promotional template —
  `.price-was` struck through beside `.price-final`, and **no `.price` at all**. The other
  three products are byte-identical to baseline.
- Expect: the job **succeeds**. Three of four rows are perfect, `success_rate` is fine, no
  hard fail, no error code. Fill rate falls to 0.75 and the contract trips on the one null →
  heal must cover both templates, not swap one selector for another.
- Replaced the old "silent injection" (a competitor price block rendering above the real
  one), which was a synthetic case: real stores do not inject a rival's price into your
  markup. They do ship a promo template to a subset of items, constantly.
- This is the beat a null-check on the whole job misses entirely — the job looked fine.

### M3 · Re-nest — structure moves, not names
- After: the price moves two levels deeper, into `span[data-testid="price-value"]`. No class
  is renamed and nothing is injected; the tree itself is different.
- Expect: structural diff pins the re-nested subtree → heal retargets via `data-testid` →
  verify gates the promotion.
- Shipped as M3 rather than S2. The S series meant "must NOT heal", and this heals — it is
  parser breakage like M1 and M2, just expressed as depth rather than as a name. With S1
  removed there was nothing else in that series, so the series is gone and the label with it.

### M4 · Build-hashed class names — the rename nobody wrote
- After: every semantic class becomes its CSS-modules twin: `.price` → `.Price_value__k39fa`,
  `.title` → `.Title_heading__8b2c1`. Nothing moved; every name is now meaningless.
- Expect: all selectors miss at once. The DOM diff degrades to "this whole subtree is
  different" — true and nearly useless — so `value_locations` carries the diagnosis instead.
  Heal must retarget on structure or a stable attribute.
- Real cause: a Next.js / styled-components / CSS-modules rebuild. Deploys do this without
  anyone editing markup, which is why a class-based scraper rots on someone else's release.
- The hash is stable across renders on purpose. A per-request hash is a different failure
  (and an undiagnosable one).

### M5 · Localised price format — the selector is fine, the value is not
- After: the price element and its class are untouched; the TEXT becomes `USD 49,99` —
  currency code, comma decimal.
- Expect: the selector still matches, the field still fills, and the **value** fails its
  declared `number` type. The DOM diff is completely empty — nothing moved — so this is the
  one scenario a diff-only diagnosis cannot see at all.
- Real cause: geo-aware rendering, a currency switcher, a CDN answering from another region.

## L-series — the index page (stage 1)

The scraper is two stages. Stage 1 parses the index for links and hands each one to stage 2:

```js
const product_cards = $('.card').toArray();
const product_urls = product_cards.map(card =>
  new URL($(card).find('a.card-link').attr('href'), base_url).href).filter(Boolean);
```

A stage-1 break is worse than a stage-2 break and looks like less. When that selector
misses, stage 2 is **never called**: the job reports success having collected nothing, and
every selector on the pages it never reached still works perfectly — so an audit of the
product pages finds nothing wrong.

`shapeDrift` cannot see any of it. Its rows are keyed by url, and a discovery break produces
either no rows at all or rows for a url never seen before; in both cases there is nothing to
compare against. `missingUrls` is the page-level twin: what the last good run collected and
this one did not.

### L1 · Listing tile renamed
- After: `.card` becomes `.product-tile` on the index only.
- Expect: 0 links discovered → 0 rows, on a run reporting SUCCESS. The run that collected
  nothing is indistinguishable from the run that had nothing to collect, until you compare it
  against the pages the last good run did collect.

### L2 · Half the catalogue behind "Load more"
- After: the index renders 2 of 4 tiles; the rest arrive only on a click.
- Expect: the row count halves on a clean run. Nothing is renamed and nothing errors, so no
  selector is wrong — only volume against this collector's own history can see it.

### L3 · Links go JS-driven
- After: `href="#"`, real path in `data-href`. An SPA migration.
- Expect: the anchors still match, so stage 1 finds four of them — and
  `new URL("#", base)` resolves every one to the index. Stage 2 scrapes the same page four
  times: the right NUMBER of rows, all of them the wrong page. This is the one where a row
  count check passes and the data is entirely wrong.

## Stretch (Tier 3) / cut-first

- **S3 · SSR → XHR (Tier 3):** price leaves the HTML, arrives via `/api/price`. The correct
  heal switches to `tag_response()`. Most impressive, most likely to fail on camera —
  attempt only if D5 is clear.
- **S4 · Lazy-load (Tier 3):** description behind infinite scroll → heal adds `load_more()`.

## Real targets (breadth beyond our own toy)

1. `books.toscrape.com` — purpose-built public sandbox, stable, has a list page (gives the
   fleet a multi-stage `next_stage()` scraper and legitimate KS-on-lists usage).
2. One real public site (candidate: Hacker News front page — titles/points/rank only,
   **no usernames**; contracts set `exclude_fields_containing_pii`). Rules ban personal data
   even from public pages — the exclusion is deliberate and gets one line in the README.
