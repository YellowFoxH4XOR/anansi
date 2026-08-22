// Console server: JSON API over the store + the React SPA (console-ui/dist)
// when it's been built, falling back to the original server-rendered views
// when it has not been built.
//
// Strictly a reader. The console holds no BRIGHTDATA_API_KEY and imports no
// platform client: the agent is the only process that talks to Bright Data,
// and the two meet on a shared data volume. Everything below is derived from
// what the agent wrote there.

import express from "express";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Store } from "../../packages/adapters/store/index.js";
import type { IncidentRecord } from "../../packages/core/types.js";
import { normalizeHtml } from "../../packages/core/diagnose/normalize.js";
import type { EvidencePack } from "../../packages/core/diagnose/evidence.js";
import { diffPage, fleetStrip, indexPage, layout, tracePage, type Page } from "./views.js";
import { stagesFor } from "./stages.js";
import { readFleet, readJobs, readLastPoll } from "./read.js";
import { failuresSince } from "./jobs.js";
import { securityHeaders } from "./security.js";

const store = new Store(process.env.ANANSI_DATA ?? "data");
const app = express();
app.disable("x-powered-by");
app.use(securityHeaders);

// ---------------------------------------------------------------- shared bits

const allJobs = () => readJobs(store);
const fleet = (jobs = allJobs()) => readFleet(store, jobs);

function incidentEvents(id: string): Record<string, unknown>[] {
  return store.auditLog().filter((e) => e.id === id);
}

/** store key → what Bright Data calls the scraper.
 *
 *  Every scraper name this console renders has to be one the operator can find
 *  in their own account. A store key is a contract's `scraper:` field — a string
 *  ANANSI invented, which exists nowhere on the platform and is indistinguishable
 *  on screen from one that does. */
function platformNames(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of fleet()) {
    if (entry.platformName) out[entry.name] = entry.platformName;
  }
  return out;
}


async function diffPayload(rec: IncidentRecord) {
  // One line per element, so the diff can point at the element that changed.
  //
  // This split on "><" only, which requires tags to be directly adjacent. Real
  // markup has whitespace between them, so a whole document collapsed to ~10
  // lines — the Lab's <main> came out as a single 1182-char line — and the diff
  // then highlighted the entire product section to report one renamed span.
  // \s* is the whole fix: the same page now renders as 57 lines with exactly one
  // of them differing. Text between tags deliberately does NOT split, so a value
  // stays on the line of the element holding it.
  const pretty = (html: string) =>
    normalizeHtml(html)
      .toString()
      .replace(/>\s*</g, ">\n<")
      .split("\n")
      .map((line) => line.trimEnd())
      .join("\n");
  const lastGood = rec.last_good_ref ? pretty(await store.snapshot(rec.last_good_ref)) : null;
  const current = rec.current_ref ? pretty(await store.snapshot(rec.current_ref)) : null;
  let removed: string[] = [];
  let added: string[] = [];
  let evidence: EvidencePack | null = null;
  if (rec.evidence_ref) {
    try {
      evidence = JSON.parse(await store.snapshot(rec.evidence_ref)) as EvidencePack;
      // Absent whenever the collector kept no baseline page; the stage view
      // falls back to value_locations, which is the actionable half anyway.
      removed = evidence.dom_diff?.removed.map((c) => c.path) ?? [];
      added = evidence.dom_diff?.added.map((c) => c.path) ?? [];
    } catch {
      /* evidence not yet written */
    }
  }
  const codeDiff = rec.heal_attempts[rec.heal_attempts.length - 1]?.diff_summary ?? "";
  return { lastGood, current, removed, added, codeDiff, evidence };
}

// ------------------------------------------------------------------- JSON API

// Which HEAL adapter the agent is running. Monitoring is read-only in every
// mode; this only says whether a fix would really be issued to Scraper Studio,
// so a fixture run can never be read as a live promotion.
const mode = process.env.ANANSI_MODE ?? process.env.ANANSI_ADAPTER ?? "real";

const DAY_MS = 24 * 60 * 60_000;

app.get("/api/state", (_req, res) => {
  const jobs = allJobs();
  res.json({
    fleet: fleet(jobs),
    // Renamed from creditsSpent: ANANSI causes no page loads, so the only
    // spend it can still initiate is a heal.
    healAttempts: store.creditsSpent(),
    incidents: store.incidents(),
    platformNames: platformNames(),
    mode,
    lastPoll: readLastPoll(store),
    failedRuns24h: failuresSince(jobs, Date.now() - DAY_MS),
  });
});

