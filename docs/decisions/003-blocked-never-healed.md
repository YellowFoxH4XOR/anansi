# ADR-003: `blocked` is never healed

**Status:** accepted · **Date:** 2026-08-15

## Context
Scraper Studio's error taxonomy distinguishes code-level failures (`parse_error`,
`wait_element_timeout`) from access-level failures (`blocked`, `captcha_timeout`, `proxy*`,
`no_peers`). A naive auto-heal loop treats every failure as a prompt for the healer.

## Decision
Triage routes by error class before any healing (full table in brightdata-notes.md):
- **Heal-eligible:** parser/selector/interaction failures, and every contract or golden-band
  violation on an HTTP 200 response.
- **Infra lane, never healed:** `blocked` and friends. Surfaced as an access incident;
  remediation is proxy/unblocker configuration (Bright Data's own job), not code.
- **Retry lane:** transient platform errors, exponential backoff.
- **Dead lane:** `bad_input` / `dead_page` — alert, stop spending, no retries.

## Rationale
Healing rewrites scraper code. A block is not a code problem; prompting the healer with
"we got a 403" invites it to mutate a working scraper into a broken one while the actual
cause (access) persists — spending 15-minute heal cycles and credits to make things worse.
The sharpest form of "reliability" is knowing which failures a fix *cannot* fix.

## Consequences
- A controlled 403 scenario verifies refusal-to-heal behavior.
- Requires trusting the error taxonomy; where ambiguous (e.g., `wait_element_timeout` caused
  by an interstitial), the DOM snapshot disambiguates — the diff shows a consent modal, not a
  removed element, and diagnosis routes accordingly.
- The triage table keeps the supported platform error taxonomy explicit and testable.
