import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { DiffPayload } from "../api";
import { Chip, Panel, Skeleton } from "../components";

// Line-level LCS diff → aligned rows for the two panes.
type Row = { left?: string; right?: string; kind: "same" | "del" | "add"; ln?: number; rn?: number };

function lcsDiff(a: string[], b: string[]): Row[] {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const rows: Row[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ left: a[i], right: b[j], kind: "same" });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      rows.push({ left: a[i], kind: "del" });
      i++;
    } else {
      rows.push({ right: b[j], kind: "add" });
      j++;
    }
  }
  while (i < n) rows.push({ left: a[i++], kind: "del" });
  while (j < m) rows.push({ right: b[j++], kind: "add" });
  // Per-side line numbers (a side only counts rows where it has a line).
  let l = 0;
  let r = 0;
  for (const row of rows) {
    if (row.left != null) row.ln = ++l;
    if (row.right != null) row.rn = ++r;
  }
  return rows;
}

function Pane({
  title,
  count,
  countColor,
  countTitle,
  rows,
  side,
  scrollRef,
  onScroll,
}: {
  title: string;
  count: string;
  countColor: string;
  countTitle: string;
  rows: Row[];
  side: "left" | "right";
  scrollRef: React.RefObject<HTMLPreElement | null>;
  onScroll: () => void;
}) {
  const gutterCh = `${String(rows.length).length + 1}ch`;
  return (
    <Panel className="min-w-0 p-0">
      <div
        className="flex items-center justify-between gap-2 border-b px-4 py-2 text-[11px] uppercase tracking-widest"
        style={{ borderColor: "var(--line)", color: "var(--muted)" }}
      >
        <span>{title}</span>
        <span className="num font-bold normal-case tracking-normal" style={{ color: countColor }} title={countTitle}>
          {count}
        </span>
      </div>
      <pre ref={scrollRef} onScroll={onScroll} className="diff-pre max-h-[70vh] overflow-auto p-3 text-[11.5px] leading-relaxed">
        {rows.map((r, idx) => {
          const text = side === "left" ? r.left : r.right;
          const no = side === "left" ? r.ln : r.rn;
          const hot = side === "left" ? r.kind === "del" : r.kind === "add";
          const bg = hot ? (side === "left" ? "var(--bad-soft)" : "var(--good-soft)") : undefined;
          const marker = hot ? (side === "left" ? "- " : "+ ") : "  ";
          return (
            <span key={idx} className="block" style={{ background: bg, minHeight: "1.3em" }}>
              <span
                aria-hidden
                className="inline-block select-none pr-2 text-right"
                style={{ width: gutterCh, color: "var(--muted)", opacity: 0.65 }}
              >
                {no ?? ""}
              </span>
              {text != null ? marker + text : " "}
            </span>
          );
        })}
      </pre>
    </Panel>
  );
}

