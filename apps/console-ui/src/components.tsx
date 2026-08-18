import { useCallback, useMemo, useRef, useState } from "react";
import type { CollectorState, GateResult, Verdict } from "./api";

export const STATE_META: Record<CollectorState, { color: string; glyph: string }> = {
  healthy: { color: "var(--good)", glyph: "●" },
  watching: { color: "var(--good)", glyph: "◉" },
  incident_open: { color: "var(--warn)", glyph: "▲" },
  healing: { color: "var(--accent)", glyph: "◔" },
  verifying: { color: "var(--accent)", glyph: "◑" },
  quarantined: { color: "var(--bad)", glyph: "✕" },
};

export function StatePill({ state }: { state: CollectorState }) {
  const m = STATE_META[state];
  const live = state === "healing" || state === "verifying";
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] tracking-wide"
      style={{ borderColor: m.color, color: m.color }}
    >
      <span className={live ? "pulse" : ""}>{m.glyph}</span>
      {state}
    </span>
  );
}

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

export function Kpi({ label, value, tone }: { label: string; value: string | number; tone?: string }) {
  return (
    <div className="overflow-hidden rounded-xl border" style={{ borderColor: "var(--line)", background: "var(--panel)" }}>
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
export function Sparkline({ points, height = 56 }: { points: { ts: number; v: number }[]; height?: number }) {
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
        no run history yet
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
              ? `price steady at ${last.v} over the last ${points.length} runs`
              : `price over the last ${points.length} runs, latest ${last.v}, min ${geom.lo}, max ${geom.hi}`
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
