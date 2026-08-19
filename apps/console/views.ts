// Console rendering: fleet strip + incident trace + split diff. Server-rendered,
// zero client framework; the trace page polls by reloading when the incident's
// audit event count changes.

import type { CollectorState, GateResult, IncidentRecord } from "../../packages/core/types.js";
import type { FleetEntry } from "./fleet.js";
import { isFailure, type JobRow } from "./jobs.js";

const esc = (s: string) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

const STATE_COLORS: Record<CollectorState, string> = {
  healthy: "#2e8b57",
  watching: "#7a9e3b",
  incident_open: "#c98a1b",
  healing: "#c2492f",
  verifying: "#7c5cd1",
  quarantined: "#8a1f1f",
};

export function layout(title: string, body: string, refreshScript = ""): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · ANANSI</title>
<style>
  :root { --bg:#12151c; --panel:#1a1f2a; --line:#2a3242; --ink:#e6e9f0; --muted:#8b94a7; --accent:#e0663f; --good:#4caf7d; --bad:#e05252; }
  * { box-sizing:border-box; margin:0; }
  body { font-family:'SF Mono',SFMono-Regular,ui-monospace,Menlo,monospace; background:var(--bg); color:var(--ink); font-size:14px; line-height:1.55; }
  a { color:inherit; }
  header { display:flex; align-items:center; gap:1.2rem; padding:.8rem 1.4rem; border-bottom:1px solid var(--line); background:var(--panel); position:sticky; top:0; flex-wrap:wrap; }
  header .logo { font-weight:700; letter-spacing:.14em; color:var(--accent); text-decoration:none; }
  .fleet { display:flex; gap:.7rem; flex-wrap:wrap; }
  .chip { display:flex; gap:.5rem; align-items:center; border:1px solid var(--line); border-radius:99px; padding:.2rem .8rem; font-size:.8rem; color:var(--muted); }
  .dot { width:.55rem; height:.55rem; border-radius:99px; display:inline-block; }
  main { max-width:1200px; margin:0 auto; padding:1.6rem 1.4rem; }
  h1 { font-size:1.15rem; margin-bottom:1rem; }
  h1 .id { color:var(--muted); }
  .panel { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:1rem 1.2rem; margin-bottom:1rem; }
  table.inc { width:100%; border-collapse:collapse; }
  table.inc th, table.inc td { text-align:left; padding:.45rem .6rem; border-bottom:1px solid var(--line); font-size:.85rem; }
  table.inc th { color:var(--muted); font-weight:400; }
  .pill { border-radius:99px; padding:.1rem .6rem; font-size:.75rem; }
  .stage { display:grid; grid-template-columns:1.6rem 1fr; gap:.7rem; }
  .stage .rail { display:flex; flex-direction:column; align-items:center; }
  .stage .node { width:1rem; height:1rem; border-radius:99px; border:2px solid var(--line); background:var(--bg); z-index:1; }
  .stage .node.done { background:var(--good); border-color:var(--good); }
  .stage .node.fail { background:var(--bad); border-color:var(--bad); }
  .stage .node.live { background:var(--accent); border-color:var(--accent); animation:pulse 1.2s infinite; }
  @keyframes pulse { 50% { opacity:.4; } }
  .stage .bar { flex:1; width:2px; background:var(--line); }
  .stage .body { padding-bottom:1.2rem; }
  .stage .name { font-weight:700; letter-spacing:.06em; font-size:.8rem; }
  .stage .meta { color:var(--muted); font-size:.78rem; margin:.15rem 0 .4rem; }
  details { margin:.3rem 0; }
  summary { cursor:pointer; color:var(--muted); font-size:.8rem; }
  pre { background:#10131a; border:1px solid var(--line); border-radius:8px; padding:.7rem .9rem; overflow-x:auto; font-size:.78rem; margin:.4rem 0; white-space:pre-wrap; word-break:break-word; }
  .gates { display:grid; gap:.25rem; margin:.3rem 0; }
  .gate { display:flex; gap:.5rem; font-size:.8rem; }
  .gate .ok { color:var(--good); } .gate .no { color:var(--bad); }
  .split { display:grid; grid-template-columns:1fr 1fr; gap:1rem; }
  .split h2 { font-size:.85rem; color:var(--muted); margin-bottom:.4rem; }
  .split pre { max-height:70vh; overflow:auto; }
  .hl-rm { background:rgba(224,82,82,.18); display:block; }
  .hl-add { background:rgba(76,175,125,.2); display:block; }
  .kpis { display:flex; gap:1.6rem; flex-wrap:wrap; color:var(--muted); font-size:.82rem; margin-bottom:1rem; }
  .kpis b { color:var(--ink); font-size:1rem; }
  @media (max-width: 860px) { .split { grid-template-columns:1fr; } }
</style>
</head>
<body>
<header>
  <a class="logo" href="/">ANANSI</a>
  <span style="color:var(--muted);font-size:.8rem;">an immune system for your scraper fleet</span>
  %%FLEET%%
</header>
<main>
${body}
</main>
${refreshScript}
</body>
</html>`;
}

export function fleetStrip(fleet: FleetEntry[]): string {
  const chips = fleet
    .map((f) => {
      // The platform id is the identity; a store key equal to it means no
      // contract names this collector, so it is monitored for platform
      // failures only.
      const depth = f.contract === "none" ? " · platform only" : f.contract === "pinned" ? " · contract" : "";
      // What Bright Data calls it, not what a contract called it.
      const label = f.platformName ?? f.name;
      const run = f.lastRunAt ? ` · ran ${new Date(f.lastRunAt).toLocaleTimeString()}` : "";
      // A run that never happened leaves no job and no error, so the strip is
      // the only place it can surface at all.
      const overdue = f.stale ? " · OVERDUE" : "";
      return `<span class="chip" title="${esc(f.collectorId ?? f.name)}"><span class="dot" style="background:${STATE_COLORS[f.state]}"></span>${esc(label)} · ${f.state}${depth}${run}${overdue}</span>`;
    })
    .join("");
  return `<span class="fleet">${chips}</span>`;
}

const VERDICT_COLOR: Record<string, string> = {
  ok: "var(--good)",
  partial: "var(--bad)",
  failed: "var(--bad)",
  unknown: "var(--muted)",
  seeded: "var(--muted)",
  in_flight: "var(--accent)",
  deferred: "var(--muted)",
  abandoned: "var(--muted)",
};

function runTable(jobs: JobRow[]): string {
  const rows = jobs
    .map(
      (j) => `<tr>
  <td><span class="pill" style="border:1px solid ${VERDICT_COLOR[j.verdict] ?? "var(--muted)"};color:${VERDICT_COLOR[j.verdict] ?? "var(--muted)"}">${j.verdict}</span></td>
  <td>${esc(j.job_id)}</td>
  <td>${esc(j.collector)}</td>
  <td>${j.trigger}</td>
  <td>${j.rows}</td>
  <td>${j.error_rows}</td>
  <td>${new Date(j.finished ?? j.seen).toLocaleString()}</td>
</tr>`,
    )
    .join("\n");
  return `<div class="panel">
<div style="color:var(--muted);font-size:.8rem;margin-bottom:.5rem">Runs Bright Data performed on its own schedule, as observed by ANANSI — it never triggers a collection.</div>
<table class="inc">
<tr><th>verdict</th><th>job</th><th>collector</th><th>trigger</th><th>rows</th><th>row errors</th><th>run finished</th></tr>
${rows || `<tr><td colspan="7" style="color:var(--muted)">No runs observed yet — either no collector has run inside the platform's retention window, or the agent has not completed a poll.</td></tr>`}
</table>
</div>`;
}

export function indexPage(incidents: IncidentRecord[], healAttempts: number, jobs: JobRow[] = []): string {
  const rows = incidents
    .slice()
    .reverse()
    .map((r) => {
      const res = r.resolution ?? "open";
      const color = res === "promoted" ? "var(--good)" : res === "open" ? "var(--accent)" : "var(--bad)";
      return `<tr>
  <td><a href="/incident/${r.id}">${r.id}</a></td>
  <td>${esc(r.scraper)}</td>
  <td>${r.signal.map((s) => s.signal).filter((v, i, a) => a.indexOf(v) === i).join(", ")}</td>
  <td>${r.route}</td>
  <td><span class="pill" style="border:1px solid ${color};color:${color}">${res}</span></td>
  <td>${r.credits_spent}</td>
  <td>${r.wall_ms ? `${Math.round(r.wall_ms / 1000)}s` : "—"}</td>
  <td>${new Date(r.opened_at).toLocaleString()}</td>
</tr>`;
    })
    .join("\n");
  return `<div class="kpis">
  <span>incidents <b>${incidents.length}</b></span>
  <span>promoted by gate <b>${incidents.filter((r) => r.resolution === "promoted").length}</b></span>
  <span>quarantined <b>${incidents.filter((r) => r.resolution === "quarantined").length}</b></span>
  <span title="A heal is the only thing ANANSI can spend on: polling and archiving are free.">heal attempts <b>${healAttempts}</b></span>
  <span title="Runs that failed or partially failed in the last 24h.">failed runs · 24h <b>${jobs.filter((j) => isFailure(j.verdict) && (j.finished ?? j.seen) >= Date.now() - 86_400_000).length}</b></span>
</div>
<div class="panel">
<table class="inc">
<tr><th>id</th><th>scraper</th><th>signals</th><th>route</th><th>resolution</th><th>heals</th><th>wall</th><th>opened</th></tr>
${rows || `<tr><td colspan="8" style="color:var(--muted)">No incidents yet — every run Bright Data has performed so far came back clean.</td></tr>`}
</table>
</div>
${runTable(jobs)}`;
}

type StageView = {
  name: string;
  status: "done" | "fail" | "live" | "pending";
  meta: string;
  detail?: string;
  gates?: GateResult[];
};

function gateList(gates: GateResult[]): string {
  return `<div class="gates">${gates
    .map(
      (g) =>
        `<div class="gate"><span class="${g.pass ? "ok" : "no"}">${g.pass ? "✓" : "✗"}</span><span><b>${esc(g.gate)}</b> — ${esc(g.detail)}</span></div>`,
    )
    .join("")}</div>`;
}

export type Page = { body: string; script?: string };

export function tracePage(rec: IncidentRecord, stages: StageView[], eventCount: number): Page {
  const nodes = stages
    .map(
      (s, i) => `<div class="stage">
  <div class="rail"><div class="node ${s.status === "pending" ? "" : s.status}"></div>${i < stages.length - 1 ? '<div class="bar"></div>' : ""}</div>
  <div class="body">
    <div class="name">${esc(s.name)}</div>
    <div class="meta">${esc(s.meta)}</div>
    ${s.gates ? gateList(s.gates) : ""}
    ${s.detail ? `<details><summary>evidence</summary><pre>${esc(s.detail)}</pre></details>` : ""}
  </div>
</div>`,
    )
    .join("\n");

  const poll = `<script>
const N = ${eventCount};
setInterval(async () => {
  try {
    const r = await fetch('/api/incident/${rec.id}/events');
    const j = await r.json();
    if (j.count !== N) location.reload();
  } catch {}
}, 3000);
</script>`;

  return {
    body: `<h1>incident <span class="id">${rec.id}</span> · ${esc(rec.scraper)} <a style="float:right;font-size:.8rem;color:var(--accent)" href="/incident/${rec.id}/diff">split diff →</a></h1>
<div class="kpis">
  <span>route <b>${rec.route}</b></span>
  <span>resolution <b>${rec.resolution ?? "open"}</b></span>
  <span title="Heal attempts — the only spend ANANSI initiates. Polling and archiving are free.">heals <b>${rec.credits_spent}</b></span>
  <span>wall <b>${rec.wall_ms ? `${Math.round(rec.wall_ms / 1000)}s` : "running"}</b></span>
  <span>approved by <b>${rec.approved_by ?? "—"}</b></span>
</div>
<div class="panel">${nodes}</div>`,
    script: poll,
  };
}

export function diffPage(
  rec: IncidentRecord,
  lastGood: string,
  current: string,
  removedPaths: string[],
  addedPaths: string[],
  codeDiff: string,
): Page {
  const mark = (html: string, needles: string[], cls: string): string => {
    const lines = esc(html).split("\n");
    const keys = needles
      .map((p) => p.split(" > ").pop() ?? "")
      .map((seg) => seg.replace(/^[a-z0-9]+/i, "").split(/[.#[]/).filter(Boolean)[0])
      .filter((k): k is string => !!k && k.length > 2);
    return lines
      .map((l) => (keys.some((k) => l.includes(k)) ? `<span class="${cls}">${l}</span>` : l))
      .join("\n");
  };
  return {
    body: `<h1>incident <span class="id">${rec.id}</span> · split diff <a style="float:right;font-size:.8rem;color:var(--accent)" href="/incident/${rec.id}">← trace</a></h1>
<div class="split">
  <div class="panel"><h2>last-good DOM (normalized)</h2><pre>${mark(lastGood, removedPaths, "hl-rm")}</pre></div>
  <div class="panel"><h2>current DOM (normalized) — cause</h2><pre>${mark(current, addedPaths, "hl-add")}</pre></div>
</div>
<div class="panel"><h2 style="color:var(--muted);font-size:.85rem;margin-bottom:.4rem;">Scraper Studio proposed fix — effect</h2><pre>${esc(codeDiff || "(diff summary not captured)")}</pre></div>`,
  };
}

export type { StageView };
