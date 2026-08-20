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
  State: `{mutation: "none" | "rename" | "inject" | "renest"}`.
- `/__control` — the control panel: one button per mutation + RESET. Also accepts
  `?mutate=rename` links so the README can deep-link each scenario.
- Every page renders according to current mutation state. Reset returns to baseline instantly.

## Shipping mutations (Tier 1)

### M1 · Rename the class — the baseline
- Before: `<span class="price">$49.99</span>`
- After:  `<span class="price-now">$49.99</span>`
- Expect: signal 2/3 (null price) → diagnosis names the selector move → heal proposes new
  selector → verify passes → promoted. The whole loop, legible.

### M2 · Silent injection — the differentiator, never cut
- Before: price block is the first `.price` on the page.
- After: a "Customers also bought" strip renders **above** it, containing its own `.price`
  (`$12.99` phone case). The scraper still returns a number. **No error, no null — wrong.**
- Expect: signals 1–3 all pass (that's the point, say it out loud in the video) → signal 4
  golden band trips ($12.99 vs pinned $49.99 ± 15%) → diagnosis explains the injected block →
  heal narrows the selector → verify → promoted.
- This is the beat every null-checking lookalike fails. Video slot 0:40.

### Removed: M3 · Cookie wall, S1 · 403 bot challenge
Both were cut from the Lab. Neither exercised the loop ANANSI is actually for — a DOM
that moved — and each cost a page of markup and CSS to keep true.

Removing S1 does **not** remove the infra lane. Triage still routes `blocked` /
`captcha_timeout` / `proxy*` away from heal (ADR-003), and the archive still recognises a
403 challenge and withholds the capture; those live in the routing table and are tested
against a fixture in `test/archive.test.ts` rather than against a Lab page.

### M3 · Re-nest — structure moves, not names
- After: the price moves two levels deeper, into `span[data-testid="price-value"]`. No class
  is renamed and nothing is injected; the tree itself is different.
- Expect: structural diff pins the re-nested subtree → heal retargets via `data-testid` →
  verify gates the promotion.
- Shipped as M3 rather than S2. The S series meant "must NOT heal", and this heals — it is
  parser breakage like M1 and M2, just expressed as depth rather than as a name. With S1
  removed there was nothing else in that series, so the series is gone and the label with it.

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
