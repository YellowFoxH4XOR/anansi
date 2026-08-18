// Console server: JSON API over the store + the React SPA (console-ui/dist)
// when it's been built, falling back to the original server-rendered views
// when it hasn't — so the demo path never depends on a frontend build.

import express from "express";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Store } from "../../packages/adapters/store/index.js";
import type { CollectorState, IncidentRecord } from "../../packages/core/types.js";
import { normalizeHtml } from "../../packages/core/diagnose/normalize.js";
import type { EvidencePack } from "../../packages/core/diagnose/evidence.js";
import { diffPage, fleetStrip, indexPage, layout, tracePage, type Page } from "./views.js";
import { stagesFor } from "./stages.js";

const store = new Store(process.env.ANANSI_DATA ?? "data");
await store.init();
const app = express();

// ---------------------------------------------------------------- shared bits

function fleet(): { name: string; state: CollectorState; lastChecked?: number }[] {
  return Object.entries(store.collectors()).map(([name, state]) => {
    const runs = store.runs(name);
    return { name, state, lastChecked: runs[runs.length - 1]?.ts };
  });
}

function incidentEvents(id: string): Record<string, unknown>[] {
  return store.auditLog().filter((e) => e.id === id);
}


async function diffPayload(rec: IncidentRecord) {
  const pretty = (html: string) => normalizeHtml(html).toString().replaceAll("><", ">\n<");
  const lastGood = rec.last_good_ref ? pretty(await store.snapshot(rec.last_good_ref)) : null;
  const current = rec.current_ref ? pretty(await store.snapshot(rec.current_ref)) : null;
  let removed: string[] = [];
  let added: string[] = [];
  let evidence: EvidencePack | null = null;
  if (rec.evidence_ref) {
    try {
      evidence = JSON.parse(await store.snapshot(rec.evidence_ref)) as EvidencePack;
      removed = evidence.dom_diff.removed.map((c) => c.path);
      added = evidence.dom_diff.added.map((c) => c.path);
    } catch {
      /* evidence not yet written */
    }
  }
  const codeDiff = rec.heal_attempts[rec.heal_attempts.length - 1]?.diff_summary ?? "";
  return { lastGood, current, removed, added, codeDiff, evidence };
}

// ------------------------------------------------------------------- JSON API

// Which adapter the agent is running. Surfaced so a rehearsal run (simulated
// heals, no credits) can never be read as a live platform run — the header
// badge and the SIMULATED stamp on every diff_summary say so together.
const mode = process.env.ANANSI_MODE ?? process.env.ANANSI_ADAPTER ?? "real";

app.get("/api/state", (_req, res) => {
  res.json({ fleet: fleet(), creditsSpent: store.creditsSpent(), incidents: store.incidents(), mode });
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
  res.json({ rec, stages: stagesFor(rec, events), eventCount: events.length, evidence });
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
    render(res, "Fleet", indexPage(store.incidents(), store.creditsSpent()));
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
    render(res, `incident ${rec.id}`, tracePage(rec, stages, events.length));
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
app.listen(port, () => {
  console.log(`ANANSI console: http://localhost:${port}`);
});
