// Job-level failure classification. Pure: no network, no clock, no I/O.
//
// This is the monitor's answer to "did the run Bright Data just performed go
// wrong?", and it exists because `status` cannot answer it. A live job was
// observed reporting no status at all while 15 of its pages had failed, so
// every counter the platform exposes is treated as a signal and status is only
// one of them.

import type { Job, JobLog } from "../../adapters/brightdata/api.js";
import type { Contract, Route, Violation } from "../types.js";
import { ROUTE_PRECEDENCE } from "./evaluate.js";
import { routeErrorCode } from "./triage.js";

export type JobOutcome = "success" | "partial" | "failed" | "unknown";

const TERMINAL_STATUS = new Set(["done", "ready", "collected", "failed", "cancelled", "error"]);
const FAILED_STATUS = new Set(["failed", "cancelled", "error"]);

/** Enough samples that one long gap cannot masquerade as the schedule. */
export const MIN_INTERVAL_SAMPLES = 4;

/** How far past the learned interval a collector may drift before it is stale. */
const STALE_INTERVAL_MULTIPLE = 3;

export type JobTotals = {
  inputs?: number;
  lines?: number;
  failedPages?: number;
  successRate?: number;
  fails?: number;
};

export type JobHealth = {
  jobId: string;
  collector: string;
  outcome: JobOutcome;
  /** hard_fail violations shaped exactly as evaluate.ts emits them, so the
   *  evidence pack, the console and the incident record need no new branch. */
  signals: Violation[];
  errorCodes: string[];
  /** Absent for "success" and "unknown". */
  route?: Route;
  /** A failure the rows do not explain. The caller applies the two-strike rule
   *  before spending a heal, because a single unexplained failure is far more
   *  often a platform hiccup than a broken selector. */
  unexplained: boolean;
  totals: JobTotals;
  finishedMs?: number;
};

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function parseTime(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : undefined;
}

/** A job is terminal when it has a finish time OR a terminal status. Both are
 *  checked because either one alone is routinely absent, and claiming a
 *  still-running job would open an incident against a half-written dataset. */
export function isTerminal(job: Job, log?: JobLog): boolean {
  if (job.finished || log?.finished) return true;
  const status = (job.status ?? log?.status ?? "").toLowerCase();
  return TERMINAL_STATUS.has(status);
}

export function jobTotals(job: Job, log?: JobLog): JobTotals {
  return {
    inputs: num(job.inputs) ?? num(log?.inputs),
    lines: num(job.data_lines) ?? num(log?.lines),
    failedPages: num(job.failed_pages),
    successRate: num(log?.success_rate),
    fails: num(log?.fails),
  };
}

/** Fold many row-level codes into one lane by the shared precedence order. */
export function jobRoute(errorCodes: readonly string[]): Route | undefined {
  if (errorCodes.length === 0) return undefined;
  const lanes = new Set(errorCodes.map(routeErrorCode));
  return ROUTE_PRECEDENCE.find((r) => lanes.has(r));
}

function rowErrorCode(row: Record<string, unknown>): string | undefined {
  const code = row.error_code ?? row.error;
  return typeof code === "string" && code.trim() ? code.trim() : undefined;
}

