// Evidence pack: everything Diagnose learned, as plain data. The prompt builder
// (and the console's split-diff view) render from this — never from raw HTML.

import type { Incident, Contract } from "../types.js";
import { diffHtml, locateValue, type DomChange, type DomDiff } from "./diff.js";
import { pinnedValue } from "../sense/goldens.js";

export type EvidencePack = {
  scraper: string;
  failing_fields: string[];
  signals: { signal: string; field?: string; detail: string }[];
  dom_diff: DomDiff;
  value_locations: { field: string; expected: unknown; found_at: DomChange[] }[];
  prior_failures: string[]; // appended on retry so the next heal knows what didn't work
};

export function buildEvidence(
  incident: Incident,
  contract: Contract,
  lastGoodHtml: string,
  currentHtml: string,
  priorFailures: string[] = [],
): EvidencePack {
  const failing = [...new Set(incident.signals.map((s) => s.field).filter((f): f is string => !!f))];
  const dd = diffHtml(lastGoodHtml, currentHtml);

  // For each failing golden-pinned field, find where its expected value renders now.
  const locations: EvidencePack["value_locations"] = [];
  for (const canary of contract.canaries) {
    for (const [field, spec] of Object.entries(canary.goldens)) {
      if (!failing.includes(field)) continue;
      const expected = pinnedValue(spec);
      if (Array.isArray(expected)) continue;
      const found = locateValue(currentHtml, expected).slice(0, 3);
      if (found.length) locations.push({ field, expected, found_at: found });
    }
  }

  return {
    scraper: incident.scraper,
    failing_fields: failing,
    signals: incident.signals.map((s) => ({ signal: s.signal, field: s.field, detail: s.detail })),
    dom_diff: dd,
    value_locations: locations,
    prior_failures: priorFailures,
  };
}
