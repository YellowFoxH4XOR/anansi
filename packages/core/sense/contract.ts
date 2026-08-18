import { load } from "js-yaml";
import type { Contract, FieldSpec, Violation } from "../types.js";

// Pure parse from YAML text; file I/O stays at the edges.
export function parseContract(yamlText: string): Contract {
  const raw = load(yamlText) as Contract;
  if (!raw?.scraper || !raw.fields || !raw.canaries?.length) {
    throw new Error("contract missing scraper/fields/canaries");
  }
  raw.invariants ??= [];
  raw.fill_rate_min ??= 0.9;
  raw.cadence_minutes ??= 30;
  return raw;
}

// Signal 2 — per-record checks: wrong type, out of range, too short. Required-null
// handling is split with fill-rate (see evaluate.ts).
export function checkFields(
  fields: Record<string, FieldSpec>,
  record: Record<string, unknown>,
  url: string,
): Violation[] {
  const out: Violation[] = [];
  for (const [name, spec] of Object.entries(fields)) {
    const v = record[name];
    if (v == null) continue; // null-where-required is owned by evaluate.ts (hard-null vs fill-rate)
    if (spec.type === "number") {
      const x = typeof v === "number" ? v : Number(v);
      if (!Number.isFinite(x)) {
        out.push({ signal: "contract", field: name, url, detail: `expected number, got ${JSON.stringify(v)}` });
        continue;
      }
      if (spec.min != null && x < spec.min) out.push({ signal: "contract", field: name, url, detail: `${x} < min ${spec.min}` });
      if (spec.max != null && x > spec.max) out.push({ signal: "contract", field: name, url, detail: `${x} > max ${spec.max}` });
    } else {
      if (typeof v !== "string") {
        out.push({ signal: "contract", field: name, url, detail: `expected string, got ${typeof v}` });
        continue;
      }
      if (spec.min_len != null && v.trim().length < spec.min_len) {
        out.push({ signal: "contract", field: name, url, detail: `length ${v.trim().length} < min_len ${spec.min_len}` });
      }
    }
  }
  return out;
}
