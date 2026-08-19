// Job classification: the failure predicate, in isolation from the poll loop.
//
// Every case here is drawn from a shape the platform actually returns. The
// sharpest one is the first: a live job reported no status at all while 15 of
// its pages had failed, so `status === "failed"` is not a failure detector and
// never was.

import { describe, expect, it } from "vitest";
import {
  classifyJob,
  inferSchedule,
  isStale,
  isTerminal,
  jobRoute,
  rowVolumeSignals,
} from "../packages/core/sense/job-health.js";
import type { Job, JobLog } from "../packages/adapters/brightdata/api.js";

const job = (over: Partial<Job> = {}): Job => ({ id: "j_1", finished: "2025-08-19T10:00:00Z", ...over });

describe("classifyJob — status is one weak signal, never the predicate", () => {
  it("calls a job with no status and failed_pages>0 a failure", () => {
    const h = classifyJob(job({ status: undefined, failed_pages: 15, data_lines: 0 }), undefined, []);
    expect(h.outcome).toBe("failed");
    expect(h.signals.map((s) => s.detail).join(" ")).toContain("failed_pages=15");
  });

  it("calls a job with no status and clean counters a success", () => {
    const h = classifyJob(job({ status: undefined, failed_pages: 0, data_lines: 4 }), undefined, [{ price: 1 }]);
    expect(h.outcome).toBe("success");
    expect(h.signals).toEqual([]);
  });

  it("reads success_rate below 1 as a failure even when nothing else complains", () => {
    const log: JobLog = { id: "j_1", success_rate: 0.75 };
    expect(classifyJob(job(), log, [{ price: 1 }]).outcome).toBe("partial");
  });

  it("reads fails>0 from the job log", () => {
    expect(classifyJob(job(), { id: "j_1", fails: 2 }, []).outcome).toBe("failed");
  });

  it("accepts vj_ CLI job ids alongside j_ batch ids", () => {
    const h = classifyJob(job({ id: "vj_9", failed_pages: 1 }), undefined, []);
    expect(h.jobId).toBe("vj_9");
    expect(h.outcome).toBe("failed");
  });

  it("takes the routing lane from the row's error_code, not from the job", () => {
    const h = classifyJob(job({ failed_pages: 1 }), undefined, [{ input: "https://x/p", error_code: "blocked" }]);
    expect(h.route).toBe("infra");
    expect(h.unexplained).toBe(false);
    expect(h.signals[0]).toMatchObject({ signal: "hard_fail", url: "https://x/p" });
  });

  it("reads a row-level `error` where no error_code is present", () => {
    const h = classifyJob(job({ failed_pages: 1 }), undefined, [{ input: "https://x/p", error: "dead_page" }]);
    expect(h.route).toBe("dead");
  });

  it("applies the shared precedence when rows disagree about the lane", () => {
    const h = classifyJob(job({ failed_pages: 2 }), undefined, [
      { error_code: "parse_error" }, // heal
      { error_code: "blocked" }, // infra — wins
    ]);
    expect(h.route).toBe("infra");
  });

  it("marks a failure its rows cannot explain, rather than guessing a lane", () => {
    const h = classifyJob(job({ failed_pages: 3, data_lines: 0 }), undefined, []);
    expect(h.unexplained).toBe(true);
    expect(h.route).toBeUndefined();
  });

  it("is partial, not failed, when some rows survived", () => {
    const h = classifyJob(job({ failed_pages: 1 }), undefined, [{ price: 1 }, { error_code: "parse_error" }]);
    expect(h.outcome).toBe("partial");
  });
});

describe("classifyJob — terminality", () => {
  it("refuses to judge a job that has not finished", () => {
    const h = classifyJob({ id: "j_1", status: "running", failed_pages: 2 }, undefined, []);
    expect(h.outcome).toBe("unknown");
    expect(isTerminal({ id: "j_1", status: "running" })).toBe(false);
  });

  it("treats a finish time as terminal even with no status", () => {
    expect(isTerminal({ id: "j_1", finished: "2025-08-19T10:00:00Z" })).toBe(true);
  });

  it("treats a terminal status as terminal even with no finish time", () => {
    expect(isTerminal({ id: "j_1", status: "failed" })).toBe(true);
  });

  it("returns unknown when the platform reported nothing usable at all", () => {
    expect(classifyJob({ id: "j_1", finished: "2025-08-19T10:00:00Z" }, undefined, undefined).outcome).toBe("unknown");
  });
});

describe("jobRoute", () => {
  it("is undefined for no codes at all", () => {
    expect(jobRoute([])).toBeUndefined();
  });

  it("routes an unknown code to retry rather than burning a heal blind", () => {
    expect(jobRoute(["something_new"])).toBe("retry");
  });
});

describe("rowVolumeSignals — the only shape check without a contract", () => {
  it("flags a run that returned nothing where history says it should return rows", () => {
    const v = rowVolumeSignals({ lines: 0 }, [40, 41, 39]);
    expect(v[0]?.signal).toBe("hard_fail");
  });

  it("flags a collapse to under half the median", () => {
    expect(rowVolumeSignals({ lines: 10 }, [40, 41, 39])[0]?.signal).toBe("fill_rate");
  });

  it("stays quiet on a normal run", () => {
    expect(rowVolumeSignals({ lines: 38 }, [40, 41, 39])).toEqual([]);
  });

  it("offers no opinion without history", () => {
    expect(rowVolumeSignals({ lines: 0 }, [])).toEqual([]);
  });
});

describe("schedule inference — learned, never configured", () => {
  const hour = 60 * 60_000;

  it("declines to guess below the sample floor", () => {
    expect(inferSchedule([0, hour, 2 * hour])).toBeUndefined();
  });

  it("learns the median gap once there are enough runs", () => {
    const s = inferSchedule([0, hour, 2 * hour, 3 * hour, 4 * hour])!;
    expect(s.medianGapMs).toBe(hour);
  });

  it("calls a collector stale only past a multiple of its own cadence", () => {
    const s = inferSchedule([0, hour, 2 * hour, 3 * hour, 4 * hour]);
    expect(isStale(s, 4 * hour, 6 * hour)).toBe(false);
    expect(isStale(s, 4 * hour, 8 * hour)).toBe(true);
  });

  it("never reports staleness without a learned schedule", () => {
    expect(isStale(undefined, 0, 10 * hour)).toBe(false);
  });
});
