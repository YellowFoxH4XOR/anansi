// What the console may claim about Bright Data's job history.
//
// These fail against the pre-pivot console, which had no concept of a platform
// job at all: it grouped OUR OWN sweep rows by a sweep_ts the scheduler
// invented, so every row asserted "ANANSI scanned" — the one thing that is now
// never true.

import { describe, expect, it } from "vitest";
import type { JobLedgerEntry } from "../packages/adapters/store/index.js";
import { emptyIncidentsNote, failuresSince, isFailure, jobRows, jobTrigger, verdictFor, type RunRow } from "../apps/console/jobs.js";

function entry(over: Partial<JobLedgerEntry> = {}): JobLedgerEntry {
  return { job_id: "j_1", collector: "shop", ts: 1000, state: "handled", outcome: "success", ...over };
}

function row(over: Partial<RunRow> = {}): RunRow {
  return { scraper: "shop", ts: 900, sweep_ts: 900, job_id: "j_1", ...over };
}

describe("job history view-model", () => {
  it("names the trigger from the job id, which is how the console proves it did not schedule anything", () => {
    // Batch ids are j_, CLI/realtime ids are vj_. A fleet whose history is all
    // j_ was demonstrably never triggered from here.
    expect(jobTrigger("j_abc")).toBe("scheduled");
    expect(jobTrigger("vj_abc")).toBe("cli");
    expect(jobTrigger("weird")).toBe("unknown");
  });

  it("separates what the run did from how far ANANSI got with it", () => {
    // Deferred and claimed are ANANSI's own backlog. Rendering either as a
    // failure would blame the scraper for our problem.
    expect(verdictFor({ state: "deferred" })).toBe("deferred");
    expect(verdictFor({ state: "claimed" })).toBe("in_flight");
    expect(verdictFor({ state: "handled", outcome: "partial" })).toBe("partial");
    expect(verdictFor({ state: "handled", outcome: "seeded" })).toBe("seeded");
    expect(verdictFor({ state: "handled", outcome: "abandoned" })).toBe("abandoned");
    expect(verdictFor({ state: "handled" })).toBe("unknown");

    expect(isFailure("partial")).toBe(true);
    expect(isFailure("failed")).toBe(true);
    for (const v of ["ok", "deferred", "in_flight", "seeded", "abandoned", "unknown"] as const) {
      expect(isFailure(v)).toBe(false);
    }
  });

  it("joins stored rows onto the job that produced them", () => {
    const rows = jobRows(
      [entry()],
      [row({ job_id: "j_1" }), row({ job_id: "j_1", error_code: "dead_page" }), row({ job_id: "other" })],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ job_id: "j_1", rows: 2, error_rows: 1, verdict: "ok", finished: 900 });
  });

  it("says when a run finished, and admits when it only knows when we saw it", () => {
    const [withRows, withoutRows] = jobRows(
      [entry({ job_id: "j_1", ts: 5000 }), entry({ job_id: "j_2", ts: 4000 })],
      [row({ job_id: "j_1", sweep_ts: 6000 })],
    );

    expect(withRows).toMatchObject({ job_id: "j_1", finished: 6000 });
    // No rows landed, so no finish time exists — the console must not present
    // its own observation time as the platform's.
    expect(withoutRows?.finished).toBeUndefined();
    expect(withoutRows).toMatchObject({ job_id: "j_2", seen: 4000 });
  });

  it("orders newest first, falling back to observation time", () => {
    const rows = jobRows(
      [entry({ job_id: "j_old", ts: 1 }), entry({ job_id: "j_new", ts: 2 }), entry({ job_id: "j_dated", ts: 3 })],
      [row({ job_id: "j_dated", sweep_ts: 10 })],
    );
    expect(rows.map((r) => r.job_id)).toEqual(["j_dated", "j_new", "j_old"]);
  });

  it("carries the reason a job is waiting, and the incident it opened", () => {
    const rows = jobRows(
      [entry({ job_id: "j_d", state: "deferred", defer_reason: "collector state=healing" }), entry({ job_id: "j_i", incident_id: "inc1" })],
      [],
    );
    expect(rows.find((r) => r.job_id === "j_d")?.note).toBe("collector state=healing");
    expect(rows.find((r) => r.job_id === "j_i")?.incident_id).toBe("inc1");
  });

  it("counts only real run failures inside the window", () => {
    const now = 10_000_000;
    const day = 24 * 60 * 60_000;
    const rows = jobRows(
      [
        entry({ job_id: "j_a", outcome: "failed", ts: now - 1000 }),
        entry({ job_id: "j_b", outcome: "partial", ts: now - 2000 }),
        // Old failure, our own backlog, and a pre-ANANSI job: none of these are
        // "a run failed in the last 24h".
        entry({ job_id: "j_c", outcome: "failed", ts: now - 3 * day }),
        entry({ job_id: "j_d", state: "deferred", ts: now - 1000 }),
        entry({ job_id: "j_e", outcome: "seeded", ts: now - 1000 }),
      ],
      [],
    );
    expect(failuresSince(rows, now - day)).toBe(2);
  });
});

describe("an empty incident table is not a claim about the runs", () => {
  // The console said "every run Bright Data has performed so far came back
  // clean" whenever the incident list was empty. That is an assertion about the
  // RUNS, and an empty list is no evidence for it: a run that failed and opened
  // no incident turned the sentence into a flat lie, which is exactly what
  // happened to a 55% success-rate job with 15 failed pages.
  const row = (verdict: "ok" | "failed" | "partial" | "seeded") =>
    ({ job_id: `j_${verdict}`, collector: "shop", verdict, trigger: "scheduled" as const, seen: 1, rows: 1, error_rows: 0 });

  it("says all clean only when the runs actually were", () => {
    const note = emptyIncidentsNote([row("ok"), row("seeded")]);
    expect(note).toContain("came back clean");
  });

  it("admits a gap when runs failed and nothing recorded why", () => {
    const note = emptyIncidentsNote([row("ok"), row("failed"), row("partial")]);
    expect(note).not.toContain("came back clean");
    expect(note).toContain("2");
    // Names it as our problem, not as a healthy fleet.
    expect(note).toContain("gap in ANANSI");
  });

  it("makes the same claim with no data at all as with clean data", () => {
    // Nothing observed yet is not a failure, and must not read as an alarm.
    expect(emptyIncidentsNote([])).toContain("came back clean");
  });
});