export default function Diff() {
  const { id } = useParams();
  const [data, setData] = useState<DiffPayload | null>(null);
  const leftRef = useRef<HTMLPreElement | null>(null);
  const rightRef = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    fetch(`/api/incident/${id}/diff`)
      .then((r) => r.json())
      .then(setData)
      .catch(() => {});
  }, [id]);

  const rows = useMemo(() => {
    if (!data?.lastGood || !data.current) return null;
    return lcsDiff(data.lastGood.split("\n"), data.current.split("\n"));
  }, [data]);

  const delCount = useMemo(() => rows?.filter((r) => r.kind === "del").length ?? 0, [rows]);
  const addCount = useMemo(() => rows?.filter((r) => r.kind === "add").length ?? 0, [rows]);
  const firstChange = useMemo(() => rows?.findIndex((r) => r.kind !== "same") ?? -1, [rows]);

  // Mirror scroll between the panes. Writing scrollTop fires the other pane's
  // scroll handler, so a driver lock (150ms, refreshed while scrolling) makes
  // that echo a no-op — no feedback loop, no jitter mid-scroll.
  const driver = useRef<{ side: "left" | "right"; until: number } | null>(null);
  const sync = (side: "left" | "right", src: HTMLPreElement | null, dst: HTMLPreElement | null) => {
    if (!src || !dst) return;
    const now = Date.now();
    if (driver.current && driver.current.side !== side && now < driver.current.until) return; // echo of a mirror write
    driver.current = { side, until: now + 150 };
    if (Math.abs(dst.scrollTop - src.scrollTop) > 1) dst.scrollTop = src.scrollTop;
    if (Math.abs(dst.scrollLeft - src.scrollLeft) > 1) dst.scrollLeft = src.scrollLeft;
  };

  const jumpToFirstChange = () => {
    if (firstChange < 0) return;
    for (const pre of [leftRef.current, rightRef.current]) {
      if (!pre) continue;
      const el = pre.children[firstChange] as HTMLElement | undefined;
      if (!el) continue;
      const top = el.getBoundingClientRect().top - pre.getBoundingClientRect().top + pre.scrollTop - 72;
      pre.scrollTo({ top: Math.max(0, top) }); // instant — safe under reduced motion
    }
  };

  if (!data) {
    return <Skeleton lines={3} label="loading diff" />;
  }

  return (
    <div className="fade-in flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-bold">
          incident <span style={{ color: "var(--muted)" }}>{id}</span> · split diff
        </h1>
        <Link
          to={`/incident/${id}`}
          className="btn-outline rounded-lg border px-3 py-1.5 text-[12.5px]"
          style={{ borderColor: "var(--accent)", color: "var(--accent)" }}
        >
          ← trace
        </Link>
      </div>

      {!rows ? (
        <Panel>
          <span style={{ color: "var(--muted)" }}>
            Snapshots for this incident are not on file (non-heal lane or diagnosis not reached).
          </span>
        </Panel>
      ) : (
        <>
          <Panel className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              {data.evidence ? (
                <span className="text-[12.5px]">
                  <b className="num">{data.removed.length}</b> nodes removed · <b className="num">{data.added.length}</b> added{" "}
                  <span style={{ color: "var(--muted)" }}>(normalized DOM)</span>
                </span>
              ) : (
                <span className="text-[12.5px]" style={{ color: "var(--muted)" }}>
                  evidence pack pending — node counts unavailable
                </span>
              )}
              {firstChange >= 0 && (
                <button
                  onClick={jumpToFirstChange}
                  className="btn-neutral ml-auto rounded-lg border px-3 py-1.5 text-[12px]"
                  style={{ borderColor: "var(--line)", color: "var(--ink)" }}
                >
                  ↓ jump to first change
                </button>
              )}
            </div>
            {(data.removed.length > 0 || data.added.length > 0) && (
              <div className="flex flex-wrap gap-1">
                {data.removed.map((p) => (
                  <Chip key={`-${p}`} color="var(--bad)" border="var(--bad)" bg="var(--bad-soft)" title={`removed: ${p}`}>
                    − {p}
                  </Chip>
                ))}
                {data.added.map((p) => (
                  <Chip key={`+${p}`} color="var(--good)" border="var(--good)" bg="var(--good-soft)" title={`added: ${p}`}>
                    + {p}
                  </Chip>
                ))}
              </div>
            )}
          </Panel>

          <div className="grid gap-4 lg:grid-cols-2">
            <Pane
              title="last-good DOM (normalized) — cause"
              count={`− ${delCount}`}
              countColor="var(--bad)"
              countTitle={`${delCount} deleted lines`}
              rows={rows}
              side="left"
              scrollRef={leftRef}
              onScroll={() => sync("left", leftRef.current, rightRef.current)}
            />
            <Pane
              title="current DOM (normalized)"
              count={`+ ${addCount}`}
              countColor="var(--good)"
              countTitle={`${addCount} added lines`}
              rows={rows}
              side="right"
              scrollRef={rightRef}
              onScroll={() => sync("right", rightRef.current, leftRef.current)}
            />
          </div>
          <Panel className="p-0">
            <div
              className="border-b px-4 py-2 text-[11px] uppercase tracking-widest"
              style={{ borderColor: "var(--line)", color: "var(--muted)" }}
            >
              Scraper Studio proposed fix — effect
            </div>
            <pre className="max-h-72 overflow-auto p-3 text-[12px] leading-relaxed">
              {data.codeDiff || "(diff summary not captured)"}
            </pre>
          </Panel>
        </>
      )}
    </div>
  );
}
