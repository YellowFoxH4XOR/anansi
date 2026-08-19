// Scheduler resilience: a failing sweep must not take the agent down.
//
// Regression for the crash loop seen on the first real-adapter deploy: the
// CLI exited non-zero (404, no collector_id), the rejection escaped start()'s
// `void this.sweepOnce(s)` call, Node treated the unhandled rejection as fatal,
// and Docker's restart policy turned one bad config into an endless restart
// loop. Any transient 429 or network blip would have done the same in prod.

import { beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseContract } from "../packages/core/sense/contract.js";
import { Store } from "../packages/adapters/store/index.js";
import { TemplateLlm } from "../packages/adapters/llm/index.js";
import { Scheduler } from "../apps/agent/scheduler.js";
import { rawToRun } from "../apps/agent/incident.js";
import { resetCollector } from "../apps/agent/reset-collector.js";
import { clearStore } from "../apps/agent/clear-store.js";
import type { BrightDataAdapter, HealResponse, RawRow } from "../packages/adapters/brightdata/types.js";

const contract = parseContract(readFileSync("contracts/lab-storefront.yaml", "utf8"));

// Mirrors the shape of a non-zero CLI exit from packages/adapters/brightdata/real.ts.
const CLI_FAILURE = new Error(
  "Command failed: brightdata scraper run UNSET https://lab/product/echo-speaker --sync\n" +
    "Failed to scrape (collector UNSET): HTTP 404 Collector not found",
);

class ExplodingBrightData implements BrightDataAdapter {
  calls = 0;
  async runSync(): Promise<RawRow> {
    this.calls++;
    throw CLI_FAILURE;
  }
  async runBatch(): Promise<RawRow[]> {
    throw CLI_FAILURE;
  }
  async heal(): Promise<HealResponse> {
    throw CLI_FAILURE;
  }
  async approve(): Promise<void> {
    throw CLI_FAILURE;
  }
  async reject(): Promise<void> {
    throw CLI_FAILURE;
  }
  async budgetBalance(): Promise<number | null> {
    return null;
  }
}

let store: Store;

beforeEach(async () => {
  store = new Store(mkdtempSync(join(tmpdir(), "anansi-sched-")));
  await store.init();
  await store.ensureCollector(contract.scraper);
});

function schedulerWith(bd: BrightDataAdapter): { sched: Scheduler; logs: string[] } {
  const logs: string[] = [];
  const sched = new Scheduler(
    [{ contract, deps: { bd, llm: new TemplateLlm(), store, collectorId: "UNSET" } }],
    (m) => logs.push(m),
  );
  return { sched, logs };
}

describe("scheduler resilience", () => {
  it("does not reject when the adapter throws", async () => {
    const bd = new ExplodingBrightData();
    const { sched } = schedulerWith(bd);
    // The assertion that matters: this resolves rather than rejecting. A
    // rejection here is what killed the process in production.
    await expect(sched.sweepOnce(sched["scrapers"][0]!)).resolves.toBeUndefined();
    expect(bd.calls).toBeGreaterThan(0);
  });

  it("logs the failure instead of swallowing it", async () => {
    const { sched, logs } = schedulerWith(new ExplodingBrightData());
    await sched.sweepOnce(sched["scrapers"][0]!);
    expect(logs.join("\n")).toContain("sweep failed");
    expect(logs.join("\n")).toContain("retrying next tick");
  });

  it("clears the in-flight lock so the next tick can run", async () => {
    const bd = new ExplodingBrightData();
    const { sched } = schedulerWith(bd);
    await sched.sweepOnce(sched["scrapers"][0]!);
    const afterFirst = bd.calls;
    // A leaked `running` entry would make every later tick a silent no-op.
    await sched.sweepOnce(sched["scrapers"][0]!);
    expect(bd.calls).toBeGreaterThan(afterFirst);
  });
});

describe("operator recovery", () => {
  it("unquarantines without deleting history and clears persistent sense flags", async () => {
    await store.ensureCollector(contract.scraper);
    await store.setCollectorState(contract.scraper, "quarantined");
    await store.setFlags(contract.scraper, { fill_rate: ["price"], cusum: ["price|url"] });
    await store.putIncident({ id: "kept", scraper: contract.scraper } as never);

    const result = await resetCollector(store, contract.scraper, "production scraper saved");

    expect(result).toEqual({ from: "quarantined", to: "healthy" });
    expect(store.collectorState(contract.scraper)).toBe("healthy");
    expect(store.flags(contract.scraper)).toEqual({ fill_rate: [], cusum: [] });
    expect(store.incident("kept")).toBeDefined();
    expect(store.auditLog()).toContainEqual(
      expect.objectContaining({
        event: "operator_reset",
        scraper: contract.scraper,
        from: "quarantined",
        to: "healthy",
        reason: "production scraper saved",
      }),
    );
  });

  it("refuses to reset an unknown collector", async () => {
    await expect(resetCollector(store, "missing")).rejects.toThrow("unknown collector 'missing'");
  });
});

