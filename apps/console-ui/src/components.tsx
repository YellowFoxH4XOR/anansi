import { useCallback, useMemo, useRef, useState } from "react";
import type { CollectorState, ContractDepth, GateResult, JobVerdict, RunTick, Verdict } from "./api";

// What each state means now that Bright Data owns the schedule: every one of
// them is a statement about runs the platform performed, never about a scan of
// ours.
export const STATE_META: Record<CollectorState, { color: string; glyph: string; title: string }> = {
  healthy: { color: "var(--good)", glyph: "●", title: "The last run observed for this collector came back clean." },
  watching: {
    color: "var(--good)",
    glyph: "◉",
    title: "A fix was promoted. Bright Data's next scheduled run is the verification — if it fails, the collector is quarantined rather than re-healed.",
  },
  incident_open: { color: "var(--warn)", glyph: "▲", title: "An incident is open. Further runs are held until it resolves." },
  healing: { color: "var(--accent)", glyph: "◔", title: "A heal is in flight in Scraper Studio, stopping at the approval gate." },
  verifying: {
    color: "var(--accent)",
    glyph: "◑",
    title: "Legacy state. Post-approval verification is now Bright Data's own next scheduled run, so nothing sets this any more — it renders only for incidents recorded before that change.",
  },
  quarantined: { color: "var(--bad)", glyph: "✕", title: "Human attention required. ANANSI will not attempt another heal here." },
};

export function StatePill({ state }: { state: CollectorState }) {
  const m = STATE_META[state];
  const live = state === "healing" || state === "verifying";
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] tracking-wide"
      style={{ borderColor: m.color, color: m.color }}
      title={m.title}
    >
      <span className={live ? "pulse" : ""}>{m.glyph}</span>
      {state}
    </span>
  );
}

// A run's outcome as the platform reported it, plus the two verdicts that are
// about ANANSI rather than the scraper (deferred, in_flight) — kept visually
// distinct so our own backlog is never read as the scraper failing.
export const VERDICT_META: Record<JobVerdict, { color: string; glyph: string; label: string; title: string }> = {
  ok: { color: "var(--good)", glyph: "✓", label: "ok", title: "Run completed with no failed pages and no row errors." },
  partial: { color: "var(--bad)", glyph: "◑", label: "partial", title: "Rows landed, but some pages failed — a real failure with partial data." },
  failed: { color: "var(--bad)", glyph: "✕", label: "failed", title: "The run failed: failed pages, row errors, or a failed status." },
  unknown: {
    color: "var(--warn)",
    glyph: "?",
    label: "unknown",
    title: "The platform reported no usable signal. Status alone is never trusted — a live job has been seen with no status at all and 15 failed pages.",
  },
  seeded: {
    color: "var(--muted)",
    glyph: "○",
    label: "seeded",
    title: "Already finished before ANANSI started watching this collector. Recorded, deliberately not judged: healing against a two-week-old page is worse than not healing.",
  },
  in_flight: { color: "var(--accent)", glyph: "●", label: "in flight", title: "Claimed by the monitor and not yet settled." },
  deferred: { color: "var(--warn)", glyph: "⏸", label: "deferred", title: "Held by ANANSI, not dropped — a job is a one-time fact, so it is re-offered on a later poll." },
  abandoned: { color: "var(--muted)", glyph: "⊘", label: "abandoned", title: "The monitor died while handling this job. Not replayed: a replay could approve an ungated fix." },
};

export function RunVerdict({ verdict }: { verdict: JobVerdict }) {
  const m = VERDICT_META[verdict];
  return (
    <span className="inline-flex items-center gap-1.5 text-[12px]" style={{ color: m.color }} title={m.title}>
      <span aria-hidden>{m.glyph}</span>
      {m.label}
    </span>
  );
}

