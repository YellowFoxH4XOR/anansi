import { Link, Route, Routes } from "react-router-dom";
import { usePoll, type StatePayload } from "./api";
import { StatePill } from "./components";
import Fleet from "./pages/Fleet";
import Trace from "./pages/Trace";
import Diff from "./pages/Diff";

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

// Rehearsal and fixture runs are labelled in the masthead: their heals are
// simulated and their "credits" are page loads, so the number below must never
// be read as Bright Data spend. Real mode shows no badge — that is the default.
const MODE_BADGE: Record<string, { label: string; title: string }> = {
  live: {
    label: "rehearsal",
    title: "Agent is on the live-Lab adapter: real fetches of the Mutation Lab, SIMULATED heals, no Bright Data calls and no credits spent.",
  },
  fake: {
    label: "fixtures",
    title: "Agent is on the fake adapter: banked fixture replay. No network, no Bright Data calls, no credits spent.",
  },
};

export default function App() {
  const state = usePoll<StatePayload>("/api/state", 5000);
  const alert = state?.fleet.some((f) => f.state !== "healthy" && f.state !== "watching") ?? false;
  const badge = state?.mode ? MODE_BADGE[state.mode] : undefined;
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
              <span
                className="flex items-baseline gap-1.5 text-[11.5px]"
                style={{ color: "var(--muted)" }}
                title="Bright Data credits spent across all incidents"
              >
                credits
                <span className="num text-[13px] font-bold" style={{ color: "var(--ink)" }}>
                  {state.creditsSpent}
                </span>
              </span>
            </>
          )}
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-6">
        <Routes>
          <Route path="/" element={<Fleet />} />
          <Route path="/incident/:id" element={<Trace />} />
          <Route path="/incident/:id/diff" element={<Diff />} />
        </Routes>
      </main>
    </div>
  );
}
