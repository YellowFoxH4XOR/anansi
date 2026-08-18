// Cross-field asserts from the contract, e.g. "sale_price == null || sale_price <= price".
// Contracts are trusted config authored in this repo, so a compiled Function over the
// record's field names is acceptable; anything throwing or non-boolean fails closed.

import type { Violation } from "../types.js";

export function checkInvariants(
  invariants: string[],
  fields: Record<string, unknown>,
  url: string,
  declaredFields: string[] = [],
): Violation[] {
  const out: Violation[] = [];
  // Bind every contract-declared field, defaulting absent ones to null, before
  // adding whatever else the row carried. A scraper that omits an optional
  // field entirely (production output schemas emit only declared fields) would
  // otherwise leave `sale_price` an undeclared identifier: under strict mode
  // that throws ReferenceError, fails closed, and turns a legitimately absent
  // optional field into a fleet-wide invariant violation — which is precisely
  // what `sale_price == null` was written to permit.
  const bound: Record<string, unknown> = {};
  for (const n of declaredFields) bound[n] = fields[n] ?? null;
  for (const [k, v] of Object.entries(fields)) if (!(k in bound)) bound[k] = v;

  const names = Object.keys(bound).filter((n) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(n));
  const values = names.map((n) => bound[n]);
  for (const expr of invariants) {
    let ok = false;
    try {
      const fn = new Function(...names, `"use strict"; return (${expr});`);
      ok = fn(...values) === true;
    } catch {
      ok = false;
    }
    if (!ok) out.push({ signal: "invariant", url, detail: `"${expr}" failed for ${JSON.stringify(fields)}` });
  }
  return out;
}
