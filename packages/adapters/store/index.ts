// Store: run history, snapshots, incidents, audit log — JSONL + files under
// data/. Bright Data retains results only 7–16 days; this store is the system
// of record, never theirs.

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { CollectorState, FieldHistory, IncidentRecord, RunRecord } from "../../core/types.js";
import type { JobOutcome } from "../../core/sense/job-health.js";
import type { Job } from "../brightdata/api.js";
import type { PriorFlags } from "../../core/sense/evaluate.js";

export type StoredRun = RunRecord & { scraper: string; lab_state?: string; healthy?: boolean; sweep_ts?: number };

/** A platform job's lifecycle inside ANANSI. `claimed` is written BEFORE any
 *  dispatch: a crash mid-heal must not replay on restart, because a replay
 *  could re-spend an AI generation or approve a fix nobody gated. */
export type JobLedgerState = "claimed" | "handled" | "deferred";

export type JobLedgerEntry = {
  job_id: string;
  collector: string;
  /** Finish time when known, else discovery time — used only for pruning. */
  ts: number;
  state: JobLedgerState;
  outcome?: JobOutcome | "seeded" | "abandoned";
  incident_id?: string;
  defer_reason?: string;
  /** The job payload rides along on a deferral so a job discovered during a
   *  heal can be re-swept later, even once it has aged out of the poll window.
   *  A dropped tick used to be harmless; a dropped job is a lost fact. */
  job?: Job;
};

/** Per-collector poll bookkeeping. Not correctness-bearing — the ledger is.
 *  This only narrows the query window and carries the two-strike counters. */
export type MonitorCursor = {
  last_polled_ms: number;
  last_job_finish_ms?: number;
  /** Consecutive failures with no error_code to explain them. */
  unexplained_failures: number;
  /** Recent job start times, newest last — feeds inferSchedule(). */
  start_times_ms: number[];
  /** Recent row counts, newest last — feeds rowVolumeSignals(). */
  line_counts: number[];
  seeded: boolean;
  /** What Bright Data calls this scraper, refreshed on every poll.
   *
   *  The store key is ours and has to stay stable, but it is not a name anyone
   *  can look up: it is a contract's `scraper:` field, or an opaque collector
   *  id. Neither exists on the platform. This is the name the operator gave the
   *  scraper in Studio, and it is what the console shows — so renaming it there
   *  renames it here, and a scraper nobody wrote a contract for is never a row
   *  of hex on the board. */
  platform_name?: string;
  /** Whether the platform reports the scraper as active. A paused scraper that
   *  stops running is not overdue; it is off. */
  platform_active?: boolean;
  /** When a fix was promoted and the collector began watching for its
   *  verification. A run that STARTED before this ran the pre-fix template and
   *  can prove nothing about the fix, however it turns out. */
  watching_since_ms?: number;
};

export const NEW_CURSOR: MonitorCursor = {
  last_polled_ms: 0,
  unexplained_failures: 0,
  start_times_ms: [],
  line_counts: [],
  seeded: false,
};

type StateFile = {
  collectors: Record<string, CollectorState>;
  flags: Record<string, PriorFlags>;
  creditsSpent: number;
  monitor?: Record<string, MonitorCursor>;
};

export class Store {
  constructor(readonly dir = "data") {}

  private file(name: string): string {
    return join(this.dir, name);
  }

  async init(): Promise<void> {
    await mkdir(join(this.dir, "snapshots"), { recursive: true });
    await mkdir(join(this.dir, "fixtures"), { recursive: true });
  }

  // --- runs ---------------------------------------------------------------
  async appendRun(run: StoredRun): Promise<void> {
    await appendFile(this.file("runs.jsonl"), `${JSON.stringify(run)}\n`);
  }

  private readLines<T>(name: string): T[] {
    const p = this.file(name);
    if (!existsSync(p)) return [];
    return readFileSync(p, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as T);
  }

  runs(scraper: string): StoredRun[] {
    return this.readLines<StoredRun>("runs.jsonl").filter((r) => r.scraper === scraper);
  }

  // Numeric history per field per URL for CUSUM, oldest first. labStateFilter lets
  // D2 tuning use only clean-baseline (state=none) captures from the harness.
  history(scraper: string, labStateFilter?: string): FieldHistory {
    const out: FieldHistory = {};
    for (const r of this.runs(scraper)) {
      if (r.error_code) continue;
      if (labStateFilter != null && r.lab_state !== labStateFilter) continue;
      for (const [f, v] of Object.entries(r.fields)) {
        if (typeof v !== "number") continue;
        ((out[f] ??= {})[r.url] ??= []).push(v);
      }
    }
    return out;
  }

