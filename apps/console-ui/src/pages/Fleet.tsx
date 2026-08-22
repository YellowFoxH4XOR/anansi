import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { fetchRuns, usePoll, type FleetEntry, type IncidentRecord, type RunPoint, type StatePayload } from "../api";
import {
  Chip,
  DEPTH_META,
  Kpi,
  Panel,
  ResolutionPill,
  RouteBadge,
  RunStrip,
  STATE_META,
  Skeleton,
  Sparkline,
  StatePill,
  ago,
} from "../components";

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

/** The first field this collector actually reports as a number, on its first
 *  URL. Previously hardcoded to `price`, which was contract-fleet thinking: on
 *  any scraper that is not a storefront it left the chart permanently blank. */
function firstNumericSeries(runs: RunPoint[]): { field: string; url: string; points: { ts: number; v: number }[] } | null {
  // A run that collected nothing is stored with url "unknown" and no fields.
  // Reading runs[0] blindly meant one failed run — the newest, exactly when a
  // chart matters most — chose a url with no numbers and blanked the card.
  const url = runs.find((r) => r.url && r.url !== "unknown" && Object.values(r.fields).some((v) => typeof v === "number"))?.url;
  if (!url) return null;
  const forUrl = runs.filter((r) => r.url === url);
  const field = forUrl
    .flatMap((r) => Object.entries(r.fields))
    .find(([, v]) => typeof v === "number")?.[0];
  if (!field) return null;
  const points = forUrl.flatMap((r) => (typeof r.fields[field] === "number" ? [{ ts: r.ts, v: r.fields[field] as number }] : []));
  return points.length >= 2 ? { field, url, points } : null;
}

/** Cadence in the coarsest unit that still reads true — an inferred median is
 *  not precise enough to deserve minutes-and-seconds. */
function humanGap(ms: number | undefined): string {
  if (!ms) return "—";
  const h = ms / 3_600_000;
  if (h >= 48) return `${Math.round(h / 24)}d`;
  if (h >= 1.5) return `${Math.round(h)}h`;
  return `${Math.max(1, Math.round(ms / 60_000))}m`;
}

