import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { evaluate, NO_PRIOR } from "../packages/core/sense/evaluate.js";
import { parseContract } from "../packages/core/sense/contract.js";
import { tokenSetRatio } from "../packages/core/sense/similarity.js";
import { cusum } from "../packages/core/sense/cusum.js";
import { routeErrorCode } from "../packages/core/sense/triage.js";
import type { Contract, RunRecord } from "../packages/core/types.js";

const contract: Contract = parseContract(readFileSync("contracts/lab-storefront.yaml", "utf8"));
const urls = contract.canaries.map((c) => c.url);

function healthySweep(ts = 1): RunRecord[] {
  const prices: Record<string, number> = {};
  const titles: Record<string, string> = {};
  for (const c of contract.canaries) {
    prices[c.url] = (c.goldens.price as { value: number }).value;
    titles[c.url] = (c.goldens.title as { value: string }).value;
  }
  return urls.map((url) => ({
    url,
    fields: { title: titles[url], price: prices[url], sale_price: null, availability: "in stock" },
    ts,
  }));
}

describe("similarity (token_set_ratio)", () => {
  it("does not false-alarm on a legitimate suffix variant", () => {
    expect(tokenSetRatio("Echo Portable Speaker", "Echo Portable Speaker - Black")).toBeGreaterThan(0.95);
  });
  it("stays below the floor for an unrelated title", () => {
    expect(tokenSetRatio("Echo Portable Speaker", "Clip-On Phone Case")).toBeLessThan(0.5);
  });
});

describe("cusum", () => {
  const flat = Array(30).fill(49.99);
  it("fires the LOWER side on sustained downward drift", () => {
    const drifted = [...flat.slice(0, 20), ...Array(10).fill(49.99 - 3)];
    const res = cusum(flat, drifted, { kSigma: 0.5, hSigma: 4, bandWidth: 49.99 * 0.3 });
    expect(res.alarm).toBe(true);
    expect(res.side).toBe("lower");
  });
  it("sigma floor keeps a constant golden series from becoming an equality test", () => {
    // σ of a constant series is 0; without the floor any wobble would alarm.
    const wobble = [...flat, 49.99 + 0.4];
    const res = cusum(flat, wobble, { kSigma: 0.5, hSigma: 4, bandWidth: 49.99 * 0.3 });
    expect(res.sigmaEff).toBeCloseTo((49.99 * 0.3) / 8, 5);
    expect(res.alarm).toBe(false);
  });
  it("stays silent with no band and no variance (other signals own that case)", () => {
    expect(cusum(flat, [...flat, 60]).alarm).toBe(false);
  });
});

describe("triage routing", () => {
  it.each([
    ["blocked", "infra"],
    ["detection_block", "infra"],
    ["proxy_error_403", "infra"],
    ["captcha_timeout", "infra"],
    ["parse_error", "heal"],
    ["wait_element_timeout", "heal"],
    ["bad_input", "dead"],
    ["dead_page", "dead"],
    ["net_err_connection_reset", "retry"],
    ["worker_too_busy", "retry"],
    ["too_many_pages", "config"],
  ])("%s → %s", (code, route) => {
    expect(routeErrorCode(code)).toBe(route);
  });
});

