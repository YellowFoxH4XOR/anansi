import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { verifyV1 } from "../packages/core/verify/v1.js";
import { verifyV2 } from "../packages/core/verify/v2.js";
import { parseContract } from "../packages/core/sense/contract.js";
import { productPage, PRODUCTS } from "../apps/ui/pages.js";
import type { RunRecord } from "../packages/core/types.js";

const contract = parseContract(readFileSync("contracts/lab-storefront.yaml", "utf8"));
const echoUrl = contract.canaries[0]!.url;
const echo = PRODUCTS.find((p) => p.sku === "echo-speaker")!;
const injectedHtml = productPage(echo, "inject"); // live DOM during the incident

const goodFields = { title: "Echo Portable Speaker", price: 49.99, sale_price: null, availability: "in stock" };

function fullSweep(overrides: Partial<Record<string, Record<string, unknown>>> = {}): RunRecord[] {
  return contract.canaries.map((c) => ({
    url: c.url,
    fields: overrides[c.url] ?? {
      title: (c.goldens.title as { value: string }).value,
      price: (c.goldens.price as { value: number }).value,
      sale_price: null,
      availability: "in stock",
    },
    ts: 2,
  }));
}

describe("V1 — pre-approval gate on preview rows", () => {
  const snapshots = { [echoUrl]: injectedHtml };

  it("passes a healed preview whose value exists in the live DOM", () => {
    const v = verifyV1(contract, [{ url: echoUrl, fields: goodFields }], snapshots, ["price"]);
    expect(v.pass).toBe(true);
    expect(v.gates.find((g) => g.gate === "value_in_dom")?.pass).toBe(true);
  });

  it("kills the degenerate hardcode heal: preview value absent from the DOM", () => {
    const v = verifyV1(
      contract,
      [{ url: echoUrl, fields: { ...goodFields, price: 47.77 } }], // in band, but nowhere on the page
      snapshots,
      ["price"],
    );
    expect(v.pass).toBe(false);
    expect(v.gates.find((g) => g.gate === "value_in_dom")?.pass).toBe(false);
  });

  it("fails on a contract violation in preview", () => {
    const v = verifyV1(contract, [{ url: echoUrl, fields: { ...goodFields, price: null } }], snapshots, ["price"]);
    expect(v.pass).toBe(false);
    expect(v.gates.find((g) => g.gate === "contract_clean")?.pass).toBe(false);
  });

  it("fails on the still-wrong injected price via the golden gate", () => {
    const v = verifyV1(contract, [{ url: echoUrl, fields: { ...goodFields, price: 12.99 } }], snapshots, ["price"]);
    expect(v.pass).toBe(false);
    expect(v.gates.find((g) => g.gate === "goldens_attributable")?.pass).toBe(false);
  });

  it("defers goldens to V2 when no preview row is attributable, but still gates contract", () => {
    const v = verifyV1(contract, [{ fields: goodFields }], snapshots, ["price"]);
    expect(v.gates.find((g) => g.gate === "goldens_attributable")?.detail).toContain("deferred to V2");
    expect(v.pass).toBe(true);
  });

  it("fails on empty preview", () => {
    expect(verifyV1(contract, [], snapshots, ["price"]).pass).toBe(false);
  });
});

describe("V2 — post-approval full sweep", () => {
  const baseline = fullSweep();

  it("passes a clean sweep with no regressions", () => {
    const v = verifyV2(contract, fullSweep(), baseline);
    expect(v.pass).toBe(true);
    expect(v.repin_flags).toEqual([]);
  });

  it("promotion is a conjunction: a heal that breaks a previously-good field never promotes", () => {
    const broken = fullSweep({
      [contract.canaries[1]!.url]: { title: "Aurora Desk Lamp", price: null, sale_price: null, availability: "in stock" },
    });
    const v = verifyV2(contract, broken, baseline);
    expect(v.pass).toBe(false);
    expect(v.gates.find((g) => g.gate === "no_regression")?.pass).toBe(false);
    expect(v.confidence).toBeLessThan(1);
  });

  it("flags for human re-pin when the promoted value is in-band but off the anchor", () => {
    const drifted = fullSweep({
      [echoUrl]: { ...goodFields, price: 45.0 }, // inside ±15% band, > 2% from 49.99
    });
    const v = verifyV2(contract, drifted, baseline);
    expect(v.pass).toBe(true); // promotion allowed…
    expect(v.repin_flags).toEqual([
      { field: "price", url: echoUrl, anchor: 49.99, promoted: 45.0 }, // …but a human re-pins
    ]);
  });

  it("fails when the sweep itself trips a golden band", () => {
    const wrong = fullSweep({ [echoUrl]: { ...goodFields, price: 12.99 } });
    const v = verifyV2(contract, wrong, baseline);
    expect(v.pass).toBe(false);
    expect(v.gates.find((g) => g.gate === "sweep_clean")?.pass).toBe(false);
  });
});
