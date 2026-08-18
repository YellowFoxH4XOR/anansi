import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { fetchRuns, usePoll, type IncidentRecord, type RunPoint, type StatePayload } from "../api";
import { Chip, Kpi, Panel, ResolutionPill, RouteBadge, STATE_META, Skeleton, Sparkline, StatePill, ago } from "../components";

function CommandLine({ cmd }: { cmd: string }) {
  return (
    <code
      className="mt-2 block w-fit rounded-md border px-3 py-1.5 text-[12px]"
      style={{ borderColor: "var(--line)", background: "var(--code-bg)", color: "var(--ink)" }}
    >
      <span aria-hidden style={{ color: "var(--muted)" }}>
        ${" "}
      </span>
      {cmd}
    </code>
  );
}

function FleetCard({
  name,
  state,
  lastChecked,
  openIncident,
}: {
  name: string;
  state: StatePayload["fleet"][number]["state"];
  lastChecked?: number;
  openIncident?: IncidentRecord;
}) {
  const [runs, setRuns] = useState<RunPoint[]>([]);
  useEffect(() => {
    fetchRuns(name).then(setRuns).catch(() => {});
    const t = setInterval(() => fetchRuns(name).then(setRuns).catch(() => {}), 15000);
    return () => clearInterval(t);
  }, [name]);

  // One golden-tracked metric per card: the first canary's price series.
  const firstUrl = runs[0]?.url;
  const points = runs
    .filter((r) => r.url === firstUrl && typeof r.fields.price === "number")
    .map((r) => ({ ts: r.ts, v: r.fields.price as number }));

  return (
    <Panel
      className="fade-in flex flex-col gap-2"
      style={{ borderLeft: `3px solid ${STATE_META[state].color}` }}
    >
      <div className="flex items-center justify-between gap-3">
        <span className="font-bold">{name}</span>
        <StatePill state={state} />
      </div>
      <Sparkline points={points.slice(-24)} />
      <div className="flex justify-between text-[11px]" style={{ color: "var(--muted)" }}>
        <span>price · canary #1</span>
        <span title={lastChecked ? new Date(lastChecked).toLocaleString() : undefined}>checked {ago(lastChecked)}</span>
      </div>
      {openIncident && (
        <Link
          to={`/incident/${openIncident.id}`}
          className="link-dotted flex w-fit items-center gap-1.5 text-[11.5px]"
          style={{ color: "var(--accent)" }}
        >
          <span aria-hidden style={{ color: "var(--warn)" }}>
            ▲
          </span>
          open incident →
        </Link>
      )}
    </Panel>
  );
}

export default function Fleet() {
  const state = usePoll<StatePayload>("/api/state", 5000);
  const navigate = useNavigate();
  if (!state) {
    return <Skeleton lines={3} label="connecting to the store" />;
  }
  const { fleet, incidents, creditsSpent } = state;
  const promoted = incidents.filter((i) => i.resolution === "promoted").length;
  const quarantined = incidents.filter((i) => i.resolution === "quarantined").length;
  const open = incidents.filter((i) => i.resolution == null).length;
  const openFor = (scraper: string) => incidents.find((i) => i.scraper === scraper && i.resolution == null);

  return (
    <div className="fade-in flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
        <Kpi label="incidents" value={incidents.length} />
        <Kpi label="open now" value={open} tone={open ? "var(--accent)" : undefined} />
        <Kpi label="promoted by gate" value={promoted} tone="var(--good)" />
        <Kpi label="quarantined" value={quarantined} tone={quarantined ? "var(--bad)" : undefined} />
        <Kpi label="credits spent" value={creditsSpent} />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {fleet.length === 0 && (
          <Panel className="sm:col-span-2 lg:col-span-3">
            <span style={{ color: "var(--muted)" }}>No collectors yet — seed the demo fleet:</span>
            <CommandLine cmd="npx tsx scripts/seed-demo.ts" />
          </Panel>
        )}
        {fleet.map((f) => (
          <FleetCard key={f.name} {...f} openIncident={openFor(f.name)} />
        ))}
      </div>

      <Panel className="overflow-x-auto p-0">
        <table className="num w-full text-[13px]">
          <thead>
            <tr className="text-left text-[10.5px] uppercase tracking-widest" style={{ color: "var(--muted)" }}>
              {["incident", "scraper", "signals", "route", "resolution", "credits", "wall", "opened"].map((h) => (
                <th key={h} className="border-b px-4 py-2 font-medium" style={{ borderColor: "var(--line)" }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {incidents.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-6" style={{ color: "var(--muted)" }}>
                  <div className="flex flex-col items-center">
                    <span>No incidents yet — the fleet is healthy. Fire a mutation from the Lab control panel:</span>
                    <CommandLine cmd="npm run lab" />
                  </div>
                </td>
              </tr>
            )}
            {[...incidents].reverse().map((r) => (
              <tr
                key={r.id}
                className="cursor-pointer transition-colors duration-150 hover:bg-[var(--panel-2)]"
                onClick={(e) => {
                  if ((e.target as HTMLElement).closest("a")) return; // let the real link handle itself
                  navigate(`/incident/${r.id}`);
                }}
              >
                <td className="border-b px-4 py-2" style={{ borderColor: "var(--line)" }}>
                  <Link to={`/incident/${r.id}`} className="link-dotted link-muted">
                    {r.id}
                  </Link>
                </td>
                <td className="border-b px-4 py-2" style={{ borderColor: "var(--line)" }}>
                  {r.scraper}
                </td>
                <td className="border-b px-4 py-2" style={{ borderColor: "var(--line)" }}>
                  <span className="flex flex-wrap gap-1">
                    {[...new Set(r.signal.map((s) => s.signal))].map((sig) => (
                      <Chip key={sig}>{sig}</Chip>
                    ))}
                  </span>
                </td>
                <td className="border-b px-4 py-2" style={{ borderColor: "var(--line)" }}>
                  <RouteBadge route={r.route} />
                </td>
                <td className="border-b px-4 py-2" style={{ borderColor: "var(--line)" }}>
                  <ResolutionPill resolution={r.resolution} />
                </td>
                <td className="border-b px-4 py-2" style={{ borderColor: "var(--line)" }}>
                  {r.credits_spent}
                </td>
                <td className="border-b px-4 py-2" style={{ borderColor: "var(--line)" }}>
                  {r.wall_ms ? `${Math.round(r.wall_ms / 1000)}s` : "—"}
                </td>
                <td className="border-b px-4 py-2" style={{ borderColor: "var(--line)", color: "var(--muted)" }}>
                  <span title={new Date(r.opened_at).toLocaleString()}>{ago(r.opened_at)}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}
