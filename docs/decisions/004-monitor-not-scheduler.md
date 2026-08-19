# ADR-004: ANANSI is a monitor, not a scheduler

**Status:** accepted · **Date:** 2026-08-20

## Context
ANANSI began as a scheduler. `apps/agent/scheduler.ts` fired a canary sweep on a cadence
declared in the contract (`cadence_minutes`), and each sweep called `brightdata scraper run
--sync` once per canary. Those are real page loads, billed to the account, on top of whatever
the customer's own scrapers were already running on Bright Data's schedule.

That is the wrong shape for the problem. The fleet ANANSI exists to protect is already being
collected — on someone else's cadence, at someone else's breadth. A sweep ANANSI invents is a
*different* workload from the one that will actually break in production, and paying twice to
observe a worse sample is the whole error in miniature.

## Decision
ANANSI never triggers a collection. It polls the platform for runs that already happened.

1. **Bright Data owns the schedule.** No `runSync`, no `runBatch`, no trigger. The
   `BrightDataAdapter` interface is narrowed to `heal` / `approve` / `reject` /
   `budgetBalance`, so a scrape-starting code path is a compile error rather than a code
   review catch. A test greps `apps/` and `packages/` for the forbidden calls as a second
   line of defence, because a raw `execFile("brightdata", ["scraper", "run", …])` would
   typecheck fine.
2. **The fleet is discovered, not configured.** `GET /dca/collectors_list` is the source of
   truth: a scraper built in Studio appears in the console with no config edit and no
   redeploy.
3. **Contracts are optional and keyed by `collector_id`.** With one, a collector gets
   goldens, CUSUM and invariants. Without one, it is still monitored for platform failures —
   row error codes, failed pages, row-count collapse. An empty or absent `contracts/`
   directory is a normal healthy state, not a misconfiguration.
4. **Failure detection never trusts `status`.** A live job was observed reporting
   `status=undefined` while carrying `failed_pages=15`. The predicate is the disjunction of
   `failed_pages > 0`, `fails > 0`, `success_rate < 1`, row-level `error`/`error_code`, and
   status only when it is present and terminal.
5. **Idempotency is persisted, not in-memory.** A job is a one-time fact: unlike a cadence
   tick, nothing regenerates it if it is dropped. A ledger under `data/jobs.jsonl` records
   `claimed → handled`, written *before* dispatch, so a crash mid-heal cannot replay and
   re-spend an AI generation. Work that cannot be dispatched now is deferred with its
   payload, never discarded.

## Rationale
1. **Cost.** Polling and the HTML archive spend nothing. The old design spent page loads
   proportional to `canaries × cadence`, forever, whether or not anything was wrong.
2. **Fidelity.** The monitor judges the exact rows the customer's pipeline received. The
   scheduler judged a proxy for them.
3. **Zero-config onboarding.** Requiring a YAML edit before a scraper could be watched meant
   the scrapers most likely to break — new ones, built quickly in Studio — were the ones
   ANANSI could not see.

## Consequences
- `scheduler.ts`, `live.ts` (the fake-scraper rehearsal adapter) and `scripts/harness.ts` are
  deleted. `contract.cadence_minutes` is removed: retaining a field named "cadence" invites
  someone to reconnect it to a timer.
- `ANANSI_CADENCE_MINUTES` is replaced by `ANANSI_POLL_SECONDS`, which is a **detection
  latency** knob, not a cost knob. Over-polling produces no duplicate work (the ledger sees
  to that) and under-polling loses nothing until the platform's ~16-day job expiry.
- `ANANSI_ADAPTER` now selects the *heal* seam only, and its `live` value is gone. Reading
  job history always goes over REST, which needs `BRIGHTDATA_API_KEY`.
- Diagnosis needs HTML the dataset rows do not carry, and there is no API to read a scraper's
  source. ANANSI plain-fetches the target page itself and archives it after every successful
  job. **Documented limitation:** a plain GET is not Bright Data's browser rendering through
  its proxy network, so JS-heavy, geo-gated or challenged pages may differ from what the
  scraper saw. Such captures are marked low-confidence rather than passed off as the product
  page, because a diff against a captcha produces a confident, wrong heal prompt.
- Credit accounting changes meaning: ANANSI causes no page loads, so `creditsSpent` now
  counts heal attempts — the only spend it can still initiate.
- From `scripts/harness.ts`, one discipline is preserved as prose rather than code: a
  characterization run against a live collector must **never** approve. Banking a heal
  fixture and promoting it are different acts.
