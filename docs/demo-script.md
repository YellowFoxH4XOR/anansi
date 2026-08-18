# Demo video — 3:00, beat by beat

Presentation is one-sixth of the score and the only artifact guaranteed watched end-to-end.
Structural decision: **the kill shot runs early (0:40)** — 5–10 lookalike
dashboard-plus-heal submissions are expected, and judges bin lookalikes inside a minute.

| Time | Beat | On screen |
|---|---|---|
| 0:00 | **The number, not the feeling** | A price silently wrong for 11 days — **captioned "Scenario:"** (the build week is 7 days; an unframed 11-day stat from our own system would read as fabricated telemetry, violating our no-fake rule in the exact window judges bin submissions). One sentence of cost: at fleet scale, N corrupted records feeding pricing decisions. No talking head; title card ≤ 2 s. |
| 0:20 | **The gap** | The real `heal` command — Bright Data built the repair — then the three human steps still around it. Line: *"null-checking catches none of this — watch."* |
| 0:40 | **Kill shot, compressed** | Fire M2 on camera. Scraper returns 200, valid JSON, wrong number. Golden band catches it. Twenty seconds, no mechanism yet — every lookalike is now behind us. **Deterministic: Sense-only, no heal, no LLM — bankable the moment Sense works (D2 night), not D4.** |
| 1:00 | **Now the machine** | Fleet green → mutation fires → amber → red, showing *which* signal tripped and why. |
| 1:25 | **The diagnosis writes itself** | Split DOM diff, then the generated heal prompt typing out. Best 20 seconds we own — let it breathe, no voiceover on top. |
| 1:50 | **Heal and gate** | Open with 3–4 s of the **Scraper Studio IDE itself** (the hand-authored scraper, `tag_html`/`collect` visible — "their healer, our gate" lands harder with their product on screen), then: proposed diff → V1 preview check against goldens → approve → **V2 full canary sweep confirms, regression watched** (narrate the two-phase gate honestly — the preview is backend-chosen sample rows, and a judge who reads the CLI docs knows it). Real elapsed time as a labelled cut ("11 min later"). The honest timestamp is a credibility asset. |
| 2:20 | **The output** | The structured records + the protected feed with trustworthy-days counter. The criterion literally names output — show it. |
| 2:45 | **Operations close** | Audit trail, credits per incident, one rollback. 15 s. No summary slide, no thanks-for-watching. |

## Fallback strategy (decided before it's needed)

- Bank a clean take of **every** beat as soon as it becomes shootable: 0:40 on D2 night
  (Sense-only, deterministic — no heal involved), console beats from D4; D6 is assembly,
  not production. The real console capture window is only D4 evening–D5 evening — D5
  evening is a protected session.
- Only beat **1:50** depends on a nondeterministic heal succeeding during the busiest
  weekend on Bright Data's backend. If a heal produces a wrong fix on camera: **use it** —
  the trust gate rejecting a bad heal and refusing to promote is a *better* demo than a
  clean pass. Narrate it, don't reshoot it.
- Beat **2:20** must survive a Tier-2 cut: if the visible-patient feed is cut under D5
  pressure, 2:20 shows the structured JSON records diffed against the golden record plus the
  protected/quarantine state in the console — all Tier 1, shootable from D4. The
  "structured output" clause of the Presentation criterion is satisfied either way.
- Never fake speed or splice fake results. On-screen timestamps everywhere time is cut.

## Capture log (fill during the week)

| Take | Beat | Date | Quality | File |
|---|---|---|---|---|
| | | | | |
