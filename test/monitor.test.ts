// The monitor loop, end to end, with no network: a fake REST client, a fake
// page fetcher, and the fake heal adapter.
//
// The load-bearing claims here are the ones the old scheduler could not make:
// a job is handled exactly once ACROSS RESTARTS, a collector nobody wrote a
// contract for is still watched, and no code path anywhere can start a
// collection.

import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseContract } from "../packages/core/sense/contract.js";
import { Store } from "../packages/adapters/store/index.js";
import { TemplateLlm } from "../packages/adapters/llm/index.js";
import { FakeBrightData } from "../packages/adapters/brightdata/fake.js";
import { Monitor, mergeJobHealth, newestJob, observedContract, pollWindow, rowsToRecords } from "../apps/agent/monitor.js";
import { BrightDataApiError } from "../packages/adapters/brightdata/api.js";
import type { PageCapture, PageFetcher } from "../apps/agent/archive.js";
import type { BrightDataApi, Collector, Job, JobLog } from "../packages/adapters/brightdata/api.js";
import type { JobHealth } from "../packages/core/sense/job-health.js";
import { productPage, PRODUCTS } from "../apps/ui/pages.js";
import type { Contract } from "../packages/core/types.js";

const contract = parseContract(readFileSync("contracts/lab-storefront.yaml", "utf8"));
const COLLECTOR = contract.collector_id!;
const echo = PRODUCTS.find((p) => p.sku === "echo-speaker")!;
const echoUrl = contract.canaries[0]!.url;
const baselineHtml = productPage(echo, "none");
const injectedHtml = productPage(echo, "inject");

/** A REST client stub that answers from in-memory tables and counts its calls. */
class FakeApi {
  readonly calls: string[] = [];
  constructor(
    private collectorList: Collector[],
    private jobsByCollector: Record<string, Job[]>,
    private logs: Record<string, JobLog> = {},
    private datasets: Record<string, Record<string, unknown>[] | { status: string } | Error> = {},
  ) {}

  async collectors(): Promise<Collector[]> {
    this.calls.push("collectors");
    return this.collectorList;
  }

  async jobs(opts: { collector: string }): Promise<Job[]> {
    this.calls.push(`jobs:${opts.collector}`);
    return (this.jobsByCollector[opts.collector] ?? []).map((j) => ({ collector: opts.collector, ...j }));
  }

  async jobLog(jobId: string): Promise<JobLog> {
    this.calls.push(`jobLog:${jobId}`);
    return this.logs[jobId] ?? { id: jobId };
  }

  async dataset(id: string): Promise<Record<string, unknown>[] | { status: string }> {
    this.calls.push(`dataset:${id}`);
    const entry = this.datasets[id];
    // A table entry that IS an error is how a test says "the platform rejects
    // this one" — preview and test runs have no dataset to read.
    if (entry instanceof Error) throw entry;
    return entry ?? [];
  }
}

const asApi = (a: FakeApi): BrightDataApi => a as unknown as BrightDataApi;

/** The platform performed another run since the last poll. */
function pushJob(api: FakeApi, collector: string, job: Job): void {
  const table = (api as unknown as { jobsByCollector: Record<string, Job[]> }).jobsByCollector;
  (table[collector] ??= []).push(job);
}

/** Serves one HTML body for every URL and records what was asked for. */
function pageFetcher(html: string, asked: string[] = []): PageFetcher {
  return async (url: string): Promise<PageCapture> => {
    asked.push(url);
    return { url, html, status: 200, bytes: Buffer.byteLength(html), low_confidence: false, fetched_ms: Date.now() };
  };
}

const goldenRow = (i: number) => {
  const c = contract.canaries[i]!;
  return {
    input: c.url,
    title: (c.goldens.title as { value: string }).value,
    price: (c.goldens.price as { value: number }).value,
    sale_price: null,
    availability: "in stock",
  };
};

const goldenRows = () => contract.canaries.map((_, i) => goldenRow(i));

let store: Store;
let clock: number;

beforeEach(async () => {
  store = new Store(mkdtempSync(join(tmpdir(), "anansi-monitor-")));
  await store.init();
  clock = Date.parse("2025-08-19T12:00:00Z");
});

function monitorWith(
  api: FakeApi,
  opts: { contracts?: Map<string, Contract>; fetchPage?: PageFetcher; heal?: FakeBrightData; logs?: string[] } = {},
): Monitor {
  return new Monitor({
    api: asApi(api),
    heal: opts.heal ?? new FakeBrightData(),
    llm: new TemplateLlm(),
    store,
    contracts: opts.contracts ?? new Map(),
    fetchPage: opts.fetchPage ?? pageFetcher(baselineHtml),
    now: () => clock,
    log: (m) => opts.logs?.push(m),
  });
}

