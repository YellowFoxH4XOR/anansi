// Drives one incident through Diagnose → Heal → Verify(V1) → Promote.
// All decision logic lives in core/; this file sequences adapters and writes the
// audit trail. Key disciplines (architecture.md):
// - V1 fail → reject the pending fix BEFORE any re-heal (a dangling
//   awaiting_approval fix could be promoted by a stray manual approve).
// - Two failed heals → reject + quarantine + page human, stop spending.
//
// There is no post-approval verification pass here any more. Bright Data's next
// scheduled run IS the verification: the monitor sees it, and a promoted fix
// that breaks the next real run quarantines the collector without a second heal.
// That is stronger evidence than a synthetic canary sweep ever produced, and it
// costs nothing — which is the whole reason the sweep could be deleted.

import { randomUUID } from "node:crypto";
import type { Contract, Incident, IncidentRecord, RunRecord } from "../../packages/core/types.js";
import { buildEvidence, type EvidencePack, type KnownGood } from "../../packages/core/diagnose/evidence.js";
import { verifyV1, type PreviewRow } from "../../packages/core/verify/v1.js";
import { previewRows, splitRow, type BrightDataAdapter, type OutputSchema, type RawRow } from "../../packages/adapters/brightdata/types.js";
import type { LlmAdapter } from "../../packages/adapters/llm/index.js";
import { Store } from "../../packages/adapters/store/index.js";

const MAX_HEAL_ATTEMPTS = 2;

/** Page loads are Bright Data's spend now, not ours; the balance still matters
 *  because a heal performs a run on the platform's dime. */
const BUDGET_FLOOR = 2_000;

/** A collector whose target is permanently broken must not heal on every
 *  scheduled run forever. Rolling 24h, reconstructed from the audit log. */
const HEALS_PER_COLLECTOR_PER_DAY = 3;
const DAY_MS = 24 * 60 * 60_000;

/** The heal seam. Excluding any run/trigger method from the type is what makes
 *  "ANANSI never starts a collection" a compile error rather than a promise. */
export type HealAdapter = Pick<BrightDataAdapter, "heal" | "approve" | "reject" | "budgetBalance">;

export type IncidentDeps = {
  bd: HealAdapter;
  llm: LlmAdapter;
  store: Store;
  collectorId: string;
  /** Set for a collector with no contract. V1 there reduces to "preview is
   *  non-empty" plus the hardcode detector, because there are no fields,
   *  goldens or invariants to gate against — and a vacuous gate is not a gate,
   *  so the fix waits for a human instead of auto-approving. */
  requiresHumanApproval?: boolean;
  /** Known-good rows the caller recovered when the store held none — see
   *  Monitor.knownGoodFor(). Merged over the store's own, which is empty in
   *  exactly the case this exists for. */
  knownGood?: KnownGood;
  log?: (msg: string) => void;
};

/** Dataset rows carry no HTML, so the snapshot normally comes from the free
 *  self-fetch archive rather than the row itself. */
export async function rawToRun(
  raw: RawRow,
  store: Store,
  ts: number,
  snapshotHtml?: string,
  schema?: OutputSchema,
): Promise<RunRecord> {
  const split = splitRow(raw, schema);
  const html = snapshotHtml ?? split.snapshotHtml;
  const snapshot_ref = html ? await store.saveSnapshot(html) : undefined;
  return { url: split.url ?? "unknown", fields: split.fields, error_code: split.error_code, snapshot_ref, ts };
}

