# ADR-002: The approval gate stays — autonomy earns trust, it isn't granted

**Status:** accepted (planning) · **Date:** 2026-08-15

## Context
Bright Data's CLI offers `--auto-approve`: a heal can promote itself with no review. The
maximally "autonomous" demo would use it. We deliberately do not.

> **Amended by [ADR-005](005-verify-v2-dropped.md).** V2 below described a
> post-approval canary sweep that ANANSI fired itself. Under
> [ADR-004](004-monitor-not-scheduler.md) ANANSI triggers no collections, so V2
> is gone: the verification is Bright Data's own next scheduled run, which the
> monitor observes. Everything else in this ADR — the gate itself, the mandatory
> reject, the two-attempt cap — stands unchanged, and V1 is untouched.

## Decision
Every heal stops at the approval gate (`status: awaiting_approval`). Verification is
two-phase, because the CLI's `--url` on heal is cosmetic ("not sent to the heal call") and
`preview_result` is backend-chosen sample rows — a multi-canary check cannot run
pre-approval:
- **V1, pre-approval, on `preview_result`:** contract clean → invariants hold → golden check
  for every row attributable via its collected `input.url` field. All gates are hard ANDs.
- ~~**V2, post-approval, before the incident closes:** the full 3–5-canary sweep — goldens in
  band → no new drift → regression check (fields that weren't broken still aren't). Failure
  routes to Versions rollback (dashboard, manual) + quarantine.~~ *(dropped — ADR-005; the
  next scheduled run is the verification, and a failure on it quarantines rather than
  re-healing.)*
V1 pass → ANANSI approves programmatically and the collector moves to `watching`; V1 fail → the pending fix is
**rejected** (`approve --reject` — mandatory before re-healing) and the loop retries with the
failure in the evidence pack; two failed heal attempts → reject + quarantine, stop spending.
The console's confidence number is a weighted per-field pass fraction for the audit trail;
the promotion decision itself is the conjunction of gates, never a threshold on a score.

## Rationale
1. An LLM-generated fix is a hypothesis, not a truth. The healer optimizes "make the error go
   away," which includes degenerate solutions (hardcoding the golden value, selecting a
   different-but-present element). Only verification distinguishes a cure from a painkiller.
2. A wrong fix promoted silently is *worse* than the original breakage — it converts a loud
   failure into a silent one, the exact disease we exist to treat.
3. Cost control: unattended heal loops against a pathological target burn credits all night.
   The two-strike quarantine is the circuit breaker.

## Consequences
- Autonomy is preserved in the common case (gate passes → no human involved) while failure
  degrades to escalation, not to corruption.
- The gate produces the project's best demo moment if a heal goes wrong on camera: ANANSI
  visibly refusing to promote a bad fix.
- Wall-clock per incident grows by one verification run (~seconds against goldens; the heal
  itself at 5–25 min dominates regardless).