describe("auto-discovery", () => {
  it("puts a collector nobody wrote a contract for on the board", async () => {
    // The fleet is the platform's answer, not readdirSync(contracts/). Before
    // the pivot a scraper built in Studio was invisible until someone edited a
    // YAML file and redeployed.
    const api = new FakeApi([{ id: "c_studio_new" }], { c_studio_new: [] });
    await monitorWith(api).pollOnce();
    expect(Object.keys(store.collectors())).toEqual(["c_studio_new"]);
  });

  it("keys a pinned contract by collector id and shows its display name", async () => {
    const api = new FakeApi([{ id: COLLECTOR }], { [COLLECTOR]: [] });
    await monitorWith(api, { contracts: new Map([[COLLECTOR, contract]]) }).pollOnce();
    expect(Object.keys(store.collectors())).toEqual([contract.scraper]);
  });
});

describe("the ledger makes a job a one-time fact", () => {
  const job: Job = { id: "j_1", finished: "2025-08-19T11:00:00Z", failed_pages: 0, data_lines: 4 };

  it("does not reprocess an already-handled job after a restart", async () => {
    const api = new FakeApi([{ id: COLLECTOR }], { [COLLECTOR]: [job] }, {}, { j_1: goldenRows() });
    const contracts = new Map([[COLLECTOR, contract]]);

    const first = await monitorWith(api, { contracts }).pollOnce();
    expect(first.jobs_handled).toBe(1);
    const runsAfterFirst = store.runs(contract.scraper).length;

    // A brand-new Monitor over a brand-new Store handle: nothing in memory
    // survives, which is exactly the state after a container restart. The
    // in-memory `running` Set the scheduler used could not express this.
    const restarted = new Monitor({
      api: asApi(api),
      heal: new FakeBrightData(),
      llm: new TemplateLlm(),
      store: new Store(store.dir),
      contracts,
      fetchPage: pageFetcher(baselineHtml),
      now: () => clock,
      log: () => {},
    });
    const second = await restarted.pollOnce();

    expect(second.jobs_handled).toBe(0);
    expect(second.jobs_seen).toBe(1);
    expect(new Store(store.dir).runs(contract.scraper).length).toBe(runsAfterFirst);
  });

  it("seeds a cold start instead of replaying the retention window", async () => {
    // Sixteen days of retroactive incidents on first boot would be useless, and
    // healing against a two-week-old DOM would be worse than useless.
    const old: Job[] = Array.from({ length: 6 }, (_, i) => ({
      id: `j_old_${i}`,
      finished: "2025-08-10T11:00:00Z",
      failed_pages: 9,
    }));
    const api = new FakeApi([{ id: COLLECTOR }], { [COLLECTOR]: [...old, job] }, {}, { j_1: goldenRows() });

    const report = await monitorWith(api, { contracts: new Map([[COLLECTOR, contract]]) }).pollOnce();

    expect(report.incidents_opened).toEqual([]);
    expect(store.jobLedger().filter((e) => e.outcome === "seeded")).toHaveLength(6);
    expect(store.jobLedgerState("j_1")).toBe("handled");
  });

  it("defers rather than drops a job discovered while the collector is healing", async () => {
    const api = new FakeApi(
      [{ id: COLLECTOR }],
      { [COLLECTOR]: [{ id: "j_seed", finished: "2025-08-19T09:00:00Z", data_lines: 4 }] },
      {},
      { j_seed: goldenRows(), j_1: goldenRows() },
    );
    const contracts = new Map([[COLLECTOR, contract]]);
    const monitor = monitorWith(api, { contracts });
    await monitor.pollCollector(COLLECTOR); // seeds
    pushJob(api, COLLECTOR, job);
    await store.setCollectorState(contract.scraper, "healing");

    const busy = await monitor.pollCollector(COLLECTOR);
    expect(busy.jobs_deferred).toBe(1);
    expect(store.jobLedgerState("j_1")).toBe("deferred");

    // The old scheduler simply skipped the tick; the next tick regenerated the
    // work. A monitor has no next tick that recreates a finished job, so the
    // deferred fact must come back when the collector is dispatchable again.
    await store.setCollectorState(contract.scraper, "healthy");
    const resumed = await monitor.pollCollector(COLLECTOR);
    expect(resumed.jobs_handled).toBe(1);
  });

  it("defers a dataset that is still building rather than calling it clean", async () => {
    const api = new FakeApi(
      [{ id: COLLECTOR }],
      { [COLLECTOR]: [{ id: "j_seed", finished: "2025-08-19T09:00:00Z", data_lines: 4 }] },
      {},
      { j_seed: goldenRows(), j_1: { status: "building" } },
    );
    const monitor = monitorWith(api, { contracts: new Map([[COLLECTOR, contract]]) });
    await monitor.pollCollector(COLLECTOR);
    pushJob(api, COLLECTOR, job);
    const report = await monitor.pollCollector(COLLECTOR);
    expect(report.jobs_deferred).toBe(1);
    expect(store.jobLedger().find((e) => e.job_id === "j_1")?.defer_reason).toContain("building");
  });

  it("never claims a job that has not finished", async () => {
    // Judging a half-written dataset would open an incident against rows the
    // platform has not finished collecting.
    const running: Job = { id: "j_run", status: "running", failed_pages: 4 };
    const api = new FakeApi([{ id: COLLECTOR }], { [COLLECTOR]: [running] });
    const monitor = monitorWith(api, { contracts: new Map([[COLLECTOR, contract]]) });
    await monitor.pollCollector(COLLECTOR);
    await monitor.pollCollector(COLLECTOR);
    expect(store.jobLedgerState("j_run")).toBeUndefined();
  });
});

