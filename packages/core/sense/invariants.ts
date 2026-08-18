// Cross-field asserts from the contract, e.g. "sale_price == null || sale_price <= price".
// Contracts are trusted config authored in this repo, so a compiled Function over the
// record's field names is acceptable; anything throwing or non-boolean fails closed.

import type { Violation } from "../types.js";

export function checkInvariants(
  invariants: string[],
  fields: Record<string, unknown>,
  url: string,
): Violation[] {
  const out: Violation[] = [];
  const names = Object.keys(fields).filter((n) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(n));
  const values = names.map((n) => fields[n]);
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