function FleetCard({ entry, openIncident }: { entry: FleetEntry; openIncident?: IncidentRecord }) {
  const { name, platformName, paused, state, collectorId, contract, recent, lastRunAt, failed24h, stale, expectedEveryMs } = entry;
  // Every identifier on this card must exist on Bright Data. The store key is a
  // name a contract invented — it appears nowhere in Studio, so an operator
  // cannot match it to their account and has no way to tell it is ours. The
  // platform's name first, then the collector id, which is at least real.
  const title = platformName ?? collectorId ?? name;
  const [runs, setRuns] = useState<RunPoint[]>([]);
  useEffect(() => {
    fetchRuns(name).then(setRuns).catch(() => {});
    const t = setInterval(() => fetchRuns(name).then(setRuns).catch(() => {}), 15000);
    return () => clearInterval(t);
  }, [name]);

  // The series is the scraper's OWN collected output over time, read back from
  // Bright Data's datasets — so it needs no contract and asserts nothing about
  // what the value ought to be. It used to be gated on `contract === "pinned"`,
  // which hid entirely platform-sourced data behind a YAML file somebody had to
  // write, and framed it as a golden band: a number a human supplied, that
  // ANANSI has no way to know is right.
  const series = firstNumericSeries(runs);
  const depth = DEPTH_META[contract];

  return (
    <Panel className="fade-in flex flex-col gap-2" style={{ borderLeft: `3px solid ${STATE_META[state].color}` }}>
      <div className="flex items-center justify-between gap-3">
        <span
          className="min-w-0 truncate font-bold"
          title={platformName ? `"${platformName}" on Bright Data${collectorId ? ` · ${collectorId}` : ""}` : (collectorId ?? name)}
        >
          {title}
        </span>
        <div className="flex shrink-0 items-center gap-1.5">
          {paused && (
            <Chip title="Bright Data reports this scraper as inactive. It is not late — it is switched off, so ANANSI does not call it overdue.">
              paused
            </Chip>
          )}
          <StatePill state={state} />
        </div>
      </div>
      {collectorId && (
        // The collector id and nothing else. The contract's name used to be
        // rendered here as provenance, which put a string ANANSI made up on a
        // board whose entire claim is that it shows the operator's own account.
        // That a contract is pinned is already said by the depth chip, without
        // naming anything the platform has never heard of.
        <span className="num truncate text-[10.5px]" style={{ color: "var(--muted)" }} title={collectorId}>
          {collectorId}
        </span>
      )}
      {/* The value chart is extra, when there is numeric history to draw. The
          outcome strip is not: it is how a card says whether runs are passing,
          and swapping it out for a trend line hid that behind a chart of a
          number whose correctness nothing here can vouch for. */}
      {series && (
        <>
          <Sparkline points={series.points.slice(-24)} label={series.field} />
          <div className="text-[11px]" style={{ color: "var(--muted)" }}>
            {/* What was collected, not what was expected. The chart scales to the
                observed range and draws no band, because there is no band to
                draw: nothing here knows the correct value. */}
            <span title={series.url}>{series.field} · as collected</span>
          </div>
        </>
      )}
      <RunStrip ticks={recent} />
      <div className="flex justify-between text-[11px]" style={{ color: "var(--muted)" }}>
        <span title="Outcome of each run Bright Data performed, oldest first.">last {recent.length} run(s)</span>
        <span title={lastRunAt ? new Date(lastRunAt).toLocaleString() : undefined}>last run {ago(lastRunAt)}</span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Chip title={depth.title}>{depth.label}</Chip>
        {failed24h > 0 && (
          <Chip color="var(--bad)" border="var(--bad)" title="Runs that failed or partly failed in the last 24h.">
            ✕ {failed24h} failed · 24h
          </Chip>
        )}
        {stale && (
          <Chip
            color="var(--warn)"
            border="var(--warn)"
            title={`Bright Data runs this roughly every ${humanGap(expectedEveryMs)} — and the last one finished longer ago than that. A run that never happens produces no job and no error, so nothing else here would mention it. ANANSI cannot start one: check the schedule in Scraper Studio.`}
          >
            ⏳ overdue · expected every {humanGap(expectedEveryMs)}
          </Chip>
        )}
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
  const { fleet, incidents, healAttempts, platformNames } = state;
  const promoted = incidents.filter((i) => i.resolution === "promoted").length;
  const quarantined = incidents.filter((i) => i.resolution === "quarantined").length;
  const open = incidents.filter((i) => i.resolution == null).length;
  const openFor = (scraper: string) => incidents.find((i) => i.scraper === scraper && i.resolution == null);
  // Runs that failed, straight from the fleet cards. An empty incident table is
  // not evidence the runs were clean, and this is the number that decides which
  // of the two the console is allowed to claim.
  const failedRuns = fleet.reduce((n, f) => n + f.failed24h, 0);

  return (
    <div className="fade-in flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
        <Kpi label="incidents" value={incidents.length} />
        <Kpi label="open now" value={open} tone={open ? "var(--accent)" : undefined} />
        <Kpi label="promoted by gate" value={promoted} tone="var(--good)" />
        <Kpi label="quarantined" value={quarantined} tone={quarantined ? "var(--bad)" : undefined} />
        <Kpi
          label="heal attempts"
          value={healAttempts}
          title="Heals ANANSI has issued. A heal runs the scraper to produce preview rows, so it is the only spend ANANSI causes: it never triggers a collection, and polling and archiving are free."
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {fleet.length === 0 && (
          <Panel className="sm:col-span-2 lg:col-span-3">
            <div className="font-bold">No scrapers discovered yet</div>
            <p className="mt-2 text-[12.5px]" style={{ color: "var(--muted)" }}>
              ANANSI reads the fleet from Bright Data, so a scraper built in Scraper Studio appears here with no config
              file and no redeploy. An empty board means either the agent has not completed a poll (check it is running
              and that <code className="mx-1">BRIGHTDATA_API_KEY</code> can read <code>/dca/collector/jobs</code>), or
              the account has no collectors. The console only reads the shared volume — it never calls the platform, so
              it cannot tell those two apart. The agent log can.
            </p>
            <p className="mt-2 text-[12.5px]" style={{ color: "var(--muted)" }}>
              For an offline example fleet with a full incident already on record:
            </p>
            <CommandLine cmd="npx tsx scripts/seed-demo.ts" />
          </Panel>
        )}
        {fleet.map((f) => (
          <FleetCard key={f.name} entry={f} openIncident={openFor(f.name)} />
        ))}
      </div>

      <Panel className="overflow-x-auto p-0">
        <table className="num w-full text-[13px]">
          <thead>
            <tr className="text-left text-[10.5px] uppercase tracking-widest" style={{ color: "var(--muted)" }}>
              {["incident", "scraper", "signals", "route", "resolution", "heals", "wall", "opened"].map((h) => (
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
                    {/* An empty incident list is not evidence that the runs were
                        clean. When the fleet reports failures and the incident
                        table is empty, the two disagree — and the honest reading
                        is that ANANSI missed something, not that all is well. */}
                    <span>
                      {failedRuns === 0
                        ? "No incidents — and no failed runs to explain: every run Bright Data has performed came back clean."
                        : `No incidents recorded, but ${failedRuns} run(s) in the last 24h did not come back clean. That is a gap in ANANSI, not a healthy fleet — check Runs.`}
                    </span>
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
                  {/* The incident keys by store key; show the platform's name. */}
                  {platformNames?.[r.scraper] ?? r.scraper}
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
                <td
                  className="border-b px-4 py-2"
                  style={{ borderColor: "var(--line)" }}
                  title="Heal attempts on this incident — the only spend ANANSI initiates."
                >
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
