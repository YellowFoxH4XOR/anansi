import type { GoldenSpec, Violation } from "../types.js";
import { tokenSetRatio } from "./similarity.js";

export function checkGolden(
  field: string,
  url: string,
  spec: GoldenSpec,
  actual: unknown,
): Violation | null {
  if (actual == null) {
    return { signal: "golden_band", field, url, detail: `golden field is null (pinned: ${JSON.stringify(pinnedValue(spec))})` };
  }
  if ("one_of" in spec) {
    const v = String(actual).toLowerCase().trim();
    if (!spec.one_of.some((o) => o.toLowerCase() === v)) {
      return { signal: "golden_band", field, url, detail: `"${actual}" not in [${spec.one_of.join(", ")}]` };
    }
    return null;
  }
  if ("tolerance_pct" in spec) {
    const x = typeof actual === "number" ? actual : Number(actual);
    if (!Number.isFinite(x)) {
      return { signal: "golden_band", field, url, detail: `non-numeric value ${JSON.stringify(actual)} for numeric golden` };
    }
    const lo = spec.value * (1 - spec.tolerance_pct / 100);
    const hi = spec.value * (1 + spec.tolerance_pct / 100);
    if (x < Math.min(lo, hi) || x > Math.max(lo, hi)) {
      return {
        signal: "golden_band",
        field,
        url,
        detail: `${x} outside band ${Math.min(lo, hi).toFixed(2)}–${Math.max(lo, hi).toFixed(2)} (pinned ${spec.value} ± ${spec.tolerance_pct}%)`,
      };
    }
    return null;
  }
  const sim = tokenSetRatio(String(actual), spec.value);
  if (sim < spec.similarity_min) {
    return {
      signal: "golden_band",
      field,
      url,
      detail: `similarity ${sim.toFixed(2)} < ${spec.similarity_min} vs pinned "${spec.value}" (${spec.similarity_metric})`,
    };
  }
  return null;
}

export function pinnedValue(spec: GoldenSpec): unknown {
  return "one_of" in spec ? spec.one_of : spec.value;
}

export function bandWidth(spec: GoldenSpec): number | undefined {
  if ("tolerance_pct" in spec) return Math.abs(spec.value) * (spec.tolerance_pct / 100) * 2;
  return undefined;
}
