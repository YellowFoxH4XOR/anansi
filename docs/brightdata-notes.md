# Bright Data platform notes — verified facts

Everything here was checked against primary sources (docs.brightdata.com, github.com/brightdata/cli)
during planning. The **Learned live** section below outranks the docs where they disagree: those
items were observed against a real account, and in two cases the published documentation is
wrong.

## Learned live — the read API (these override the docs)

ANANSI is a monitor: it reads job history and never triggers a collection
([ADR-004](decisions/004-monitor-not-scheduler.md)). These are the facts that shape
`packages/adapters/brightdata/api.ts` and `packages/core/sense/job-health.ts`.

| Fact | Detail | Design consequence |
|---|---|---|
| **`GET /dca/collector/jobs` requires `collector`** | The docs call the parameter optional. It is not: without it the API answers **400 `"Missing collector parameter"`** | There is no account-wide job feed. Discover collectors with `GET /dca/collectors_list`, then **fan out** one jobs call per collector (`allJobs()` is that loop, not an endpoint) |
| **Job ids carry two prefixes** | `j_…` for batch/scheduled runs, `vj_…` for CLI/realtime runs | Both are real jobs and both are monitored. The console renders the prefix as *scheduled* vs *cli/realtime* — the visible proof the schedule is not ours. Never filter on prefix |
| **`job.status` can be undefined** | A live job was observed with **no status at all and `failed_pages: 15`** | Failure detection must never rely on status. The predicate is a **disjunction**: `failed_pages > 0` · `fails > 0` · `success_rate < 1` · any row-level `error`/`error_code` · status only when present *and* terminal (`failed`, `cancelled`, `error`) |
| **Per-input errors live inside dataset rows** | The job summary says how many pages failed; *why* is a per-row `error` and/or `error_code` field in the `GET /dca/dataset` payload. A row may carry `error` alone, and `error` is sometimes a code and sometimes a prose sentence | `splitRow()` reads both names and strips them from the scraped fields; a prose message degrades to `row_error` (unknown → transient) rather than being fed to triage as a routable code |
| **There is no API to read a scraper's source** | Neither REST nor CLI exposes the collector's code | Diagnosis cannot compare code. ANANSI plain-fetches the target URL itself (free — it never touches Bright Data) and archives that HTML after every successful job. A plain GET is not Bright Data's browser rendering, so JS-heavy / geo-gated / challenged captures are **marked low-confidence**, not passed off as the page the scraper saw |
| Per-collector responses omit `collector` | The rows returned by a per-collector query do not name the collector they came from | The client puts it back, so a failing job is always attributable |
| Result retention | 7 d realtime / 16 d batch | Our store is the system of record, never theirs. The monitor never queries older than 16 days, and on first sight of a collector it seeds the whole retention window as handled and evaluates only the newest terminal job — booting must show current health, not replay two weeks of retroactive incidents |

### Read endpoints ANANSI uses

```
GET /dca/collectors_list                       # the fleet — source of truth, no config file
GET /dca/collector/jobs?collector=c_xxx        # runs that already happened (collector REQUIRED)
        &from_date=YYYY-MM-DD&to_date=YYYY-MM-DD   # day-granular, so it cannot be a cursor
GET /dca/log/{job_id}                          # job metadata
GET /dca/dataset?id={collection_id}            # the rows — object {status:"building"} while running
```

Bearer auth via `BRIGHTDATA_API_KEY`. The date filter is day-granular and job ids are opaque and
unsortable, so a timestamp watermark cannot prevent a replay — hence the persisted job ledger
(`data/jobs.jsonl`), which is the actual at-most-once mechanism.

`POST /dca/trigger` exists and is **deliberately never called**. Starting a collection is not
ANANSI's job; the write-side adapter interface has no trigger method so that this is a compile
error rather than a convention.

## CLI

ANANSI shells out to the CLI for the **write** side only: heal, approve, reject, budget.
`scraper create` and `scraper run` are operator commands, listed here because they are how a
collector comes to exist and how a human can check one by hand — the agent calls neither.

