// V1 · pre-approval gate, consumed from heal's preview_result. The CLI's --url on
// heal is cosmetic — preview rows are backend-chosen samples — so V1 checks only
// what preview rows can prove: contract clean, invariants hold, goldens for any
// row attributable via its collected input.url, and the hardcode detector.

import type { Contract, GateResult, Verdict } from "../types.js";
import { checkFields } from "../sense/contract.js";
import { checkInvariants } from "../sense/invariants.js";
import { checkGolden, pinnedValue } from "../sense/goldens.js";
import { locateValue } from "../diagnose/diff.js";
import { locatableValues, rowShape, unrestoredRoots } from "../sense/rows.js";
import { confidence } from "./confidence.js";

export type PreviewRow = { url?: string; fields: Record<string, unknown> };

export function verifyV1(
  contract: Contract,
  previewRows: PreviewRow[],
  currentSnapshots: Record<string, string>, // captured target url → current (mutated) HTML
  failingFields: string[],
  /** What this scraper emitted while it was working, by url. The shape gate
   *  measures the healed preview against it — which is how promotion works for a
   *  scraper nobody described, of any shape. */
  knownGood: Record<string, Record<string, unknown>> = {},
): Verdict {
  const gates: GateResult[] = [];
  const fieldPassed: Record<string, boolean> = {};

  if (previewRows.length === 0) {
    gates.push({ gate: "preview_nonempty", pass: false, detail: "heal returned no preview rows" });
    return { pass: false, gates, confidence: 0 };
  }
  gates.push({ gate: "preview_nonempty", pass: true, detail: `${previewRows.length} preview row(s)` });

  // Contract + invariants over every preview row.
  const contractViolations = previewRows.flatMap((r) => [
    ...checkFields(contract.fields, r.fields, r.url ?? "preview"),
    ...Object.entries(contract.fields)
      .filter(([n, s]) => s.required && r.fields[n] == null)
      .map(([n]) => ({ signal: "contract" as const, field: n, detail: "required field null in preview" })),
  ]);
  for (const v of contractViolations) if (v.field) fieldPassed[v.field] = false;
  gates.push({
    gate: "contract_clean",
    pass: contractViolations.length === 0,
    detail: contractViolations.length ? contractViolations.map((v) => `${v.field}: ${v.detail}`).join("; ") : "all preview rows satisfy the contract",
  });

  const invariantViolations = previewRows.flatMap((r) => checkInvariants(contract.invariants, r.fields, r.url ?? "preview"));
  gates.push({
    gate: "invariants_hold",
    pass: invariantViolations.length === 0,
    detail: invariantViolations.length ? invariantViolations.map((v) => v.detail).join("; ") : "all invariants hold",
  });

  // Goldens — only for rows we can attribute to a canary via input.url.
  const goldenViolations = [];
  let attributable = 0;
  for (const row of previewRows) {
    const canary = row.url ? contract.canaries.find((c) => c.url === row.url) : undefined;
    if (!canary) continue;
    attributable++;
    for (const [field, spec] of Object.entries(canary.goldens)) {
      const v = checkGolden(field, canary.url, spec, row.fields[field]);
      if (v) {
        goldenViolations.push(v);
        fieldPassed[field] = false;
      }
    }
  }
  gates.push({
    gate: "goldens_attributable",
    pass: goldenViolations.length === 0,
    detail:
      attributable === 0
        ? "no preview row attributable to a canary — golden check deferred to V2"
        : goldenViolations.length
          ? goldenViolations.map((v) => `${v.field}@${v.url}: ${v.detail}`).join("; ")
          : `goldens pass on ${attributable} attributable row(s)`,
  });

  // Hardcode detector: a value the heal claims to have scraped must actually
  // appear in the live page. This is the gate that makes promotion safe WITHOUT
  // goldens — it needs no opinion about which value is correct, only that the
  // one produced was read from the page rather than written into the template.
  //
  // It used to iterate failingFields, which is populated from golden violations.
  // A collector with no goldens named no fields, and a run that returned zero
  // rows names none either — so the one check standing between a fabricated fix
  // and production passed vacuously in exactly the two cases ANANSI now targets.
  // With nothing named, every value in the preview is checked.
  const hardcodeFailures: string[] = [];
  for (const row of previewRows) {
    const snap = row.url ? currentSnapshots[row.url] : undefined;
    if (!snap) continue;
    // Two strictnesses, because there are two questions.
    //
    // When a field is NAMED as broken, that exact value must come from the page:
    // it is the one the heal claims to have fixed, so a miss is the hardcode
    // this gate exists to catch.
    //
    // When nothing is named — a run that returned zero rows names nothing — the
    // question is instead "was this whole record fabricated". Demanding every
    // scalar match would sink correct heals over ordinary things: a derived
    // field, a value reformatted on the way out, a tag rendered as an
    // attribute. A fabricated record scores near zero; a real one scores high.
    if (failingFields.length) {
      const named = locatableValues(row.fields).filter((l) => failingFields.some((f) => l.path === f || l.path.startsWith(`${f}.`) || l.path.startsWith(`${f}[`)));
      for (const leaf of named) {
        if (locateValue(snap, leaf.value).length === 0) {
          hardcodeFailures.push(`${leaf.path}="${leaf.value}" not present in the live DOM for ${row.url}`);
          fieldPassed[leaf.path.split(/[.[]/)[0]!] = false;
        }
      }
    } else {
      const leaves = locatableValues(row.fields);
      const missing = leaves.filter((l) => locateValue(snap, l.value).length === 0);
      if (leaves.length > 0 && missing.length * 2 >= leaves.length) {
        for (const m of missing) fieldPassed[m.path.split(/[.[]/)[0]!] = false;
        hardcodeFailures.push(
          `${missing.length} of ${leaves.length} value(s) absent from the live DOM for ${row.url}` +
            ` (e.g. ${missing[0]!.path}="${String(missing[0]!.value).slice(0, 60)}") — the record reads as written, not scraped`,
        );
      }
    }
  }
  // Shape gate: the healed rows must fill what this scraper used to fill.
  //
  // This is the check that needs nothing declared — no contract, no goldens, no
  // output_schema. A scraper's own last good output IS its specification, and
  // comparing leaf paths works identically for a flat row, a nested price object
  // and a list of ten quotes. Type assertions could not do this: `price` is
  // declared `price` and arrives as an object, `quotes` is declared `array` and
  // arrives as records, so a declared type says little about the value.
  const knownShape = new Set(Object.values(knownGood).flatMap((f) => [...rowShape(f)]));
  if (knownShape.size > 0) {
    const healedShape = new Set(previewRows.flatMap((r) => [...rowShape(r.fields)]));
    const stillMissing = unrestoredRoots(knownShape, healedShape);
    for (const field of stillMissing) fieldPassed[field] = false;
    gates.push({
      gate: "shape_restored",
      pass: stillMissing.length === 0,
      detail: stillMissing.length
        ? `still not filled after the heal: ${stillMissing.slice(0, 6).join(", ")}`
        : `every field this scraper used to fill is filled again (${new Set([...knownShape].map((p) => p.split(/[.[]/)[0]!)).size} checked)`,
    });
  }

  gates.push({
    gate: "value_in_dom",
    pass: hardcodeFailures.length === 0,
    detail: hardcodeFailures.length ? hardcodeFailures.join("; ") : "every healed value exists in the live DOM (not hardcoded)",
  });

  return {
    pass: gates.every((g) => g.pass),
    gates,
    confidence: confidence(contract, fieldPassed),
  };
}

export { pinnedValue };
