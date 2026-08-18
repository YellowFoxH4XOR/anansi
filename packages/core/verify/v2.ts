// V2 · post-approval, before the incident closes: the full canary sweep, where
// every row has a URL. Goldens, no new drift, and the regression check (fields
// that weren't broken still aren't). A V2 fail means rollback via the dashboard
// Versions menu (no CLI rollback exists) + quarantine.

import type { Contract, FieldHistory, GateResult, RunRecord, Verdict } from "../types.js";
import { evaluate, NO_PRIOR } from "../sense/evaluate.js";
import { checkGolden } from "../sense/goldens.js";
import { confidence } from "./confidence.js";

export type RepinFlag = { field: string; url: string; anchor: unknown; promoted: unknown };

export type V2Result = Verdict & { repin_flags: RepinFlag[] };

const REPIN_EPSILON_PCT = 2; // promoted value drifting > ε from the anchor → human re-pin

export function verifyV2(
  contract: Contract,
  sweep: RunRecord[], // full canary sweep run against the promoted version
  preIncidentSweep: RunRecord[], // last healthy sweep — the regression baseline
  history: FieldHistory = {},
): V2Result {
  const gates: GateResult[] = [];
  const fieldPassed: Record<string, boolean> = {};
  const repin: RepinFlag[] = [];

  // Full sense pass over the sweep: contract, goldens, invariants, CUSUM ("no new
  // drift"). Prior flags empty on purpose — a fresh alarm here is disqualifying.
  const { result } = evaluate(contract, sweep, history, NO_PRIOR);
  const violations = result.kind === "incident" ? result.signals : [];
  for (const v of violations) if (v.field) fieldPassed[v.field] = false;
  gates.push({
    gate: "sweep_clean",
    pass: violations.length === 0,
    detail: violations.length
      ? violations.map((v) => `${v.signal}${v.field ? `:${v.field}` : ""} ${v.detail}`).join("; ")
      : `full sweep of ${sweep.length} canaries is healthy (contract · goldens · invariants · CUSUM)`,
  });

  // Regression check: every field that was non-null and golden-clean before the
  // incident must still be so — a heal that broke a previously-good field never
  // promotes at any "score".
  const regressions: string[] = [];
  for (const before of preIncidentSweep) {
    const after = sweep.find((r) => r.url === before.url);
    if (!after) continue;
    for (const [name, spec] of Object.entries(contract.fields)) {
      if (before.fields[name] != null && spec.required && after.fields[name] == null) {
        regressions.push(`${name}@${before.url} was populated pre-incident, now null`);
        fieldPassed[name] = false;
      }
    }
  }
  gates.push({
    gate: "no_regression",
    pass: regressions.length === 0,
    detail: regressions.length ? regressions.join("; ") : "previously-healthy fields are still healthy",
  });

  // Golden-anchor discipline: promotion never re-pins. A promoted numeric value
  // inside the band but > ε from the anchor flags for explicit human re-pin.
  for (const canary of contract.canaries) {
    const rec = sweep.find((r) => r.url === canary.url);
    if (!rec) continue;
    for (const [field, spec] of Object.entries(canary.goldens)) {
      if (!("tolerance_pct" in spec)) continue;
      const v = rec.fields[field];
      if (typeof v !== "number" || checkGolden(field, canary.url, spec, v)) continue;
      const epsilon = Math.abs(spec.value) * (REPIN_EPSILON_PCT / 100);
      if (Math.abs(v - spec.value) > epsilon) {
        repin.push({ field, url: canary.url, anchor: spec.value, promoted: v });
      }
    }
  }

  return {
    pass: gates.every((g) => g.pass),
    gates,
    confidence: confidence(contract, fieldPassed),
    repin_flags: repin,
  };
}