  // --- snapshots ----------------------------------------------------------
  async saveSnapshot(html: string): Promise<string> {
    const ref = createHash("sha256").update(html).digest("hex").slice(0, 16);
    await writeFile(join(this.dir, "snapshots", `${ref}.html`), html);
    return ref;
  }

  async snapshot(ref: string): Promise<string> {
    return readFile(join(this.dir, "snapshots", `${ref}.html`), "utf8");
  }

  // Most recent snapshot for a URL captured while the sweep was healthy.
  lastGoodSnapshotRef(scraper: string, url: string): string | undefined {
    const rs = this.runs(scraper).filter((r) => r.url === url && !r.error_code && r.snapshot_ref && r.healthy === true);
    return rs[rs.length - 1]?.snapshot_ref;
  }

  /** The values this scraper last produced correctly, by url then field.
   *
   *  This is the baseline that exists for EVERY collector. An archived page does
   *  not: Studio's HTML tag is opt-in, so most scrapers have no historical page
   *  anywhere, and gating Diagnose on one confined it to the few that do. A row
   *  the scraper emitted while healthy is its own statement of what right looks
   *  like, and Diagnose only needs the value — it locates it in the live page. */
  lastGoodFields(scraper: string): Record<string, Record<string, unknown>> {
    const out: Record<string, Record<string, unknown>> = {};
    for (const r of this.runs(scraper)) {
      if (r.error_code || r.healthy !== true) continue;
      if (!r.url || r.url === "unknown") continue;
      const fields = Object.fromEntries(Object.entries(r.fields).filter(([, v]) => v != null));
      if (Object.keys(fields).length === 0) continue;
      out[r.url] = fields; // later runs win: newest correct output for that url
    }
    return out;
  }

  // --- incidents (event-sourced: append updates, last write wins) ---------
  async putIncident(rec: IncidentRecord): Promise<void> {
    await appendFile(this.file("incidents.jsonl"), `${JSON.stringify(rec)}\n`);
  }

  incidents(): IncidentRecord[] {
    const byId = new Map<string, IncidentRecord>();
    for (const rec of this.readLines<IncidentRecord>("incidents.jsonl")) byId.set(rec.id, rec);
    return [...byId.values()].sort((a, b) => a.opened_at - b.opened_at);
  }

  incident(id: string): IncidentRecord | undefined {
    return this.incidents().find((r) => r.id === id);
  }

  // --- audit (append-only) ------------------------------------------------
  async audit(event: Record<string, unknown>): Promise<void> {
    await appendFile(this.file("audit.jsonl"), `${JSON.stringify({ ts: Date.now(), ...event })}\n`);
  }

  auditLog(): Record<string, unknown>[] {
    return this.readLines("audit.jsonl");
  }

  // --- collector state machine + sense flags ------------------------------
  // runs/incidents/audit are re-read from disk on every call, but state.json is
  // hot enough to cache. The cache is keyed on the file's mtime because the
  // agent and the console are separate processes sharing one data volume (see
  // docs/deploy-coolify.md): a read-only console that cached forever would show
  // a fleet frozen at boot — collector states and credits would never move.
  private stateCache?: StateFile;
  private stateMtimeMs = -1;

  private mtimeMs(): number {
    const p = this.file("state.json");
    return existsSync(p) ? statSync(p).mtimeMs : 0;
  }

  private state(): StateFile {
    const mtime = this.mtimeMs();
    if (!this.stateCache || mtime !== this.stateMtimeMs) {
      const p = this.file("state.json");
      this.stateCache = existsSync(p)
        ? (JSON.parse(readFileSync(p, "utf8")) as StateFile)
        : { collectors: {}, flags: {}, creditsSpent: 0 };
      this.stateMtimeMs = mtime;
    }
    return this.stateCache;
  }

  private async persistState(): Promise<void> {
    const s = this.state();
    await writeFile(this.file("state.json"), JSON.stringify(s, null, 2));
    // Adopt our own write's mtime so the next read keeps this object rather
    // than reloading it (only the agent writes; the console is read-only).
    this.stateMtimeMs = this.mtimeMs();
  }

  collectorState(scraper: string): CollectorState {
    return this.state().collectors[scraper] ?? "healthy";
  }

  collectors(): Record<string, CollectorState> {
    return { ...this.state().collectors };
  }

