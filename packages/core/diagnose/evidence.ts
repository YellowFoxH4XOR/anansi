// Evidence pack: everything Diagnose learned, as plain data. The prompt builder
// (and the console's split-diff view) render from this — never from raw HTML.
//
// A last-good page is OPTIONAL and always was, in every sense that matters. The
// diff is enrichment; the load-bearing line is value_locations — "the correct
// price (49.99) now renders at .price-block" — and producing that needs only the
// page as it is NOW plus a value we know is right. Requiring a baseline scoped
// Diagnose to scrapers that happen to collect HTML, which is a minority: Studio's
// tag_html is opt-in, so most collectors have no historical page anywhere and
// never will. Known-good VALUES, by contrast, are every scraper's own output.

import type { Incident, Contract } from "../types.js";
import { diffHtml, locateValue, type DomChange, type DomDiff } from "./diff.js";
import { pinnedValue } from "../sense/goldens.js";

export type EvidencePack = {
  scraper: string;
  failing_fields: string[];
  signals: { signal: string; field?: string; detail: string }[];
  /** Absent when no baseline page exists — the common case for a collector that
   *  collects no HTML. Its absence weakens the prompt; it does not block it. */
  dom_diff?: DomDiff;
  value_locations: { field: string; expected: unknown; found_at: DomChange[] }[];
  prior_failures: string[]; // appended on retry so the next heal knows what didn't work
};

/** Values this scraper is known to have produced correctly, by url then field.
 *  Sourced from its own last good run — so it exists for every scraper, with no
 *  contract written and no HTML collected. */
export type KnownGood = Record<string, Record<string, unknown>>;

export function buildEvidence(
  incident: Incident,
  contract: Contract,
  lastGoodHtml: string | undefined,
  currentHtml: string,
  priorFailures: string[] = [],
  knownGood: KnownGood = {},
): EvidencePack {
  const failing = [...new Set(incident.signals.map((s) => s.field).filter((f): f is string => !!f))];

  // Two sources of "what this field should say", tried in that order:
  //   1. a golden someone pinned by hand — authoritative, but optional and rare
  //   2. the value the scraper itself last produced for that url — always there
  // Deduped by field+value so a golden and an identical observation don't both
  // spend a line of a 1000-char prompt.
  const expectations: { field: string; expected: unknown }[] = [];
  for (const canary of contract.canaries) {
    for (const [field, spec] of Object.entries(canary.goldens)) {
      if (!failing.includes(field)) continue;
      const expected = pinnedValue(spec);
      if (Array.isArray(expected)) continue;
      expectations.push({ field, expected });
    }
  }
  for (const fields of Object.values(knownGood)) {
    for (const [field, expected] of Object.entries(fields)) {
      // A field that broke is the one worth locating; when nothing named a field
      // (a run that produced no rows at all names none) every known value is a
      // candidate, because any of them landing somewhere new explains the break.
      if (failing.length && !failing.includes(field)) continue;
      if (expected == null || typeof expected === "object") continue;
      expectations.push({ field, expected });
    }
  }

  const seen = new Set<string>();
  const locations: EvidencePack["value_locations"] = [];
  for (const { field, expected } of expectations) {
    const key = `${field}\u0000${String(expected)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const found = locateValue(currentHtml, expected).slice(0, 3);
    if (found.length) locations.push({ field, expected, found_at: found });
  }

  return {
    scraper: incident.scraper,
    failing_fields: failing,
    signals: incident.signals.map((s) => ({ signal: s.signal, field: s.field, detail: s.detail })),
    ...(lastGoodHtml === undefined ? {} : { dom_diff: diffHtml(lastGoodHtml, currentHtml) }),
    value_locations: locations,
    prior_failures: priorFailures,
  };
}
