// Read-only REST client for the Scraper Studio platform.
//
// ANANSI does not schedule work. Bright Data owns the schedule; this client is
// how the agent watches what that schedule produced. Nothing here triggers a
// collection, so nothing here spends page loads.
//
// Auth is the same BRIGHTDATA_API_KEY the CLI uses, so a container configured
// for `scraper heal` can also read job history with no extra secret.
//
// Endpoints verified against docs.brightdata.com/api-reference/scraper-studio-api.

import type { OutputSchema } from "./types.js";

const BASE = "https://api.brightdata.com";

/** One scraper on the account, from GET /dca/collectors_list. */
export type Collector = {
  id: string;
  name?: string;
  active?: boolean;
  last_run?: string;
  /** Cadence the platform will actually run this on, in ms. Discovered, not
   *  configured — staleness has a real expectation to measure against. */
  schedule?: { frequency?: number; start?: string };
  /** The scraper's declared field shape. See OutputSchema: this is the contract
   *  ANANSI monitors against when no YAML overlay pins goldens for it. */
  output_schema?: OutputSchema;
  [k: string]: unknown;
};

/** One run, from GET /dca/collector/jobs. */
export type Job = {
  id: string; // `j_` for batch runs, `vj_` for CLI/realtime ones
  /** Optional on purpose. A live job was observed reporting no status at all
   *  while carrying failed_pages=15, so a `status === "failed"` check is not a
   *  failure detector. See core/sense/job-health.ts for the real predicate. */
  status?: string; // building | running | done | failed | cancelled
  queued?: string;
  started?: string;
  finished?: string;
  inputs?: number;
  page_loads?: number;
  total_pages?: number;
  failed_pages?: number;
  data_lines?: number;
  trigger?: { type?: string; user?: string; ip?: string };
  expired?: string;
  collector?: string;
};

/** Job metadata, from GET /dca/log/{job_id}. */
export type JobLog = {
  id: string;
  status?: string;
  collector?: string;
  inputs?: number;
  lines?: number;
  fails?: number;
  success?: number;
  success_rate?: number;
  job_time?: number;
  queue_time?: number;
  created?: string;
  started?: string;
  finished?: string;
};

export type ListJobsOpts = {
  /** Required. The docs describe this as an optional filter, but the API
   *  answers "Missing collector parameter" with 400 when it is absent — verified
   *  against a live account. Job history is therefore always per-scraper, which
   *  is why callers discover collectors first and fan out. */
  collector: string;
  fromDate: string; // YYYY-MM-DD — required by the API
  toDate: string;
  offset?: number;
  limit?: number;
};

export type Fetcher = typeof fetch;

/** An API failure that kept its status and its body.
 *
 *  The body is the whole diagnostic. `/dca/collector/jobs` answers 400 with
 *  "Missing collector parameter" — a one-line fix that a bare "HTTP 400" hides
 *  completely — and the same is true of every other 4xx this client can meet.
 *  Callers also need `permanent` to decide between retrying and settling: a
 *  monitor that defers a permanently-rejected job re-offers it on every poll,
 *  forever. */
export class BrightDataApiError extends Error {
  constructor(
    readonly path: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(`${path} → HTTP ${status}${body ? `: ${body}` : ""}`);
    this.name = "BrightDataApiError";
  }

  /** 4xx means the request itself will never be accepted — except 408/429,
   *  which are "not now" rather than "not ever". */
  get permanent(): boolean {
    return this.status >= 400 && this.status < 500 && this.status !== 408 && this.status !== 429;
  }
}

/** Trims a body to something a log line can carry without becoming the log. */
function snippet(text: string, max = 300): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

export class BrightDataApi {
  constructor(
    private apiKey: string,
    private fetchImpl: Fetcher = fetch,
    private base = BASE,
  ) {
    if (!apiKey) throw new Error("BrightDataApi needs an API key (BRIGHTDATA_API_KEY)");
  }