describe("platform row normalisation", () => {
  it("reads the snapshot from Studio's page_html and keeps it out of fields", async () => {
    // Shape taken verbatim from a live c_msyy76jk20f9e9mrh5 run.
    const row = {
      url: "https://anansi-lab.akshatkatiyar.com/product/echo-speaker",
      title: "Echo Portable Speaker",
      price: 49.99,
      sale_price: null,
      availability: "in stock",
      page_html: '<html><span class="price">$49.99</span></html>',
      page_html_url: "https://anansi-lab.akshatkatiyar.com/product/echo-speaker",
    };
    const run = await rawToRun(row, store, 1);

    expect(run.snapshot_ref).toBeDefined();
    expect(run.url).toBe(row.url);
    // A 15KB document arriving as a scraped field would corrupt fill-rate,
    // PII and invariant checks, so both tag keys must be stripped.
    expect(Object.keys(run.fields).sort()).toEqual(["availability", "price", "sale_price", "title"]);
  });

  it("still accepts _snapshot_html from the fake and live adapters", async () => {
    const run = await rawToRun({ url: "u", title: "t", _snapshot_html: "<html>x</html>" }, store, 1);
    expect(run.snapshot_ref).toBeDefined();
    expect(Object.keys(run.fields)).toEqual(["title"]);
  });
});

describe("store clear", () => {
  it("removes runtime data but preserves banked fixtures by default", async () => {
    await store.ensureCollector(contract.scraper);
    await store.setCollectorState(contract.scraper, "quarantined");
    await store.addCredits(20);
    await store.appendRun({ url: "u", fields: {}, ts: 1, scraper: contract.scraper });
    await store.putIncident({ id: "old", scraper: contract.scraper } as never);
    await store.saveSnapshot("<html>snap</html>");
    writeFileSync(join(store.dir, "fixtures", "heal-m1.json"), "{}");

    const { removed } = await clearStore(store.dir);

    expect(removed.join(" ")).toContain("state.json");
    expect(removed.join(" ")).toContain("snapshots/");
    // A fresh Store, because the old one caches state keyed on mtime.
    const after = new Store(store.dir);
    expect(after.incidents()).toEqual([]);
    expect(after.runs(contract.scraper)).toEqual([]);
    expect(after.auditLog()).toEqual([]);
    expect(after.creditsSpent()).toBe(0);
    expect(after.collectors()).toEqual({});
    // Banked heal fixtures are dev assets from the harness, not runtime data.
    expect(existsSync(join(store.dir, "fixtures", "heal-m1.json"))).toBe(true);
    // Directory layout must survive so the agent can write without a restart.
    expect(existsSync(join(store.dir, "snapshots"))).toBe(true);
  });

  it("removes fixtures only when explicitly asked", async () => {
    writeFileSync(join(store.dir, "fixtures", "heal-m1.json"), "{}");
    await clearStore(store.dir, { includeFixtures: true });
    expect(existsSync(join(store.dir, "fixtures", "heal-m1.json"))).toBe(false);
  });
});

describe("sweep history", () => {
  const run = (over: Record<string, unknown>) =>
    ({ url: "u", fields: {}, scraper: contract.scraper, ...over }) as never;

  it("groups rows into one sweep per cadence tick", async () => {
    // Two 4-canary sweeps. At demo cadence the gap between them can be shorter
    // than a sweep's own duration, so only sweep_ts can separate them.
    for (const t of [0, 20, 40, 60]) await store.appendRun(run({ ts: 1000 + t, healthy: true, sweep_ts: 1000 }));
    for (const t of [0, 20, 40, 60]) await store.appendRun(run({ ts: 1100 + t, healthy: false, sweep_ts: 1100 }));

    const sweeps = store.sweeps(contract.scraper);
    expect(sweeps).toHaveLength(2);
    expect(sweeps[0]).toMatchObject({ sweep_ts: 1000, healthy: true, canaries: 4, errors: 0 });
    expect(sweeps[1]).toMatchObject({ sweep_ts: 1100, healthy: false, canaries: 4 });
    expect(sweeps[0]!.finished_ts).toBe(1060);
  });

  it("counts error rows and marks the sweep unhealthy", async () => {
    await store.appendRun(run({ ts: 1, healthy: false, sweep_ts: 1, error_code: "blocked" }));
    await store.appendRun(run({ ts: 2, healthy: false, sweep_ts: 1 }));
    const s = store.sweeps(contract.scraper)[0]!;
    expect(s).toMatchObject({ healthy: false, canaries: 2, errors: 1 });
  });

  it("falls back to proximity for rows written before sweep_ts existed", async () => {
    for (const t of [0, 20]) await store.appendRun(run({ ts: 1000 + t, healthy: true }));
    for (const t of [0, 20]) await store.appendRun(run({ ts: 1000 + 4 * 60_000 + t, healthy: true }));
    expect(store.sweeps(contract.scraper)).toHaveLength(2);
  });

  it("returns the most recent sweeps when limited", async () => {
    for (let i = 1; i <= 5; i++) await store.appendRun(run({ ts: i * 10, healthy: true, sweep_ts: i * 10 }));
    const sweeps = store.sweeps(contract.scraper, 2);
    expect(sweeps.map((s) => s.sweep_ts)).toEqual([40, 50]);
  });
});
