// The monitor loop. ANANSI does not schedule work: Bright Data owns the
// schedule, and this file watches what that schedule produced.
//
// The shape is a consumer over an append-only fact stream. Two mechanisms with
// different jobs keep it honest:
//   - the JOB LEDGER gives correctness — a job is acted on at most once, across
//     restarts. There is no `since` cursor on the platform, job ids are opaque
//     and unsortable, and the date filter is day-granular, so a timestamp
//     watermark alone cannot prevent a replay.
//   - the DATE WATERMARK is only an optimiser. It may be wrong without causing
//     a double-process.
//
// The old scheduler could drop a tick harmlessly, because the next tick
// regenerated the work. A monitor cannot: a job is a one-time fact, so work it
// cannot dispatch right now is DEFERRED, never dropped.

import { BrightDataApiError, type BrightDataApi, type Collector, type Job } from "../../packages/adapters/brightdata/api.js";
import type { Contract, Route, RunRecord, SenseResult, Violation } from "../../packages/core/types.js";
import { ROUTE_PRECEDENCE, evaluate } from "../../packages/core/sense/evaluate.js";
import { classifyJob, isTerminal, jobRoute, requiredFieldsNamedIn, rowVolumeSignals, type JobHealth } from "../../packages/core/sense/job-health.js";
import type { LlmAdapter } from "../../packages/adapters/llm/index.js";
import { Store, type MonitorCursor } from "../../packages/adapters/store/index.js";
import { splitRow, type RawRow } from "../../packages/adapters/brightdata/types.js";
import type { KnownGood } from "../../packages/core/diagnose/evidence.js";
import { driveIncident, type HealAdapter } from "./incident.js";
import { archivePages, type ArchiveResult, type PageFetcher } from "./archive.js";

export type MonitorConfig = {
  /** Detection latency, not cost: a poll spends no page loads, so this is
   *  bounded by API rate limits rather than by money. Over-polling produces no
   *  duplicate work (the ledger sees to that); under-polling only adds latency. */
  pollSeconds: number;
  jitterPct: number;
  collectorRefreshMs: number;
  /** UTC-midnight rollover plus jobs that spanned days. */
  lookbackDays: number;
  /** Platform expiry — querying older than this is wasted. */
  retentionDays: number;
  maxArchiveUrlsPerJob: number;
  archiveFloorMs: number;
  /** How many job start times / row counts to remember for schedule and volume
   *  inference. */
  historySamples: number;
};

export const DEFAULT_MONITOR_CONFIG: MonitorConfig = {
  pollSeconds: 60,
  jitterPct: 10,
  collectorRefreshMs: 5 * 60_000,
  lookbackDays: 1,
  retentionDays: 16,
  maxArchiveUrlsPerJob: 8,
  archiveFloorMs: 15 * 60_000,
  historySamples: 10,
};

export type MonitorDeps = {
  api: BrightDataApi;
  heal: HealAdapter;
  llm: LlmAdapter;
  store: Store;
  /** collector id → contract. Absent means platform monitoring only. */
  contracts: Map<string, Contract>;
  fetchPage: PageFetcher;
  config?: Partial<MonitorConfig>;
  now?: () => number;
  log?: (msg: string) => void;
};

/** What one poll did. Returned rather than only logged, so the loop is
 *  assertable without reading stdout or the audit file. */
export type PollReport = {
  polled_ms: number;
  collectors: number;
  jobs_seen: number;
  jobs_handled: number;
  jobs_deferred: number;
  incidents_opened: string[];
  errors: string[];
};

function emptyReport(nowMs: number): PollReport {
  return { polled_ms: nowMs, collectors: 0, jobs_seen: 0, jobs_handled: 0, jobs_deferred: 0, incidents_opened: [], errors: [] };
}

function mergeReport(into: PollReport, from: PollReport): void {
  into.jobs_seen += from.jobs_seen;
  into.jobs_handled += from.jobs_handled;
  into.jobs_deferred += from.jobs_deferred;
  into.incidents_opened.push(...from.incidents_opened);
  into.errors.push(...from.errors);
}

const DAY_MS = 24 * 60 * 60_000;

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The jobs endpoint filters by DATE, and does not document which timezone it
 *  reads those dates in. We compute ours in UTC, so an account east of UTC has
 *  a window every "today" job falls outside of: a run at 02:30 IST is 21:00 UTC
 *  the previous day, and asking for `to_date` = that UTC day hides every job the
 *  platform files under tomorrow. Observed live — three of five runs, including
 *  both scheduled ones, were invisible to the monitor.
 *
 *  So every window is padded by a day at each end. Over-fetching is free: the
 *  job ledger already guarantees a job is acted on at most once, no matter how
 *  often it is offered. Under-fetching loses a run permanently, because there is
 *  no second chance at a finished job. */