// Run-outcome strip: the contract-free equivalent of a golden sparkline. Every
// collector has one, because every collector has runs; only some have goldens.
export function RunStrip({ ticks, height = 56 }: { ticks: RunTick[]; height?: number }) {
  if (ticks.length === 0) {
    return (
      <div className="flex items-center text-[11px]" style={{ color: "var(--muted)", height }}>
        no runs observed yet
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-1" style={{ minHeight: height }}>
      {ticks.map((t) => {
        const m = VERDICT_META[t.verdict];
        return (
          <span
            key={t.job_id}
            className="text-[13px] leading-none"
            style={{ color: m.color }}
            title={`${t.job_id} · ${m.label} · ${new Date(t.ts).toLocaleString()}`}
          >
            {m.glyph}
          </span>
        );
      })}
    </div>
  );
}

// A contract is an EXTRA, not a tier. This used to read as an upsell — "platform
// signals only", "add a contract to get them" — which described a real gap at the
// time: without one, ANANSI had no declared fields to check and could not verify
// a heal. It no longer does. Every collector is checked against the output_schema
// Bright Data publishes for it, so a contract-less scraper is fully monitored for
// the thing ANANSI is for: whether it still works.
//
// What a contract adds is golden VALUES — an assertion about what the data should
// say, which needs a human who knows the answer. That is a different question
// from "did this break", and the board must not imply a scraper is
// under-watched for lacking one.
export const DEPTH_META: Record<ContractDepth, { label: string; title: string }> = {
  pinned: {
    label: "goldens pinned",
    title:
      "A contract pins known-correct values for this collector, so ANANSI also checks the data is RIGHT — golden bands, CUSUM drift and invariants — on top of checking that the scraper still works.",
  },
  none: {
    label: "schema-checked",
    title:
      "Fully monitored. ANANSI checks this collector against the output_schema Bright Data publishes for it: run failures, fields that stop filling, and whether a heal's values really appear in the live page. No contract is needed for any of that.",
  },
  unknown: {
    label: "not yet discovered",
    title: "The agent has not recorded discovering this collector, so the console cannot yet say what it is checking.",
  },
};

export function resolutionMeta(resolution?: string): { color: string; glyph: string; word: string } {
  if (resolution === "promoted") return { color: "var(--good)", glyph: "✓", word: "promoted" };
  if (resolution == null) return { color: "var(--accent)", glyph: "●", word: "open" };
  return { color: "var(--bad)", glyph: "✕", word: resolution };
}

export function ResolutionPill({ resolution }: { resolution?: string }) {
  const m = resolutionMeta(resolution);
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px]"
      style={{ borderColor: m.color, color: m.color }}
    >
      <span className={resolution == null ? "pulse" : ""}>{m.glyph}</span>
      {m.word}
    </span>
  );
}

export function Panel({
  children,
  className = "",
  style,
}: {
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <div
      className={`rounded-xl border p-4 ${className}`}
      style={{ borderColor: "var(--line)", background: "var(--panel)", ...style }}
    >
      {children}
    </div>
  );
}

export function Caption({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10.5px] uppercase tracking-widest" style={{ color: "var(--muted)" }}>
      {children}
    </div>
  );
}

// Small status/identity chip. Defaults to the muted outline look; pass tones
// for soft-background variants (never color alone — callers ship a glyph/word).
export function Chip({
  children,
  color = "var(--muted)",
  border = "var(--line)",
  bg = "transparent",
  title,
}: {
  children: React.ReactNode;
  color?: string;
  border?: string;
  bg?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className="inline-flex max-w-full items-center gap-1 truncate rounded border px-1.5 py-0.5 text-[10.5px] leading-4"
      style={{ borderColor: border, color, background: bg }}
    >
      {children}
    </span>
  );
}

export function RouteBadge({ route }: { route: string }) {
  const heal = route === "heal";
  return (
    <Chip
      color={heal ? "var(--accent)" : "var(--muted)"}
      border={heal ? "var(--accent)" : "var(--line)"}
      title={heal ? "routed to the heal lane (Scraper Studio)" : `routed to the ${route} lane — never healed`}
    >
      {heal ? "◆ heal" : route}
    </Chip>
  );
}

export function VerdictChip({ v }: { v: Verdict }) {
  const c = v.pass ? "var(--good)" : "var(--bad)";
  return (
    <span
      className="num inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]"
      style={{ borderColor: c, color: c }}
      title={`verify verdict — confidence ${v.confidence.toFixed(2)} (audit-only; promotion is a conjunction of gates)`}
    >
      {v.pass ? "✓ pass" : "✕ fail"} · {v.confidence.toFixed(2)}
    </span>
  );
}

// Skeleton loader: shimmering muted bars (reduced-motion safe via CSS).
export function Skeleton({ lines = 3, label = "loading" }: { lines?: number; label?: string }) {
  const widths = ["62%", "88%", "45%"];
  return (
    <div role="status" aria-label={label} className="flex flex-col gap-2 py-10">
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="skeleton-bar" style={{ width: widths[i % widths.length] }} />
      ))}
      <span className="sr-only">{label}</span>
    </div>
  );
}

export function Kpi({ label, value, tone, title }: { label: string; value: string | number; tone?: string; title?: string }) {
  return (
    <div className="overflow-hidden rounded-xl border" title={title} style={{ borderColor: "var(--line)", background: "var(--panel)" }}>
      <div aria-hidden style={{ height: 2, background: tone ?? "var(--line)" }} />
      <div className="px-4 pb-3 pt-2.5">
        <div className="num text-[22px] font-bold leading-7" style={{ color: tone ?? "var(--ink)" }}>
          {value}
        </div>
        <div className="mt-1 text-[10.5px] uppercase tracking-widest" style={{ color: "var(--muted)" }}>
          {label}
        </div>
      </div>
    </div>
  );
}