```bash
npm install -g @brightdata/cli        # or curl -fsSL https://cli.brightdata.com/install.sh | sh
brightdata login                      # creates cli_unlocker / cli_browser zones
brightdata budget                     # true starting balance — check before the gun

brightdata scraper create <url> "<description>" --name anansi-lab -o create.json   # operator
brightdata scraper run <collector_id> <url> --sync                                 # operator only
brightdata scraper heal <collector_id> "<generated diagnosis>" \
    --url <canary> --timeout 1800 -o heal.json                # ⭐ NEVER default timeout
brightdata scraper approve <collector_id> --url <canary>      # or --reject
```

## Load-bearing facts

| Fact | Value | Design consequence |
|---|---|---|
| Heal/AI-generation latency | 5–15 min, **up to 25** | loop is async; live demo = Sense→Diagnose only |
| CLI default `--timeout` | **600 s — less than worst case** | always pass `--timeout 1800` |
| Concurrent AI generations | **3 per account** — confirmed to cover heal (heal documents `--max-retries` for the concurrent-job-cap 429) | the monitor dispatches at most one incident per collector, and defers rather than drops |
| Heal without `--auto-approve` | stops at gate: `{status:"awaiting_approval", preview_result, diff_summary, view_url, next_step}` | V1 gate consumes `preview_result` |
| **`--url` on heal is cosmetic** | "woven into the success next_step hint (**not sent to the heal call**)" — `preview_result` is backend-chosen sample rows, no URL attribution | V1 judges what it is given; post-approval confirmation is Bright Data's next scheduled run ([ADR-005](decisions/005-verify-v2-dropped.md)). The scraper should `collect()` `input.url` so preview rows are attributable at all |
| Heal prompt cap | **1000 chars max** | diagnose stage enforces truncate-and-retry; symptom + located change + expected output, never the raw diff |
| Approval | separate `scraper approve` call; `--reject` discards the pending fix | reject **before** any re-heal; gate decision is ours, auditable |
| `run --sync` | **single-URL only**; 2+ URLs route to the async batch endpoint | operator-only knowledge — ANANSI runs nothing |
| Billing | 1 credit = 1 page load; free 5k/mo; PAYG $1.5/1k | see credit budget below |
| Sync run cap | 25–50 s server-side | operator-only |
| Result retention | 7 d realtime / 16 d batch | our store is the system of record, never theirs |
| **Output schema is a second layer** | renames fields, retypes them (`price` type + `raw` format → `{value,currency,symbol}`), and DROPS undeclared fields. Applied only on **Save to Production** | preview output ≠ production output; verify against a real job's dataset rows, never the IDE preview alone |
| Versions menu | dashboard rollback to earlier scraper version | manual rollback demo is legitimate |

## Credit budget (solo)

**RESOLVED (site verified): the promo code IS the per-participant $50** — "Not a prize and
not split between teams: sign up with Bright Data and the $50 is yours to build with," via
code `wemakedevs` in billing. There is no second credit; 71k was a double-count. Firm budget:
free 5,000 + $50 (≈33.3k) ≈ **38k page loads** (billed only for successful requests).

**ANANSI itself spends none of it.** Polling, dataset reads and the HTML archive are free — the
archive is a plain GET straight to the target site, and the read API is not billed per page load.
The page loads on the account are the customer's own scheduled runs, on their cadence, which
would happen with or without ANANSI. The only spend ANANSI can *initiate* is a heal, which is why
`credits_spent` now counts heal attempts and the console labels it that way.
`brightdata budget balance --json` is still the check. Credit-shortage escalation:
contact@wemakedevs.org.

## Error-code routing table (triage — decided now, encoded in packages/core/sense/)

Codes arrive from three places now: the job summary, per-row `error`/`error_code` fields in the
dataset, and ANANSI's own archive fetch (403 → `blocked`, 404 → `dead_page`, 5xx → retry). All
three route through the same table.

