# ADR-005: Verify V2 is dropped — the next scheduled run is the verification

**Status:** accepted · **Date:** 2026-08-20
**Supersedes:** the two-phase half of [ADR-002](002-approval-gate-stays.md). The V1 gate and
the never-`--auto-approve` discipline in ADR-002 remain in force and are not touched here.

## Context
ADR-002 made verification two-phase because a multi-canary check cannot run before approval.
V2 ran after `scraper approve`: ANANSI fired a fresh 3–5-canary sweep with `scraper run
--sync`, evaluated it, and either closed the incident `promoted` or quarantined the collector
as `rolled_back`.

That design assumed ANANSI could start a collection. It cannot any more. ANANSI is a monitor:
Bright Data owns the schedule, and every code path that triggered a scrape has been removed
(see ADR-004). V2 was one of the three call sites of `runSync`.

The question this ADR answers is not "how do we keep V2 without scraping?" but "what did V2
actually buy, and is it still available?"

## Decision
Verify V2 is deleted. `packages/core/verify/v2.ts`, the `verifying` collector state, the
`rolled_back` resolution and the golden re-pin flag go with it. After a V1 pass, ANANSI
approves and the incident closes `promoted`, with the collector left in `watching`.

Post-approval regression checking is not lost — it moves into the monitor. When the monitor
sees the next terminal job for a collector in `watching`:

- **clean run →** `watching` becomes `healthy`. The fix survived production.
- **failed run →** the collector is `quarantined` **without a second heal attempt.** A fix
  that broke the first real run after promotion is not a candidate for another AI generation.

## Rationale
1. **The replacement is strictly better evidence.** V2 judged a promoted fix on a synthetic
   sweep of 3–5 canaries that ANANSI chose. The next scheduled run is the real production
   workload, at whatever breadth and cadence the operator actually configured. A fix that
   passes on four canaries and fails on four hundred pages is exactly the failure V2 could
   not see.
2. **It costs nothing.** V2 spent one page load per canary on every single promotion. The
   monitor's version reads a job that Bright Data was going to run regardless.
3. **The latency cost is bounded and honest.** V2 gave a verdict in ~60 seconds; the monitor
   gives one on the next scheduled run. During that window the collector sits in `watching`,
   which the console renders as exactly what it is — approved, not yet confirmed. A fast
   verdict on the wrong workload is not worth more than a slower verdict on the real one.
4. **Two verification stages against one contract was one too many.** V1 and V2 shared
   `evaluate()`, `checkGolden()` and `confidence()`. The genuine difference between them was
   which rows they saw, and under the monitor both sets of rows arrive from the platform.

## What is genuinely lost
The golden re-pin flag. V2 was its only producer: a promoted numeric value inside the
tolerance band but more than 2% off its pinned anchor raised `repin_flags` for a human to
re-pin. Nothing else computes it, and it is not being reimplemented. Golden drift is now
caught only when it leaves the band or trips CUSUM — later, and less specifically. This is
accepted rather than mitigated because the signal only ever fired on canaries with numeric
goldens, which contract-less collectors do not have at all.

## Consequences
- `IncidentRecord.resolution` keeps `"rolled_back"` and `CollectorState` keeps `"verifying"`
  as union members with no producer, so incidents recorded before this change still render.
- `HealAttempt.phase` is gone: with one phase it carried no information.
- The console's V2 stage becomes "awaiting the next scheduled run".
- `driveIncident` no longer takes `preIncidentSweep`. V2 was its only consumer.
