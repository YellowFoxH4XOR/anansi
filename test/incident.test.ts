// End-to-end incident drive against the fake adapter and real Lab markup —
// fixture-first: no network, no credits.

import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluate } from "../packages/core/sense/evaluate.js";
import { parseContract } from "../packages/core/sense/contract.js";
import { FakeBrightData } from "../packages/adapters/brightdata/fake.js";
import { TemplateLlm } from "../packages/adapters/llm/index.js";
import { Store } from "../packages/adapters/store/index.js";
import { driveIncident } from "../apps/agent/incident.js";
import { productPage, PRODUCTS } from "../apps/ui/pages.js";
import type { Incident, RunRecord } from "../packages/core/types.js";

const contract = parseContract(readFileSync("contracts/lab-storefront.yaml", "utf8"));
const echo = PRODUCTS.find((p) => p.sku === "echo-speaker")!;
const echoUrl = contract.canaries[0]!.url;
const baselineHtml = productPage(echo);
const injectedHtml = productPage(echo);

const goodFields = { title: "Echo Portable Speaker", price: 49.99, sale_price: null, availability: "in stock" };

let store: Store;

beforeEach(async () => {
  store = new Store(mkdtempSync(join(tmpdir(), "anansi-test-")));
  await store.init();
});

/** The archive's last-good captures, which are what driveIncident diffs against. */
async function seedHealthyBaseline(): Promise<void> {
  for (const c of contract.canaries) {
    const snapshot_ref = await store.saveSnapshot(baselineHtml);
    const run: RunRecord = {
      url: c.url,
      fields: {
        title: (c.goldens.title as { value: string }).value,
        price: (c.goldens.price as { value: number }).value,
        sale_price: null,
        availability: "in stock",
      },
      snapshot_ref,
      ts: 1,
    };
    await store.appendRun({ ...run, scraper: contract.scraper, healthy: true });
  }
}

async function m2Incident(): Promise<Incident> {
  const snapshot_ref = await store.saveSnapshot(injectedHtml);
  const records: RunRecord[] = contract.canaries.map((c, i) => ({
    url: c.url,
    fields:
      i === 0
        ? { ...goodFields, price: 12.99 }
        : {
            title: (c.goldens.title as { value: string }).value,
            price: (c.goldens.price as { value: number }).value,
            sale_price: null,
            availability: "in stock",
          },
    snapshot_ref: i === 0 ? snapshot_ref : undefined,
    ts: 2,
  }));
  const { result } = evaluate(contract, records);
  if (result.kind !== "incident") throw new Error("expected incident");
  return result;
}

describe("driveIncident — M2 silent injection, full loop", () => {
  it("diagnoses, heals, verifies, promotes; audit trail complete", async () => {
    await seedHealthyBaseline();
    const incident = await m2Incident();
    const bd = new FakeBrightData({
      heals: [
        {
          status: "awaiting_approval",
          diff_summary: "narrowed price selector to .price-block .price",
          preview_result: [{ url: echoUrl, ...goodFields }],
        },
      ],
    });

    const rec = await driveIncident(incident, contract, {
      bd,
      llm: new TemplateLlm(),
      store,
      collectorId: "c_test",
    });

    expect(rec.resolution).toBe("promoted");
    expect(rec.approved_by).toBe("gate");
    expect(rec.prompt).toBeTruthy();
    expect(rec.prompt!.length).toBeLessThanOrEqual(1000);
    expect(rec.heal_attempts).toHaveLength(1); // one gate, not two
    // Heal attempts are the only spend ANANSI still initiates: it triggers no
    // collection, so it consumes no page loads.
    expect(rec.credits_spent).toBe(1);

    // The whole platform interaction, in order. Nothing here starts a run.
    const ops = bd.calls.map((c) => c.op);
    expect(ops).toEqual(["heal", "approve"]);
    expect(ops).not.toContain("reject");

    // watching = approved, awaiting Bright Data's own next scheduled run as
    // the regression check.
    expect(store.collectorState(contract.scraper)).toBe("watching");
    const events = store.auditLog().map((e) => e.event);
    for (const expected of ["incident_open", "heal_start", "verify_v1", "approved", "incident_closed"]) {
      expect(events).toContain(expected);
    }
  });
});

describe("driveIncident — failed heals", () => {
  it("rejects the pending fix before each re-heal and quarantines after two strikes", async () => {
    await seedHealthyBaseline();
    const incident = await m2Incident();
    const badHeal = {
      status: "awaiting_approval",
      diff_summary: "still wrong",
      preview_result: [{ url: echoUrl, ...goodFields, price: 12.99 }],
    };
    const bd = new FakeBrightData({ heals: [badHeal, badHeal] });

    const rec = await driveIncident(incident, contract, {
      bd,
      llm: new TemplateLlm(),
      store,
      collectorId: "c_test",
    });

    expect(rec.resolution).toBe("quarantined");
    expect(bd.calls.map((c) => c.op)).toEqual(["heal", "reject", "heal", "reject"]);
    expect(store.collectorState(contract.scraper)).toBe("quarantined");
    // Second heal prompt carries the first failure's gate detail.
    const secondPrompt = (bd.calls[2]!.args as string[])[1]!;
    expect(secondPrompt).toContain("different approach");
  });

});

describe("driveIncident — non-heal lanes", () => {
  it("blocked is never healed (ADR-003): no adapter calls, infra resolution", async () => {
    await seedHealthyBaseline();
    const records = contract.canaries.map((c) => ({ url: c.url, fields: {}, error_code: "blocked", ts: 2 }));
    const { result } = evaluate(contract, records);
    if (result.kind !== "incident") throw new Error("expected incident");
    const bd = new FakeBrightData();

    const rec = await driveIncident(result, contract, {
      bd,
      llm: new TemplateLlm(),
      store,
      collectorId: "c_test",
    });

    expect(rec.resolution).toBe("infra");
    expect(bd.calls.length).toBe(0);
    expect(store.collectorState(contract.scraper)).toBe("quarantined");
  });
});
