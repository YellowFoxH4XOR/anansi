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
import type { RawRow } from "../packages/adapters/brightdata/types.js";

const contract = parseContract(readFileSync("contracts/lab-storefront.yaml", "utf8"));
const echo = PRODUCTS.find((p) => p.sku === "echo-speaker")!;
const echoUrl = contract.canaries[0]!.url;
const baselineHtml = productPage(echo, "none");
const injectedHtml = productPage(echo, "inject");

const goodFields = { title: "Echo Portable Speaker", price: 49.99, sale_price: null, availability: "in stock" };

function healedRawRows(): Record<string, RawRow[]> {
  const out: Record<string, RawRow[]> = {};
  for (const c of contract.canaries) {
    out[c.url] = [
      {
        url: c.url,
        _snapshot_html: baselineHtml,
        title: (c.goldens.title as { value: string }).value,
        price: (c.goldens.price as { value: number }).value,
        sale_price: null,
        availability: "in stock",
      },
    ];
  }
  return out;
}

let store: Store;

beforeEach(async () => {
  store = new Store(mkdtempSync(join(tmpdir(), "anansi-test-")));
  await store.init();
});

async function seedHealthyBaseline(): Promise<RunRecord[]> {
  const sweep: RunRecord[] = [];
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
    sweep.push(run);
  }
  return sweep;
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
    const baseline = await seedHealthyBaseline();
    const incident = await m2Incident();
    const bd = new FakeBrightData({
      runs: healedRawRows(),
      heals: [
        {
          status: "awaiting_approval",
          diff_summary: "narrowed price selector to .price-block .price",
          preview_result: [{ url: echoUrl, ...goodFields }],
        },
      ],
    });

    const rec = await driveIncident(incident, contract, baseline, {
      bd,
      llm: new TemplateLlm(),
      store,
      collectorId: "c_test",
    });

    expect(rec.resolution).toBe("promoted");
    expect(rec.approved_by).toBe("gate");
    expect(rec.prompt).toBeTruthy();
    expect(rec.prompt!.length).toBeLessThanOrEqual(1000);
    expect(rec.heal_attempts.map((a) => a.phase)).toEqual(["v1", "v2"]);
    expect(rec.credits_spent).toBe(contract.canaries.length); // the V2 sweep

    const ops = bd.calls.map((c) => c.op);
    expect(ops).toEqual(["heal", "approve", "runSync", "runSync", "runSync", "runSync"]);
    expect(ops).not.toContain("reject");

    expect(store.collectorState(contract.scraper)).toBe("watching");
    const events = store.auditLog().map((e) => e.event);
    for (const expected of ["incident_open", "heal_start", "verify_v1", "approved", "verify_v2", "incident_closed"]) {
      expect(events).toContain(expected);
    }
  });
});

describe("driveIncident — failed heals", () => {
  it("rejects the pending fix before each re-heal and quarantines after two strikes", async () => {
    const baseline = await seedHealthyBaseline();
    const incident = await m2Incident();
    const badHeal = {
      status: "awaiting_approval",
      diff_summary: "still wrong",
      preview_result: [{ url: echoUrl, ...goodFields, price: 12.99 }],
    };
    const bd = new FakeBrightData({ runs: healedRawRows(), heals: [badHeal, badHeal] });

    const rec = await driveIncident(incident, contract, baseline, {
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

  it("V2 regression after approve quarantines and reports rollback (dashboard-only)", async () => {
    const baseline = await seedHealthyBaseline();
    const incident = await m2Incident();
    // Preview looks perfect, but the promoted version breaks another canary.
    const runs = healedRawRows();
    runs[contract.canaries[1]!.url] = [
      { url: contract.canaries[1]!.url, _snapshot_html: baselineHtml, title: "Aurora Desk Lamp", price: null, sale_price: null, availability: "in stock" },
    ];
    const bd = new FakeBrightData({
      runs,
      heals: [{ status: "awaiting_approval", diff_summary: "ok", preview_result: [{ url: echoUrl, ...goodFields }] }],
    });

    const rec = await driveIncident(incident, contract, baseline, {
      bd,
      llm: new TemplateLlm(),
      store,
      collectorId: "c_test",
    });

    expect(rec.resolution).toBe("rolled_back");
    expect(store.collectorState(contract.scraper)).toBe("quarantined");
  });
});

describe("driveIncident — non-heal lanes", () => {
  it("blocked is never healed (ADR-003): no adapter calls, infra resolution", async () => {
    const baseline = await seedHealthyBaseline();
    const records = contract.canaries.map((c) => ({ url: c.url, fields: {}, error_code: "blocked", ts: 2 }));
    const { result } = evaluate(contract, records);
    if (result.kind !== "incident") throw new Error("expected incident");
    const bd = new FakeBrightData();

    const rec = await driveIncident(result, contract, baseline, {
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
