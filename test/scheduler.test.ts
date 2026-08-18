// Scheduler resilience: a failing sweep must not take the agent down.
//
// Regression for the crash loop seen on the first real-adapter deploy: the
// CLI exited non-zero (404, no collector_id), the rejection escaped start()'s
// `void this.sweepOnce(s)` call, Node treated the unhandled rejection as fatal,
// and Docker's restart policy turned one bad config into an endless restart
// loop. Any transient 429 or network blip would have done the same in prod.

import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseContract } from "../packages/core/sense/contract.js";
import { Store } from "../packages/adapters/store/index.js";
import { TemplateLlm } from "../packages/adapters/llm/index.js";
import { Scheduler } from "../apps/agent/scheduler.js";
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
