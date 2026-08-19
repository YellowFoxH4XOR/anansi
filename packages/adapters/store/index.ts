// Store: run history, snapshots, incidents, audit log — JSONL + files under
// data/. Bright Data retains results only 7–16 days; this store is the system
// of record, never theirs.

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { CollectorState, FieldHistory, IncidentRecord, RunRecord } from "../../core/types.js";
import type { PriorFlags } from "../../core/sense/evaluate.js";

export type StoredRun = RunRecord & { scraper: string; lab_state?: string; healthy?: boolean; sweep_ts?: number };

/** One cadence tick, reconstructed from the rows it wrote. */
export type SweepSummary = {
  sweep_ts: number; // when the sweep started
  finished_ts: number; // last row it wrote
  healthy: boolean;
  canaries: number;
  errors: number;
};

type StateFile = {
  collectors: Record<string, CollectorState>;
  flags: Record<string, PriorFlags>;
  creditsSpent: number;
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

  /** Recent sweeps, newest last. A healthy fleet writes nothing else, so this is
   *  the only evidence the agent is alive and working. Rows are grouped by the
   *  sweep_ts the scheduler stamps them with; rows written before that existed
   *  fall back to proximity, which is why the gap is generous. */
  sweeps(scraper: string, limit = 50): SweepSummary[] {
    const LEGACY_GAP_MS = 3 * 60_000;
    const groups: StoredRun[][] = [];
    for (const r of this.runs(scraper)) {
      const prev = groups[groups.length - 1];
      const last = prev?.[prev.length - 1];
      const sameSweep =
        prev &&
        last &&
        (r.sweep_ts != null && last.sweep_ts != null
          ? r.sweep_ts === last.sweep_ts
          : r.ts - last.ts <= LEGACY_GAP_MS);
      if (sameSweep) prev.push(r);
      else groups.push([r]);
    }

    return groups.slice(-limit).map((rows) => {
      const first = rows[0]!;
      const last = rows[rows.length - 1]!;
      return {
        sweep_ts: first.sweep_ts ?? first.ts,
        finished_ts: last.ts,
        // appendRun stamps every row of a sweep with that sweep's verdict.
        healthy: rows.every((r) => r.healthy === true),
        canaries: rows.length,
        errors: rows.filter((r) => r.error_code).length,
      };
    });
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

  async addCredits(n: number): Promise<void> {
    this.state().creditsSpent += n;
    await this.persistState();
  }
}