const WINDOW_PAD_MS = DAY_MS;

/** Day-granularity window, clamped to the platform's retention floor and padded
 *  for the undocumented timezone. */
export function pollWindow(
  cursor: { last_polled_ms: number } | undefined,
  nowMs: number,
  cfg: Pick<MonitorConfig, "lookbackDays" | "retentionDays">,
): { fromDate: string; toDate: string } {
  const anchor = cursor?.last_polled_ms ? cursor.last_polled_ms : nowMs;
  const floor = nowMs - cfg.retentionDays * DAY_MS;
  const from = Math.max(Math.min(anchor - cfg.lookbackDays * DAY_MS, nowMs), floor);
  return { fromDate: utcDay(from - WINDOW_PAD_MS), toDate: utcDay(nowMs + WINDOW_PAD_MS) };
}

/** Dataset rows → RunRecord[]. A row nobody can attribute to a URL breaks both
 *  golden checks and last-good snapshot lookup, so it is counted rather than
 *  silently dropped. */
export function rowsToRecords(
  rows: readonly Record<string, unknown>[],
  tsMs: number,
  snapshotRefs: Readonly<Record<string, string>> = {},
): { records: RunRecord[]; unattributed: number } {
  const records: RunRecord[] = [];
  let unattributed = 0;
  for (const row of rows) {
    const { url, error_code, fields } = splitRow(row as RawRow);
    if (!url) unattributed++;
    records.push({
      url: url ?? "unknown",
      fields,
      ...(error_code ? { error_code } : {}),
      ...(url && snapshotRefs[url] ? { snapshot_ref: snapshotRefs[url] } : {}),
      ts: tsMs,
    });
  }
  return { records, unattributed };
}

/** The most recently finished job, by timestamp rather than array position.
 *
 *  The platform documents no ordering for /dca/collector/jobs and job ids are
 *  opaque, so reading a newest-first response as oldest-first would seed the
 *  current run away as "already handled" and evaluate a two-week-old one — the
 *  exact outcome seedCursor() exists to prevent. Ties and missing timestamps
 *  fall back to the later array position, which is the old behaviour. */
export function newestJob(jobs: readonly Job[]): Job | undefined {
  let best: Job | undefined;
  let bestMs = -Infinity;
  for (const j of jobs) {
    const parsed = Date.parse(j.finished ?? j.started ?? j.queued ?? "");
    const ms = Number.isFinite(parsed) ? parsed : -Infinity;
    if (best === undefined || ms >= bestMs) {
      best = j;
      bestMs = ms;
    }
  }
  return best;
}

/** Lets a contract-less collector reach the existing incident pipeline without
 *  widening its signature. Every contract gate then passes vacuously, which is
 *  exactly why callers must also set requiresHumanApproval. */
export function observedContract(collectorId: string): Contract {
  return { scraper: collectorId, collector_id: collectorId, canaries: [], fields: {}, invariants: [], fill_rate_min: 0 };
}

/** Union the job-level verdict with the contract-level one. A failed job whose
 *  rows were all dropped produces no records for evaluate() to judge, so a
 *  contract alone would report it healthy. */
export function mergeJobHealth(health: JobHealth, sense: SenseResult, scraper: string, records: RunRecord[], extra: Violation[] = []): SenseResult {
  const jobFailed = health.outcome === "failed" || health.outcome === "partial";
  const senseSignals = sense.kind === "incident" ? sense.signals : [];
  const signals = [...senseSignals, ...(jobFailed ? health.signals : []), ...extra];
  if (signals.length === 0) return sense;

  const senseRoute = sense.kind === "incident" ? sense.route : undefined;
  const lanes = new Set([senseRoute, health.route].filter((r): r is NonNullable<typeof r> => r != null));
  // No lane from either side means nothing said WHY. Callers apply the
  // two-strike rule before that becomes a heal.
  const route = ROUTE_PRECEDENCE.find((r) => lanes.has(r)) ?? "retry";
  return {
    kind: "incident",
    scraper,
    route,
    signals,
    records,
    snapshot_refs: records.flatMap((r) => (r.snapshot_ref ? [r.snapshot_ref] : [])),
  };
}

