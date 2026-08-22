// The fleet the console shows must be the fleet Bright Data has, not the fleet
// contracts/ describes.
//
// These fail against the pre-pivot console: it built the board from
// `readdirSync(contracts)` via ensureCollector, so a scraper built in Scraper
// Studio was invisible until someone wrote a YAML file and redeployed, and a
// fleet entry carried `lastChecked` — a claim that ANANSI had scraped the site.

import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../packages/adapters/store/index.js";
import { buildFleet, contractDepth, discoveredIds, lastPoll } from "../apps/console/fleet.js";
import { readFleet, readJobs, readLastPoll } from "../apps/console/read.js";

async function freshStore(): Promise<Store> {
  const s = new Store(mkdtempSync(join(tmpdir(), "anansi-console-")));
  await s.init();
  return s;
}

/** What the monitor writes when it discovers a collector: ensureCollector puts
 *  it on the board, and monitor_seeded records the platform id it came from. */
async function discover(store: Store, name: string, collectorId: string): Promise<void> {
  await store.ensureCollector(name);
  await store.audit({ event: "monitor_seeded", collector: collectorId, scraper: name, jobs: 0 });
}

describe("fleet discovery", () => {
  it("shows a scraper that no contract mentions", async () => {
    const store = await freshStore();
    // A collector built in Studio: the monitor keys it by its platform id
    // because no contract named it. It must still be a first-class card.
    await discover(store, "c_newscraper", "c_newscraper");
    await store.claimJob("j_1", "c_newscraper", 1000);
    await store.settleJob("j_1", "failed");

    const [entry] = readFleet(store);

    expect(entry).toMatchObject({ name: "c_newscraper", collectorId: "c_newscraper", contract: "none" });
    expect(entry?.recent.map((t) => t.verdict)).toEqual(["failed"]);
  });

  it("marks a contract-pinned collector as the deeper tier", async () => {
    const store = await freshStore();
    await discover(store, "lab-storefront", "c_example");
    expect(readFleet(store)[0]).toMatchObject({ contract: "pinned", collectorId: "c_example" });
  });

  it("refuses to guess the depth when the agent never recorded a discovery", () => {
    // An unearned "platform signals only" badge would tell an operator their
    // goldens are not running when they are.
    expect(contractDepth("lab-storefront", undefined)).toBe("unknown");
    expect(contractDepth("c_x", "c_x")).toBe("none");
    expect(contractDepth("lab-storefront", "c_x")).toBe("pinned");
  });

  it("reads the platform id from the monitor's own seed events, last one winning", () => {
    expect(
      discoveredIds([
        { event: "state_change", scraper: "shop", state: "healthy" },
        { event: "monitor_seeded", scraper: "shop", collector: "c_old" },
        { event: "monitor_seeded", scraper: "shop", collector: "c_new" },
      ]),
    ).toEqual({ shop: "c_new" });
  });

  it("builds a run strip oldest-first from the newest-first job list", () => {
    const [entry] = buildFleet({
      collectors: { shop: "healthy" },
      discovered: { shop: "c_shop" },
      cursors: {},
      jobs: [
        { job_id: "j_3", collector: "shop", verdict: "ok", trigger: "scheduled", seen: 3, finished: 3, rows: 1, error_rows: 0 },
        { job_id: "j_2", collector: "shop", verdict: "failed", trigger: "scheduled", seen: 2, finished: 2, rows: 0, error_rows: 0 },
        { job_id: "j_1", collector: "shop", verdict: "ok", trigger: "scheduled", seen: 1, finished: 1, rows: 1, error_rows: 0 },
        { job_id: "j_x", collector: "other", verdict: "failed", trigger: "scheduled", seen: 9, finished: 9, rows: 0, error_rows: 0 },
      ],
    });

    expect(entry?.recent.map((t) => t.job_id)).toEqual(["j_1", "j_2", "j_3"]);
    expect(entry?.lastRunAt).toBe(3);
  });

  it("reports the last poll, not a last scan", async () => {
    const store = await freshStore();
    await discover(store, "shop", "c_shop");
    await store.setMonitorCursor("shop", {
      last_polled_ms: 7000,
      last_job_finish_ms: 6000,
      unexplained_failures: 0,
      start_times_ms: [],
      line_counts: [],
      seeded: true,
    });

    // Proof of life is the age of our last READ of the platform. ANANSI never
    // triggers a collection, so there is no scan whose age could be shown.
    expect(readLastPoll(store)).toBe(7000);
    expect(readFleet(store)[0]).toMatchObject({ lastPolled: 7000, lastRunAt: 6000 });
  });

  it("has no poll to report on an empty board, rather than inventing one", () => {
    // With nothing discovered there is no cursor, so "agent down" and "account
    // has no collectors" are genuinely indistinguishable from the volume. The
    // console says so in the empty state instead of implying liveness.
    expect(lastPoll({})).toBeNull();
  });

  it("counts a collector's failed runs in the last 24h", async () => {
    const store = await freshStore();
    const now = Date.now();
    await discover(store, "shop", "c_shop");
    await store.claimJob("j_recent", "shop", now - 1000);
    await store.settleJob("j_recent", "failed");
    await store.claimJob("j_old", "shop", now - 3 * 24 * 60 * 60_000);
    await store.settleJob("j_old", "failed");
    // settleJob preserves the claim's timestamp, so the window is honest.
    expect(readJobs(store).map((j) => j.verdict)).toEqual(["failed", "failed"]);
    expect(readFleet(store)[0]?.failed24h).toBe(1);
  });
});

