// Shared plain-data types. Everything in core/ is pure: no network, no clock, no I/O.

export type FieldSpec = {
  type: "string" | "number";
  required: boolean;
  min?: number;
  max?: number;
  min_len?: number;
};

export type GoldenString = {
  value: string;
  similarity_min: number;
  similarity_metric: "token_set_ratio";
};
export type GoldenNumber = { value: number; tolerance_pct: number };
export type GoldenEnum = { one_of: string[] };
export type GoldenSpec = GoldenString | GoldenNumber | GoldenEnum;

export type Canary = { url: string; goldens: Record<string, GoldenSpec> };

export type Contract = {
  /** Display name and store key. Identity is collector_id — a scraper built in
   *  Studio is discovered by id and monitored whether or not a contract names it. */
  scraper: string;
  collector_id?: string;
  /** May be empty: a collector with no pinned goldens is still monitored for
   *  platform failures. Absence of goldens is not absence of monitoring. */
  canaries: Canary[];
  fields: Record<string, FieldSpec>;
  invariants: string[];
  fill_rate_min: number;
  exclude_fields_containing_pii?: boolean;
};

// One canary row as it comes back from a run (snapshot already stripped to a ref).
export type RunRecord = {
  url: string; // collected input.url — every row must be attributable
  fields: Record<string, unknown>;
  error_code?: string;
  snapshot_ref?: string;
  ts: number;
};

// Historical numeric observations for CUSUM: per field, per URL, oldest first.
export type FieldHistory = Record<string, Record<string, number[]>>;

export type SignalClass =
  | "hard_fail"
  | "contract"
  | "fill_rate"
  | "golden_band"
  | "cusum"
  | "invariant";

// Where an incident is routed (docs/brightdata-notes.md routing table; ADR-003).
export type Route = "heal" | "infra" | "retry" | "dead" | "config";

export type Violation = {
  signal: SignalClass;
  field?: string;
  url?: string;
  detail: string;
};

export type Incident = {
  kind: "incident";
  scraper: string;
  route: Route;
  signals: Violation[];
  records: RunRecord[];
  snapshot_refs: string[];
};

export type Healthy = { kind: "healthy"; warnings: Violation[] };
export type SenseResult = Incident | Healthy;

// Per-collector state machine (architecture.md).
// `verifying` has no producer since post-approval verification became Bright
// Data's own next scheduled run; it stays in the union so incidents recorded
// before that change still render.
export type CollectorState =
  | "healthy"
  | "incident_open"
  | "healing"
  | "verifying"
  | "watching"
  | "quarantined";

export type GateResult = { gate: string; pass: boolean; detail: string };

export type Verdict = {
  pass: boolean; // conjunction of all hard gates — never a score threshold
  gates: GateResult[];
  confidence: number; // weighted per-field pass fraction, audit/UI only
};

export type HealAttempt = {
  prompt: string;
  diff_summary: string;
  verdict?: Verdict;
  ts: number;
};

export type IncidentRecord = {
  id: string;
  scraper: string;
  opened_at: number;
  closed_at?: number;
  signal: Violation[];
  route: Route;
  evidence_ref?: string;
  last_good_ref?: string; // snapshot refs powering the console's split diff
  current_ref?: string;
  prompt?: string;
  heal_attempts: HealAttempt[];
  // `rolled_back` is likewise legacy-render-only: it was V2's failure outcome.
  /** `observed` is a failure ANANSI recorded and deliberately did not act on —
   *  the retry lane. A blank resolution used to mean this, which read in the
   *  console as an incident still in flight. */
  resolution?: "promoted" | "quarantined" | "rolled_back" | "infra" | "dead" | "observed";
  credits_spent: number;
  wall_ms?: number;
  approved_by?: "gate" | "human";
};
