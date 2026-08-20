import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { verifyV1 } from "../packages/core/verify/v1.js";
import { parseContract } from "../packages/core/sense/contract.js";
import { productPage, PRODUCTS } from "../apps/ui/pages.js";

const contract = parseContract(readFileSync("contracts/lab-storefront.yaml", "utf8"));
const echoUrl = contract.canaries[0]!.url;
const echo = PRODUCTS.find((p) => p.sku === "echo-speaker")!;
const injectedHtml = productPage(echo); // live DOM during the incident

const goodFields = { title: "Echo Portable Speaker", price: 49.99, sale_price: null, availability: "in stock" };

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