| Route | Codes | Why |
|---|---|---|
| **Heal-eligible** | `parse_error`, `wait_element_timeout`, `click_timeout`, contract/fill/band/CUSUM/invariant violations on HTTP 200 | the page changed; new instructions can fix it |
| **Never heal — infra lane** | `blocked`, `detection_block` (the docs' code string — `detect_block()` is the function name; match both), `captcha_timeout`, `proxy*`, `no_peers` | access problem; healing code can never fix it (ADR-003) |
| **Retry with backoff** | `infra_error`, `worker_too_busy`, `net_err_*`, `runner_disconnected`, 5xx, unparsed `row_error` | transient platform noise. "Retry" means *wait for the next scheduled run* — ANANSI does not re-run anything |
| **Mark dead, stop** | `bad_input`, `dead_page` | the URL is wrong/gone; alert human, don't spend |
| **Config review** | `too_many_pages`, `parse_mem/cpu_limit_exceeded`, `job_run_timeout` | our scraper's design problem |

A job that failed with **no** row-level code to explain it is `unexplained`: the two-strike rule
applies before a heal is spent, because one unexplained failure is far more often a platform
hiccup than a broken selector.

## IDE functions we deliberately exercise (Web-Slinger surface table)

`tag_html()` on every page load (snapshot source — **VERIFIED on live runs: parser code reads a
tag as `parser.<name>` and must RETURN it, and the OUTPUT SCHEMA must declare the field or
it is dropped silently**; `input.url` is returned explicitly for row attribution). Note that
most scrapers on an account will *not* do this, and there is no API to check or change that,
which is exactly why ANANSI keeps its own free HTML archive ·
`tag_response()` (S3 XHR heal, if it survives cuts) ·
`next_stage()` (books list→detail) · `collect()` **without** a validate_fn — deliberately:
a throwing validator makes Studio discard the whole record including the `tag_html` capture,
so M1 arrives as an empty row and the heal loop has nothing to diff (observed as incident
9708ba89); ANANSI's contract engine is the validity authority and must see the null ·
`detect_block()` (triage semantics) · `close_popup()` (M3 heal target) ·
`load_more()` (S4) · error taxonomy consumed end-to-end · Versions for rollback
(dashboard-only — no CLI rollback; ANANSI flags, a human clicks).

README surface table rule: render with a status column — "exercised in repo (file:line)" vs
"designed, cut for scope (see CUTS.md)" — so Tier cuts never read as overclaiming.


## The dataset does not always carry the failure (verified live, 2026-08-20)

`GET /dca/dataset?id=<job>` returned an **empty array** for a scheduled run that
the platform itself reported as `failed_pages=1, fails=1, success_rate=0`. The
dashboard's own export of that same run contained the reason:

```json
[{"input": {"url": ".../product/echo-speaker"}, "error": "Error: price missing"}]
```

So a run that had explained itself perfectly was reported by ANANSI as "failed
with no row-level error code", routed as unexplained, and quarantined without
ever attempting a heal.

The per-input failures live at **`GET /dca/jobs/{job_id}/hp_errors`**, which
answers `{"errors":[{"url":…,"error":…,"consumer":…}]}`. The monitor now calls it
whenever the job counters say a run failed and no row says why, and folds the
result into the same row shape (`input` + `error`) everything downstream reads.

Two consequences worth keeping in mind:

- **`data_lines` counts records, not rows.** A run whose only output is an error
  row reports `data_lines: 0`, which is why the volume check correctly said "0
  rows" while the export plainly had one. They are counting different things.
- **The message is prose, not a code.** `routeErrorCode` is right to treat
  "Error: price missing" as unknown and refuse to spend a heal on a sentence. It
  becomes routable only because it names a field the contract declares
  *required* — see `requiredFieldsNamedIn`. An error that names nothing we
  declared stays in its original lane, so an arbitrary message cannot invent a
  heal for itself.
