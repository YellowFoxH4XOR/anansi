// Releasing a quarantined collector.
//
// Quarantine stops the monitor dispatching ANY job for a collector, and nothing
// clears it on its own. Before this the only exit was store:clear, which deletes
// snapshots/ too — throwing away exactly the archived last-good pages Diagnose
// needs, so recovering from a quarantine cost you the ability to diagnose the
// next failure.

import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../packages/adapters/store/index.js";
import { releaseCollector } from "../apps/agent/release-collector.js";

async function storeWith(state: "quarantined" | "healthy" | "healing"): Promise<Store> {
  const s = new Store(mkdtempSync(join(tmpdir(), "anansi-release-")));
  await s.init();
  await s.ensureCollector("shop");
  await s.setCollectorState("shop", state);
  return s;
}

describe("collector:release", () => {
  it("returns a quarantined collector to monitoring", async () => {
    const store = await storeWith("quarantined");
    await releaseCollector(store, "shop");
    expect(store.collectorState("shop")).toBe("healthy");
  });

  it("re-offers the jobs that were held, rather than losing them", async () => {
    const store = await storeWith("quarantined");
    await store.deferJob("j_1", "shop", 1000, "collector state=quarantined", { id: "j_1" });
    await store.deferJob("j_2", "shop", 1001, "collector state=quarantined", { id: "j_2" });

    expect(await releaseCollector(store, "shop")).toBe(2);
    // Still deferred, not settled: the next poll picks them up now that the
    // collector is dispatchable, and the ledger still guarantees at-most-once.
    expect(store.deferredJobs("shop").map((e) => e.job_id)).toEqual(["j_1", "j_2"]);
  });

  it("keeps every snapshot, run and incident — that is the whole point", async () => {
    const store = await storeWith("quarantined");
    const ref = await store.saveSnapshot("<html>last good</html>");
    await releaseCollector(store, "shop");
    expect(await store.snapshot(ref)).toBe("<html>last good</html>");
  });

  it("leaves a healthy collector alone", async () => {
    const store = await storeWith("healthy");
    await releaseCollector(store, "shop");
    expect(store.collectorState("shop")).toBe("healthy");
    expect(store.auditLog().some((e) => e.event === "collector_released")).toBe(false);
  });

  it("records who was released and from what", async () => {
    // The audit log is the only account of why a collector stopped being held.
    const store = await storeWith("healing");
    await releaseCollector(store, "shop");
    expect(store.auditLog().find((e) => e.event === "collector_released")).toMatchObject({
      scraper: "shop",
      from: "healing",
    });
  });

  it("refuses a name it does not know instead of quietly doing nothing", async () => {
    const store = await storeWith("quarantined");
    const before = process.exitCode;
    await releaseCollector(store, "typo");
    expect(process.exitCode).toBe(1);
    expect(store.collectorState("shop")).toBe("quarantined");
    process.exitCode = before;
  });

  it("with no name, reports what is held and changes nothing", async () => {
    const store = await storeWith("quarantined");
    await releaseCollector(store);
    expect(store.collectorState("shop")).toBe("quarantined");
  });
});