  /** Put a collector on the board at its default state, without the
   *  state_change audit event a real transition emits. Called once at agent
   *  startup so a freshly deployed fleet is visible in the console before
   *  anything has gone wrong — otherwise a healthy fleet reads as "no
   *  collectors yet", which is indistinguishable from a dead agent. */
  async ensureCollector(scraper: string): Promise<void> {
    if (this.state().collectors[scraper]) return;
    this.state().collectors[scraper] = "healthy";
    await this.persistState();
  }

  async setCollectorState(scraper: string, s: CollectorState): Promise<void> {
    this.state().collectors[scraper] = s;
    await this.persistState();
    await this.audit({ event: "state_change", scraper, state: s });
  }

  flags(scraper: string): PriorFlags {
    return this.state().flags[scraper] ?? { fill_rate: [], cusum: [] };
  }

  async setFlags(scraper: string, f: PriorFlags): Promise<void> {
    this.state().flags[scraper] = f;
    await this.persistState();
  }

  creditsSpent(): number {
    return this.state().creditsSpent;
  }

  /** ANANSI causes no page loads, so this counts heal attempts — the only spend
   *  it can still initiate. */
  async addCredits(n: number): Promise<void> {
    this.state().creditsSpent += n;
    await this.persistState();
  }

  // --- job ledger (append-only jsonl, last write wins) --------------------
  jobLedger(collector?: string): JobLedgerEntry[] {
    const byId = new Map<string, JobLedgerEntry>();
    for (const e of this.readLines<JobLedgerEntry>("jobs.jsonl")) byId.set(e.job_id, e);
    const all = [...byId.values()];
    return collector ? all.filter((e) => e.collector === collector) : all;
  }

  jobLedgerState(jobId: string): JobLedgerState | undefined {
    return this.jobLedger().find((e) => e.job_id === jobId)?.state;
  }

  private async putLedger(entry: JobLedgerEntry): Promise<void> {
    await appendFile(this.file("jobs.jsonl"), `${JSON.stringify(entry)}\n`);
  }

  async claimJob(jobId: string, collector: string, ts: number): Promise<void> {
    await this.putLedger({ job_id: jobId, collector, ts, state: "claimed" });
  }

  async settleJob(jobId: string, outcome: JobLedgerEntry["outcome"], incidentId?: string): Promise<void> {
    const prev = this.jobLedger().find((e) => e.job_id === jobId);
    await this.putLedger({
      job_id: jobId,
      collector: prev?.collector ?? "",
      ts: prev?.ts ?? Date.now(),
      state: "handled",
      outcome,
      ...(incidentId ? { incident_id: incidentId } : {}),
    });
  }

  async deferJob(jobId: string, collector: string, ts: number, reason: string, job?: Job): Promise<void> {
    // Keep the FIRST time this job was seen. Restamping it on every re-defer
    // would let a job that can never be handled outlive the retention window it
    // is pruned by, which is how one stuck job becomes a permanent one.
    const first = this.jobLedger().find((e) => e.job_id === jobId)?.ts ?? ts;
    await this.putLedger({ job_id: jobId, collector, ts: first, state: "deferred", defer_reason: reason, ...(job ? { job } : {}) });
  }

  deferredJobs(collector: string): JobLedgerEntry[] {
    return this.jobLedger(collector).filter((e) => e.state === "deferred");
  }

  /** Entries older than the platform's own retention can never be re-offered,
   *  so dropping them bounds the ledger without an arbitrary cap. */
  async pruneJobLedger(beforeMs: number): Promise<void> {
    const kept = this.jobLedger().filter((e) => e.ts >= beforeMs);
    await writeFile(this.file("jobs.jsonl"), kept.map((e) => `${JSON.stringify(e)}\n`).join(""));
  }

  // --- monitor cursor -----------------------------------------------------
  monitorCursor(collector: string): MonitorCursor {
    return this.state().monitor?.[collector] ?? { ...NEW_CURSOR };
  }

  async setMonitorCursor(collector: string, c: MonitorCursor): Promise<void> {
    (this.state().monitor ??= {})[collector] = c;
    await this.persistState();
  }

  /** Heal attempts in a rolling window, read from the audit log rather than a
   *  counter, so a restart cannot reset a collector's daily budget. */
  healAttemptsSince(collector: string, sinceMs: number): number {
    return this.auditLog().filter(
      (e) => e.event === "heal_start" && e.scraper === collector && typeof e.ts === "number" && e.ts >= sinceMs,
    ).length;
  }
}
