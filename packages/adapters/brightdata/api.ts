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

/** Parse a newline-delimited JSON body, or undefined if it is not one. */
function jsonLines(text: string): unknown[] | undefined {
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  if (lines.length < 2) return undefined; // a single line was already tried as JSON
  const rows: unknown[] = [];
  for (const line of lines) {
    try {
      rows.push(JSON.parse(line));
    } catch {
      return undefined;
    }
  }
  return rows;
}

/** Keys a "still building" envelope may carry. Anything else present means the
 *  object is a record the scraper produced, not a progress report about one. */
const PENDING_ONLY_KEYS = new Set(["status", "state", "message", "job_id", "id", "collection_id"]);

function isPending(body: Record<string, unknown>): boolean {
  if (typeof body.status !== "string") return false;
  return Object.keys(body).every((k) => PENDING_ONLY_KEYS.has(k));
}

export class BrightDataApi {
  constructor(
    private apiKey: string,
    private fetchImpl: Fetcher = fetch,
    private base = BASE,
  ) {
    if (!apiKey) throw new Error("BrightDataApi needs an API key (BRIGHTDATA_API_KEY)");
  }

  /** Returns undefined when the platform answers 200 with an EMPTY body, which
   *  is not an error and not JSON. Callers supply the empty value that means
   *  nothing-to-report for their own endpoint, because "no content" means
   *  different things to a job list and to a dataset. */
  private async get<T>(path: string, query: Record<string, string | number | undefined> = {}): Promise<T | undefined> {
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
    // Parse from text, not res.json(). A 200 with a zero-length body — observed
    // live on /dca/dataset for a failed run of c_mt1mhrj82pr6gc44rw — makes
    // res.json() throw "Unexpected end of JSON input", which the poll loop
    // caught as a transport error and deferred, so the job was re-offered and
    // re-thrown on every poll for the rest of the agent's life.
    const text = await res.text();
    if (text.trim() === "") return undefined;
    try {
      return JSON.parse(text) as T;
    } catch (err) {
      // /dca/dataset answers application/jsonl for some collectors: one record
      // per line, no enclosing array. Observed live on c_mt1ptxyfr93wwgxl6,
      // where it surfaced as "Unexpected non-whitespace character after JSON at
      // position 426" and deferred the job on every poll. Matched on shape
      // rather than on Content-Type so a correct body is never rejected over a
      // header, and only accepted when EVERY line parses — a half-parsed body is
      // a truncated response, and reading it as a short result set would be a
      // silent false negative about how much the run collected.
      const rows = jsonLines(text);
      if (rows) return rows as T;
      throw new Error(`${path} → body is neither JSON nor JSONL: ${snippet(text)}`);
    }
  }

  /** Every scraper on the account. This is what makes the console self-populating:
   *  a scraper built in Studio appears without anyone editing a contract. */
  async collectors(): Promise<Collector[]> {
    const body = await this.get<Collector[] | { data?: Collector[]; collectors?: Collector[] }>(
      "/dca/collectors_list",
    );
    if (!body) return [];
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
    const rows = !body ? [] : Array.isArray(body) ? body : (body.data ?? []);
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
  /** Undefined when the platform returns no log body. Callers already treat a
   *  missing log as "no signal from here" rather than as a clean run. */
  async jobLog(jobId: string): Promise<JobLog | undefined> {
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
    return body?.errors ?? [];
  }

  /** The collected rows. Some per-input failures ride along here as
   *  `error`/`error_code`; the ones that do not are in jobErrors() above. */
  async dataset<T = Record<string, unknown>>(collectionId: string): Promise<T[] | { status: string }> {
    const body = await this.get<T[] | Record<string, unknown>>("/dca/dataset", { id: collectionId });
    // An empty body on a finished job is an empty result set, not a pending one.
    // Bright Data answers /dca/dataset with 200 and zero bytes for some failed
    // runs, and with [] for others; both mean the same thing.
    if (!body) return [];
    if (Array.isArray(body)) return body as T[];
    // A non-array is not automatically "not ready". A scraper that emits ONE
    // record per run returns that record as a bare object — observed live on
    // c_mt1mhrj82pr6gc44rw, whose successful run (lines=1, fails=0) answered
    // {"quotes":[…],"input":{…}}. Reading every object as a status envelope
    // deferred that run forever with the reason "dataset undefined", because
    // there was no .status to read.
    if (isPending(body)) return body as { status: string };
    return [body as T];
  }
}

export function apiFromEnv(fetchImpl: Fetcher = fetch): BrightDataApi | null {
  const key = process.env.BRIGHTDATA_API_KEY ?? process.env.BRIGHTDATA_API_TOKEN;
  return key ? new BrightDataApi(key, fetchImpl) : null;
}
