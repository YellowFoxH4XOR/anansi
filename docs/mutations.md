# Mutation Lab

The Mutation Lab is a deliberately fragile storefront used to exercise ANANSI
against controlled page drift. It is a development and evaluation fixture, not
a production service.

The app is server-rendered so each mutation changes deterministic HTML. Its
state is held in memory, resets to `none` on restart, and must run as a single
replica.

## Control API

- `GET /__control` renders the mutation panel.
- `GET /__control?mutate=<id>` changes the active mutation.
- `GET /__state` returns the current state for health checks.
- Every response disables caching so a collector sees the current mutation.

## Listing-page scenarios

Product pages remain unchanged. This isolates discovery failures: a run can
silently omit or misroute product pages even though every selector on those
pages still works.

### L1: listing tile renamed

`.card` becomes `.product-tile` on the index.

Expected result: the scraper discovers zero links and produces zero rows even
though the platform job can still report success. ANANSI detects the missing
volume relative to the collector's prior healthy run.

### L2: catalogue requires interaction

The index initially renders two of four cards. The remaining cards are appended
only after clicking "Load more".

Expected result: the job produces half its normal rows without a parser error.
ANANSI detects the missing URLs and output-volume change.

The held cards are absent from the initial DOM rather than hidden with CSS.
This matters because a server-side selector would still find
`display: none` elements.

### L3: links become JavaScript-driven

Each card keeps a matching anchor, but `href` becomes `#` and the real path
moves to `data-href`.

Expected result: every card resolves to the listing page. The scraper returns
the expected number of rows, but all rows describe the wrong page. Golden
records and cross-field checks detect the silent corruption.

## Running locally

```bash
npm run lab
```

Or run the complete production stack, which includes the Lab:

```bash
docker compose up --build
```

Add `-f docker-compose.demo.yml` only when the agent should use the fake write
adapter.

Do not expose `/__control` on a production host.