  private async get<T>(path: string, query: Record<string, string | number | undefined> = {}): Promise<T> {
    const url = new URL(path, this.base);
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    const res = await this.fetchImpl(url.toString(), {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    if (!res.ok) {
      // 401 is a revoked key, 404 an expired job, 400 usually a parameter the
      // docs describe wrongly — all operator-actionable, and none of them
      // diagnosable from the status alone.
      // The status must survive a body that cannot be read: losing "HTTP 401"
      // because the diagnostic extra failed would be a worse error than none.
      let body = "";
      try {
        body = snippet(await res.text());
      } catch {
        body = "";
      }
      throw new BrightDataApiError(path, res.status, body);
    }
    return (await res.json()) as T;
  }

  /** Every scraper on the account. This is what makes the console self-populating:
   *  a scraper built in Studio appears without anyone editing a contract. */
  async collectors(): Promise<Collector[]> {
    const body = await this.get<Collector[] | { data?: Collector[]; collectors?: Collector[] }>(
      "/dca/collectors_list",
    );
    if (Array.isArray(body)) return body;
    return body.data ?? body.collectors ?? [];
  }

  /** Runs for one scraper in a date window. from_date/to_date are required by
   *  the API, and a narrower window is markedly faster, so callers pass their
   *  poll cursor. */
  async jobs(opts: ListJobsOpts): Promise<Job[]> {
    const body = await this.get<{ data?: Job[]; total?: number } | Job[]>("/dca/collector/jobs", {
      collector: opts.collector,
      from_date: opts.fromDate,
      to_date: opts.toDate,
      offset: opts.offset,
      limit: opts.limit ?? 50,
    });
    const rows = Array.isArray(body) ? body : (body.data ?? []);
    // The per-collector response omits `collector`; put it back so a failing job
    // can always be attributed to a scraper downstream.
    return rows.map((j) => ({ collector: opts.collector, ...j }));
  }

  /** Every recent run across the whole account: discover scrapers, then read
   *  each one's history. This pairing is the monitor loop — a scraper added in
   *  Studio is picked up on the next poll with no configuration. */
  async allJobs(opts: { fromDate: string; toDate: string; limit?: number }): Promise<Job[]> {
    const out: Job[] = [];
    for (const c of await this.collectors()) {
      if (!c.id) continue;
      out.push(...(await this.jobs({ ...opts, collector: c.id })));
    }
    return out;
  }

  /** Per-job metadata: success_rate and fails are the cheap failure signal. */
  async jobLog(jobId: string): Promise<JobLog> {
    return this.get<JobLog>(`/dca/log/${encodeURIComponent(jobId)}`);
  }

  /** Per-input failures for one job.
   *
   *  This exists because the assumption it replaces was wrong. We believed
   *  failures rode along on the dataset rows, so no errors endpoint was needed.
   *  In production a scheduled run failed with `failed_pages=1, success_rate=0`
   *  and /dca/dataset returned an EMPTY array, while the dashboard's own export
   *  of the same run contained
   *  `{"input":{...},"error":"Error: price missing"}`. ANANSI therefore reported
   *  a run that had explained itself perfectly as "failed with no row-level
   *  error code" — and could not route it.
   *
   *  Shaped into dataset rows (`input` + `error`) by the caller, so everything
   *  downstream keeps one row format. */
  async jobErrors(jobId: string): Promise<{ url?: string; error?: string }[]> {
    const body = await this.get<{ errors?: { url?: string; error?: string }[] }>(
      `/dca/jobs/${encodeURIComponent(jobId)}/hp_errors`,
    );
    return body.errors ?? [];
  }

  /** The collected rows. Some per-input failures ride along here as
   *  `error`/`error_code`; the ones that do not are in jobErrors() above. */
  async dataset<T = Record<string, unknown>>(collectionId: string): Promise<T[] | { status: string }> {
    const body = await this.get<T[] | { status: string }>("/dca/dataset", { id: collectionId });
    return body;
  }
}

export function apiFromEnv(fetchImpl: Fetcher = fetch): BrightDataApi | null {
  const key = process.env.BRIGHTDATA_API_KEY ?? process.env.BRIGHTDATA_API_TOKEN;
  return key ? new BrightDataApi(key, fetchImpl) : null;
}
