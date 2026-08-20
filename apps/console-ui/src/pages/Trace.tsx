import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { usePoll, type EvidencePack, type HealAttempt, type IncidentPayload } from "../api";
import { Caption, Chip, GateList, Kpi, Panel, ResolutionPill, Skeleton, VerdictChip, resolutionMeta } from "../components";

const NODE: Record<string, { color: string; glyph: string }> = {
  done: { color: "var(--good)", glyph: "✓" },
  fail: { color: "var(--bad)", glyph: "✕" },
  live: { color: "var(--accent)", glyph: "●" },
  pending: { color: "var(--muted)", glyph: "○" },
};

// Connector below a stage node, colored by that stage's completion.
const CONNECTOR: Record<string, string> = {
  done: "var(--good)",
  fail: "var(--bad)",
  live: "var(--accent)",
  pending: "var(--line)",
};

// One card per heal attempt. There is exactly one verify per attempt now: the
// V1 pre-approval gate. The post-approval sweep that used to share a card is
// gone — Bright Data's next scheduled run is the verification (ADR-005).
function AttemptCard({ attempt, index }: { attempt: HealAttempt; index: number }) {
  return (
    <div className="rounded-lg border" style={{ borderColor: "var(--line)", background: "var(--panel-2)" }}>
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2" style={{ borderColor: "var(--line)" }}>
        <span className="text-[11px] font-bold uppercase tracking-widest">attempt {index + 1}</span>
        <span className="num ml-auto text-[11px]" style={{ color: "var(--muted)" }} title={new Date(attempt.ts).toLocaleString()}>
          {new Date(attempt.ts).toLocaleTimeString()}
        </span>
      </div>
      <div className="flex flex-col gap-3 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <Chip color="var(--accent)" border="var(--accent)" title="V1 — pre-approval verify on preview rows">
            v1
          </Chip>
          <span className="text-[11.5px]" style={{ color: "var(--muted)" }}>
            pre-approval verify on preview rows
          </span>
          <span className="ml-auto">
            {attempt.verdict ? <VerdictChip v={attempt.verdict} /> : <Chip title="verify has not run yet">… awaiting verdict</Chip>}
          </span>
        </div>
        <div>
          <Caption>auto-generated heal prompt · {attempt.prompt.length} chars</Caption>
          <blockquote
            className="mt-1.5 rounded-r-md border-l-2 py-1.5 pl-3 pr-2 text-[12px] leading-relaxed"
            style={{ borderColor: "var(--accent)", background: "var(--accent-soft)" }}
          >
            {attempt.prompt}
          </blockquote>
        </div>
        {attempt.diff_summary && (
          <div>
            <Caption>diff summary</Caption>
            <pre
              className="mt-1.5 max-h-48 overflow-auto rounded-md border p-2.5 text-[11.5px] leading-relaxed"
              style={{ borderColor: "var(--line)", background: "var(--code-bg)" }}
            >
              {attempt.diff_summary}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}

function PathList({ title, items, tone }: { title: string; items: { path: string; text?: string }[]; tone: "removed" | "added" }) {
  const bg = tone === "removed" ? "var(--bad-soft)" : "var(--good-soft)";
  const color = tone === "removed" ? "var(--bad)" : "var(--good)";
  const mark = tone === "removed" ? "−" : "+";
  return (
    <div className="min-w-0 overflow-hidden rounded-md border" style={{ borderColor: "var(--line)" }}>
      <div className="border-b px-2.5 py-1.5" style={{ borderColor: "var(--line)" }}>
        <Caption>
          {title} ({items.length})
        </Caption>
      </div>
      {items.length === 0 && (
        <div className="px-2.5 py-1.5 text-[11.5px]" style={{ color: "var(--muted)" }}>
          none
        </div>
      )}
      {items.map((c, i) => (
        <div key={i} className="flex gap-1.5 px-2.5 py-1 text-[11.5px] leading-relaxed" style={{ background: bg }}>
          <span aria-hidden className="font-bold" style={{ color }}>
            {mark}
          </span>
          <span className="min-w-0 break-all">
            {c.path}
            {c.text && <span style={{ color: "var(--muted)" }}> — “{c.text.length > 90 ? `${c.text.slice(0, 90)}…` : c.text}”</span>}
          </span>
        </div>
      ))}
    </div>
  );
}

function EvidenceView({ pack }: { pack: EvidencePack }) {
  const [raw, setRaw] = useState(false);
  return (
    <div className="mt-2 rounded-lg border" style={{ borderColor: "var(--line)", background: "var(--panel-2)" }}>
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2" style={{ borderColor: "var(--line)" }}>
        <Caption>evidence pack</Caption>
        <button onClick={() => setRaw((v) => !v)} className="link-dotted link-muted text-[11px]">
          {raw ? "structured view" : "raw JSON"}
        </button>
      </div>
      {raw ? (
        <pre className="max-h-80 overflow-auto rounded-b-lg p-3 text-[11px] leading-relaxed" style={{ background: "var(--code-bg)" }}>
          {JSON.stringify(pack, null, 2)}
        </pre>
      ) : (
        <div className="flex flex-col gap-3 p-3">
          <div>
            <Caption>failing fields</Caption>
            <div className="mt-1.5 flex flex-wrap gap-1">
              {pack.failing_fields.length === 0 && (
                <span className="text-[11.5px]" style={{ color: "var(--muted)" }}>
                  none
                </span>
              )}
              {pack.failing_fields.map((f) => (
                <Chip key={f} color="var(--bad)" border="var(--bad)" bg="var(--bad-soft)">
                  ✕ {f}
                </Chip>
              ))}
            </div>
          </div>
          {pack.dom_diff ? (
            <div className="grid gap-2 sm:grid-cols-2">
              <PathList title="dom nodes removed" items={pack.dom_diff.removed} tone="removed" />
              <PathList title="dom nodes added" items={pack.dom_diff.added} tone="added" />
            </div>
          ) : (
            <Caption>
              no baseline page to diff — this scraper collects no HTML, so Diagnose located the known-good values in the
              live page instead
            </Caption>
          )}
          {pack.value_locations.length > 0 && (
            <div>
              <Caption>value locations — where the pinned values went</Caption>
              <div className="mt-1.5 flex flex-col gap-1">
                {pack.value_locations.map((v) => (
                  <div key={v.field} className="text-[12px] leading-relaxed">
                    <b>{v.field}</b>
                    <span style={{ color: "var(--muted)" }}> · expected </span>
                    <span className="num">{String(v.expected)}</span>
                    <span style={{ color: "var(--muted)" }}> · found at </span>
                    {v.found_at.length === 0 ? (
                      <span style={{ color: "var(--muted)" }}>nowhere in the new DOM</span>
                    ) : (
                      v.found_at.map((f, i) => (
                        <span key={f.path}>
                          {i > 0 && <span style={{ color: "var(--muted)" }}>, </span>}
                          <code className="break-all rounded px-1 py-0.5 text-[11px]" style={{ background: "var(--code-bg)" }}>
                            {f.path}
                          </code>
                        </span>
                      ))
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
          {pack.prior_failures.length > 0 && (
            <div>
              <Caption>prior failures — fed to the next heal</Caption>
              <div className="mt-1.5 flex flex-col gap-1">
                {pack.prior_failures.map((p, i) => (
                  <div key={i} className="text-[11.5px] leading-relaxed" style={{ color: "var(--muted)" }}>
                    ✕ {p}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function Trace() {
  const { id } = useParams();
  const events = usePoll<{ count: number }>(`/api/incident/${id}/events`, 3000);
  const [data, setData] = useState<IncidentPayload | null>(null);

  useEffect(() => {
    fetch(`/api/incident/${id}`)
      .then((r) => r.json())
      .then(setData)
      .catch(() => {});
  }, [id, events?.count]); // refetch whenever the audit stream grows

  if (!data) {
    return <Skeleton lines={3} label="loading incident" />;
  }
  if (!data.rec) {
    // 404 body is {error} — e.g. a stale tab after the demo store was re-seeded.
    return (
      <Panel>
        <span style={{ color: "var(--muted)" }}>
          No such incident — it may have been re-seeded.{" "}
          <Link to="/" className="link-dotted" style={{ color: "var(--accent)" }}>
            ← back to fleet
          </Link>
        </span>
      </Panel>
    );
  }
  const { rec, stages, evidence } = data;
  const resColor = resolutionMeta(rec.resolution).color;

  return (
    <div className="fade-in flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-bold">
          incident <span style={{ color: "var(--muted)" }}>{rec.id}</span> · {rec.scraper}
        </h1>
        <Link
          to={`/incident/${rec.id}/diff`}
          className="btn-outline rounded-lg border px-3 py-1.5 text-[12.5px]"
          style={{ borderColor: "var(--accent)", color: "var(--accent)" }}
        >
          split diff →
        </Link>
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
        <Kpi label="route" value={rec.route} tone={rec.route === "heal" ? "var(--accent)" : undefined} />
        <div className="overflow-hidden rounded-xl border" style={{ borderColor: "var(--line)", background: "var(--panel)" }}>
          <div aria-hidden style={{ height: 2, background: resColor }} />
          <div className="px-4 pb-3 pt-2.5">
            <ResolutionPill resolution={rec.resolution} />
            <div className="mt-1.5 text-[10.5px] uppercase tracking-widest" style={{ color: "var(--muted)" }}>
              resolution
            </div>
          </div>
        </div>
        <Kpi
          label="heal attempts"
          value={rec.credits_spent}
          title="Heal attempts on this incident. A heal runs the scraper to produce preview rows, so it is the only thing ANANSI spends on — polling and archiving are free."
        />
        <Kpi label="wall" value={rec.wall_ms ? `${Math.round(rec.wall_ms / 1000)}s` : "running"} />
        <Kpi label="approved by" value={rec.approved_by ?? "—"} />
      </div>

      <Panel>
        {stages.map((s, i) => {
          const n = NODE[s.status]!;
          // Once an attempt card exists its blockquote is the canonical prompt
          // rendering — clamp the stage-2 meta (which quotes it verbatim).
          const clampMeta = s.name.startsWith("2") && rec.heal_attempts.length > 0;
          return (
            <div key={s.name} className="grid grid-cols-[1.75rem_1fr] gap-3">
              <div className="flex flex-col items-center">
                <span
                  className={`flex h-7 w-7 items-center justify-center rounded-full border-2 text-[13px] font-bold ${s.status === "live" ? "pulse" : ""}`}
                  style={{ borderColor: n.color, color: n.color, background: "var(--panel-2)" }}
                  aria-label={s.status}
                >
                  {n.glyph}
                </span>
                {i < stages.length - 1 && (
                  <span
                    aria-hidden
                    className="w-0.5 flex-1"
                    style={{ background: CONNECTOR[s.status], opacity: s.status === "pending" ? 1 : 0.55 }}
                  />
                )}
              </div>
              <div className="pb-6">
                <div className="text-[13px] font-bold tracking-[0.08em]">{s.name}</div>
                <div
                  className="mt-1 text-[12px] leading-relaxed"
                  style={{
                    color: "var(--muted)",
                    ...(clampMeta
                      ? { display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" as const, overflow: "hidden" }
                      : {}),
                  }}
                  title={clampMeta ? s.meta : undefined}
                >
                  {s.meta}
                </div>
                {s.gates && <GateList gates={s.gates} />}
                {s.name.startsWith("2") && evidence && <EvidenceView pack={evidence} />}
                {s.name.startsWith("3") && rec.heal_attempts.length > 0 && (
                  <div className="mt-2 flex flex-col gap-2">
                    {rec.heal_attempts.map((a, idx) => (
                      <AttemptCard key={`${a.ts}-${idx}`} attempt={a} index={idx} />
                    ))}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </Panel>
    </div>
  );
}