describe("overdue is the failure only a monitor can see", () => {
  // A run that never happened produces no job, no rows and no error code, so
  // nothing else in the system will ever mention it. inferSchedule/isStale
  // existed and were unit-tested, but nothing called them and the console had
  // no way to say it — a silently stopped scraper looked exactly like a healthy
  // one. The cadence is LEARNED from the platform's own start times; a cadence
  // in ANANSI's config is the coupling ADR-004 removed.
  const HOUR = 3_600_000;

  async function withCadence(startTimes: number[], lastFinish: number) {
    const store = await freshStore();
    await discover(store, "shop", "shop");
    await store.setMonitorCursor("shop", {
      ...store.monitorCursor("shop"),
      start_times_ms: startTimes,
      last_job_finish_ms: lastFinish,
      seeded: true,
    });
    return store;
  }

  const hourly = [0, HOUR, 2 * HOUR, 3 * HOUR, 4 * HOUR];

  it("flags a collector overdue against its own learned cadence", async () => {
    const store = await withCadence(hourly, 4 * HOUR);
    const [entry] = readFleet(store, readJobs(store), 8 * HOUR);
    expect(entry).toMatchObject({ stale: true, expectedEveryMs: HOUR });
  });

  it("stays quiet while the collector is merely between runs", async () => {
    const store = await withCadence(hourly, 4 * HOUR);
    expect(readFleet(store, readJobs(store), 6 * HOUR)[0]).toMatchObject({ stale: false });
  });

  it("offers no opinion at all below the sample floor", async () => {
    // A false overdue alarm on a healthy fleet costs more trust than a late one
    // costs uptime, so "not enough samples" is absent, not false.
    const store = await withCadence([0, HOUR], 100 * HOUR);
    const [entry] = readFleet(store, readJobs(store), 500 * HOUR);
    expect(entry?.stale).toBeUndefined();
    expect(entry?.expectedEveryMs).toBeUndefined();
  });
});

