// Heal-prompt builder. Hard CLI cap: 1000 chars. Shape: symptom → located change →
// expected output. Never the raw diff. Degrades gracefully: drop detail levels until
// it fits, then hard-truncate as a last resort.

import type { EvidencePack } from "./evidence.js";

export const PROMPT_MAX = 1000;

function lastSegment(path: string): string {
  const parts = path.split(" > ");
  return parts.slice(-2).join(" > ");
}

function render(ev: EvidencePack, level: number): string {
  const lines: string[] = [];

  const symptom =
    ev.failing_fields.length > 0
      ? `Field(s) ${ev.failing_fields.join(", ")} broke: ${ev.signals[0]?.detail ?? "contract violation"}.`
      : `Scraper failed: ${ev.signals[0]?.detail ?? "unknown"}.`;
  lines.push(symptom);

  // No baseline page → no diff. The prompt still works: value_locations below
  // tells the healer where the right value renders today, which is the part it
  // can act on. Saying "an element vanished" was never the actionable half.
  const rm = (ev.dom_diff?.removed ?? []).slice(0, level >= 2 ? 1 : 2);
  const ad = (ev.dom_diff?.added ?? []).slice(0, level >= 2 ? 1 : 2);
  if (rm.length) {
    lines.push(`Page change: element ${rm.map((c) => (level >= 1 ? lastSegment(c.path) : c.path)).join("; ")} no longer exists.`);
  }
  if (ad.length) {
    lines.push(
      `New element(s) appeared: ${ad
        .map((c) => `${level >= 1 ? lastSegment(c.path) : c.path}${c.text && level < 2 ? ` ("${c.text.slice(0, 40)}")` : ""}`)
        .join("; ")}.`,
    );
  }

  for (const loc of ev.value_locations.slice(0, level >= 2 ? 1 : 2)) {
    const at = loc.found_at[0];
    if (at) {
      lines.push(`The correct ${loc.field} ("${loc.expected}") now renders at ${level >= 1 ? lastSegment(at.path) : at.path}.`);
    }
  }

  if (ev.prior_failures.length && level < 3) {
    lines.push(`Previous fix attempt failed verification: ${ev.prior_failures[ev.prior_failures.length - 1]!.slice(0, 120)}. Try a different approach.`);
  }

  lines.push(
    `Fix the scraper so ${ev.failing_fields.length ? ev.failing_fields.join(", ") + " match" : "output matches"} the page's real values again; leave working fields untouched.`,
  );
  return lines.join(" ");
}

export function buildPrompt(ev: EvidencePack): string {
  for (let level = 0; level <= 3; level++) {
    const p = render(ev, level);
    if (p.length <= PROMPT_MAX) return p;
  }
  return render(ev, 3).slice(0, PROMPT_MAX);
}