export function classifyJob(
  job: Job,
  log: JobLog | undefined,
  rows: readonly Record<string, unknown>[] | undefined,
): JobHealth {
  const totals = jobTotals(job, log);
  const status = (job.status ?? log?.status ?? "").toLowerCase();
  const finishedMs = parseTime(job.finished) ?? parseTime(log?.finished);
  const collector = job.collector ?? log?.collector ?? "";
  const errorCodes = (rows ?? []).flatMap((r) => {
    const c = rowErrorCode(r);
    return c ? [c] : [];
  });

  const signals: Violation[] = [];
  const failureReasons: string[] = [];
  if (status && FAILED_STATUS.has(status)) failureReasons.push(`status=${status}`);
  if ((totals.failedPages ?? 0) > 0) failureReasons.push(`failed_pages=${totals.failedPages}`);
  if ((totals.fails ?? 0) > 0) failureReasons.push(`fails=${totals.fails}`);
  if (totals.successRate != null && totals.successRate < 1) failureReasons.push(`success_rate=${totals.successRate}`);
  if (errorCodes.length) failureReasons.push(`${errorCodes.length} row error(s)`);

  if (!isTerminal(job, log)) {
    return { jobId: job.id, collector, outcome: "unknown", signals, errorCodes, unexplained: false, totals, finishedMs };
  }

  // No counters, no status, no rows: the platform told us nothing. Guessing
  // "healthy" here would silently clear a genuinely broken collector.
  const hasEvidence =
    status !== "" || totals.failedPages != null || totals.fails != null || totals.successRate != null || totals.lines != null || rows != null;
  if (!hasEvidence) {
    return { jobId: job.id, collector, outcome: "unknown", signals, errorCodes, unexplained: false, totals, finishedMs };
  }

  if (failureReasons.length === 0) {
    return { jobId: job.id, collector, outcome: "success", signals, errorCodes, unexplained: false, totals, finishedMs };
  }

  // Per-input failures are the only place the platform says WHY, so they are
  // what carries the routing lane. Job counters say only THAT.
  for (const row of rows ?? []) {
    const code = rowErrorCode(row);
    if (!code) continue;
    const route = routeErrorCode(code);
    const url = typeof row.url === "string" ? row.url : typeof row.input === "string" ? row.input : undefined;
    signals.push({ signal: "hard_fail", url, detail: `error_code=${code} → ${route} lane` });
  }

  const usableRows = (rows ?? []).filter((r) => !rowErrorCode(r)).length;
  const producedData = usableRows > 0 || (totals.lines ?? 0) > 0;
  const outcome: JobOutcome = producedData ? "partial" : "failed";
  const route = jobRoute(errorCodes);

  if (!route) {
    // A job whose pages failed but whose rows were dropped entirely: real, and
    // the one case where nothing explains the fault.
    signals.push({ signal: "hard_fail", detail: `job ${job.id} failed with no row-level error code (${failureReasons.join(", ")})` });
  }

  return { jobId: job.id, collector, outcome, signals, errorCodes, route, unexplained: !route, totals, finishedMs };
}

/** Volume signals for a collector with no contract: the only shape check
 *  available when nobody declared what the rows should look like. */
export function rowVolumeSignals(current: JobTotals, historyLines: readonly number[]): Violation[] {
  const out: Violation[] = [];
  const lines = current.lines ?? 0;
  const past = historyLines.filter((n) => n > 0);
  if (past.length < 2) return out;

  const sorted = [...past].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  if (lines === 0) {
    out.push({ signal: "hard_fail", detail: `job returned 0 rows; this collector has produced a median of ${median}` });
  } else if (lines < median / 2) {
    out.push({ signal: "fill_rate", detail: `row count ${lines} is under half the median ${median} of the last ${past.length} runs` });
  }
  return out;
}

/** Learn Bright Data's cadence rather than being told it: a cadence in our own
 *  config is exactly the coupling the monitor pivot removes. */
export function inferSchedule(startTimesMs: readonly number[]): { medianGapMs: number; samples: number } | undefined {
  const t = [...startTimesMs].sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < t.length; i++) gaps.push(t[i]! - t[i - 1]!);
  if (gaps.length < MIN_INTERVAL_SAMPLES - 1) return undefined;
  gaps.sort((a, b) => a - b);
  return { medianGapMs: gaps[Math.floor(gaps.length / 2)]!, samples: gaps.length + 1 };
}

/** Below the sample floor no opinion is offered: a false staleness alarm on a
 *  healthy fleet costs more trust than a late one costs uptime. */
export function isStale(
  schedule: { medianGapMs: number; samples: number } | undefined,
  lastFinishMs: number | undefined,
  nowMs: number,
): boolean {
  if (!schedule || lastFinishMs == null) return false;
  return nowMs - lastFinishMs > schedule.medianGapMs * STALE_INTERVAL_MULTIPLE;
}

/** Required contract fields named by a per-input error message.
 *
 *  Bright Data reports some collection failures as prose — "Error: price
 *  missing" — and routeErrorCode is right to call a sentence unknown and refuse
 *  to spend a heal on it. But when that sentence names a field the contract
 *  declares REQUIRED, it stops being an unparsed string and becomes the most
 *  specific signal available: the page loaded, the parser ran, and a field we
 *  declared must exist was not there. That is the DOM change heal exists for,
 *  and without this it routed to retry and never healed.
 *
 *  Matched on word boundaries so `price` does not fire on `sale_price_currency`,
 *  and only against declared field names, so an arbitrary message cannot invent
 *  a lane for itself. */
export function requiredFieldsNamedIn(message: string, contract: Contract): string[] {
  const text = message.toLowerCase();
  return Object.entries(contract.fields)
    .filter(([, spec]) => spec.required)
    .map(([name]) => name)
    .filter((name) => {
      const escaped = name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`\\b${escaped}\\b`).test(text);
    });
}