describe("platform failures on a collector with no contract", () => {
  const seedJob: Job = { id: "j_seed", finished: "2025-08-19T10:00:00Z", data_lines: 4 };
  const failJob: Job = { id: "j_fail", finished: "2025-08-19T11:00:00Z", failed_pages: 2, data_lines: 0 };

  it("opens an incident from row error codes with no contract in sight", async () => {
    const api = new FakeApi(
      [{ id: "c_bare" }],
      { c_bare: [seedJob] },
      {},
      { j_seed: [{ input: echoUrl, title: "t" }], j_fail: [{ input: echoUrl, error_code: "parse_error" }] },
    );
    const monitor = monitorWith(api, { fetchPage: pageFetcher(baselineHtml) });

    await monitor.pollCollector("c_bare"); // seeds and archives on j_seed…
    pushJob(api, "c_bare", failJob);
    clock += 60_000;
    const report = await monitor.pollCollector("c_bare"); // …then sees j_fail

    expect(report.incidents_opened).toHaveLength(1);
    const rec = store.incident(report.incidents_opened[0]!)!;
    expect(rec.route).toBe("heal");
    expect(rec.signal[0]!.detail).toContain("error_code=parse_error");
  });

  it("stops a contract-less heal at the gate instead of auto-approving it", async () => {
    // Without fields, goldens or invariants, V1 reduces to "preview is
    // non-empty" plus the hardcode detector. A vacuous gate is not a gate, so
    // the fix waits for a human.
    const heal = new FakeBrightData({
      heals: [{ status: "awaiting_approval", diff_summary: "d", preview_result: [{ url: echoUrl, price: 49.99 }] }],
    });
    const api = new FakeApi(
      [{ id: "c_bare" }],
      { c_bare: [seedJob] },
      {},
      { j_seed: [{ input: echoUrl, title: "t" }], j_fail: [{ input: echoUrl, error_code: "parse_error" }] },
    );
    const monitor = monitorWith(api, { heal, fetchPage: pageFetcher(injectedHtml) });

    await monitor.pollCollector("c_bare");
    pushJob(api, "c_bare", failJob);
    clock += 60_000;
    await monitor.pollCollector("c_bare");

    const ops = heal.calls.map((c) => c.op);
    expect(ops).toContain("heal");
    expect(ops).not.toContain("approve");
    expect(store.auditLog().map((e) => e.event)).toContain("awaiting_human_approval");
  });

  it("never routes blocked to heal, contract or not (ADR-003)", async () => {
    const heal = new FakeBrightData();
    const blocked: Job = { id: "j_blk", finished: "2025-08-19T11:00:00Z", failed_pages: 2 };
    const api = new FakeApi(
      [{ id: "c_bare" }],
      { c_bare: [seedJob] },
      {},
      { j_seed: [{ input: echoUrl, title: "t" }], j_blk: [{ input: echoUrl, error_code: "blocked" }] },
    );
    const monitor = monitorWith(api, { heal });
    await monitor.pollCollector("c_bare");
    pushJob(api, "c_bare", blocked);
    clock += 60_000;
    const report = await monitor.pollCollector("c_bare");

    expect(store.incident(report.incidents_opened[0]!)!.resolution).toBe("infra");
    expect(heal.calls).toEqual([]);
  });

  it("does not heal the first failure nothing explains", async () => {
    // failed_pages with no rows at all is real. Routing it blind to heal burns
    // an AI generation on what is usually a platform hiccup.
    const heal = new FakeBrightData();
    const api = new FakeApi(
      [{ id: "c_bare" }],
      { c_bare: [seedJob] },
      {},
      { j_seed: [{ input: echoUrl, title: "t" }], j_fail: [] },
    );
    const monitor = monitorWith(api, { heal });
    await monitor.pollCollector("c_bare");
    pushJob(api, "c_bare", failJob);
    clock += 60_000;
    const report = await monitor.pollCollector("c_bare");

    expect(report.incidents_opened).toEqual([]);
    expect(heal.calls).toEqual([]);
    expect(store.auditLog().map((e) => e.event)).toContain("unexplained_failure");
    expect(store.monitorCursor("c_bare").unexplained_failures).toBe(1);
  });
});