// Bright Data's job history as ANANSI observed it. Never a list of things
// ANANSI did — it triggers nothing.
app.get("/api/jobs", (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 100), 200);
  const collector = req.query.collector ? String(req.query.collector) : undefined;
  const verdict = req.query.verdict ? String(req.query.verdict) : undefined;
  let rows = readJobs(store, collector);
  if (verdict) rows = rows.filter((r) => r.verdict === verdict);
  res.json(rows.slice(0, limit));
});

app.get("/api/incident/:id/events", (req, res) => {
  res.json({ count: incidentEvents(req.params.id).length });
});

app.get("/api/incident/:id", async (req, res) => {
  const rec = store.incident(req.params.id);
  if (!rec) return res.status(404).json({ error: "no such incident" });
  const events = incidentEvents(rec.id);
  let evidence: EvidencePack | null = null;
  if (rec.evidence_ref) {
    try {
      evidence = JSON.parse(await store.snapshot(rec.evidence_ref)) as EvidencePack;
    } catch {
      /* not yet written */
    }
  }
  res.json({
    rec,
    stages: stagesFor(rec, events),
    eventCount: events.length,
    evidence,
    // The incident record keys by store key; the header must show a name the
    // operator can find in Studio.
    platformName: platformNames()[rec.scraper] ?? null,
  });
});

app.get("/api/incident/:id/diff", async (req, res) => {
  const rec = store.incident(req.params.id);
  if (!rec) return res.status(404).json({ error: "no such incident" });
  res.json(await diffPayload(rec));
});

app.get("/api/runs/:scraper", (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 60), 200);
  const runs = store.runs(req.params.scraper).slice(-limit);
  res.json(runs.map((r) => ({ ts: r.ts, url: r.url, fields: r.fields, healthy: r.healthy ?? null })));
});

// ------------------------------------------------- SPA (built) or SSR fallback

const dist = resolve("apps/console-ui/dist");
if (existsSync(resolve(dist, "index.html"))) {
  app.use(express.static(dist));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(resolve(dist, "index.html")));
  console.log("serving React console from console-ui/dist");
} else {
  const render = (res: express.Response, title: string, page: Page | string): void => {
    const p: Page = typeof page === "string" ? { body: page } : page;
    res.send(layout(title, p.body, p.script ?? "").replace("%%FLEET%%", fleetStrip(fleet())));
  };

  app.get("/", (_req, res) => {
    render(res, "Fleet", indexPage(store.incidents(), store.creditsSpent(), allJobs().slice(0, 20), platformNames()));
  });

  app.get("/incident/:id", async (req, res) => {
    const rec = store.incident(req.params.id);
    if (!rec) return res.status(404).send("no such incident");
    const events = incidentEvents(rec.id);
    const stages = stagesFor(rec, events);
    if (rec.evidence_ref) {
      try {
        const ev = await store.snapshot(rec.evidence_ref);
        const diag = stages.find((s) => s.name.startsWith("2"));
        if (diag) diag.detail = ev;
      } catch {
        /* evidence not yet written */
      }
    }
    render(res, `incident ${rec.id}`, tracePage(rec, stages, events.length, platformNames()[rec.scraper]));
  });

  app.get("/incident/:id/diff", async (req, res) => {
    const rec = store.incident(req.params.id);
    if (!rec) return res.status(404).send("no such incident");
    const d = await diffPayload(rec);
    if (!d.lastGood || !d.current) {
      return render(res, "diff", `<div class="panel">Snapshots for this incident are not on file (non-heal lane or diagnosis not reached).</div>`);
    }
    render(res, `diff ${rec.id}`, diffPage(rec, d.lastGood, d.current, d.removed, d.added, d.codeDiff));
  });
  console.log("console-ui/dist not built — serving legacy SSR console");
}

const port = Number(process.env.PORT ?? 4700);
const server = app.listen(port, () => {
  console.log(`ANANSI console: http://localhost:${port}`);
});

function shutdown(signal: NodeJS.Signals): void {
  console.log(`${signal}: draining ANANSI console`);
  server.close((error) => {
    if (error) {
      console.error(error);
      process.exitCode = 1;
    }
  });
}

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