describe("evaluate — the five signals", () => {
  it("healthy sweep is healthy", () => {
    const { result } = evaluate(contract, healthySweep());
    expect(result.kind).toBe("healthy");
  });

  it("M1 (rename): all-null required field is an instant contract incident routed to heal", () => {
    const records = healthySweep().map((r) => ({ ...r, fields: { ...r.fields, price: null } }));
    const { result } = evaluate(contract, records);
    expect(result.kind).toBe("incident");
    if (result.kind !== "incident") return;
    expect(result.route).toBe("heal");
    expect(result.signals.some((s) => s.signal === "contract" && s.field === "price")).toBe(true);
  });

  it("a platform validation error does not masquerade as a schema mismatch", () => {
    // When collect()'s validate_fn throws, Studio discards the record and
    // returns only system fields. Every required field then looks absent, but
    // the cause is a DOM change (M1 renamed .price), which belongs in heal.
    const records = urls.map((url) => ({
      url,
      fields: { input: { url }, error: "Error: price missing" },
      ts: 1,
    }));
    const { result } = evaluate(contract, records);
    expect(result.kind).toBe("incident");
    if (result.kind !== "incident") return;
    expect(result.route).toBe("heal");
  });

  it("systemic output-schema mismatch routes to config, not heal", () => {
    // Exact field shape returned by the generated production collector: two
    // required contract fields are wrong on every canary. Healing page selectors
    // cannot fix an output-schema mismatch, so spending heal attempts is wrong.
    const records = healthySweep().map((r) => ({
      ...r,
      fields: {
        product_title: r.fields.title,
        price: { value: r.fields.price, currency: "USD", symbol: "$" },
        availability: r.fields.availability,
        input: { url: r.url },
      },
    }));
    const { result } = evaluate(contract, records);
    expect(result.kind).toBe("incident");
    if (result.kind !== "incident") return;
    expect(result.route).toBe("config");
  });

  it("M2 (silent injection): plausible wrong price passes 1–3 and trips the golden band", () => {
    const records = healthySweep().map((r) =>
      r.url.includes("echo-speaker") ? { ...r, fields: { ...r.fields, price: 12.99 } } : r,
    );
    const { result } = evaluate(contract, records);
    expect(result.kind).toBe("incident");
    if (result.kind !== "incident") return;
    // The point of M2: no hard fail, no contract violation, no fill-rate drop.
    expect(result.signals.every((s) => s.signal === "golden_band")).toBe(true);
    expect(result.signals[0]?.field).toBe("price");
    expect(result.route).toBe("heal");
  });

  it("S1 (blocked): routes to the infra lane and never to heal", () => {
    const records = urls.map((url) => ({ url, fields: {}, error_code: "blocked", ts: 1 }));
    const { result } = evaluate(contract, records);
    expect(result.kind).toBe("incident");
    if (result.kind !== "incident") return;
    expect(result.route).toBe("infra");
  });

  it("fill-rate: a partial null needs two consecutive failing sweeps", () => {
    // Strip the availability golden so signal 4 doesn't preempt signal 3 —
    // on golden-pinned canaries a null is (correctly) an instant golden trip.
    const noGolden: Contract = structuredClone(contract);
    for (const c of noGolden.canaries) delete c.goldens.availability;
    const partial = healthySweep().map((r, i) =>
      i === 0 ? { ...r, fields: { ...r.fields, availability: null } } : r,
    );
    const first = evaluate(noGolden, partial, {}, NO_PRIOR);
    expect(first.result.kind).toBe("healthy"); // warning only
    if (first.result.kind === "healthy") {
      expect(first.result.warnings.some((w) => w.signal === "fill_rate")).toBe(true);
    }
    expect(first.flags.fill_rate).toContain("availability");

    const second = evaluate(noGolden, partial, {}, first.flags);
    expect(second.result.kind).toBe("incident");
    if (second.result.kind === "incident") {
      expect(second.result.signals.some((s) => s.signal === "fill_rate")).toBe(true);
    }
  });

  it("an absent optional field satisfies a null-guarded invariant", () => {
    // Production rows omit sale_price entirely rather than sending null (the
    // output schema only emits declared fields). `sale_price == null` is written
    // to allow exactly that, so an absent optional field must not fail closed.
    const records = healthySweep().map((r) => {
      const { sale_price, ...rest } = r.fields as Record<string, unknown>;
      return { ...r, fields: rest };
    });
    const { result } = evaluate(contract, records);
    expect(result.kind).toBe("healthy");
  });

  it("invariant: sale_price above price fails", () => {
    const records = healthySweep().map((r) => ({ ...r, fields: { ...r.fields, sale_price: 999 } }));
    const { result } = evaluate(contract, records);
    expect(result.kind).toBe("incident");
    if (result.kind !== "incident") return;
    expect(result.signals.some((s) => s.signal === "invariant")).toBe(true);
  });

  it("retry-class errors do not open a heal incident when data is otherwise fine", () => {
    const records = [
      { url: urls[0]!, fields: {}, error_code: "worker_too_busy", ts: 1 },
      ...healthySweep().slice(1),
    ];
    const { result } = evaluate(contract, records);
    expect(result.kind).toBe("incident");
    if (result.kind !== "incident") return;
    expect(result.route).toBe("retry");
  });
});

describe("contracts are optional per collector", () => {
  it("parses a contract that pins no canaries", () => {
    // A discovered scraper may declare field types without anyone pinning
    // golden anchors. Rejecting that used to mean no monitoring at all.
    const c = parseContract("scraper: bare\nfields:\n  title: { type: string, required: true }\n");
    expect(c.canaries).toEqual([]);
    expect(c.fill_rate_min).toBe(0.9);
  });

  it("evaluates a canary-less contract against collected rows", () => {
    const c = parseContract("scraper: bare\nfields:\n  price: { type: number, required: true }\n");
    const bad = evaluate(c, [{ url: "u", fields: { price: "not a number" }, ts: 1 }]);
    expect(bad.result.kind).toBe("incident");
    const good = evaluate(c, [{ url: "u", fields: { price: 4 }, ts: 1 }]);
    expect(good.result.kind).toBe("healthy");
  });

  it("still refuses a contract with no fields at all", () => {
    expect(() => parseContract("scraper: bare\n")).toThrow(/scraper\/fields/);
  });
});