describe("the free HTML archive", () => {
  it("archives after a healthy job so the next failure has something to diff", async () => {
    const asked: string[] = [];
    const healthy: Job = { id: "j_ok", finished: "2025-08-19T10:00:00Z", data_lines: 4 };
    const broken: Job = { id: "j_bad", finished: "2025-08-19T11:00:00Z", data_lines: 4 };
    const brokenRows = [{ ...goldenRow(0), price: 12.99 }, goldenRow(1), goldenRow(2), goldenRow(3)];
    const api = new FakeApi(
      [{ id: COLLECTOR }],
      { [COLLECTOR]: [healthy] },
      {},
      { j_ok: goldenRows(), j_bad: brokenRows },
    );
    const contracts = new Map([[COLLECTOR, contract]]);
    const heal = new FakeBrightData({
      heals: [{ status: "awaiting_approval", diff_summary: "d", preview_result: [goldenRow(0)] }],
    });
    const monitor = monitorWith(api, { contracts, heal, fetchPage: pageFetcher(baselineHtml, asked) });

    await monitor.pollCollector(COLLECTOR); // seeds
    clock += 60_000;
    await monitor.pollCollector(COLLECTOR); // healthy job → archive

    expect(asked).toContain(echoUrl);
    expect(store.lastGoodSnapshotRef(contract.scraper, echoUrl)).toBeDefined();

    // Now the same page is mutated and the next scheduled run reports the
    // injected price. The archive is what supplies both halves of the diff.
    pushJob(api, COLLECTOR, broken);
    clock += 60 * 60_000;
    const report = await monitorWith(api, {
      contracts,
      heal,
      fetchPage: pageFetcher(injectedHtml, asked),
    }).pollCollector(COLLECTOR);

    const rec = store.incident(report.incidents_opened[0]!)!;
    expect(rec.last_good_ref).toBeDefined();
    expect(rec.current_ref).toBeDefined();
    expect(rec.last_good_ref).not.toBe(rec.current_ref);
    expect(rec.resolution).toBe("promoted");
  });
});

describe("the next scheduled run is the verification", () => {
  it("quarantines a promoted fix that fails the very next run, without re-healing", async () => {
    // This is what replaced Verify V2: real production rows from Bright Data's
    // own schedule instead of a synthetic canary sweep, at zero cost. A fix
    // that broke the next real run is not a candidate for another AI attempt.
    const failed: Job = { id: "j_after", finished: "2025-08-19T12:00:00Z", failed_pages: 1, data_lines: 4 };
    const api = new FakeApi(
      [{ id: COLLECTOR }],
      { [COLLECTOR]: [{ id: "j_seed", finished: "2025-08-19T10:00:00Z", data_lines: 4 }] },
      {},
      { j_after: [{ ...goldenRow(0), error_code: "parse_error" }] },
    );
    const heal = new FakeBrightData();
    const monitor = monitorWith(api, { contracts: new Map([[COLLECTOR, contract]]), heal });
    await monitor.pollCollector(COLLECTOR);
    await store.setCollectorState(contract.scraper, "watching");

    pushJob(api, COLLECTOR, failed);
    clock += 60_000;
    await monitor.pollCollector(COLLECTOR);

    expect(store.collectorState(contract.scraper)).toBe("quarantined");
    expect(heal.calls).toEqual([]);
    expect(store.auditLog().map((e) => e.event)).toContain("post_promotion_regression");
  });

  it("returns a watching collector to healthy when the next run is clean", async () => {
    const api = new FakeApi(
      [{ id: COLLECTOR }],
      { [COLLECTOR]: [{ id: "j_seed", finished: "2025-08-19T10:00:00Z", data_lines: 4 }] },
      {},
      { j_ok: goldenRows() },
    );
    const monitor = monitorWith(api, { contracts: new Map([[COLLECTOR, contract]]) });
    await monitor.pollCollector(COLLECTOR);
    await store.setCollectorState(contract.scraper, "watching");

    pushJob(api, COLLECTOR, { id: "j_ok", finished: "2025-08-19T12:00:00Z", data_lines: 4 });
    clock += 60_000;
    await monitor.pollCollector(COLLECTOR);

    expect(store.collectorState(contract.scraper)).toBe("healthy");
  });
});

