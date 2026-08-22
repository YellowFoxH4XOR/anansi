import { useState } from "react";
import { Link } from "react-router-dom";
import { usePoll, type JobRow, type StatePayload } from "../api";
import { Chip, Kpi, Panel, RunVerdict, Skeleton, VERDICT_META, ago } from "../components";

// A healthy fleet is silent: no incidents, no state changes, nothing on a fleet
// card but an unchanged strip. That silence is indistinguishable from a dead
// agent, which is the hardest thing to distinguish from this console. This page
// answers the question that replaced "did we scan?" — what has Bright Data run,
// and what did those runs do?

function when(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

const TRIGGER_META: Record<JobRow["trigger"], { label: string; title: string }> = {
  scheduled: { label: "scheduled", title: "Batch job (j_…) — started by Bright Data's own schedule." },
  cli: { label: "cli / realtime", title: "Realtime or CLI job (vj_…) — started by hand or by a heal preview, never by the monitor loop." },
  unknown: { label: "—", title: "Job id carries no recognised prefix." },
};

function Row({ j }: { j: JobRow }) {
  const t = TRIGGER_META[j.trigger];
  return (
    <tr className="border-t" style={{ borderColor: "var(--line)" }}>
      <td className="py-2 pr-4 align-top">
        <RunVerdict verdict={j.verdict} />
      </td>
      <td className="num py-2 pr-4 align-top" title={j.job_id}>
        {j.incident_id ? (
          <Link to={`/incident/${j.incident_id}`} className="link-dotted" style={{ color: "var(--accent)" }}>
            {j.job_id}
          </Link>
        ) : (
          j.job_id
        )}
      </td>
      <td className="py-2 pr-4 align-top" style={{ color: "var(--muted)" }}>
        {j.collector}
      </td>
      <td className="py-2 pr-4 align-top" style={{ color: "var(--muted)" }} title={t.title}>
        {t.label}
      </td>
      <td className="num py-2 pr-4 align-top" style={{ color: "var(--muted)" }}>
        {j.rows}
      </td>
      <td className="num py-2 pr-4 align-top" style={{ color: j.error_rows ? "var(--warn)" : "var(--muted)" }}>
        {j.error_rows}
      </td>
      <td
        className="num whitespace-nowrap py-2 pr-4 align-top"
        title={
          j.finished
            ? `Bright Data finished this run at ${new Date(j.finished).toISOString()}`
            : `Not recorded — ANANSI first observed this job at ${new Date(j.seen).toISOString()}`
        }
      >
        {j.finished ? when(j.finished) : `seen ${when(j.seen)}`}
      </td>
      <td className="py-2 align-top whitespace-nowrap" style={{ color: "var(--muted)" }}>
        {ago(j.finished ?? j.seen)}
      </td>
      <td className="py-2 align-top" style={{ color: "var(--muted)" }}>
        {j.note ?? ""}
      </td>
    </tr>
  );
}

export default function Runs() {
  const [collector, setCollector] = useState("");
  const [verdict, setVerdict] = useState("");
  const query = new URLSearchParams({ limit: "200" });
  if (collector) query.set("collector", collector);
  if (verdict) query.set("verdict", verdict);
  const jobs = usePoll<JobRow[]>(`/api/jobs?${query}`, 5000);
  const state = usePoll<StatePayload>("/api/state", 15000);

  if (!jobs) return <Skeleton label="loading run history" />;

  const failed = jobs.filter((j) => j.verdict === "failed" || j.verdict === "partial").length;
  const newest = jobs[0];

  const filters = (
    <div className="flex flex-wrap items-center gap-2 text-[12px]">
      <select
        value={collector}
        onChange={(e) => setCollector(e.target.value)}
        className="rounded-md border px-2 py-1"
        style={{ borderColor: "var(--line)", background: "var(--panel-2)", color: "var(--ink)" }}
        aria-label="filter by collector"
      >
        <option value="">all collectors</option>
        {state?.fleet.map((f) => (
          <option key={f.name} value={f.name}>
            {f.name}
          </option>
        ))}
      </select>
      <select
        value={verdict}
        onChange={(e) => setVerdict(e.target.value)}
        className="rounded-md border px-2 py-1"
        style={{ borderColor: "var(--line)", background: "var(--panel-2)", color: "var(--ink)" }}
        aria-label="filter by verdict"
      >
        <option value="">all verdicts</option>
        {Object.entries(VERDICT_META).map(([v, m]) => (
          <option key={v} value={v}>
            {m.label}
          </option>
        ))}
      </select>
    </div>
  );

  if (jobs.length === 0) {
    return (
      <Panel className="fade-in flex flex-col gap-3">
        {filters}
        <div className="font-bold">No runs on record yet</div>
        <p className="text-[12.5px]" style={{ color: "var(--muted)" }}>
          Bright Data owns the schedule — ANANSI never triggers a collection, it reports the runs your scrapers already
          performed. An empty table means one of: no collector has run inside the platform's retention window; the agent
          has not completed a poll since the store was cleared; or <code className="mx-1">BRIGHTDATA_API_KEY</code>{" "}
          cannot read <code>/dca/collector/jobs</code>. Check the scraper's schedule in Scraper Studio first, then the
          agent log.
        </p>
        {state && state.fleet.length === 0 && (
          <p className="text-[12.5px]" style={{ color: "var(--warn)" }}>
            No collectors have been discovered either, so this is a discovery problem before it is a schedule problem —
            job history can only be fetched per collector.
          </p>
        )}
      </Panel>
    );
  }

  return (
    <div className="fade-in flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Kpi
          label="last run"
          value={newest ? ago(newest.finished ?? newest.seen) : "—"}
          tone={newest && (newest.verdict === "failed" || newest.verdict === "partial") ? "var(--bad)" : "var(--good)"}
        />
        <Kpi label="failed runs" value={failed} tone={failed ? "var(--bad)" : "var(--good)"} />
        <Kpi label="runs shown" value={jobs.length} />
        <Kpi label="row errors" value={jobs.reduce((n, j) => n + j.error_rows, 0)} />
      </div>

      <Panel>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="font-bold">Run history</span>
          {filters}
          <Chip title="Every row is a job Bright Data ran on its own schedule. ANANSI polls for them afterwards and spends no page loads doing it.">
            newest first · polls every 5s
          </Chip>
        </div>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-[12.5px]">
            <thead>
              <tr className="text-[10.5px] uppercase tracking-widest" style={{ color: "var(--muted)" }}>
                <th className="pb-2 pr-4 font-normal">verdict</th>
                <th className="pb-2 pr-4 font-normal">job</th>
                <th className="pb-2 pr-4 font-normal">collector</th>
                <th className="pb-2 pr-4 font-normal">trigger</th>
                <th className="pb-2 pr-4 font-normal">rows</th>
                <th className="pb-2 pr-4 font-normal">row errors</th>
                <th className="pb-2 pr-4 font-normal">run finished</th>
                <th className="pb-2 pr-4 font-normal">age</th>
                <th className="pb-2 font-normal">note</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <Row key={j.job_id} j={j} />
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}
