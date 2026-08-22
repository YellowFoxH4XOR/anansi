# ADR-001: Tolerance bands + CUSUM instead of PSI for drift detection

**Status:** accepted · **Date:** 2026-08-15

## Context
We must detect *silent corruption*: a scraper returning HTTP 200 and well-formed JSON whose
values are wrong (e.g., the price of an injected "related products" item). The obvious
industry reflex is a distributional test — PSI or KS — between current output and a baseline.

Our monitoring unit is 3–5 pinned canary URLs per scraper. At n=5, distributional tests are
statistically meaningless: binned PSI requires epsilon-smoothing whose arbitrary choice
dominates the statistic, and sampling noise alone produces alarm-level values — a bin with
true probability 0.4 receives zero of five observations 7.8% of the time (0.6⁵), which by
itself pushes PSI past the conventional 0.25 "major shift" threshold, a threshold calibrated
for samples in the hundreds. Entropy estimates on five strings are similarly biased; one
legitimately reworded product title would trip an alarm.

## Decision
1. **Cross-section (n≈5):** no statistics. Deterministic per-URL comparison against
   hand-pinned golden records with declared tolerance (numeric bands, string-similarity
   floors). Catches the silent-injection case exactly and is explainable in one sentence.
2. **Time axis (n=24–288/day/field): two-sided tabular CUSUM** per field per URL — the
   standard pair (Page 1954; Montgomery SPC): S⁺_t = max(0, S⁺_{t−1} + (x_t − μ − k)) and
   S⁻_t = max(0, S⁻_{t−1} + (μ − x_t − k)), alarm when either exceeds h. The upper chart
   alone is blind to downward drift, and a slowly sinking price that stays inside the
   tolerance band per-reading is exactly the failure this signal exists to catch. Start
   k = 0.5σ, h = 4σ (≈1σ-shift tuning, in-control ARL ≈ 168 samples) — **with a σ floor,
   σ_eff = max(σ_window, band_width/8)**: a golden-pinned canary is a constant series whose
   window σ ≈ 0, which would collapse k and h to 0 and alarm on the first legitimate in-band
   move. CUSUM's role is explicitly the gap the other signals leave: *sustained shifts inside
   the tolerance band*, and aggregate/list metrics where σ is real. EWMA was considered and
   is an acceptable substitute; CUSUM chosen for its explicit change-point semantics.
3. **Distributional tests only where n is honest — and stated honestly:** two-sample KS for
   list-page scrapers, current crawl vs baseline. At n = m = 20–30 the α=0.05 critical value
   is D ≈ 0.35–0.43, so KS flags *gross* distributional breaks, not per-item corruption
   (5 wrong prices in 20 items ⇒ max CDF gap ≈ 0.25, invisible). Heal-routing therefore
   requires persistence across 2 consecutive crawls (≈2.4 expected false alarms/day otherwise
   at 30-min cadence), and per-item corruption on lists is covered the same way as detail
   pages: goldens pinned for 2–3 specific list items. (books.toscrape.com is ~20 items/page,
   below a strict n≥30 line — acknowledged, hence the persistence gate.)

## Consequences
- Every alarm is explainable ("$12.99 left the $49.99 +/- 15% band"), which
  improves operator trust and produces better diagnosis inputs.
- **Known residual window, by design:** an injected value landing *inside* the tolerance band
  (e.g. a $45 "also bought" item against a $49.99 ± 15% golden) evades the band instantly and
  is caught only by two-sided CUSUM persistence over the following runs — a
  sensitivity/specificity trade-off we accept and can state out loud, not a blind spot we
  failed to notice.
- Cost: golden records need hand-pinning (one-time per scraper, re-pinned on promotion) and
  tolerance bands need choosing per field. Accepted — it is exactly the "data contract"
  discipline the product argues for.
- Prior art acknowledged: wrapper verification (Kushmerick, AAAI-99) established
  distributional output-checking; our contribution is not the statistics but wiring detection
  into an autonomous, gated heal loop on Bright Data's platform.
