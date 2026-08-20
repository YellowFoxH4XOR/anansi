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
  State: `{mutation: "none" | "cardrename" | "paginate" | "jslinks"}`.
- `/__control` — the control panel: one button per mutation + RESET. Also accepts
  `?mutate=rename` links so the README can deep-link each scenario.
- Every page renders according to current mutation state. Reset returns to baseline instantly.

## Why only the index

Product pages do not mutate, and that is the design rather than a gap. The sharp edge of a
stage-1 break is precisely that the pages it never reached are still perfect: an audit of the
product pages finds nothing wrong, every selector on them still matches, and the job reports
success. Mutating them too would let a run fail for two reasons at once, and neither the demo
nor the diagnosis could say which.

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