/** States in which a newly-seen job may be acted on. A job discovered mid-heal
 *  must not open a duplicate incident — but it must not be forgotten either. */
const DISPATCHABLE = new Set(["healthy", "watching"]);

export class Monitor {
  private readonly cfg: MonitorConfig;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private polling = false;
  private timer?: NodeJS.Timeout;
  private collectorCache?: { at: number; list: Collector[] };
  private lastArchiveMs = new Map<string, number>();

  constructor(private deps: MonitorDeps) {
    this.cfg = { ...DEFAULT_MONITOR_CONFIG, ...deps.config };
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? console.log;
  }

  /** What Bright Data calls this scraper. The console shows this rather than
   *  our store key, which is either a contract's invented name or an opaque id —
   *  neither of which exists on the platform the operator is looking at. */
  private platformFor(collectorId: string): Collector | undefined {
    return this.collectorCache?.list.find((c) => c.id === collectorId);
  }

  private nameFor(collectorId: string): string {
    // Identity is the collector id; the contract's `scraper` is a display name
    // that also keys the store, so an existing collector keeps its history.
    return this.deps.contracts.get(collectorId)?.scraper ?? collectorId;
  }

  /** Settle orphaned claims and refuse to guess about interrupted heals. The
   *  monitor cannot know whether a CLI heal completed or left a fix sitting
   *  awaiting_approval on the platform, and silently resuming risks promoting an
   *  ungated fix — so a human clears it. */
  async reconcile(): Promise<void> {
    const { store } = this.deps;
    for (const entry of store.jobLedger()) {
      if (entry.state !== "claimed") continue;
      await store.audit({ event: "job_abandoned", job_id: entry.job_id, collector: entry.collector });
      await store.settleJob(entry.job_id, "abandoned");
    }
    for (const [name, state] of Object.entries(store.collectors())) {
      if (state !== "healing" && state !== "verifying") continue;
      this.log(`[${name}] was ${state} at shutdown — quarantining; a human must confirm whether a fix is pending on the platform`);
      await store.setCollectorState(name, "quarantined");
    }
  }

  /** collectors() is the fleet's source of truth: a scraper built in Studio
   *  appears with no config edit. Cached so a 60s poll stays cheap. */
  async discover(): Promise<Collector[]> {
    const now = this.now();
    if (this.collectorCache && now - this.collectorCache.at < this.cfg.collectorRefreshMs) {
      return this.collectorCache.list;
    }
    const list = (await this.deps.api.collectors()).filter((c) => !!c.id);
    this.collectorCache = { at: now, list };
    return list;
  }

  /** First sight of a collector: ledger every job in the retention window as
   *  handled, and evaluate only the newest terminal one. Booting must show real
   *  current health without replaying sixteen days of retroactive incidents —
   *  and must never heal against a two-week-old DOM. */
  async seedCursor(collectorId: string): Promise<void> {
    const { store, api } = this.deps;
    const name = this.nameFor(collectorId);
    const now = this.now();
    const jobs = await api.jobs({
      collector: collectorId,
      // Padded for the same undocumented timezone as pollWindow. Seeding against
      // a short window is worse than polling against one: it decides which job
      // is "current" at first boot, and a missing today would make a two-day-old
      // run look like the newest thing that ever happened.
      fromDate: utcDay(now - this.cfg.retentionDays * DAY_MS - WINDOW_PAD_MS),
      toDate: utcDay(now + WINDOW_PAD_MS),
    });
    // Only terminal jobs are seeded. Marking a still-running job handled would
    // discard its result the moment it finished.
    const terminal = jobs.filter((j) => isTerminal(j));
    const newest = newestJob(terminal);
    for (const j of terminal) {
      if (j.id === newest?.id) continue;
      await store.claimJob(j.id, name, now);
      await store.settleJob(j.id, "seeded");
    }
    const cursor: MonitorCursor = { ...store.monitorCursor(name), last_polled_ms: now, seeded: true };
    await store.setMonitorCursor(name, cursor);
    await store.audit({ event: "monitor_seeded", collector: collectorId, scraper: name, jobs: terminal.length });
  }