describe("resilience", () => {
  it("does not reject when the REST client throws", async () => {
    // Regression for the crash loop on the first real-adapter deploy: the
    // rejection escaped start()'s `void` call, Node treated the unhandled
    // rejection as fatal, and Docker's restart policy turned one bad config
    // into an endless restart loop.
    const logs: string[] = [];
    const exploding = {
      async collectors(): Promise<Collector[]> {
        return [{ id: COLLECTOR }];
      },
      async jobs(): Promise<Job[]> {
        throw new Error("Command failed: HTTP 429 Too Many Requests\nrate limited");
      },
    } as unknown as FakeApi;
    const monitor = monitorWith(exploding, { logs });

    const report = await expect(monitor.pollOnce()).resolves.toBeDefined().then(() => monitor.pollOnce());
    expect(report.errors.join(" ")).toContain("429");
    expect(logs.join("\n")).toContain("retrying next tick");
  });

  it("defers a job whose dataset read fails instead of losing it", async () => {
    const api = new FakeApi([{ id: COLLECTOR }], {
      [COLLECTOR]: [
        { id: "j_seed", finished: "2025-08-19T10:00:00Z", data_lines: 1 },
        { id: "j_boom", finished: "2025-08-19T11:00:00Z", data_lines: 1 },
      ],
    });
    api.dataset = async (id: string) => {
      if (id === "j_boom") throw new Error("HTTP 500");
      return goldenRows();
    };
    const monitor = monitorWith(api, { contracts: new Map([[COLLECTOR, contract]]) });
    await monitor.pollCollector(COLLECTOR);
    clock += 60_000;
    const report = await monitor.pollCollector(COLLECTOR);

    expect(report.jobs_deferred).toBe(1);
    expect(report.errors.join(" ")).toContain("500");
    expect(store.jobLedgerState("j_boom")).toBe("deferred");
  });

  it("settles a claim orphaned by a crash rather than replaying it", async () => {
    // A crash between claim and settle must not replay: a replay could re-spend
    // an AI generation or approve a fix nobody gated.
    await store.claimJob("j_orphan", contract.scraper, clock);
    await monitorWith(new FakeApi([], {})).reconcile();
    expect(store.jobLedgerState("j_orphan")).toBe("handled");
    expect(store.auditLog().map((e) => e.event)).toContain("job_abandoned");
  });

  it("quarantines a collector left mid-heal by a crash", async () => {
    // The monitor cannot know whether the CLI heal completed or left a fix
    // sitting awaiting_approval on the platform, so it refuses to guess.
    await store.ensureCollector(contract.scraper);
    await store.setCollectorState(contract.scraper, "healing");
    await monitorWith(new FakeApi([], {})).reconcile();
    expect(store.collectorState(contract.scraper)).toBe("quarantined");
  });
});

describe("pure helpers", () => {
  it("includes yesterday just after UTC midnight", () => {
    // The API filters by day, and a job that finished at 23:59 is still
    // yesterday's from 00:03's point of view.
    const w = pollWindow({ last_polled_ms: Date.parse("2025-08-19T00:03:00Z") }, Date.parse("2025-08-19T00:03:00Z"), {
      lookbackDays: 1,
      retentionDays: 16,
    });
    expect(w).toEqual({ fromDate: "2025-08-18", toDate: "2025-08-19" });
  });

  it("never asks for jobs older than the platform retains", () => {
    const w = pollWindow({ last_polled_ms: Date.parse("2020-01-01T00:00:00Z") }, Date.parse("2025-08-19T12:00:00Z"), {
      lookbackDays: 1,
      retentionDays: 16,
    });
    expect(w.fromDate).toBe("2025-08-03");
  });

  it("attributes dataset rows and counts the ones it cannot", () => {
    const { records, unattributed } = rowsToRecords([{ input: "a", price: 1 }, { price: 2 }], 5, { a: "ref1" });
    expect(records[0]).toMatchObject({ url: "a", snapshot_ref: "ref1", fields: { price: 1 } });
    expect(unattributed).toBe(1);
  });

  it("gives a contract-less collector a contract every gate passes vacuously", () => {
    const c = observedContract("c_x");
    expect(c).toMatchObject({ scraper: "c_x", collector_id: "c_x", canaries: [], fields: {} });
  });
});

