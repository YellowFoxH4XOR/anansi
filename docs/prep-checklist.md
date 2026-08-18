# Prep checklist

Preparation tasks and mandatory rules for submission.

## Accounts (do these today — some are things only you can do)
- [ ] Register for the hackathon via the form on wemakedevs.org/hackathons/scrape-verse
      (registration alone = one MK5 helmet raffle entry)
- [ ] **Join the WeMakeDevs Discord** — the exact submission deadline time/timezone is
      announced only there. (Calendar resolved: Aug 17, 2026 is a Monday; window is Mon→Sun.)
- [ ] Create Bright Data account
- [ ] Redeem promo `wemakedevs` (all lowercase, in the billing section) — the credits are
      load-bearing. RESOLVED: the code IS the per-participant $50, there is no second credit;
      **~38k page loads is the firm budget** (see brightdata-notes.md). Ground-truth with
      `brightdata budget balance` at the gun.
- [ ] Install CLI: `npm i -g @brightdata/cli` → `brightdata login` → zones provision
- [ ] `brightdata budget` — record the true starting balance
- [ ] Vercel account ready for the Lab deploy
- [ ] Plan build-in-public posts (10 swag boxes go to people who share during the week)

## Rules that bind the submission (verified against the /rules page)
- Rule 5: a **custom Scraper Studio scraper is mandatory** — library-only disqualifies
  (our hand-authored Lab scraper satisfies this; it stays Tier 1).
- Rule 9: five required components — public repo · clear README · **example structured
  output committed in the repo** · demo video · explanation of Scraper Studio usage.
- Rule 10: AI-assistant use must be disclosed (README section is required, not optional).
- Submission form appears **on the event page itself** before the deadline — watch the page
  daily from D5, alongside Discord. No video length limit exists; 3:00 is our choice.

## Reading (2–3 hours total)
- [ ] Scraper Studio functions reference — especially `tag_html`, `tag_response`,
      `next_stage`, `detect_block`, `close_popup`, `collect(validate_fn)`
- [ ] Error-codes page — the routing table in brightdata-notes.md should feel obvious after
- [ ] CUSUM in one sitting (k = allowance, h = threshold; that's genuinely most of it) —
      enough to explain ADR-001 out loud without notes
- [ ] Skim Kushmerick 1999 abstract (wrapper verification) — one sentence of it goes in the README

## Already written (this folder)
- [x] Architecture + adapter design
- [x] Contract schema + signal spec
- [x] Mutation Lab spec (3 ship + 3 stretch)
- [x] CUTS.md tier list
- [x] ADRs 001–003 drafted
- [x] Runbook D1–D7
- [x] Demo beat sheet + fallback strategy
- [x] Bright Data verified-facts reference

## At the gun (first hour of D1)
- [ ] `git init`, commit this planning pack as-is (dated pre-work = notes, which is legal
      and transparent), repo public
- [ ] Hour-one smoke test per runbook.md
