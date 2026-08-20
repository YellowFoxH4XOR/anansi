// Fleet view-model. Pure: takes what the store holds and returns what the
// console may claim.
//
// The fleet is whatever Bright Data reports, not whatever contracts/ contains:
// the monitor calls ensureCollector() for every collector it discovers, so a
// scraper built in Scraper Studio is on the board with no config edit and no
// redeploy. A contract is a decoration on a discovered collector — it buys
// goldens, CUSUM and invariants — never the reason a collector exists.

import type { CollectorState } from "../../packages/core/types.js";
import { inferSchedule, isStale } from "../../packages/core/sense/job-health.js";
import { isFailure, type JobRow, type JobVerdict } from "./jobs.js";

/** Whether this collector has goldens behind it.
 *
 *  There is no field in the store that says so: the monitor keys everything by
 *  `contract.scraper ?? collectorId`, and the console must never call the
 *  platform to find out. The `monitor_seeded` audit event carries both halves
 *  of that choice, so a store key that differs from the platform id is a
 *  contract that named it. With no seed event on file we know nothing, and
 *  "unknown" is reported rather than guessed — an unearned "no contract" badge
 *  would tell an operator their goldens are not running when they are. */
export type ContractDepth = "pinned" | "none" | "unknown";

export type RunTick = { job_id: string; verdict: JobVerdict; ts: number };

export type FleetEntry = {
  /** Store key: the contract's display name, else the platform collector id.
   *  Internal identity — stable, and not a name anyone can look up. */
  name: string;
  /** What Bright Data calls this scraper. This is what an operator should see:
   *  the store key is either a name ANANSI invented in a contract or a raw
   *  collector id, and neither appears anywhere in Scraper Studio. Absent until
   *  the first poll has reported it. */
  platformName?: string;
  /** The platform reports the scraper as paused. A paused scraper that stops
   *  running is off, not overdue. */
  paused?: boolean;
  collectorId?: string;
  state: CollectorState;
  contract: ContractDepth;
  /** Last time the agent read this collector's job history. Proof of life —
   *  not proof of a scan, because ANANSI does not scan. */
  lastPolled?: number;
  /** Finish time of the newest run Bright Data performed, as observed. */
  lastRunAt?: number;
  /** Newest last: the run-outcome strip a contract-less card shows instead of
   *  a golden sparkline. */
  recent: RunTick[];
  failed24h: number;
  /** Bright Data's own cadence. Taken from the schedule the platform reports
   *  when it reports one, and only inferred from observed start times otherwise
   *  — inference is a guess, and it is least reliable for the collector whose
   *  runs have stopped, which is the one staleness exists to catch. */
  expectedEveryMs?: number;
  /** The collector is overdue against that learned cadence. This is the one
   *  failure a monitor can see and a scheduler could not: a run that never
   *  happened produces no job, no rows and no error, so nothing else in the
   *  system will ever mention it. Absent until there are enough samples to have
   *  an opinion — a false staleness alarm costs more trust than a late one
   *  costs uptime. */
  stale?: boolean;
};

export type CursorLike = {
  last_polled_ms?: number;
  last_job_finish_ms?: number;
  /** Observed job start times, newest last. Feeds inferSchedule() — the fallback
   *  for a collector the platform reports no schedule for. */
  start_times_ms?: number[];
  /** The cadence collectors_list reports, in ms. Authoritative when present. */
  platform_schedule_ms?: number;
  platform_name?: string;
  platform_active?: boolean;
};

export type FleetInput = {
  collectors: Record<string, CollectorState>;
  /** store key → platform collector id, from `monitor_seeded` audit events. */
  discovered: Record<string, string>;
  cursors: Record<string, CursorLike>;
  jobs: readonly JobRow[];
};

const DAY_MS = 24 * 60 * 60_000;
const STRIP_LENGTH = 20;

/** store key → platform collector id, learned from the monitor's own seed
 *  events. Append-only log, so the last one wins. */
export function discoveredIds(auditLog: readonly Record<string, unknown>[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of auditLog) {
    if (e.event !== "monitor_seeded") continue;
    if (typeof e.scraper === "string" && typeof e.collector === "string") out[e.scraper] = e.collector;
  }
  return out;
}

export function contractDepth(name: string, collectorId: string | undefined): ContractDepth {
  if (collectorId == null) return "unknown";
  return collectorId === name ? "none" : "pinned";
}

export function buildFleet(input: FleetInput, nowMs = Date.now()): FleetEntry[] {
  const since = nowMs - DAY_MS;
  return Object.entries(input.collectors).map(([name, state]) => {
    const collectorId = input.discovered[name];
    const cursor = input.cursors[name] ?? {};
    const mine = input.jobs.filter((j) => j.collector === name);
    const finished = mine.flatMap((j) => (j.finished != null ? [j.finished] : []));
    // The platform's own answer beats our reconstruction of it. inferSchedule
    // stays for collectors that report no schedule — an on-demand scraper still
    // has a rhythm worth noticing — but it is no longer the first source.
    const observed = inferSchedule(cursor.start_times_ms ?? []);
    const schedule = cursor.platform_schedule_ms
      ? { medianGapMs: cursor.platform_schedule_ms, samples: observed?.samples ?? 0 }
      : observed;
    return {
      name,
      ...(cursor.platform_name ? { platformName: cursor.platform_name } : {}),
      ...(cursor.platform_active === false ? { paused: true } : {}),
      ...(collectorId ? { collectorId } : {}),
      state,
      contract: contractDepth(name, collectorId),
      ...(cursor.last_polled_ms ? { lastPolled: cursor.last_polled_ms } : {}),
      ...(finished.length || cursor.last_job_finish_ms
        ? { lastRunAt: Math.max(...finished, cursor.last_job_finish_ms ?? 0) }
        : {}),
      // jobs arrive newest first; the strip reads left-to-right oldest-to-newest.
      recent: mine
        .slice(0, STRIP_LENGTH)
        .reverse()
        .map((j) => ({ job_id: j.job_id, verdict: j.verdict, ts: j.finished ?? j.seen })),
      failed24h: mine.filter((j) => isFailure(j.verdict) && (j.finished ?? j.seen) >= since).length,
      ...(schedule ? { expectedEveryMs: schedule.medianGapMs } : {}),
      // A paused scraper is not late, it is switched off. Claiming otherwise
      // would page someone about a decision they made on purpose.
      ...(schedule && cursor.platform_active !== false
        ? { stale: isStale(schedule, cursor.last_job_finish_ms, nowMs) }
        : {}),
    };
  });
}

/** The newest poll across the fleet: the console's only evidence that the agent
 *  is alive. It is deliberately absent when the fleet is empty — with nothing
 *  discovered there is no cursor, and "agent down" is then genuinely
 *  indistinguishable from "account has no collectors". Saying so is the honest
 *  option; inventing a timestamp is not. */
export function lastPoll(cursors: Record<string, CursorLike>): number | null {
  const times = Object.values(cursors).flatMap((c) => (c.last_polled_ms ? [c.last_polled_ms] : []));
  return times.length ? Math.max(...times) : null;
}
