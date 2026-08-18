import { useEffect, useState } from "react";

export type CollectorState = "healthy" | "incident_open" | "healing" | "verifying" | "watching" | "quarantined";
export type GateResult = { gate: string; pass: boolean; detail: string };
export type Verdict = { pass: boolean; gates: GateResult[]; confidence: number };
export type Violation = { signal: string; field?: string; url?: string; detail: string };
export type HealAttempt = { prompt: string; diff_summary: string; verdict?: Verdict; phase: "v1" | "v2"; ts: number };
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
export type FleetEntry = { name: string; state: CollectorState; lastChecked?: number };
export type StatePayload = {
  fleet: FleetEntry[];
  creditsSpent: number;
  incidents: IncidentRecord[];
  /** Agent adapter: "real" (platform) · "live" (rehearsal) · "fake" (fixtures). */
  mode?: string;
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
