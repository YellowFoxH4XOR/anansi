// A scraper that emits ONE nested record per run, rather than one flat row per
// page. Every shape here is verbatim from c_mt1mhrj82pr6gc44rw
// (quotes.toscrape.com), whose first successful run ANANSI refused to read.

import { describe, expect, it } from "vitest";
import { BrightDataApi } from "../packages/adapters/brightdata/api.js";
import { contractFieldsFromSchema, splitRow } from "../packages/adapters/brightdata/types.js";
import { observedContract } from "../apps/agent/monitor.js";
import { verifyV1 } from "../packages/core/verify/v1.js";

const row = {
  quotes: [
    { text: "The world as we have created it is a process of our thinking.", author: "Albert Einstein", tags: ["change", "thinking"] },
    { text: "It is our choices, Harry, that show what we truly are.", author: "J.K. Rowling", tags: ["choices"] },
  ],
  input: { url: "http://quotes.toscrape.com/" },
};

const schema = {
  fields: {
    quotes: { type: "array", active: true },
    input: { type: "input", active: true },
    error: { type: "error", active: true },
    error_code: { type: "error_code", active: true },
  },
};

const page = `<html><body>
  <div class="quote"><span class="text">The world as we have created it is a process of our thinking.</span>
  <small class="author">Albert Einstein</small><a class="tag">change</a><a class="tag">thinking</a></div>
  <div class="quote"><span class="text">It is our choices, Harry, that show what we truly are.</span>
  <small class="author">J.K. Rowling</small><a class="tag">choices</a></div>
</body></html>`;

const apiReturning = (body: unknown) =>
  new BrightDataApi("k", (async () => ({
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  })) as never);

describe("a dataset that is one object, not an array", () => {
  it("reads it as a single row rather than a not-ready envelope", async () => {
    // The live symptom: a run with lines=1, fails=0 deferred forever, reason
    // "dataset undefined" — .status read off a record that never had one.
    const out = await apiReturning(row).dataset("j_1");
    expect(Array.isArray(out)).toBe(true);
    expect((out as Record<string, unknown>[])[0]!.quotes).toBeDefined();
  });

  it("still waits when the platform really is still building", async () => {
    const out = await apiReturning({ status: "building" }).dataset("j_1");
    expect(Array.isArray(out)).toBe(false);
    expect((out as { status: string }).status).toBe("building");
  });

  it("treats a record that merely has a status field as a record", async () => {
    const out = await apiReturning({ status: "in stock", price: 49.99 }).dataset("j_1");
    expect(Array.isArray(out)).toBe(true);
  });

  it("attributes the row by its nested input.url", () => {
    expect(splitRow(row).url).toBe("http://quotes.toscrape.com/");
  });
});

describe("a schema field whose shape cannot be checked", () => {
  it("is carried but never type-asserted", () => {
    // Mapping "anything not number" to string made every clean run of this
    // scraper fail its own contract with "expected string, got object".
    expect(contractFieldsFromSchema(schema)).toEqual({});
  });
});

describe("verifying a heal on a nested record", () => {
  const contract = observedContract("c_1", schema);

  it("passes when the nested values are really on the page", () => {
    // String(quotes) is "[object Object],[object Object]", which appears in no
    // document — so this gate used to reject every correct heal of a nested
    // scraper. It now walks to the scalars that actually render.
    const v = verifyV1(contract, [{ url: "u", fields: { quotes: row.quotes } }], { u: page }, []);
    expect(v.gates.find((g) => g.gate === "value_in_dom")!.pass).toBe(true);
    expect(v.pass).toBe(true);
  });

  it("tolerates one value that does not render, without waving the record through", () => {
    // A derived field, or one reformatted on the way out, must not sink a heal
    // whose other values plainly came from the page.
    const mostlyReal = [
      { text: "The world as we have created it is a process of our thinking.", author: "Albert Einstein" },
      { text: "It is our choices, Harry, that show what we truly are.", author: "J.K. Rowling", note: "collected 2026-08-20" },
    ];
    const v = verifyV1(contract, [{ url: "u", fields: { quotes: mostlyReal } }], { u: page }, []);
    expect(v.gates.find((g) => g.gate === "value_in_dom")!.pass).toBe(true);
  });

  it("still catches a nested value the heal invented", () => {
    const invented = [{ text: "A quote that is nowhere on this page at all.", author: "Nobody" }];
    const v = verifyV1(contract, [{ url: "u", fields: { quotes: invented } }], { u: page }, []);
    expect(v.gates.find((g) => g.gate === "value_in_dom")!.pass).toBe(false);
    expect(v.pass).toBe(false);
  });
});
