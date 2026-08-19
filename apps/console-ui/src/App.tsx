import { Link, Route, Routes, useLocation } from "react-router-dom";
import { usePoll, type StatePayload } from "./api";
import { StatePill, ago } from "./components";
import Fleet from "./pages/Fleet";
import Trace from "./pages/Trace";
import Diff from "./pages/Diff";
import Runs from "./pages/Runs";

function SpiderMark({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" className="shrink-0">
      <g fill="none" stroke="var(--accent)" strokeWidth="5" strokeLinecap="round">
        <path d="M24 28 L10 14 M22 33 L4 28 M22 38 L8 50 M26 42 L18 58" />
        <path d="M40 28 L54 14 M42 33 L60 28 M42 38 L56 50 M38 42 L46 58" />
      </g>
      <circle cx="32" cy="22" r="7" fill="var(--accent)" />
      <circle cx="32" cy="38" r="12" fill="var(--accent)" />
    </svg>
  );
}

// ANANSI_ADAPTER selects the HEAL seam only — monitoring is read-only in every
// mode. The badge therefore says nothing about spend or about reading the
// platform; it says whether a fix would really be issued to Scraper Studio.
const MODE_BADGE: Record<string, { label: string; title: string }> = {
  fake: {
    label: "fixtures",
    title: "Agent is on the fake heal adapter: no `scraper heal` is issued and every fix is simulated. Job history is still read from the real platform.",
  },
};

// A poll older than this means the agent has stopped reading the platform, so
// the fleet on screen is stale no matter how green it looks.
const STALE_POLL_MS = 10 * 60_000;

function NavTab({ to, label, active }: { to: string; label: string; active: boolean }) {
  return (
    <Link
      to={to}
      aria-current={active ? "page" : undefined}
      className="rounded-full border px-2.5 py-0.5 text-[11.5px] transition-colors"
      style={{
        borderColor: active ? "var(--accent)" : "var(--line)",
        color: active ? "var(--accent)" : "var(--muted)",
      }}
    >
      {label}
    </Link>
  );
}

export default function App() {
  const state = usePoll<StatePayload>("/api/state", 5000);
  const { pathname } = useLocation();
  const alert = state?.fleet.some((f) => f.state !== "healthy" && f.state !== "watching") ?? false;
  const badge = state?.mode ? MODE_BADGE[state.mode] : undefined;
  const poll = state?.lastPoll ?? null;
  const pollStale = poll != null && Date.now() - poll > STALE_POLL_MS;
  return (
    <div className="min-h-screen">
      <header
        className={`masthead sticky top-0 z-10 flex flex-wrap items-center gap-x-6 gap-y-2 border-b px-6 py-3 ${alert ? "masthead-alert" : ""}`}
        style={{ borderColor: "var(--line)", background: "var(--panel)" }}
      >
        <Link to="/" className="brand-link flex items-baseline gap-2.5">
          <span className="flex items-center gap-2 text-[15px] font-bold tracking-[0.2em]" style={{ color: "var(--accent)" }}>
            <SpiderMark />
            ANANSI
          </span>
          <span className="hidden text-[11px] md:inline" style={{ color: "var(--muted)" }}>
            an immune system for your scraper fleet
          </span>
        </Link>
        <div className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-2">
          {badge && (
            <span
              className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] tracking-wide"
              style={{ borderColor: "var(--warn)", color: "var(--warn)" }}
              title={badge.title}
            >
              ▲ {badge.label}
            </span>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {state?.fleet.map((f) => (
              <span key={f.name} className="flex items-center gap-1.5 text-[11.5px]" style={{ color: "var(--muted)" }}>
                {f.name}
                <StatePill state={f.state} />
              </span>
            ))}
          </div>
          {state && (
            <>
              <span aria-hidden className="hidden h-4 w-px sm:inline-block" style={{ background: "var(--line)" }} />
              {/* A healthy fleet is otherwise silent. ANANSI never triggers a
                  collection, so proof of life is the age of our last READ of
                  the platform, not of a scan. */}
              <span
                className="flex items-baseline gap-1.5 text-[11.5px]"
                style={{ color: "var(--muted)" }}
                title={
                  poll
                    ? `ANANSI last read the Bright Data job API at ${new Date(poll).toLocaleString()}. Bright Data owns the schedule — ANANSI never triggers a run.`
                    : "No collector has been polled yet. Either the agent has not completed a poll, or the account has no collectors — the console reads a shared volume and cannot tell these apart."
                }
              >
                last poll
                <span
                  className="num text-[13px] font-bold"
                  style={{ color: poll == null ? "var(--warn)" : pollStale ? "var(--bad)" : "var(--good)" }}
                >
                  {poll ? ago(poll) : "never"}
                </span>
              </span>
              <span aria-hidden className="hidden h-4 w-px sm:inline-block" style={{ background: "var(--line)" }} />
              <span
                className="flex items-baseline gap-1.5 text-[11.5px]"
                style={{ color: "var(--muted)" }}
                title="Runs Bright Data performed in the last 24h that failed or partly failed. ANANSI observes these; it does not cause them."
              >
                failed runs · 24h
                <span
                  className="num text-[13px] font-bold"
                  style={{ color: state.failedRuns24h ? "var(--bad)" : "var(--good)" }}
                >
                  {state.failedRuns24h}
                </span>
              </span>
            </>
          )}
          <span aria-hidden className="hidden h-4 w-px sm:inline-block" style={{ background: "var(--line)" }} />
          <nav className="flex items-center gap-1.5">
            <NavTab to="/" label="fleet" active={pathname === "/"} />
            <NavTab to="/runs" label="runs" active={pathname === "/runs"} />
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-6">
        <Routes>
          <Route path="/" element={<Fleet />} />
          <Route path="/runs" element={<Runs />} />
          <Route path="/incident/:id" element={<Trace />} />
          <Route path="/incident/:id/diff" element={<Diff />} />
        </Routes>
      </main>
    </div>
  );
}