  async pollCollector(collectorId: string): Promise<PollReport> {
    const { store, api } = this.deps;
    const name = this.nameFor(collectorId);
    const report = emptyReport(this.now());
    await store.ensureCollector(name);

    let cursor = store.monitorCursor(name);
    if (!cursor.seeded) {
      await this.seedCursor(collectorId);
      cursor = store.monitorCursor(name);
    }

    const { fromDate, toDate } = pollWindow(cursor, this.now(), this.cfg);
    const fresh = await api.jobs({ collector: collectorId, fromDate, toDate });
    // Deferred jobs carry their payload so they survive ageing out of the
    // window; without that a job discovered during a heal would be lost.
    const deferred = store.deferredJobs(name).flatMap((e) => (e.job ? [e.job] : []));
    const seen = new Map<string, Job>();
    for (const j of [...deferred, ...fresh]) seen.set(j.id, j);
    report.jobs_seen = seen.size;

    for (const job of seen.values()) {
      if (store.jobLedgerState(job.id) === "handled") continue;
      if (!isTerminal(job)) continue;

      const state = store.collectorState(name);
      if (!DISPATCHABLE.has(state)) {
        await store.deferJob(job.id, name, this.now(), `collector state=${state}`, job);
        report.jobs_deferred++;
        continue;
      }

      // Claimed BEFORE dispatch: at-most-once beats at-least-once here, because
      // a replay could re-spend an AI generation or approve an ungated fix.
      await store.claimJob(job.id, name, this.now());
      try {
        const outcome = await this.handleJob(collectorId, name, job, [...seen.values()]);
        if (outcome.deferred) {
          await store.deferJob(job.id, name, this.now(), outcome.deferred, job);
          report.jobs_deferred++;
          continue;
        }
        await store.settleJob(job.id, outcome.outcome, outcome.incidentId);
        report.jobs_handled++;
        if (outcome.incidentId) report.incidents_opened.push(outcome.incidentId);
      } catch (err) {
        // A transport failure is not a page-shape problem, so it never reaches
        // evaluate(). Without this catch the rejection escapes start()'s `void`
        // call, becomes an unhandled rejection, and kills the agent — turning
        // one 429 into a container restart loop.
        const first = (err as Error).message.split("\n")[0]!;
        await store.deferJob(job.id, name, this.now(), `poll error: ${first}`, job);
        report.jobs_deferred++;
        report.errors.push(`[${name}] ${job.id}: ${first}`);
        this.log(`[${name}] job ${job.id} failed: ${first} — deferred to the next poll`);
      }
    }

    const platform = this.platformFor(collectorId);
    await store.setMonitorCursor(name, {
      ...store.monitorCursor(name),
      last_polled_ms: this.now(),
      // Refreshed every poll, not just at discovery: a scraper renamed in Studio
      // must not keep its old name on the board.
      ...(platform?.name ? { platform_name: platform.name } : {}),
      ...(platform?.active != null ? { platform_active: platform.active } : {}),
    });
    return report;
  }

