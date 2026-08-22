# Data contracts & detection signals

A contract is **optional**, and it is an overlay rather than a registration. The fleet is
discovered from Bright Data (`GET /dca/collectors_list`), so every collector on the account is
monitored whether or not anyone wrote a YAML file for it:

- **No contract** → platform-failure monitoring only: job failure signals, per-row error codes,
  row-count collapse. An empty or absent `contracts/` directory is a normal healthy state.
- **With a contract** → all of the above, plus goldens, tolerance bands, CUSUM and invariants,
  and a V1 gate with something to judge a proposed fix against.

The contract is the definition of "healthy" for the collector it names. It is joined by
`collector_id`; a contract without one cannot be attached to any discovered scraper, so its
goldens are inert and the agent says so at load time.

## Contract shape

```yaml
scraper: lab-storefront          # display name, also the store key
collector_id: c_example                # join to a discovered scraper; replace this value
canaries:                        # 3–5 pinned, known-stable URLs
  - url: https://<lab>/product/echo-speaker
    goldens:                     # hand-pinned correct values = ground truth
      title:  { value: "Echo Portable Speaker", similarity_min: 0.85,
                similarity_metric: token_set_ratio }   # metric MUST be named — Levenshtein
                # ratio scores a legit "- Black" suffix 0.84 (false alarm), token_set ~1.0.
                # Lowercase + strip punctuation first; validate floor vs 2–3 hand-written
                # legitimate title variants before trusting 0.85.
      price:  { value: 49.99, tolerance_pct: 15 }   # legit sales exist; bands, not equality
      availability: { one_of: ["in stock", "out of stock"] }
fields:
  title:        { type: string, required: true, min_len: 3 }
  price:        { type: number, required: true, min: 0.5, max: 10000 }
  sale_price:   { type: number, required: false }
  availability: { type: string, required: true }
invariants:                      # cross-field asserts
  - "sale_price == null || sale_price <= price"
  - "price > 0"
fill_rate_min: 0.9               # fraction of rows where each required field is non-null
exclude_fields_containing_pii: true   # usernames, contacts — rules ban personal data
```

There is no `cadence_minutes`. Bright Data owns the schedule; ANANSI observes it and infers it
from job start times to tell whether a collector has gone quiet
([ADR-004](decisions/004-monitor-not-scheduler.md)). A canary is now a **pinned URL to compare
against**, not a URL to fetch on a timer — goldens apply to whichever of those URLs turn up in a
run the platform performed, and the HTML archive plain-fetches them for the DOM diff.

## The six signals (evaluation order)

| # | Signal | Trigger | Routed to |
|---|--------|---------|-----------|
| 1 | Hard fail | `error_code` present on the job or on a row (see brightdata-notes routing table); job-level failure with no code to explain it; row count collapsed against the collector's median | heal OR infra lane |
| 2 | Contract | missing field, wrong type, null-where-required, out of range | heal |
| 3 | Fill-rate | required field's fill drops below `fill_rate_min` | heal |
| 4 | Golden band | pinned URL's value leaves its tolerance band / similarity floor | heal — **this catches the silent lie** |
| 5 | CUSUM | cumulative drift across run history per field per URL | warn → heal on persistence |
| 6 | Invariant | cross-field assert fails | heal |

Signal 1 is the only one available without a contract, and it is evaluated first: a job that
failed at the platform level is not judged against goldens as if its rows were data.


## Why bands + CUSUM, not PSI (short form — full argument in ADR-001)

Distributional tests (PSI, KS) across 3–5 canary URLs are statistically meaningless: with
n=5, a bin with true probability 0.4 is empty 7.8% of the time (0.6^5) by pure chance, which
alone exceeds PSI's standard 0.25 alarm threshold — a threshold calibrated for hundreds of
samples. Instead:

- **Cross-section (n=5):** deterministic per-URL comparison against pinned goldens with
  declared tolerance. No statistics needed; catches wrong-but-plausible values exactly.
- **Time axis (n depends on the operator's schedule, typically 24–288/day/field):** **two-sided**
  CUSUM per field per URL — the standard pair
  `S⁺_t = max(0, S⁺_{t-1} + (x_t − μ − k))` and
  `S⁻_t = max(0, S⁻_{t-1} + (μ − x_t − k))`, alarm when either exceeds `h` (Page 1954;
  upper-only cannot fire on downward drift, and prices drift down at least as often as up).
  Start with k = 0.5σ, h = 4σ of the field's trailing window, **with a σ floor:
  σ_eff = max(σ_window, band_width/8)** — a golden-pinned canary returns a constant series
  whose σ ≈ 0, which would collapse k and h to 0 and turn the chart into an equality test
  that defeats the tolerance band. CUSUM's declared role: sustained small shifts *inside*
  the band (which no other signal covers), and list/aggregate metrics where σ is real.
  The sample rate is Bright Data's schedule, not ours, so a sparsely scheduled collector
  accumulates evidence more slowly — the statistic is unchanged, the latency is not.
- **Lists only (n≥30 per crawl):** two-sample KS is legitimate for list-page scrapers
  (books sandbox ≈ 20–30 items/page) — compare this crawl's distribution to baseline.

## Golden records discipline

- Pinned by hand when each scraper first goes green; updated **only by explicit human
  action** — promotion never re-pins (a correct heal fixes the selector; the true value
  hasn't changed, so the old golden must still match). The automatic "promoted value drifted
  off the anchor, ask a human to re-pin" flag was produced only by verify V2 and went with it
  ([ADR-005](decisions/005-verify-v2-dropped.md)); in-band drift is now caught by CUSUM, later
  and less specifically. The immutability rule itself is unchanged.
- Verification is single-phase (see architecture.md): **V1, pre-approval**, on the heal's
  preview rows — contract clean, invariants, goldens for URL-attributable rows, hardcode
  detector. Confirmation that the fix survived is **Bright Data's next scheduled run**: a clean
  one moves the collector from `watching` to `healthy`, a failed one quarantines it without a
  second heal attempt. A collector with no contract has nothing for V1 to judge, so its fix is
  left `awaiting_approval` for a human rather than gated by an empty conjunction.
- **Promotion is a conjunction, not a score:** every hard gate must pass — a heal that breaks
  one previously-good field never promotes at any "score". The confidence number shown in the
  console is the weighted per-field pass fraction (required fields weighted 3:1 over
  optional), reported for the audit trail and UI — it is not the decision rule. Retry on any
  gate failure, quarantine at 2 failed heals.
- Fill-rate at n=3–5 canaries is quantized (4/5 = 0.8), so `fill_rate_min: 0.9` is
  deliberately all-or-nothing for required fields; to absorb transient render misses, a null
  routes to heal only after **2 consecutive** failing runs (signal 2 owns the instant
  hard-null case).
