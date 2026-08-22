// ANANSI's first job is "did this collector break", not "is this value right".
//
// The second question needs a human who knows the correct answer, and every gate
// that depended on one scoped the system to scrapers somebody had already
// hand-configured in YAML. These pin the contract-free path: the platform's own
// output_schema says what a scraper emits, and the hardcode detector says
// whether a healed value was really read from the page.

import { describe, expect, it } from "vitest";
import { observedContract } from "../apps/agent/monitor.js";
import { contractFieldsFromSchema } from "../packages/adapters/brightdata/types.js";
import { verifyV1 } from "../packages/core/verify/v1.js";

// Representative of a collectors_list response.
const schema = {
  type: "object",
  fields: {
    price: { type: "number", active: true },
    title: { type: "text", active: true },
    availability: { type: "text", active: true },
    page_html: { type: "text", active: true },
    timestamp: { type: "timestamp", active: false },
    input: { type: "input", active: true },
    error: { type: "error", active: true },
    error_code: { type: "error_code", active: true },
    html: { type: "html_snapshot", active: false },
  },
};

const page = `<html><body><div class="price-block">
  <span class="price-now">49.99</span><span class="availability">in stock</span>
  </div><h1 class="title">Echo Portable Speaker</h1></body></html>`;

describe("a contract derived from what the platform declares", () => {
  it("keeps real fields and drops the platform's own columns", () => {
    const fields = contractFieldsFromSchema(schema);
    expect(Object.keys(fields).sort()).toEqual(["availability", "page_html", "price", "title"]);
    expect(fields.price!.type).toBe("number");
    expect(fields.title!.type).toBe("string");
  });

  it("asserts no field is required, because the schema never says so", () => {
    // Guessing would fail an otherwise good heal over a legitimately empty
    // optional field, which is a worse error than not checking.
    expect(Object.values(contractFieldsFromSchema(schema)).every((f) => !f.required)).toBe(true);
  });

  it("pins nothing about what a value should be", () => {
    const c = observedContract("c_1", schema);
    expect(c.canaries).toEqual([]);
    expect(c.invariants).toEqual([]);
  });
});

describe("promotion without a single golden", () => {
  const contract = observedContract("c_1", schema);

  it("passes a heal whose values are all present in the live page", () => {
    const v = verifyV1(
      contract,
      [{ url: "u", fields: { price: 49.99, title: "Echo Portable Speaker", availability: "in stock" } }],
      { u: page },
      [], // no failing fields named — a 0-row failure names none
    );
    expect(v.pass).toBe(true);
    expect(v.gates.find((g) => g.gate === "value_in_dom")!.pass).toBe(true);
  });

  it("rejects a heal that invented a value, with no golden to compare against", () => {
    // The case that matters: with failingFields empty this gate used to check
    // nothing at all, so a fabricated fix sailed through to production.
    const v = verifyV1(
      contract,
      [{ url: "u", fields: { price: 49.99, title: "Totally Different Product" } }],
      { u: page },
      [],
    );
    expect(v.pass).toBe(false);
    const gate = v.gates.find((g) => g.gate === "value_in_dom")!;
    expect(gate.pass).toBe(false);
    expect(gate.detail).toContain("Totally Different Product");
  });

  it("still fails a heal that produced no rows", () => {
    const v = verifyV1(contract, [], { u: page }, []);
    expect(v.pass).toBe(false);
    expect(v.gates[0]!.gate).toBe("preview_nonempty");
  });

  it("enforces the type the platform declared", () => {
    const v = verifyV1(contract, [{ url: "u", fields: { price: "forty nine ninety nine" } }], { u: page }, []);
    expect(v.gates.find((g) => g.gate === "contract_clean")!.pass).toBe(false);
  });
});