  private async handleJob(
    collectorId: string,
    name: string,
    job: Job,
    siblings: readonly Job[] = [],
  ): Promise<{ outcome?: "success" | "partial" | "failed" | "unknown"; incidentId?: string; deferred?: string }> {
    const { store, api } = this.deps;
    const contract = this.deps.contracts.get(collectorId);

    const log = await api.jobLog(job.id).catch(() => undefined);

    // The job id is the collection id for /dca/dataset — for jobs that HAVE a
    // dataset. Preview and test runs do not: the endpoint rejects them outright,
    // and a rejection that will never stop happening must not be deferred, or
    // the job is re-offered on every poll for the rest of the agent's life.
    // Judging it from its counters alone is worse evidence, not no evidence: the
    // row-level codes are what carry a routing lane, so a job read this way is
    // unexplained by construction and the two-strike rule below applies to it.
    let rows: Record<string, unknown>[] | undefined;
    try {
      const dataset = await api.dataset(job.id);
      if (!Array.isArray(dataset)) {
        // Rows land after the job finishes. Reading "not ready" as "no errors"
        // is a silent false negative, so this waits instead of judging.
        return { deferred: `dataset ${dataset.status}` };
      }
      rows = dataset;
    } catch (err) {
      if (!(err instanceof BrightDataApiError) || !err.permanent) throw err;
      await store.audit({ event: "dataset_unavailable", scraper: name, job_id: job.id, status: err.status, detail: err.body });
      this.log(`[${name}] job ${job.id}: no dataset to read (${err.message}) — judging it on its job counters alone, which cannot explain a failure`);
    }

    let health = classifyJob(job, log, rows);
    if (health.outcome === "unknown") return { deferred: "job produced no usable signal yet" };

    // The dataset does not always carry the per-input failures. A scheduled run
    // with failed_pages=1 and success_rate=0 returned an EMPTY dataset, while the
    // platform's own export of that same run held
    // {"input":{...},"error":"Error: price missing"} — so ANANSI reported a run
    // that had explained itself perfectly as "failed with no row-level error
    // code", and had nothing to route on. When the counters say a job failed and
    // no row says why, ask the endpoint whose whole job is to say why.
    if (health.outcome !== "success" && health.errorCodes.length === 0) {
      const errors = await api.jobErrors(job.id).catch((err: unknown) => {
        this.log(`[${name}] job ${job.id}: could not read per-input errors (${(err as Error).message})`);
        return [] as { url?: string; error?: string }[];
      });
      if (errors.length) {
        // Shaped as dataset rows so everything downstream keeps one row format.
        rows = [...(rows ?? []), ...errors.map((e) => ({ input: e.url, error: e.error }))];
        health = classifyJob(job, log, rows);
        this.log(`[${name}] job ${job.id}: dataset carried no failure, hp_errors explained ${errors.length} input(s)`);
      }
    }

    // Read from the RAW rows: splitRow reduces a prose message to the opaque
    // code `row_error`, and the message is the only place the field name lives.
    const errorMessages = (rows ?? []).flatMap((r) =>
      [r.error, r.error_code].filter((v): v is string => typeof v === "string" && v.trim() !== ""),
    );
    const namedFields = contract
      ? [...new Set(errorMessages.flatMap((m) => requiredFieldsNamedIn(m, contract)))]
      : [];

    const ts = health.finishedMs ?? this.now();
    const cursor = store.monitorCursor(name);
    const { records } = rowsToRecords(rows ?? [], ts);

    // A contract whose canaries match none of the collected URLs is a contract
    // that silently does nothing: evaluate() joins goldens by exact URL, so a
    // canary the rows never mention is skipped rather than failed. Loud, because
    // the symptom of the bug is a perfectly clean verdict.
    if (contract && contract.canaries.length > 0 && records.length > 0) {
      const collected = new Set(records.map((r) => r.url));
      if (!contract.canaries.some((c) => collected.has(c.url))) {
        this.log(
          `[${name}] job ${job.id}: none of ${contract.canaries.length} canary URL(s) appear in the collected rows — goldens are inert for this run (contract e.g. ${contract.canaries[0]!.url}, collected e.g. ${records[0]!.url})`,
        );
        await store.audit({ event: "canaries_unmatched", scraper: name, job_id: job.id, canary: contract.canaries[0]!.url, collected: records[0]!.url });
      }
    }

    // A per-input error naming a required field is the most specific signal
    // available — more specific than any counter — so it is carried as a
    // contract violation on that field, which is what the heal prompt reads.
    const fieldSignals: Violation[] = namedFields.map((field) => ({
      signal: "contract",
      field,
      detail: `per-input error names required field "${field}" — the page rendered and the parser ran, but the field was absent`,
    }));

    // Volume is the only shape check available when nobody declared a contract
    // — and it is also the only one that fires on an EMPTY result set, because
    // evaluate() has no records to judge and every gate passes vacuously. So a
    // contract suppresses it only while rows actually arrived.
    const volume = contract && records.length > 0 ? [] : rowVolumeSignals(health.totals, cursor.line_counts);

    let sense: SenseResult = { kind: "healthy", warnings: [] };
    let nextFlags = store.flags(name);
    if (contract && records.length) {
      const out = evaluate(contract, records, store.history(name), store.flags(name));
      sense = out.result;
      nextFlags = out.flags;
    }
    let merged = mergeJobHealth(health, sense, name, records, [...volume, ...fieldSignals]);

    // Two-strike rule for a failure nothing explains. Routing blind to heal
    // burns AI generations on what is usually a platform hiccup; routing it to
    // retry forever means a genuine break never heals.
    const strikes = health.unexplained && merged.kind === "incident" && merged.route === "retry"
      ? cursor.unexplained_failures + 1
      : 0;
    if (health.unexplained && merged.kind === "incident" && strikes >= 2) {
      merged = { ...merged, route: "heal" };
    }

    await this.rememberJob(name, job, health, strikes);
    await store.setFlags(name, nextFlags);

    if (merged.kind === "healthy") {
      const { refs } = await this.archive(this.targetUrls(contract, records), false);
      await this.recordRun(name, records, refs, job.id, ts, true);
      if (store.collectorState(name) === "watching") {
        // The run that verifies a promoted fix is Bright Data's own next one.
        await store.setCollectorState(name, "healthy");
      }
      if (merged.warnings.length) {
        this.log(`[${name}] job ${job.id} healthy with warnings: ${merged.warnings.map((w) => `${w.signal}:${w.field ?? ""}`).join(", ")}`);
      }
      return { outcome: health.outcome };
    }

    if (health.unexplained && strikes === 1) {
      // First unexplained failure: watched, not healed. It still opens an
      // incident. "Do not spend a heal on this" and "do not tell anyone this
      // happened" are different decisions, and only the first one is defensible:
      // returning here left a run with 15 failed pages showing in the console as
      // "every run came back clean". The retry lane below records it and closes
      // it without spending anything, which is exactly the intended outcome.
      await store.audit({ event: "unexplained_failure", scraper: name, job_id: job.id, strike: 1 });
      this.log(`[${name}] job ${job.id} failed with nothing to explain it — first strike, watching rather than healing`);
    }

    // A collector that was watching a promoted fix and failed the very next
    // scheduled run is not a candidate for another AI attempt.
    //
    // But only a run that STARTED after the promotion can verify it. Bright Data
    // runs on its own schedule, so a job queued moments before the incident
    // opened finishes carrying the pre-fix template — observed live: the run
    // that quarantined lab-storefront had template .3, the same as the run that
    // triggered the heal, and finished 50 seconds BEFORE the heal call was made.
    // Judging a fix by output that predates it condemns every heal whose
    // collector runs more often than a heal takes.
    const watchingSince = cursor.watching_since_ms;
    const jobStarted = Date.parse(job.started ?? job.queued ?? "");
    const predatesFix =
      store.collectorState(name) === "watching" &&
      watchingSince != null &&
      Number.isFinite(jobStarted) &&
      jobStarted < watchingSince;

    if (predatesFix) {
      await this.recordRun(name, records, {}, job.id, ts, false);
      await store.audit({ event: "pre_fix_run_ignored", scraper: name, job_id: job.id, started: jobStarted, watching_since: watchingSince });
      this.log(`[${name}] job ${job.id} failed, but it started before the fix was promoted — it ran the old template, so it verifies nothing. Still watching.`);
      return { outcome: health.outcome };
    }

    if (store.collectorState(name) === "watching") {
      await this.recordRun(name, records, (await this.archive(this.targetUrls(contract, records), true)).refs, job.id, ts, false);
      await store.setCollectorState(name, "quarantined");
      await store.audit({ event: "post_promotion_regression", scraper: name, job_id: job.id, signals: merged.signals });
      this.log(`[${name}] job ${job.id} FAILED on the first scheduled run after a promotion — quarantined, not re-healed`);
      return { outcome: health.outcome };
    }

    const { refs, captures } = await this.archive(this.targetUrls(contract, records, merged.signals), true);
    const withRefs = records.map((r) => (refs[r.url] ? { ...r, snapshot_ref: refs[r.url] } : r));
    await this.recordRun(name, withRefs, {}, job.id, ts, false);

    // "Returned 0 rows" was the one failure that could never be diagnosed:
    // Diagnose looks for a record carrying a snapshot, and a job with no rows
    // has no records at all. But the pages are right there — the contract's
    // canaries were archived a moment ago, and the last clean run archived the
    // same URLs — so the diff is available even though the scraper produced
    // nothing. These stand in for Diagnose only; recordRun above has already
    // written the real (empty) result, and inventing rows in the store would be
    // the same lie in a worse place.
    const diagnosable: RunRecord[] = withRefs.length
      ? withRefs
      : Object.entries(refs).map(([url, ref]) => ({ url, fields: {}, snapshot_ref: ref, ts }));

    // An archive fetch that was itself blocked, 404'd or timed out is a routable
    // fact about the target, not noise: no selector edit repairs a 403, and a
    // dead URL is never healed (ADR-003). Without this the archive's own error
    // taxonomy was computed, logged and then thrown away.
    const archiveCodes = captures.flatMap((c) => (c.error_code ? [c.error_code] : []));
    const archiveRoute = jobRoute(archiveCodes);

    // Facts that outrank what sense concluded on its own, each carrying the
    // reason that earned it. Only a strictly more urgent lane may win, so an
    // override can never soften a verdict — only sharpen it.
    const overrides: { route: Route; detail: string }[] = [];
    if (archiveRoute) {
      overrides.push({ route: archiveRoute, detail: `archive fetch returned ${[...new Set(archiveCodes)].join(", ")} → ${archiveRoute} lane` });
    }
    if (namedFields.length) {
      // routeErrorCode is right to call "Error: price missing" unknown and send
      // it to retry — a sentence is not a code. But it names a field WE declared
      // required, which makes it the DOM change heal exists for. Without this a
      // genuine selector break retried forever and never healed.
      overrides.push({
        route: "heal",
        detail: `per-input error names required contract field(s) ${namedFields.join(", ")} → heal lane`,
      });
    }
    const better = overrides
      .filter((o) => ROUTE_PRECEDENCE.indexOf(o.route) < ROUTE_PRECEDENCE.indexOf(merged.route))
      .sort((a, b) => ROUTE_PRECEDENCE.indexOf(a.route) - ROUTE_PRECEDENCE.indexOf(b.route))[0];
    const route = better?.route ?? merged.route;
    const signals = better ? [...merged.signals, { signal: "hard_fail" as const, detail: better.detail }] : merged.signals;

    const incident = { ...merged, route, signals, records: diagnosable, snapshot_refs: Object.values(refs) };
    this.log(`[${name}] INCIDENT (${incident.route}) from job ${job.id}: ${incident.signals.map((v) => `${v.signal}${v.field ? `:${v.field}` : ""}`).join(", ")}`);
    const rec = await driveIncident(incident, contract ?? observedContract(collectorId), {
      knownGood: await this.knownGoodFor(collectorId, name, siblings, job.id),
      bd: this.deps.heal,
      llm: this.deps.llm,
      store,
      collectorId,
      requiresHumanApproval: !contract,
      log: this.log,
    });
    // The clock the verification run is measured against. Written here rather
    // than inside driveIncident so the incident logic stays free of cursors.
    if (rec.resolution === "promoted") {
      await store.setMonitorCursor(name, { ...store.monitorCursor(name), watching_since_ms: this.now() });
    }
    return { outcome: health.outcome, incidentId: rec.id };
  }

