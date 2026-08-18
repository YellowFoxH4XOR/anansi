// The Sense engine: one sweep's records + contract + history → Incident | Healthy.
// Signal order and semantics follow docs/data-contract.md.

import type {
  Contract,
  FieldHistory,
  Incident,
  Route,
  RunRecord,
  SenseResult,
  Violation,
} from "../types.js";
import { checkFields } from "./contract.js";
import { checkGolden, bandWidth } from "./goldens.js";
import { checkInvariants } from "./invariants.js";
import { cusum, DEFAULT_CUSUM, type CusumParams } from "./cusum.js";
import { routeErrorCode } from "./triage.js";

// Signals that need confirmation across consecutive sweeps carry state between
// evaluations as plain data (keys: fill-rate → field name, CUSUM → `${field}|${url}`).
export type PriorFlags = { fill_rate: string[]; cusum: string[] };
export const NO_PRIOR: PriorFlags = { fill_rate: [], cusum: [] };

export type SenseOutput = {
  result: SenseResult;
  flags: PriorFlags; // feed back into the next sweep's evaluate()
};

const ROUTE_PRECEDENCE: Route[] = ["infra", "dead", "config", "heal", "retry"];

export function evaluate(
  contract: Contract,
  records: RunRecord[],
  history: FieldHistory = {},
  prior: PriorFlags = NO_PRIOR,
  cusumParams: CusumParams = DEFAULT_CUSUM,
): SenseOutput {
  const violations: Violation[] = [];
  const warnings: Violation[] = [];
  const errorRoutes = new Set<Route>();
  const nextFlags: PriorFlags = { fill_rate: [], cusum: [] };

  // 1 · Hard fail — error_code present, routed by the triage table.
  const failed = records.filter((r) => r.error_code);
  for (const r of failed) {
    const route = routeErrorCode(r.error_code!);
    errorRoutes.add(route);
    violations.push({ signal: "hard_fail", url: r.url, detail: `error_code=${r.error_code} → ${route} lane` });
  }
  const ok = records.filter((r) => !r.error_code);

  // 2 · Contract — per-record type/range/length checks.
  for (const r of ok) violations.push(...checkFields(contract.fields, r.fields, r.url));

  // 2b/3 · Required-null split: all-canaries-null is an instant contract violation
  // (hard null); a partial drop below fill_rate_min is signal 3 and needs two
  // consecutive failing sweeps to absorb transient render misses.
  const requiredFields = Object.entries(contract.fields).filter(([, s]) => s.required);
  if (ok.length > 0) {
    for (const [name] of requiredFields) {
      const nonNull = ok.filter((r) => r.fields[name] != null).length;
      const fill = nonNull / ok.length;
      if (nonNull === 0) {
        violations.push({ signal: "contract", field: name, detail: `required field null on all ${ok.length} canaries (hard null)` });
      } else if (fill < contract.fill_rate_min) {
        const flagged = prior.fill_rate.includes(name);
        const v: Violation = { signal: "fill_rate", field: name, detail: `fill ${nonNull}/${ok.length} = ${fill.toFixed(2)} < ${contract.fill_rate_min}${flagged ? " (2nd consecutive sweep)" : " (1st sweep — watching)"}` };
        if (flagged) violations.push(v);
        else {
          warnings.push(v);
          nextFlags.fill_rate.push(name);
        }
      }
    }
  }

  // 4 · Golden band — pinned canaries vs declared tolerance. Catches the silent lie.
  for (const canary of contract.canaries) {
    const rec = ok.find((r) => r.url === canary.url);
    if (!rec) continue;
    for (const [field, spec] of Object.entries(canary.goldens)) {
      const v = checkGolden(field, canary.url, spec, rec.fields[field]);
      if (v) violations.push(v);
    }
  }

  // 5 · CUSUM — sustained small shifts inside the band; warn first, escalate on
  // persistence. σ floor tied to the golden band width where one exists.
  for (const [field, spec] of Object.entries(contract.fields)) {
    if (spec.type !== "number") continue;
    for (const r of ok) {
      const x = r.fields[field];
      if (typeof x !== "number") continue;
      const hist = history[field]?.[r.url] ?? [];
      const golden = contract.canaries.find((c) => c.url === r.url)?.goldens[field];
      const bw = golden ? bandWidth(golden) : undefined;
      const res = cusum(hist, [...hist, x], { ...cusumParams, bandWidth: bw });
      if (res.alarm) {
        const key = `${field}|${r.url}`;
        const flagged = prior.cusum.includes(key);
        const v: Violation = { signal: "cusum", field, url: r.url, detail: `${res.side}-side drift: S=${(res.side === "upper" ? res.sPlus : res.sMinus).toFixed(3)} > h (μ=${res.mean.toFixed(2)}, σ_eff=${res.sigmaEff.toFixed(3)})${flagged ? " (persistent)" : " (first alarm — warning)"}` };
        if (flagged) violations.push(v);
        else {
          warnings.push(v);
          nextFlags.cusum.push(key);
        }
      }
    }
  }

  // 6 · Invariants — cross-field asserts.
  for (const r of ok) violations.push(...checkInvariants(contract.invariants, r.fields, r.url));

  if (violations.length === 0) {
    return { result: { kind: "healthy", warnings }, flags: nextFlags };
  }

  const route =
    ROUTE_PRECEDENCE.find((rt) => errorRoutes.has(rt)) ??
    (violations.some((v) => v.signal !== "hard_fail") ? "heal" : "retry");

  const incident: Incident = {
    kind: "incident",
    scraper: contract.scraper,
    route,
    signals: violations,
    records,
    snapshot_refs: records.flatMap((r) => (r.snapshot_ref ? [r.snapshot_ref] : [])),
  };
  return { result: incident, flags: nextFlags };
}
