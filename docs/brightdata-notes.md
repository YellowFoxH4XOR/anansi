# Bright Data platform notes — verified facts

Everything here was checked against primary sources (docs.brightdata.com, github.com/brightdata/cli)
during planning. Re-verify the starred items in the D1 hour-one smoke test.

## CLI

```bash
npm install -g @brightdata/cli        # or curl -fsSL https://cli.brightdata.com/install.sh | sh
brightdata login                      # creates cli_unlocker / cli_browser zones
brightdata budget                     # true starting balance — check before the gun

brightdata scraper create <url> "<description>" --name anansi-lab -o create.json
brightdata scraper run <collector_id> <url> --sync            # canaries (25–50s server cap)
brightdata scraper run <collector_id> --urls "u1,u2" -o out.json   # batch
brightdata scraper heal <collector_id> "<generated diagnosis>" \
    --url <canary> --timeout 1800 -o heal.json                # ⭐ NEVER default timeout
brightdata scraper approve <collector_id> --url <canary>      # or --reject
```

## Load-bearing facts

| Fact | Value | Design consequence |
|---|---|---|
| Heal/AI-generation latency | 5–15 min, **up to 25** | loop is async; live demo = Sense→Diagnose only |
| CLI default `--timeout` | **600 s — less than worst case** | always pass `--timeout 1800` |
| Concurrent AI generations | **3 per account** — confirmed to cover heal (heal documents `--max-retries` for the concurrent-job-cap 429) | mutation matrix runs 3-wide, overnight |
| Heal without `--auto-approve` | stops at gate: `{status:"awaiting_approval", preview_result, diff_summary, view_url, next_step}` | V1 gate consumes `preview_result` |
| **`--url` on heal is cosmetic** | "woven into the success next_step hint (**not sent to the heal call**)" — `preview_result` is backend-chosen sample rows, no URL attribution | multi-canary regression check runs **post-approval (V2)**; scraper must `collect()` `input.url` so preview rows are attributable ⭐ try `run --version dev` on D1 |
| Heal prompt cap | **1000 chars max** | diagnose stage enforces truncate-and-retry; symptom + located change + expected output, never the raw diff |
| Approval | separate `scraper approve` call; `--reject` discards the pending fix | reject **before** any re-heal; gate decision is ours, auditable |
| `run --sync` | **single-URL only**; 2+ URLs route to the async batch endpoint | canary sweep = 3–5 individual --sync calls (or one async batch) |
| Billing | 1 credit = 1 page load; free 5k/mo; PAYG $1.5/1k | see credit budget below |
| Sync run cap | 25–50 s server-side | lazy-load canaries must go async |
| Result retention | 7 d realtime / 16 d batch | our store is the system of record, never theirs |
| **Output schema is a second layer** | renames fields, retypes them (`price` type + `raw` format → `{value,currency,symbol}`), and DROPS undeclared fields. Applied only on **Save to Production** | preview output ≠ production output; verify with `scraper run`, never the IDE preview alone |
| Versions menu | dashboard rollback to earlier scraper version | manual rollback demo is legitimate |

## Credit budget (solo)

**RESOLVED (site verified): the promo code IS the per-participant $50** — "Not a prize and
not split between teams: sign up with Bright Data and the $50 is yours to build with," via
code `wemakedevs` in billing. There is no second credit; 71k was a double-count. Firm budget:
free 5,000 + $50 (≈33.3k) ≈ **38k page loads** (billed only for successful requests). Fleet
at 30-min cadence, 5 URLs × 3 scrapers ≈ 5,040/week; dev iteration + matrix + goldens ≈ a
few thousand more — workable, with cadence held at 30–60 min. Budget guard in the scheduler
from D1; `brightdata budget balance --json` is the check. Credit-shortage escalation:
contact@wemakedevs.org.

## Error-code routing table (triage — decided now, encoded in sense/)

| Route | Codes | Why |
|---|---|---|
| **Heal-eligible** | `parse_error`, `wait_element_timeout`, `click_timeout`, contract/fill/band/CUSUM/invariant violations on HTTP 200 | the page changed; new instructions can fix it |
| **Never heal — infra lane** | `blocked`, `detection_block` (the docs' code string — `detect_block()` is the function name; match both), `captcha_timeout`, `proxy*`, `no_peers` | access problem; healing code can never fix it (ADR-003) |
| **Retry with backoff** | `infra_error`, `worker_too_busy`, `net_err_*`, `runner_disconnected`, 5xx | transient platform noise |
| **Mark dead, stop** | `bad_input`, `dead_page` | the URL is wrong/gone; alert human, don't spend |
| **Config review** | `too_many_pages`, `parse_mem/cpu_limit_exceeded`, `job_run_timeout` | our scraper's design problem |

## IDE functions we deliberately exercise (Web-Slinger surface table)

`tag_html()` every canary (snapshot source — **VERIFIED on live runs: parser code reads a
tag as `parser.<name>` and must RETURN it, and the OUTPUT SCHEMA must declare the field or
it is dropped silently**; `input.url` is returned explicitly for row attribution) ·
`tag_response()` (S3 XHR heal, if it survives cuts) ·
`next_stage()` (books list→detail) · `collect()` **without** a validate_fn — deliberately:
a throwing validator makes Studio discard the whole record including the `tag_html` capture,
so M1 arrives as an empty row and the heal loop has nothing to diff (observed as incident
9708ba89); ANANSI's contract engine is the validity authority and must see the null ·
`detect_block()` (triage semantics) · `close_popup()` (M3 heal target) ·
`load_more()` (S4) · error taxonomy consumed end-to-end · Versions for rollback
(dashboard-only — no CLI rollback; auto-detect, manual click).

README surface table rule: render with a status column — "exercised in repo (file:line)" vs
"designed, cut for scope (see CUTS.md)" — so Tier cuts never read as overclaiming.

## API (if the CLI subprocess ever binds us)

`POST https://api.brightdata.com/dca/trigger?collector=c_xxx&queue_next=1` (Bearer auth,
JSON array of inputs) → `{collection_id}`; poll `GET /dca/dataset?id=...` every 5 s —
object `{status:"building"}` while running, JSON array when done.
