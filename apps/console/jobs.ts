// Bright Data job history, as the console can honestly report it. Pure: no
// store, no server, no I/O — the inputs are exactly the rows the agent wrote.
//
// ANANSI never triggers a collection, so every row here is a run Bright Data
// performed on its own schedule and the monitor observed afterwards. That is
// why nothing in this file can produce a "we scanned" claim: there is no field
// to hang one on.

import type { JobLedgerEntry } from "../../packages/adapters/store/index.js";

/** The ledger records two different things — what the platform's run did
 *  (`outcome`) and how far ANANSI got with it (`state`) — and an operator
 *  needs both. A deferred job is not a failed run, and a claimed-but-unsettled
 *  job means the monitor died mid-handling; folding either into "failed" would
 *  blame the scraper for our own problem. */
export type JobVerdict =
  | "ok"
  | "partial"
  | "failed"
  | "unknown"
  | "seeded"
  | "in_flight"
  | "deferred"
  | "abandoned";

/** Batch ids are `j_`, CLI/realtime ids are `vj_`. Surfacing the distinction is
 *  the visible proof that the schedule is Bright Data's: a fleet whose rows are
 *  all `j_` was never triggered from here. */
export type JobTrigger = "scheduled" | "cli" | "unknown";

export type JobRow = {
  job_id: string;
  collector: string;
  verdict: JobVerdict;
  trigger: JobTrigger;
  /** When ANANSI first saw the job. Always known. */
  seen: number;
  /** When the platform finished the run, if any row carried it. */
  finished?: number;
  rows: number;
  error_rows: number;
  incident_id?: string;
  /** Why a job is deferred — the only place the ledger explains itself. */
  note?: string;
};

/** The subset of a stored run row this join needs. `job_id` is written by the
 *  monitor but is not on StoredRun's declared shape, hence the local type. */
export type RunRow = {
  scraper: string;
  ts: number;
  sweep_ts?: number;
  job_id?: string;
  error_code?: string;
};

export function jobTrigger(jobId: string): JobTrigger {
  if (jobId.startsWith("vj_")) return "cli";
  if (jobId.startsWith("j_")) return "scheduled";
  return "unknown";
}

export function verdictFor(entry: Pick<JobLedgerEntry, "state" | "outcome">): JobVerdict {
  if (entry.state === "deferred") return "deferred";
  if (entry.state === "claimed") return "in_flight";
  switch (entry.outcome) {
    case "success":
      return "ok";
    case "partial":
      return "partial";
    case "failed":
      return "failed";
    case "seeded":
      return "seeded";
    case "abandoned":
      return "abandoned";
    default:
      return "unknown";
  }
}

/** A run whose pages failed, i.e. the platform's problem rather than ours.
 *  `partial` is a failure: some pages did not collect, even though rows landed. */
export function isFailure(v: JobVerdict): boolean {
  return v === "failed" || v === "partial";
}

export function jobRows(ledger: readonly JobLedgerEntry[], runs: readonly RunRow[]): JobRow[] {
  const byJob = new Map<string, { rows: number; errors: number; finished?: number }>();
  for (const r of runs) {
    if (!r.job_id) continue;
    const agg = byJob.get(r.job_id) ?? { rows: 0, errors: 0 };
    agg.rows++;
    if (r.error_code) agg.errors++;
    // sweep_ts is the platform job's own finish time under the monitor; ts is
    // the same value for those rows, so either answers "when did it run?".
    agg.finished = r.sweep_ts ?? r.ts;
    byJob.set(r.job_id, agg);
  }

  const rows = ledger.map((e): JobRow => {
    const agg = byJob.get(e.job_id);
    return {
      job_id: e.job_id,
      collector: e.collector,
      verdict: verdictFor(e),
      trigger: jobTrigger(e.job_id),
      seen: e.ts,
      ...(agg?.finished != null ? { finished: agg.finished } : {}),
      rows: agg?.rows ?? 0,
      error_rows: agg?.errors ?? 0,
      ...(e.incident_id ? { incident_id: e.incident_id } : {}),
      ...(e.defer_reason ? { note: e.defer_reason } : {}),
    };
  });

  // Newest first: "what did the platform just do?" should be the top row.
  return rows.sort((a, b) => (b.finished ?? b.seen) - (a.finished ?? a.seen));
}

export function failuresSince(rows: readonly JobRow[], sinceMs: number): number {
  return rows.filter((r) => isFailure(r.verdict) && (r.finished ?? r.seen) >= sinceMs).length;
}
