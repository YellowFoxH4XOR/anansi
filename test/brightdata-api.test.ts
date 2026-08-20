// The platform client is read-only by design: ANANSI watches the schedule
// Bright Data owns, and must never trigger a collection. These tests pin the
// request shapes and the response-envelope tolerance.

import { describe, expect, it } from "vitest";
import { BrightDataApi, BrightDataApiError } from "../packages/adapters/brightdata/api.js";

type Call = { url: string; headers: Record<string, string> };

function stubFetch(body: unknown, status = 200, text?: string) {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => text ?? JSON.stringify(body),
    } as Response;
  }) as typeof fetch;
  return { impl, calls };
}

describe("BrightDataApi", () => {
  it("refuses to construct without a key rather than sending anonymous requests", () => {
    expect(() => new BrightDataApi("", stubFetch([]).impl)).toThrow("API key");
  });

  it("authenticates with the same key the CLI uses", async () => {
    const { impl, calls } = stubFetch([]);
    await new BrightDataApi("k123", impl).collectors();
    expect(calls[0]!.headers.Authorization).toBe("Bearer k123");
    expect(calls[0]!.url).toContain("/dca/collectors_list");
  });

  it("accepts either a bare array or a wrapped envelope for collectors", async () => {
    const bare = await new BrightDataApi("k", stubFetch([{ id: "c_1" }]).impl).collectors();
    expect(bare.map((c) => c.id)).toEqual(["c_1"]);

    const wrapped = await new BrightDataApi("k", stubFetch({ data: [{ id: "c_2" }] }).impl).collectors();
    expect(wrapped.map((c) => c.id)).toEqual(["c_2"]);
  });

  it("sends the required date window and pagination for jobs", async () => {
    const { impl, calls } = stubFetch({ data: [] });
    await new BrightDataApi("k", impl).jobs({
      collector: "c_1",
      fromDate: "2026-08-19",
      toDate: "2026-08-20",
      offset: 10,
      limit: 25,
    });
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/dca/collector/jobs");
    expect(url.searchParams.get("collector")).toBe("c_1");
    expect(url.searchParams.get("from_date")).toBe("2026-08-19");
    expect(url.searchParams.get("to_date")).toBe("2026-08-20");
    expect(url.searchParams.get("offset")).toBe("10");
    expect(url.searchParams.get("limit")).toBe("25");
  });

  it("restores the collector id the filtered list omits", async () => {
    // Without this, a failing job cannot be attributed to a scraper.
    const { impl } = stubFetch({ data: [{ id: "j_1", status: "failed" }] });
    const jobs = await new BrightDataApi("k", impl).jobs({
      collector: "c_9",
      fromDate: "2026-08-19",
      toDate: "2026-08-20",
    });
    expect(jobs[0]).toMatchObject({ id: "j_1", collector: "c_9" });
  });

  it("keeps the collector the API reports when it is present", async () => {
    const { impl } = stubFetch({ data: [{ id: "j_1", status: "done", collector: "c_from_api" }] });
    const jobs = await new BrightDataApi("k", impl).jobs({ collector: "c_9", fromDate: "a", toDate: "b" });
    expect(jobs[0]!.collector).toBe("c_from_api");
  });

  it("walks every discovered scraper so a new one needs no configuration", async () => {
    // The jobs endpoint requires a collector, so account-wide history is only
    // reachable by discovering scrapers first. That pairing IS the monitor loop.
    const calls: string[] = [];
    const impl = (async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      const body = url.includes("collectors_list")
        ? [{ id: "c_a" }, { id: "c_b" }]
        : { data: [{ id: `j_for_${new URL(url).searchParams.get("collector")}`, status: "done" }] };
      return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as Response;
    }) as typeof fetch;

    const jobs = await new BrightDataApi("k", impl).allJobs({ fromDate: "a", toDate: "b" });
    expect(jobs.map((j) => j.id)).toEqual(["j_for_c_a", "j_for_c_b"]);
    expect(jobs.map((j) => j.collector)).toEqual(["c_a", "c_b"]);
    expect(calls.filter((c) => c.includes("/dca/collector/jobs"))).toHaveLength(2);
  });

  it("surfaces the HTTP status so 401 and 404 stay actionable", async () => {
    const { impl } = stubFetch({}, 401);
    await expect(new BrightDataApi("k", impl).jobLog("j_1")).rejects.toThrow("HTTP 401");
  });

  it("carries the response body, because the status alone diagnoses nothing", async () => {
    // The body is where the platform actually explains itself: the jobs endpoint
    // answers 400 with "Missing collector parameter", a one-line fix that a bare
    // "HTTP 400" hides completely.
    const { impl } = stubFetch({}, 400, "Missing collector parameter");
    await expect(new BrightDataApi("k", impl).jobs({ collector: "c", fromDate: "a", toDate: "b" })).rejects.toThrow(
      "Missing collector parameter",
    );
  });

  it("still reports the status when the body cannot be read", async () => {
    // Losing "HTTP 401" because the diagnostic extra failed would be a worse
    // error than no extra at all.
    const impl = (async () => ({ ok: false, status: 401, json: async () => ({}) }) as Response) as typeof fetch;
    await expect(new BrightDataApi("k", impl).jobLog("j_1")).rejects.toThrow("HTTP 401");
  });

  it("separates a rejection that will never succeed from one that might", async () => {
    // A monitor that defers a permanently-rejected job re-offers it on every
    // poll forever; one that settles a 429 loses a readable job.
    const permanent = [400, 401, 403, 404].map((s) => new BrightDataApiError("/p", s, "").permanent);
    const transient = [408, 429, 500, 502, 503].map((s) => new BrightDataApiError("/p", s, "").permanent);
    expect(permanent).toEqual([true, true, true, true]);
    expect(transient).toEqual([false, false, false, false, false]);
  });

  it("reads a 200 with an empty body as no content, not as broken JSON", async () => {
    // Observed live: /dca/dataset answered 200 with zero bytes for a failed run
    // of c_mt1mhrj82pr6gc44rw. res.json() throws "Unexpected end of JSON input"
    // on that, which the poll loop caught as a transport error and deferred —
    // so the job was re-offered and re-thrown on every poll, forever.
    const empty = () => stubFetch(undefined, 200, "").impl;

    expect(await new BrightDataApi("k", empty()).dataset("d_1")).toEqual([]);
    expect(await new BrightDataApi("k", empty()).collectors()).toEqual([]);
    expect(await new BrightDataApi("k", empty()).jobs({ collector: "c", fromDate: "a", toDate: "b" })).toEqual([]);
    expect(await new BrightDataApi("k", empty()).jobErrors("j_1")).toEqual([]);
    // A log is the one case where absence is not emptiness: no counters is not
    // a clean run, and callers must be able to tell the difference.
    expect(await new BrightDataApi("k", empty()).jobLog("j_1")).toBeUndefined();
  });

  it("reads a whitespace-only body the same way", async () => {
    const { impl } = stubFetch(undefined, 200, "\n  ");
    expect(await new BrightDataApi("k", impl).dataset("d_1")).toEqual([]);
  });

  it("reads a job log and a dataset by id", async () => {
    const log = await new BrightDataApi("k", stubFetch({ id: "j_1", status: "done", success_rate: 1 }).impl).jobLog("j_1");
    expect(log!.success_rate).toBe(1);

    const { impl, calls } = stubFetch([{ url: "u", price: 1 }]);
    const rows = await new BrightDataApi("k", impl).dataset("d_1");
    expect(new URL(calls[0]!.url).searchParams.get("id")).toBe("d_1");
    expect(rows).toEqual([{ url: "u", price: 1 }]);
  });

  it("passes through the building status while a collection is still running", async () => {
    const rows = await new BrightDataApi("k", stubFetch({ status: "building" }).impl).dataset("d_1");
    expect(rows).toEqual({ status: "building" });
  });
});
