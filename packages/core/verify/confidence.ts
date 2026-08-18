// Promotion is a conjunction of hard gates, never a score. This number is the
// weighted per-field pass fraction (required fields 3:1 over optional), reported
// for the audit trail and console only.

import type { Contract } from "../types.js";

export function confidence(contract: Contract, fieldPassed: Record<string, boolean>): number {
  let num = 0;
  let den = 0;
  for (const [name, spec] of Object.entries(contract.fields)) {
    const w = spec.required ? 3 : 1;
    den += w;
    if (fieldPassed[name] !== false) num += w;
  }
  return den === 0 ? 1 : num / den;
}
