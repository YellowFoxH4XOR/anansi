# Build runbook — seven days, solo

Organizing fact: **a heal takes 5–25 minutes and parallelizes at most 3-wide.** Heals run in
the background from D1 evening onward; everything buildable against banked `heal.json`
fixtures is built that way. ~84 working hours total; CUTS.md governs all trade-offs.

## D1 · Mon Aug 17 — spike, deploy, start the harness

| Hour | Do |
|---|---|
| 1 | `git init` + first commit (README, docs, CUTS.md). Smoke test: `brightdata login`, `budget balance --json` (bare `budget` may not print the balance), throwaway `scraper create` + `run --sync` + `heal --timeout 1800` (fire-and-forget: check the result later, build while it runs) + `approve` on any page. Record: real latency; the **shape of `preview_result`** (row count, any URL attribution); whether `scraper run <id> <url> --version dev` executes the pending heal candidate (if yes, V1 upgrades to a full pre-approval canary sweep); the exact `error_code` string a blocked page emits (`blocked` vs `detection_block`). |
| 2–4 | Mutation Lab live on Vercel: 4 product pages + listing, M1 + M2 working, `/__control` + `?mutate=` links, RESET. |
| 5–7 | Hand-author the Lab scraper in Scraper Studio IDE: `tag_html()` on every run, `collect()` validation, correct `dead_page`/`bad_input` semantics. Pin golden records. |
| 8–9 | Adapter interface + real CLI adapter (subprocess) + store (SQLite). |
| evening | **Start the characterization harness**: loop M1 → heal → bank heal.json → **`approve --reject`** → RESET, all night. The reject is non-negotiable: approving would move the collector to M1-adapted markup while RESET restores baseline, silently corrupting every later fixture AND the production scraper. Each stored run row records the Lab's mutation state at capture time (one KV read) so D2's CUSUM tuning can filter to clean baselines. **Supervise one full cycle (~60 min worst case) before sleeping** — verify cycle 2 starts from a clean collector; if the version ever moves, the dashboard Versions menu is the recovery path. By morning: real latency distribution + 8–10 banked fixtures. |

## D2 · Tue Aug 18 — Sense, entirely offline
Contract engine, tolerance bands, CUSUM over run history, invariants, canary runner,
fill-rate. **Fake adapter + unit tests on all of it — no network, no credits.** Tonight: a
mutated Lab page produces a correctly classified Incident, provably. Read overnight harness
results; tune CUSUM k/h on state=none Lab history (two-sided pair + σ floor per ADR-001).
**Bank the 0:40 kill-shot take tonight** — it is Sense-only (fire M2, sync run, golden band
trips), fully deterministic, no heal involved; don't wait for D4. Start 30 min/day of README
drafting (runs D2–D5).

## D3 · Wed Aug 19 — Diagnose, close the loop once
DOM normalization (strip hydration ids/nonces/timestamps/CSS-in-JS suffixes) + subtree diff +
evidence pack + LLM prompt generation (≤1000 chars, hard CLI cap) + heal/approve/**reject**
driver — the fail path always rejects the pending fix before re-healing. **Milestone: end-to-end on M1
only** — that is the honest Wednesday. Kick off overnight 3-wide matrix: M2, M3, S1.

## D4 · Thu Aug 20 — Trust gate on fixtures; console starts
Morning: verify gate (goldens, regression check, confidence, quarantine) built **against
banked fixtures**. Wire to live results from the overnight matrix. Afternoon: split-diff view
+ incident trace. **Start recording takes today** — every clean loop closure is footage.

## D5 · Fri Aug 21 — Real targets, audit, patient
Books sandbox scraper (`next_stage()` list→detail) + one real target (PII-excluded contract).
Audit log with credits-per-incident. Visible-patient feed if Tier 2 survives. Console polish.
**Evening is a protected capture session** for the three console beats (1:00, 1:25, 1:50) —
it outranks any remaining Tier-2 feature; the real capture window is only D4 eve–D5 eve.
README sections now mostly written. From today, check the event page daily — the submission
form appears there before the deadline.

## D6 · Sat Aug 22 — Freeze at noon, then assemble
Feature freeze 12:00, no exceptions. README final (surface table, prior art para, AI
disclosure, example output committed), 3 ADRs finalized, architecture diagram. Video =
**assembly of banked takes** (editing runs 6–12 h at normal ratios — capture already
happened). If attending the SF event, today is ~6 h: move README final to D5, protect the edit.

## D7 · Sun Aug 23 — Submit in the morning
Deadline time/timezone are published nowhere on the site — watch **both** Discord and the
event page (the submission form goes up on the page itself; needs repo, demo video, project
description, and the Scraper-Studio-usage explanation per Rule 9). Treat Sunday morning as
the deadline: file the form complete, then keep improving and re-file/re-record a weak beat
only with hours to spare.

> Calendar check (verified): Aug 17, 2026 is a Monday, so the window is Mon 17 → Sun 23 —
> a clean 7 days, no shifting needed. Still confirm the exact start/end *times* on Discord.

## Recovering a quarantined collector

Quarantine is deliberate and sticky: `sweepOnce` skips any collector that is not
`healthy`/`watching`, so the agent stays dormant until an operator clears it
(ADR-002 — the gate does not self-open). After fixing the underlying cause:

```bash
# in the agent container
npm run collector:reset -- lab-storefront "saved corrected Studio version"
```

It returns the state machine to `healthy` and clears the fill-rate/CUSUM
persistence flags, so the next tick starts from a clean sweep. Incidents, runs,
snapshots and credit accounting are preserved, and the reset is written to the
audit log as `operator_reset` — never delete the volume to clear a quarantine.

Check the cause is actually fixed *before* resetting, or the next sweep
re-quarantines and spends another round of heal attempts:

```bash
brightdata scraper run <collector_id> <canary-url> --sync -o /tmp/v.json
```

## Standing rules
- Anything that waits on a heal goes background; never sit watching a spinner.
- Fixture-first: UI and gate development never call the real backend.
- Commit small with conventional messages; the history is a judged artifact.
- 30 minutes of README/ADR prose daily D2–D5 beats a D6 documentation panic.
