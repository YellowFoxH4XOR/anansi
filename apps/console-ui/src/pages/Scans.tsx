import { usePoll, type SweepRow } from "../api";
import { Chip, Kpi, Panel, Skeleton, ago } from "../components";

// A healthy fleet is silent: no incidents, no state changes, nothing on the
// fleet card but an unchanged sparkline. That silence is indistinguishable from
// a dead agent, which is the single hardest thing to judge from this console.
// This page exists to answer one question — did it scan, and what did it find?

function when(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function duration(from: number, to: number): string {
  const ms = Math.max(0, to - from);
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function Row({ s }: { s: SweepRow }) {
  const tone = s.healthy ? "var(--good)" : "var(--bad)";
  return (
    <tr className="border-t" style={{ borderColor: "var(--line)" }}>
      <td className="py-2 pr-4 align-top">
        <span aria-hidden style={{ color: tone }}>
          {s.healthy ? "✓" : "✕"}
        </span>{" "}
        <span style={{ color: tone }}>{s.healthy ? "clean" : "violations"}</span>
      </td>
      <td className="py-2 pr-4 align-top num whitespace-nowrap" title={new Date(s.sweep_ts).toISOString()}>
        {when(s.sweep_ts)}
      </td>
      <td className="py-2 pr-4 align-top whitespace-nowrap" style={{ color: "var(--muted)" }}>
        {ago(s.sweep_ts)}
      </td>
      <td className="py-2 pr-4 align-top num" style={{ color: "var(--muted)" }}>
        {s.canaries}
      </td>
      <td className="py-2 pr-4 align-top num" style={{ color: s.errors ? "var(--warn)" : "var(--muted)" }}>
        {s.errors}
      </td>
      <td className="py-2 align-top num" style={{ color: "var(--muted)" }}>
        {duration(s.sweep_ts, s.finished_ts)}
      </td>
    </tr>
  );
}

export default function Scans() {
  const sweeps = usePoll<SweepRow[]>("/api/sweeps?limit=100", 5000);

  if (!sweeps) return <Skeleton label="loading scan history" />;

  if (sweeps.length === 0) {
    return (
      <Panel className="fade-in">
        <div className="font-bold">No scans recorded yet</div>
        <p className="mt-2 text-[12.5px]" style={{ color: "var(--muted)" }}>
          The agent writes a row per canary on every cadence tick. Nothing here means it has not
          completed a sweep since the store was last cleared — check the agent logs for
          <code className="mx-1">contract(s) schedulable</code>, and remember a quarantined
          collector is skipped rather than swept.
        </p>
      </Panel>
    );
  }

  const latest = sweeps[0]!;
  const clean = sweeps.filter((s) => s.healthy).length;

  return (
    <div className="fade-in flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Kpi label="last scan" value={ago(latest.sweep_ts)} tone={latest.healthy ? "var(--good)" : "var(--bad)"} />
        <Kpi label="last result" value={latest.healthy ? "clean" : "violations"} tone={latest.healthy ? "var(--good)" : "var(--bad)"} />
        <Kpi label="scans shown" value={sweeps.length} />
        <Kpi label="clean" value={`${clean}/${sweeps.length}`} />
      </div>

      <Panel>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="font-bold">Scan history</span>
          <Chip title="Every cadence tick writes one row per canary; a clean scan is the agent working normally.">
            newest first · polls every 5s
          </Chip>
        </div>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-[12.5px]">
            <thead>
              <tr className="text-[10.5px] uppercase tracking-widest" style={{ color: "var(--muted)" }}>
                <th className="pb-2 pr-4 font-normal">status</th>
                <th className="pb-2 pr-4 font-normal">scanned at</th>
                <th className="pb-2 pr-4 font-normal">age</th>
                <th className="pb-2 pr-4 font-normal">canaries</th>
                <th className="pb-2 pr-4 font-normal">errors</th>
                <th className="pb-2 font-normal">took</th>
              </tr>
            </thead>
            <tbody>
              {sweeps.map((s) => (
                <Row key={`${s.scraper}-${s.sweep_ts}`} s={s} />
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}
