import { useEffect, useState } from "react";

export type CollectorState = "healthy" | "incident_open" | "healing" | "verifying" | "watching" | "quarantined";
export type GateResult = { gate: string; pass: boolean; detail: string };
export type Verdict = { pass: boolean; gates: GateResult[]; confidence: number };
export type Violation = { signal: string; field?: string; url?: string; detail: string };
// One heal attempt = one pre-approval V1 verdict. The post-approval V2 sweep is
// gone: Bright Data's next scheduled run is the verification (ADR-005).
export type HealAttempt = { prompt: string; diff_summary: string; verdict?: Verdict; ts: number };
export type IncidentRecord = {
  id: string;
  scraper: string;
  opened_at: number;
  closed_at?: number;
  signal: Violation[];
  route: string;
  prompt?: string;
  heal_attempts: HealAttempt[];
  resolution?: string;
  credits_spent: number;
  wall_ms?: number;
  approved_by?: string;
};
export type StageView = {
  name: string;
  status: "done" | "fail" | "live" | "pending";
  meta: string;
  gates?: GateResult[];
};
export type JobVerdict = "ok" | "partial" | "failed" | "unknown" | "seeded" | "in_flight" | "deferred" | "abandoned";
export type ContractDepth = "pinned" | "none" | "unknown";
export type RunTick = { job_id: string; verdict: JobVerdict; ts: number };
/** A collector discovered on the platform. Contracts are an optional overlay:
 *  `contract: "none"` is a fully monitored scraper, just without goldens. */
export type FleetEntry = {
  /** Internal store key. Not a name anyone can look up in Scraper Studio. */
  name: string;
  /** What Bright Data calls this scraper — the name to show. */
  platformName?: string;
  paused?: boolean;
  collectorId?: string;
  state: CollectorState;
  contract: ContractDepth;
  lastPolled?: number;
  lastRunAt?: number;
  recent: RunTick[];
  failed24h: number;
  /** Bright Data's cadence as ANANSI observed it, never as ANANSI configured it. */
  expectedEveryMs?: number;
  /** Overdue against that cadence. The one failure only a monitor can report:
   *  a run that never happened leaves no job, no rows and no error behind. */
  stale?: boolean;
};
/** One run Bright Data performed on its own schedule, as ANANSI observed it. */
export type JobRow = {
  job_id: string;
  collector: string;
  verdict: JobVerdict;
  trigger: "scheduled" | "cli" | "unknown";
  seen: number;
  finished?: number;
  rows: number;
  error_rows: number;
  incident_id?: string;
  note?: string;
};
export type StatePayload = {
  fleet: FleetEntry[];
  /** Heal attempts — the only spend ANANSI initiates. Polling is free. */
  healAttempts: number;
  incidents: IncidentRecord[];
  /** Agent HEAL adapter: "real" (platform) · "fake" (fixtures). Monitoring is
   *  read-only in both. */
  mode?: string;
  /** When the agent last read the platform's job history — the only proof a
   *  healthy agent is alive. Null when nothing has been discovered yet. */
  lastPoll?: number | null;
  failedRuns24h: number;
};
export type EvidencePack = {
  failing_fields: string[];
  dom_diff: { added: { path: string; text?: string }[]; removed: { path: string; text?: string }[] };
  value_locations: { field: string; expected: unknown; found_at: { path: string }[] }[];
  prior_failures: string[];
};
export type IncidentPayload = { rec: IncidentRecord; stages: StageView[]; eventCount: number; evidence: EvidencePack | null };
export type DiffPayload = { lastGood: string | null; current: string | null; removed: string[]; added: string[]; codeDiff: string; evidence: EvidencePack | null };
export type RunPoint = { ts: number; url: string; fields: Record<string, unknown>; healthy: boolean | null };

async function get<T>(path: string): Promise<T> {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return (await r.json()) as T;
}

// Poll a JSON endpoint on an interval; keeps last good data on transient errors.
export function usePoll<T>(path: string, intervalMs: number): T | null {
  const [data, setData] = useState<T | null>(null);
  useEffect(() => {
    let alive = true;
    const tick = () => get<T>(path).then((d) => alive && setData(d)).catch(() => {});
    tick();
    const t = setInterval(tick, intervalMs);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [path, intervalMs]);
  return data;
}

export const fetchRuns = (scraper: string) => get<RunPoint[]>(`/api/runs/${encodeURIComponent(scraper)}`);