describe("ANANSI never triggers a collection", () => {
  // The whole pivot in one assertion. Grep, not types, because a stray
  // `execFile("brightdata", ["scraper", "run", ...])` would typecheck fine.
  const FORBIDDEN = /\brunSync\b|\brunBatch\b|"scraper",\s*"run"|\.trigger\(/;

  function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules") continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) sourceFiles(p, out);
      else if (p.endsWith(".ts") && !p.endsWith(".d.ts")) out.push(p);
    }
    return out;
  }

  it("has no run/trigger call anywhere under apps/ or packages/", () => {
    const offenders = [...sourceFiles("apps"), ...sourceFiles("packages")].filter((p) =>
      FORBIDDEN.test(readFileSync(p, "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  it("keeps the heal seam free of any way to start one", () => {
    const heal = new FakeBrightData();
    expect(Object.keys(Object.getPrototypeOf(heal) as object).concat(Object.keys(heal)).join(" ")).not.toMatch(FORBIDDEN);
    expect(readFileSync("packages/adapters/brightdata/types.ts", "utf8")).not.toMatch(/runSync|runBatch/);
  });
});

describe("the newest job is the newest by clock, not by array position", () => {
  // /dca/collector/jobs documents no ordering and job ids are opaque, so
  // `terminal[terminal.length - 1]` was a guess. Guessing wrong is not a cosmetic
  // slip: seedCursor marks every job except the "newest" as already handled, so
  // a newest-first response seeded the CURRENT run away and evaluated a job from
  // the far end of the retention window — healing against a two-week-old DOM,
  // the one thing seedCursor exists to prevent.
  const ancient: Job = { id: "j_ancient", finished: "2025-08-05T11:00:00Z", failed_pages: 9 };
  const recent: Job = { id: "j_recent", finished: "2025-08-19T11:00:00Z", data_lines: 4 };

  it("picks by finish time whichever way round the platform lists them", () => {
    expect(newestJob([ancient, recent])?.id).toBe("j_recent");
    expect(newestJob([recent, ancient])?.id).toBe("j_recent");
  });

  it("falls back to start time, then to position, when nothing finished", () => {
    expect(newestJob([{ id: "a", started: "2025-08-01T00:00:00Z" }, { id: "b", started: "2025-08-09T00:00:00Z" }])?.id).toBe("b");
    expect(newestJob([{ id: "a" }, { id: "b" }])?.id).toBe("b");
    expect(newestJob([])).toBeUndefined();
  });

  async function seedWith(jobs: Job[]): Promise<string[]> {
    const api = new FakeApi([{ id: COLLECTOR }], { [COLLECTOR]: jobs }, {}, { j_ancient: [], j_recent: goldenRows() });
    await monitorWith(api, { contracts: new Map([[COLLECTOR, contract]]) }).pollOnce();
    return store.jobLedger().filter((e) => e.outcome === "seeded").map((e) => e.job_id);
  }

  it("seeds away the old job regardless of response order", async () => {
    expect(await seedWith([ancient, recent])).toEqual(["j_ancient"]);
  });

  it("still seeds away the old job when the platform answers newest-first", async () => {
    // This is the assertion that fails against the previous implementation: it
    // seeded j_recent and went on to evaluate a two-week-old job.
    expect(await seedWith([recent, ancient])).toEqual(["j_ancient"]);
  });
});

describe("a contract whose canaries match nothing is reported, not trusted", () => {
  // evaluate() joins goldens to rows by exact URL equality and `continue`s on a
  // canary it cannot find. So a contract in a different URL space than the
  // dataset does not fail — it silently checks nothing, and the console shows a
  // clean board. The one symptom is the absence of symptoms, so the monitor has
  // to say it out loud.
  const job: Job = { id: "j_1", finished: "2025-08-19T11:00:00Z", data_lines: 4 };
  const seed: Job = { id: "j_seed", finished: "2025-08-19T09:00:00Z", data_lines: 4 };

  it("logs and audits when no canary appears in the collected rows", async () => {
    const foreign = goldenRows().map((r) => ({ ...r, input: r.input.replace("https://anansi-lab.akshatkatiyar.com", "http://lab:4600") }));
    const api = new FakeApi([{ id: COLLECTOR }], { [COLLECTOR]: [seed] }, {}, { j_seed: goldenRows(), j_1: foreign });
    const logs: string[] = [];
    const monitor = monitorWith(api, { contracts: new Map([[COLLECTOR, contract]]), logs });
    await monitor.pollCollector(COLLECTOR);
    pushJob(api, COLLECTOR, job);
    await monitor.pollCollector(COLLECTOR);

    expect(logs.some((l) => l.includes("canary URL(s) appear in the collected rows"))).toBe(true);
    expect(store.auditLog().some((e) => e.event === "canaries_unmatched")).toBe(true);
  });

  it("says nothing when the contract and the rows share a URL space", async () => {
    const api = new FakeApi([{ id: COLLECTOR }], { [COLLECTOR]: [seed] }, {}, { j_seed: goldenRows(), j_1: goldenRows() });
    const logs: string[] = [];
    const monitor = monitorWith(api, { contracts: new Map([[COLLECTOR, contract]]), logs });
    await monitor.pollCollector(COLLECTOR);
    pushJob(api, COLLECTOR, job);
    await monitor.pollCollector(COLLECTOR);

    expect(store.auditLog().some((e) => e.event === "canaries_unmatched")).toBe(false);
  });
});

describe("a job that collected nothing is not a healthy job", () => {
  // With a contract, evaluate() gets zero records and every gate passes
  // vacuously: no hard_fail, no fill_rate (that block is behind ok.length > 0),
  // no goldens. The volume check was gated on "no contract", so the collectors
  // someone bothered to configure were exactly the ones that could return
  // nothing and read clean.
  const runs: Job[] = [
    { id: "j_a", finished: "2025-08-19T06:00:00Z", data_lines: 4 },
    { id: "j_b", finished: "2025-08-19T07:00:00Z", data_lines: 4 },
    { id: "j_c", finished: "2025-08-19T08:00:00Z", data_lines: 4 },
  ];
  const empty: Job = { id: "j_empty", finished: "2025-08-19T11:00:00Z", data_lines: 0 };

  /** Builds a real row-count history one poll at a time. Volume needs at least
   *  two observed runs before it has an opinion, and a job the monitor SEEDED
   *  was never evaluated, so it contributes nothing — the history has to be
   *  lived through rather than handed over at boot. */
  async function runHistoryThen(last: Job): Promise<void> {
    const datasets: Record<string, Record<string, unknown>[]> = { j_empty: [] };
    for (const j of runs) datasets[j.id] = goldenRows();
    const api = new FakeApi([{ id: COLLECTOR }], { [COLLECTOR]: [runs[0]!] }, {}, datasets);
    const monitor = monitorWith(api, { contracts: new Map([[COLLECTOR, contract]]) });
    await monitor.pollCollector(COLLECTOR);
    for (const j of [...runs.slice(1), last]) {
      pushJob(api, COLLECTOR, j);
      await monitor.pollCollector(COLLECTOR);
    }
  }

  it("opens an incident when a contract-pinned collector returns zero rows", async () => {
    await runHistoryThen(empty);
    const opened = store.incidents().filter((i) => i.scraper === contract.scraper);
    expect(opened.length).toBeGreaterThan(0);
    expect(JSON.stringify(opened[0]!.signal)).toContain("0 rows");
  });

  it("stamps the placeholder run with its job id so the console can join it", async () => {
    // Without job_id the trace exists but apps/console/jobs.ts drops it, so the
    // run that failed hardest is the one shown with no finish time at all.
    await runHistoryThen(empty);
    const placeholder = (store.runs(contract.scraper) as { job_id?: string; url: string }[]).find((r) => r.url === "unknown");
    expect(placeholder?.job_id).toBe("j_empty");
  });
});

describe("what the archive itself hit is a routable fact", () => {
  // The archive computes a real error taxonomy (403 → blocked → infra lane) and
  // then dropped it on the floor: only low_confidence was read, and only to log.
  // A 403 on our own fetch must never become a heal — no selector edit repairs
  // an access problem (ADR-003).
  const seed: Job = { id: "j_seed", finished: "2025-08-19T09:00:00Z", data_lines: 4 };
  const broken: Job = { id: "j_1", finished: "2025-08-19T11:00:00Z", data_lines: 4 };

  it("routes an incident to infra when the archive fetch was blocked", async () => {
    // Rows that violate the goldens: on their own this is the heal lane.
    const wrong = goldenRows().map((r) => ({ ...r, price: 0.01 }));
    const api = new FakeApi([{ id: COLLECTOR }], { [COLLECTOR]: [seed] }, {}, { j_seed: goldenRows(), j_1: wrong });
    const blockedFetcher: PageFetcher = async (url) => ({
      url,
      html: "<html>Access denied</html>",
      status: 403,
      bytes: 30,
      low_confidence: true,
      error_code: "blocked",
      fetched_ms: clock,
    });
    const monitor = monitorWith(api, { contracts: new Map([[COLLECTOR, contract]]), fetchPage: pageFetcher(baselineHtml) });
    await monitor.pollCollector(COLLECTOR);

    const blocked = monitorWith(api, { contracts: new Map([[COLLECTOR, contract]]), fetchPage: blockedFetcher });
    pushJob(api, COLLECTOR, broken);
    await blocked.pollCollector(COLLECTOR);

    const rec = store.incidents().find((i) => i.scraper === contract.scraper)!;
    expect(rec.route).toBe("infra");
    expect(JSON.stringify(rec.signal)).toContain("archive fetch returned blocked");
  });
});

describe("the job verdict and the contract verdict are unioned, not chosen between", () => {
  // Each half is blind to the other. A job whose rows were all dropped gives
  // evaluate() nothing to judge, so the contract alone says "healthy" about a
  // run that plainly failed; a job that succeeded at the platform level says
  // nothing about a price that silently halved. The lane has to be the more
  // urgent of the two, by the one shared precedence order.
  const health = (over: Partial<JobHealth> = {}): JobHealth => ({
    jobId: "j_1",
    collector: "c",
    outcome: "failed",
    signals: [{ signal: "hard_fail", detail: "job failed" }],
    errorCodes: [],
    unexplained: false,
    totals: {},
    ...over,
  });

  it("keeps a healthy verdict when neither half objects", () => {
    const out = mergeJobHealth(health({ outcome: "success", signals: [] }), { kind: "healthy", warnings: [] }, "s", []);
    expect(out.kind).toBe("healthy");
  });

  it("reports a failed job the contract could not see, because it had no rows", () => {
    const out = mergeJobHealth(health({ route: "retry" }), { kind: "healthy", warnings: [] }, "s", []);
    expect(out.kind).toBe("incident");
  });

  it("takes the more urgent lane when the two disagree", () => {
    // infra outranks heal: no selector edit repairs an access problem.
    const out = mergeJobHealth(
      health({ route: "infra" }),
      { kind: "incident", scraper: "s", route: "heal", signals: [{ signal: "golden_band", field: "price", detail: "out of band" }], records: [], snapshot_refs: [] },
      "s",
      [],
    );
    expect(out.kind === "incident" && out.route).toBe("infra");
  });

  it("falls back to retry when signals exist but nothing said why", () => {
    // Routing a lane-less failure to heal would spend an AI generation on what
    // is usually a platform hiccup; the caller applies the two-strike rule.
    const out = mergeJobHealth(health({ route: undefined }), { kind: "healthy", warnings: [] }, "s", []);
    expect(out.kind === "incident" && out.route).toBe("retry");
  });

  it("ignores job-level signals when the job itself succeeded", () => {
    // A success carrying stale signals must not manufacture an incident.
    const out = mergeJobHealth(health({ outcome: "success" }), { kind: "healthy", warnings: [] }, "s", []);
    expect(out.kind).toBe("healthy");
  });
});

describe("a job with no dataset is settled, never retried forever", () => {
  // Observed in production: /dca/dataset answers 400 for a preview/test run,
  // which has no delivered dataset at all. That rejection will never stop
  // happening, so deferring it re-offered the same job on every 60s poll
  // indefinitely — the agent's only visible activity was one repeating error.
  const seed: Job = { id: "j_seed", finished: "2025-08-19T09:00:00Z", data_lines: 4 };
  const noDataset: Job = { id: "vj_preview", finished: "2025-08-19T11:00:00Z", data_lines: 19, failed_pages: 15 };

  function apiWith(datasetResult: Error | Record<string, unknown>[]) {
    return new FakeApi([{ id: COLLECTOR }], { [COLLECTOR]: [seed] }, {}, { j_seed: goldenRows(), vj_preview: datasetResult });
  }

  async function pollTwice(api: FakeApi, logs: string[]) {
    const monitor = monitorWith(api, { contracts: new Map([[COLLECTOR, contract]]), logs });
    await monitor.pollCollector(COLLECTOR);
    pushJob(api, COLLECTOR, noDataset);
    await monitor.pollCollector(COLLECTOR);
    await monitor.pollCollector(COLLECTOR);
  }

  it("handles the job once and does not offer it again", async () => {
    const logs: string[] = [];
    const api = apiWith(new BrightDataApiError("/dca/dataset", 400, "invalid id"));
    await pollTwice(api, logs);

    expect(store.jobLedgerState("vj_preview")).toBe("handled");
    // Two polls after it appeared, but only one dataset read: the second poll
    // skipped a job the ledger already settled.
    expect(api.calls.filter((c) => c === "dataset:vj_preview")).toHaveLength(1);
  });

  it("still judges it, from the job counters it does have", async () => {
    const logs: string[] = [];
    await pollTwice(apiWith(new BrightDataApiError("/dca/dataset", 400, "invalid id")), logs);

    // 15 failed pages is a real failure and must not be silently dropped just
    // because the rows explaining it are unreadable.
    expect(store.auditLog().some((e) => e.event === "dataset_unavailable" && e.job_id === "vj_preview")).toBe(true);
    expect(logs.some((l) => l.includes("no dataset to read") && l.includes("HTTP 400"))).toBe(true);
    expect(store.auditLog().some((e) => e.event === "unexplained_failure" && e.job_id === "vj_preview")).toBe(true);
  });

  it("still defers when the rejection might succeed later", async () => {
    // 429 and 5xx are "not now", not "not ever" — settling those would discard
    // a job that was perfectly readable a minute later.
    const logs: string[] = [];
    await pollTwice(apiWith(new BrightDataApiError("/dca/dataset", 429, "slow down")), logs);
    expect(store.jobLedgerState("vj_preview")).toBe("deferred");
  });
});