  /** What this scraper last produced correctly, recovered from the PLATFORM when
   *  our own store cannot answer.
   *
   *  Cold start is the case that matters. On a fresh deploy — or after the store
   *  is cleared — ANANSI has observed no healthy run, so it holds no known-good
   *  values, and a failure arriving before any success would be undiagnosable
   *  for want of history it could simply have read. Bright Data keeps that
   *  history: the newest job whose dataset has rows is the scraper's own last
   *  correct output. Costs one GET, and only on the incident path when the store
   *  came back empty.
   *
   *  Works for every collector because it reads the rows a scraper emits, not a
   *  page it may never have collected. */
  private async knownGoodFor(collectorId: string, name: string, siblings: readonly Job[], failedJobId: string): Promise<KnownGood> {
    const stored = this.deps.store.lastGoodFields(name);
    if (Object.keys(stored).length > 0) return stored;

    const candidates = [...siblings]
      .filter((j) => j.id !== failedJobId && (j.data_lines ?? 0) > 0 && !(j.failed_pages ?? 0))
      .sort((a, b) => Date.parse(b.finished ?? b.started ?? "") - Date.parse(a.finished ?? a.started ?? ""));

    for (const cand of candidates.slice(0, 3)) {
      const rows = await this.deps.api.dataset(cand.id).catch(() => undefined);
      if (!Array.isArray(rows) || rows.length === 0) continue;
      const out: KnownGood = {};
      for (const row of rows) {
        const { url, fields } = splitRow(row as RawRow, this.platformFor(collectorId)?.output_schema);
        const kept = Object.fromEntries(Object.entries(fields).filter(([, v]) => v != null));
        if (url && Object.keys(kept).length) out[url] = kept;
      }
      if (Object.keys(out).length) {
        this.log(`[${name}] no known-good rows in the store — recovered ${Object.keys(out).length} from job ${cand.id}, the platform's last run that produced any`);
        return out;
      }
    }
    return {};
  }