export async function driveIncident(
  incident: Incident,
  contract: Contract,
  deps: IncidentDeps,
): Promise<IncidentRecord> {
  const { store, bd, llm } = deps;
  const log = deps.log ?? (() => {});
  const startedAt = Date.now();
  const creditsBefore = store.creditsSpent();
  const rec: IncidentRecord = {
    id: randomUUID().slice(0, 8),
    scraper: contract.scraper,
    opened_at: startedAt,
    signal: incident.signals,
    route: incident.route,
    heal_attempts: [],
    credits_spent: 0,
  };
  await store.setCollectorState(contract.scraper, "incident_open");
  await store.putIncident(rec);
  await store.audit({ event: "incident_open", id: rec.id, scraper: contract.scraper, route: incident.route, signals: incident.signals });

  const finish = async (resolution: IncidentRecord["resolution"], approvedBy?: "gate" | "human") => {
    rec.resolution = resolution;
    rec.closed_at = Date.now();
    rec.wall_ms = rec.closed_at - startedAt;
    rec.credits_spent = store.creditsSpent() - creditsBefore;
    if (approvedBy) rec.approved_by = approvedBy;
    await store.putIncident(rec);
    await store.audit({ event: "incident_closed", id: rec.id, resolution, wall_ms: rec.wall_ms, credits: rec.credits_spent });
    return rec;
  };

  // Non-heal lanes (ADR-003: blocked is never healed).
  if (incident.route !== "heal") {
    const state = incident.route === "retry" ? "healthy" : "quarantined";
    await store.setCollectorState(contract.scraper, state);
    log(`incident ${rec.id}: routed to ${incident.route} lane — not healing`);
    return finish(incident.route === "infra" ? "infra" : incident.route === "dead" ? "dead" : "observed");
  }

  // Diagnose inputs: last-good + current snapshot for the worst-hit URL. Both
  // come from the archive, which captures pages the scraper itself never did.
  const failingFields = [...new Set(incident.signals.map((s) => s.field).filter((f): f is string => !!f))];

  // Every URL worth diffing, best first: one a signal actually named, then any
  // page the archive captured. Picking the first named URL and giving up when it
  // had no baseline discarded a perfectly diffable page sitting next to it.
  const candidates = [
    ...incident.signals.flatMap((s) => (s.url ? [s.url] : [])),
    ...incident.records.flatMap((r) => (r.snapshot_ref ? [r.url] : [])),
  ];
  const scored = candidates
    .map((url) => ({
      url,
      current: incident.records.find((r) => r.url === url && r.snapshot_ref)?.snapshot_ref,
      lastGood: store.lastGoodSnapshotRef(contract.scraper, url),
    }))
    .filter((c) => c.current);
  // A baseline is a bonus, so prefer a page that has one — but never require it.
  const diffable = scored.find((c) => c.lastGood) ?? scored[0];

  if (!diffable?.current) {
    // The one thing Diagnose genuinely cannot work without is the page as it is
    // NOW. Everything else degrades. This used to also demand an archived
    // last-good and quarantine without one, which scoped healing to collectors
    // that happen to collect HTML — a minority, since Studio's tag_html is
    // opt-in — and stalled this one permanently, because a baseline is archived
    // only by a clean run and no run has been clean since the mutation landed.
    log(`incident ${rec.id}: no current capture of any affected page — nothing to diagnose from. Recorded; still watching.`);
    await store.setCollectorState(contract.scraper, "healthy");
    return finish("undiagnosable");
  }
  const hitUrl = diffable.url;
  if (diffable.lastGood) rec.last_good_ref = diffable.lastGood;
  rec.current_ref = diffable.current;
  const lastGoodHtml = diffable.lastGood ? await store.snapshot(diffable.lastGood) : undefined;
  const currentHtml = await store.snapshot(diffable.current);
  const currentSnapshots: Record<string, string> = { [hitUrl]: currentHtml };

  // What this scraper itself last emitted for these pages. Present for every
  // collector, contract or not, HTML or not — and the source of the one line the
  // healer can actually act on: "the correct price (49.99) renders at X now".
  const knownGood = { ...store.lastGoodFields(contract.scraper), ...(deps.knownGood ?? {}) };
  if (!lastGoodHtml) {
    const n = Object.keys(knownGood).length;
    log(`incident ${rec.id}: no baseline page for ${hitUrl} — diagnosing from ${n} known-good row(s) located in the live page instead`);
  }

  const priorFailures: string[] = [];
  for (let attempt = 1; attempt <= MAX_HEAL_ATTEMPTS; attempt++) {
    const recentHeals = store.healAttemptsSince(contract.scraper, Date.now() - DAY_MS);
    if (recentHeals >= HEALS_PER_COLLECTOR_PER_DAY) {
      await store.setCollectorState(contract.scraper, "quarantined");
      log(`incident ${rec.id}: ${recentHeals} heals in the last 24h for ${contract.scraper} — cap reached, quarantining instead of healing`);
      return finish("quarantined");
    }
    const balance = await bd.budgetBalance();
    if (balance != null && balance < BUDGET_FLOOR) {
      await store.setCollectorState(contract.scraper, "quarantined");
      log(`incident ${rec.id}: budget balance ${balance} below floor ${BUDGET_FLOOR} — refusing to heal`);
      return finish("quarantined");
    }

    await store.setCollectorState(contract.scraper, "healing");
    const evidence: EvidencePack = buildEvidence(incident, contract, lastGoodHtml, currentHtml, priorFailures, knownGood);
    const prompt = await llm.healPrompt(evidence);
    rec.prompt = prompt;
    rec.evidence_ref = await store.saveSnapshot(JSON.stringify(evidence, null, 2));
    log(`incident ${rec.id}: heal attempt ${attempt} — "${prompt.slice(0, 100)}…"`);
    // scraper is on the event so the daily per-collector heal budget can be
    // rebuilt from the audit log after a restart.
    await store.audit({ event: "heal_start", id: rec.id, scraper: contract.scraper, attempt, prompt });
    // A heal is the only spend ANANSI still initiates, so it is the only thing
    // worth counting.
    await store.addCredits(1);

    const heal = await bd.heal(deps.collectorId, prompt, { url: hitUrl, timeoutSec: 1800 });
    if (heal.status !== "awaiting_approval") {
      priorFailures.push(`heal call returned status=${heal.status}`);
      await store.audit({ event: "heal_failed", id: rec.id, attempt, status: heal.status });
      continue;
    }

    // V1 · pre-approval gate on preview rows.
    const rows: PreviewRow[] = previewRows(heal).map((r) => {
      const { url, fields } = splitRow(r);
      return { url, fields };
    });
    const v1 = verifyV1(contract, rows, currentSnapshots, failingFields, knownGood);
    rec.heal_attempts.push({
      prompt,
      diff_summary: heal.diff_summary ?? "",
      ...(heal.view_url ? { view_url: heal.view_url } : {}),
      verdict: v1,
      ts: Date.now(),
    });
    await store.audit({ event: "verify_v1", id: rec.id, attempt, pass: v1.pass, confidence: v1.confidence, gates: v1.gates });

    if (!v1.pass) {
      // Mandatory reject before any re-heal.
      await bd.reject(deps.collectorId);
      await store.audit({ event: "reject", id: rec.id, attempt, reason: "v1_failed" });
      priorFailures.push(v1.gates.filter((g) => !g.pass).map((g) => `${g.gate}: ${g.detail}`).join("; "));
      log(`incident ${rec.id}: V1 failed (${v1.gates.filter((g) => !g.pass).map((g) => g.gate).join(", ")}) — rejected pending fix`);
      continue;
    }

    if (deps.requiresHumanApproval) {
      // Left pending on the platform on purpose. The incident stays open, which
      // also keeps the monitor from dispatching further jobs for this collector
      // until a human has acted.
      await store.setCollectorState(contract.scraper, "incident_open");
      await store.audit({ event: "awaiting_human_approval", id: rec.id, attempt, reason: "no contract pinned — V1 cannot gate" });
      rec.credits_spent = store.creditsSpent() - creditsBefore;
      await store.putIncident(rec);
      log(`incident ${rec.id}: V1 passed but this collector has no contract — fix left awaiting_approval for a human`);
      return rec;
    }

    await bd.approve(deps.collectorId);
    await store.audit({ event: "approved", id: rec.id, attempt });
    // watching = approved, awaiting Bright Data's next scheduled run as the
    // regression check. The monitor promotes or quarantines on what it sees.
    await store.setCollectorState(contract.scraper, "watching");
    log(`incident ${rec.id}: promoted (V1 confidence ${v1.confidence.toFixed(2)}) — next scheduled run verifies it`);
    return finish("promoted", "gate");
  }

  // Two failed heals: any pending fix was already rejected above; quarantine.
  await store.setCollectorState(contract.scraper, "quarantined");
  log(`incident ${rec.id}: ${MAX_HEAL_ATTEMPTS} heal attempts failed — QUARANTINED, human attention required`);
  return finish("quarantined");
}