export function GateList({ gates }: { gates: GateResult[] }) {
  return (
    <div className="mt-2 grid gap-1">
      {gates.map((g) => (
        <div key={g.gate} className="flex gap-2 text-[12.5px] leading-relaxed">
          <span className="font-bold" style={{ color: g.pass ? "var(--good)" : "var(--bad)" }}>
            {g.pass ? "✓" : "✕"}
          </span>
          <span style={{ color: "var(--muted)" }}>
            <b style={{ color: "var(--ink)", fontWeight: 600 }}>{g.gate}</b>
            {" — "}
            {g.detail}
          </span>
        </div>
      ))}
    </div>
  );
}

// Single-series sparkline: 2px line, faint area, emphasized endpoint, hover
// tooltip on the nearest point, min/max end labels (a single steady label when
// the series is flat, drawn at vertical center). No axes/grid — it lives
// inside a fleet card whose caption names the series; width tracks the card.
export function Sparkline({ points, label = "value", height = 56 }: { points: { ts: number; v: number }[]; label?: string; height?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const [width, setWidth] = useState(216);
  const ro = useRef<ResizeObserver | null>(null);
  // Callback ref — the wrapper only mounts once there is data, so observe on attach.
  const wrapRef = useCallback((el: HTMLDivElement | null) => {
    ro.current?.disconnect();
    ro.current = null;
    if (!el) return;
    const measure = () => setWidth(Math.max(120, Math.round(el.clientWidth)));
    ro.current = new ResizeObserver(measure);
    ro.current.observe(el);
    measure();
  }, []);
  const pad = 4;
  const geom = useMemo(() => {
    if (points.length < 2) return null;
    const vs = points.map((p) => p.v);
    const lo = Math.min(...vs);
    const hi = Math.max(...vs);
    const flat = hi === lo;
    const span = hi - lo || 1;
    const x = (i: number) => pad + (i / (points.length - 1)) * (width - pad * 2);
    // A flat (healthy) series sits at vertical center, not pinned to an edge.
    const y = (v: number) => (flat ? height / 2 : height - pad - ((v - lo) / span) * (height - pad * 2));
    const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
    const area = `${line} L${x(points.length - 1).toFixed(1)},${height - 1} L${x(0).toFixed(1)},${height - 1} Z`;
    return { x, y, line, area, lo, hi, flat };
  }, [points, width, height]);

  if (!geom) {
    return (
      <div className="flex items-center text-[11px]" style={{ color: "var(--muted)", height }}>
        not enough numeric history yet
      </div>
    );
  }
  const hp = hover != null ? points[hover] : null;
  const last = points[points.length - 1]!;
  return (
    <div className="flex items-stretch gap-2">
      <div ref={wrapRef} className="relative min-w-0 flex-1">
        <svg
          className="block"
          width={width}
          height={height}
          role="img"
          aria-label={
            geom.flat
              ? `${label} steady at ${last.v} over the last ${points.length} runs`
              : `${label} over the last ${points.length} runs, latest ${last.v}, min ${geom.lo}, max ${geom.hi}`
          }
          onMouseMove={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const i = Math.round(((e.clientX - rect.left - pad) / (width - pad * 2)) * (points.length - 1));
            setHover(Math.max(0, Math.min(points.length - 1, i)));
          }}
          onMouseLeave={() => setHover(null)}
        >
          <path d={geom.area} fill="var(--chart)" opacity="0.12" />
          <path d={geom.line} fill="none" stroke="var(--chart)" strokeWidth="2" strokeLinejoin="round" />
          <circle cx={geom.x(points.length - 1)} cy={geom.y(last.v)} r="3" fill="var(--chart)" />
          {hp && hover != null && (
            <circle cx={geom.x(hover)} cy={geom.y(hp.v)} r="4" fill="none" stroke="var(--ink)" strokeWidth="1.5" />
          )}
        </svg>
        {hp && (
          <div
            className="num pointer-events-none absolute -top-6 rounded border px-1.5 py-0.5 text-[10.5px]"
            style={{
              left: Math.min(width - 80, Math.max(0, geom.x(hover!) - 30)),
              background: "var(--panel-2)",
              borderColor: "var(--line)",
              color: "var(--ink)",
            }}
          >
            {hp.v} · {new Date(hp.ts).toLocaleTimeString()}
          </div>
        )}
      </div>
      <div
        aria-hidden
        className={`num flex flex-col ${geom.flat ? "justify-center" : "justify-between"} py-0.5 text-right text-[10px] leading-none`}
        style={{ color: "var(--muted)" }}
      >
        {geom.flat ? (
          <span title="steady across the window">{geom.hi}</span>
        ) : (
          <>
            <span title="max in window">{geom.hi}</span>
            <span title="min in window">{geom.lo}</span>
          </>
        )}
      </div>
    </div>
  );
}

export function ago(ts?: number): string {
  if (!ts) return "—";
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(ts).toLocaleString();
}