  /** Canary URLs first — they are what the goldens pin. Without a contract the
   *  collected rows are the only target list there is. */
  private targetUrls(contract: Contract | undefined, records: RunRecord[], signals: Violation[] = []): string[] {
    const hit = signals.flatMap((s) => (s.url ? [s.url] : []));
    const canaries = contract?.canaries.map((c) => c.url) ?? [];
    const collected = records.map((r) => r.url).filter((u) => u !== "unknown");
    return [...new Set([...hit, ...canaries, ...collected])];
  }

  private async archive(urls: string[], force: boolean): Promise<ArchiveResult> {
    const { refs, captures } = await archivePages(
      urls,
      this.deps.store,
      this.deps.fetchPage,
      { maxUrls: this.cfg.maxArchiveUrlsPerJob, floorMs: this.cfg.archiveFloorMs, force },
      this.lastArchiveMs,
      this.now,
    );
    for (const c of captures.filter((c) => c.low_confidence)) {
      // Loud on purpose: a diff against a challenge page describes OUR block,
      // not the scraper's failure. archivePages() withholds the ref, so the
      // incident quarantines for a human rather than healing off a captcha.
      this.log(`archive: ${c.url} → status ${c.status}, ${c.bytes} bytes — low confidence, withheld: evidence from it is not the page the scraper saw`);
    }
    return { refs, captures };
  }

