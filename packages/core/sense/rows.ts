// One shape-agnostic view of a scraped row.
//
// ANANSI has now met three dataset shapes from the same endpoint on one account:
// an array of flat rows, a single object holding a nested array, and JSONL whose
// price is {value, currency, symbol}. Each one broke something, because the code
// underneath kept asking "what type did output_schema declare" and then assuming
// the value matched. It frequently does not: `price` is declared `price` and
// arrives as an object; `quotes` is declared `array` and arrives as ten records.
//
// So nothing here reads the schema. A row is a tree, and what ANANSI actually
// needs from it are its leaves: the scalars a page is supposed to render. Ask
// the row what it contains rather than asking a declaration what it should.

/** A scalar found in a row, and the path it was found at. */
export type Leaf = { path: string; value: string | number | boolean };

const MAX_DEPTH = 6;
const MAX_LEAVES = 200;

/** Every scalar in a row, with array indices collapsed so ten quotes yield
 *  `quotes[].text` ten times rather than `quotes[0].text` … `quotes[9].text`.
 *  Collapsing is what makes the path comparable ACROSS runs — a list that grew
 *  by one item must not read as a changed shape. */
export function flattenRow(value: unknown, prefix = "", out: Leaf[] = [], depth = 0): Leaf[] {
  if (out.length >= MAX_LEAVES || depth > MAX_DEPTH) return out;
  if (value == null) return out;

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    if (typeof value === "number" && !Number.isFinite(value)) return out;
    out.push({ path: prefix || "value", value });
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) flattenRow(item, `${prefix}[]`, out, depth + 1);
    return out;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      flattenRow(v, prefix ? `${prefix}.${k}` : k, out, depth + 1);
    }
  }
  return out;
}

/** The distinct paths a row filled. This is the row's SHAPE — what a scraper
 *  produces when it is working — learned from output rather than declared. */
export function rowShape(fields: Record<string, unknown>): Set<string> {
  return new Set(flattenRow(fields).map((l) => l.path));
}

/** Paths present in `before` that `after` no longer fills.
 *
 *  The whole breakage question in one function, and it needs no contract, no
 *  goldens and no schema: a scraper that used to emit price.value and now does
 *  not has broken, whatever its shape, whoever wrote it. */
export function droppedPaths(before: Set<string>, after: Set<string>): string[] {
  return [...before].filter((p) => !after.has(p)).sort();
}

/** Scalars worth looking for in a page.
 *
 *  Short values are excluded: a boolean, a one-character string or a small
 *  integer appears in almost any document by chance, so "present in the DOM"
 *  only means something for a value specific enough that coincidence is
 *  implausible. */
export function locatableValues(fields: Record<string, unknown>): Leaf[] {
  return flattenRow(fields).filter((l) => typeof l.value !== "boolean" && String(l.value).trim().length >= 3);
}