describe("the board shows what Bright Data calls a scraper", () => {
  // The store key is ours: a contract's `scraper:` field, or an opaque collector
  // id. Neither of those exists in Scraper Studio, so a board full of them is a
  // board an operator cannot match against their own account — "lab-storefront"
  // is a name only ANANSI has ever used.
  it("prefers the platform name over the store key", async () => {
    const store = await freshStore();
    await discover(store, "lab-storefront", "c_example");
    await store.setMonitorCursor("lab-storefront", {
      ...store.monitorCursor("lab-storefront"),
      platform_name: "anansi-lab",
      platform_active: true,
    });

    const [entry] = readFleet(store);
    // The key stays put — it is identity, and history is filed under it.
    expect(entry?.name).toBe("lab-storefront");
    // But the name an operator reads is the one they typed into Studio.
    expect(entry?.platformName).toBe("anansi-lab");
  });

  it("names a brand-new scraper nobody wrote a contract for", async () => {
    // The whole point of auto-discovery: build a scraper in Studio, and it is on
    // the board under its own name with no config edit. Falling back to the raw
    // collector id would technically "discover" it and still tell the operator
    // nothing.
    const store = await freshStore();
    await discover(store, "c_brandnew", "c_brandnew");
    await store.setMonitorCursor("c_brandnew", { ...store.monitorCursor("c_brandnew"), platform_name: "amazon-prices" });

    const [entry] = readFleet(store);
    expect(entry).toMatchObject({ name: "c_brandnew", platformName: "amazon-prices", contract: "none" });
  });

  it("says nothing rather than guessing before the first poll", async () => {
    const store = await freshStore();
    await discover(store, "c_unpolled", "c_unpolled");
    expect(readFleet(store)[0]?.platformName).toBeUndefined();
  });

  it("a paused scraper is off, not overdue", async () => {
    // isStale would otherwise page someone about a scraper they deliberately
    // switched off in Studio.
    const HOUR = 3_600_000;
    const store = await freshStore();
    await discover(store, "shop", "shop");
    await store.setMonitorCursor("shop", {
      ...store.monitorCursor("shop"),
      start_times_ms: [0, HOUR, 2 * HOUR, 3 * HOUR, 4 * HOUR],
      last_job_finish_ms: 4 * HOUR,
      platform_active: false,
      seeded: true,
    });

    const [entry] = readFleet(store, readJobs(store), 500 * HOUR);
    expect(entry?.paused).toBe(true);
    expect(entry?.stale).toBeUndefined();
  });
});

describe("nothing on the board may be a name ANANSI invented", () => {
  const base = {
    collectors: { "lab-storefront": "healthy" as const },
    discovered: { "lab-storefront": "c_abc123" },
    jobs: [],
  };

  it("prefers the platform's own cadence over one inferred from run gaps", () => {
    // inferSchedule reconstructs a rhythm from observed start times. That guess
    // is least trustworthy for the collector whose runs have STOPPED, which is
    // the only collector staleness exists to catch — and collectors_list states
    // the real schedule outright.
    const [entry] = buildFleet({
      ...base,
      cursors: {
        "lab-storefront": {
          platform_name: "anansi-lab",
          platform_schedule_ms: 300_000,
          // Gaps of ~1h, nothing like the real 5m cadence.
          start_times_ms: [0, 3_600_000, 7_200_000, 10_800_000],
        },
      },
    });
    expect(entry!.expectedEveryMs).toBe(300_000);
  });

  it("still infers a cadence when the platform reports no schedule", () => {
    const [entry] = buildFleet({
      ...base,
      cursors: {
        "lab-storefront": { start_times_ms: [0, 60_000, 120_000, 180_000] },
      },
    });
    expect(entry!.expectedEveryMs).toBe(60_000);
  });

  it("carries the platform name so nothing has to fall back to the store key", () => {
    // "lab-storefront" is a contract's `scraper:` field. It exists nowhere in
    // Scraper Studio, and on screen it is indistinguishable from a name that
    // does — which is what makes rendering it a fabrication rather than a label.
    const [entry] = buildFleet({
      ...base,
      cursors: { "lab-storefront": { platform_name: "anansi-lab" } },
    });
    expect(entry!.platformName).toBe("anansi-lab");
    expect(entry!.collectorId).toBe("c_abc123");
  });
});