  private async recordRun(
    name: string,
    records: RunRecord[],
    refs: Record<string, string>,
    jobId: string,
    ts: number,
    healthy: boolean,
  ): Promise<void> {
    for (const r of records) {
      const snapshot_ref = r.snapshot_ref ?? refs[r.url];
      await this.deps.store.appendRun({
        ...r,
        ...(snapshot_ref ? { snapshot_ref } : {}),
        scraper: name,
        healthy,
        // The platform job id groups rows into one run. Unlike the scheduler's
        // invented sweep_ts this is not a number we made up.
        sweep_ts: ts,
        job_id: jobId,
      } as never);
    }
    // A job that returned no rows at all still has to leave a trace, or the
    // console cannot tell "scanned, nothing wrong" from "agent is dead".
    // job_id is what makes that trace joinable: without it apps/console/jobs.ts
    // drops the row, and the run that failed hardest is the one the console
    // shows with no finish time at all.
    if (records.length === 0) {
      await this.deps.store.appendRun({
        url: "unknown",
        fields: {},
        ts,
        scraper: name,
        healthy,
        sweep_ts: ts,
        job_id: jobId,
        // Marked, because it is a trace and not data. Counted as a row it makes
        // the console report "1 row" for a job whose own incident says the job
        // returned none — the console contradicting itself in two panels.
        placeholder: true,
      } as never);
    }
  }

  private async rememberJob(name: string, job: Job, health: JobHealth, strikes: number): Promise<void> {
    const cursor = this.deps.store.monitorCursor(name);
    const started = Date.parse(job.started ?? job.queued ?? "");
    const cap = this.cfg.historySamples;
    await this.deps.store.setMonitorCursor(name, {
      ...cursor,
      last_job_finish_ms: health.finishedMs ?? cursor.last_job_finish_ms,
      unexplained_failures: strikes,
      start_times_ms: Number.isFinite(started) ? [...cursor.start_times_ms, started].slice(-cap) : cursor.start_times_ms,
      line_counts: [...cursor.line_counts, health.totals.lines ?? 0].slice(-cap),
      seeded: true,
    });
  }

  /** Single-flight: a heal can run 25 minutes and must never overlap itself. */
  async pollOnce(): Promise<PollReport> {
    const report = emptyReport(this.now());
    if (this.polling) return report;
    this.polling = true;
    try {
      const collectors = await this.discover();
      report.collectors = collectors.length;
      for (const c of collectors) {
        try {
          mergeReport(report, await this.pollCollector(c.id));
        } catch (err) {
          const first = (err as Error).message.split("\n")[0]!;
          report.errors.push(`[${c.id}] ${first}`);
          this.log(`[${c.id}] poll failed: ${first} — retrying next tick`);
        }
      }
      await this.deps.store.pruneJobLedger(this.now() - (this.cfg.retentionDays + 1) * DAY_MS);
    } catch (err) {
      const first = (err as Error).message.split("\n")[0]!;
      report.errors.push(first);
      this.log(`discovery failed: ${first} — retrying next tick`);
    } finally {
      this.polling = false;
    }
    return report;
  }

  start(): NodeJS.Timeout {
    const base = Math.max(1, this.cfg.pollSeconds) * 1000;
    // Jitter so a fleet of agents restarted together does not synchronise into
    // a thundering herd against the same REST endpoint.
    const ms = base + Math.floor(base * (this.cfg.jitterPct / 100) * (Math.random() * 2 - 1));
    void this.pollOnce();
    this.timer = setInterval(() => void this.pollOnce(), Math.max(1000, ms));
    return this.timer;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
