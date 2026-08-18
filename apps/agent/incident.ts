// Drives one incident through Diagnose → Heal → Verify(V1) → Promote → Verify(V2).
// All decision logic lives in core/; this file sequences adapters and writes the
// audit trail. Key disciplines (architecture.md):
// - V1 fail → reject the pending fix BEFORE any re-heal (a dangling
//   awaiting_approval fix could be promoted by a stray manual approve).
// - Two failed heals → reject + quarantine + page human, stop spending.
// - V2 fail → rollback is dashboard-only (Versions menu): auto-detect, human clicks.

import { randomUUID } from "node:crypto";
import type { Contract, Incident, IncidentRecord, RunRecord } from "../../packages/core/types.js";
import { buildEvidence, type EvidencePack } from "../../packages/core/diagnose/evidence.js";
import { verifyV1, type PreviewRow } from "../../packages/core/verify/v1.js";
import { verifyV2 } from "../../packages/core/verify/v2.js";
import { previewRows, type BrightDataAdapter, type RawRow } from "../../packages/adapters/brightdata/types.js";
import type { LlmAdapter } from "../../packages/adapters/llm/index.js";
import { Store, type StoredRun } from "../../packages/adapters/store/index.js";

const MAX_HEAL_ATTEMPTS = 2;

export type IncidentDeps = {
  bd: BrightDataAdapter;
  llm: LlmAdapter;
  store: Store;
  collectorId: string;
  log?: (msg: string) => void;
};

export async function rawToRun(raw: RawRow, store: Store, ts: number): Promise<RunRecord> {
  const { _snapshot_html, url, error_code, ...fields } = raw;
  const snapshot_ref = _snapshot_html ? await store.saveSnapshot(_snapshot_html) : undefined;
  return { url: url ?? "unknown", fields, error_code, snapshot_ref, ts };
}

async function canarySweep(deps: IncidentDeps, contract: Contract): Promise<RunRecord[]> {
  const out: RunRecord[] = [];
  for (const c of contract.canaries) {
    const raw = await deps.bd.runSync(deps.collectorId, c.url);
    await deps.store.addCredits(1);
    out.push(await rawToRun(raw, deps.store, Date.now()));
  }
  return out;
}

export async function driveIncident(
  incident: Incident,
  contract: Contract,
  preIncidentSweep: RunRecord[],
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
    return finish(incident.route === "infra" ? "infra" : incident.route === "dead" ? "dead" : undefined);
  }

  // Diagnose inputs: last-good + current snapshot for the worst-hit canary.
  const failingFields = [...new Set(incident.signals.map((s) => s.field).filter((f): f is string => !!f))];
  const hitUrl =
    incident.signals.find((s) => s.url)?.url ?? incident.records.find((r) => r.snapshot_ref)?.url;
  const currentRec = incident.records.find((r) => r.url === hitUrl && r.snapshot_ref);
  const lastGoodRef = hitUrl ? store.lastGoodSnapshotRef(contract.scraper, hitUrl) : undefined;
  if (!currentRec?.snapshot_ref || !lastGoodRef) {
    log(`incident ${rec.id}: missing snapshots (current=${currentRec?.snapshot_ref}, lastGood=${lastGoodRef}) — quarantining`);
    await store.setCollectorState(contract.scraper, "quarantined");
    return finish("quarantined");
  }
  rec.last_good_ref = lastGoodRef;
  rec.current_ref = currentRec.snapshot_ref;
  const lastGoodHtml = await store.snapshot(lastGoodRef);
  const currentHtml = await store.snapshot(currentRec.snapshot_ref);
  const currentSnapshots: Record<string, string> = { [currentRec.url]: currentHtml };

  const priorFailures: string[] = [];
  for (let attempt = 1; attempt <= MAX_HEAL_ATTEMPTS; attempt++) {
    await store.setCollectorState(contract.scraper, "healing");
    const evidence: EvidencePack = buildEvidence(incident, contract, lastGoodHtml, currentHtml, priorFailures);
    const prompt = await llm.healPrompt(evidence);
    rec.prompt = prompt;
    rec.evidence_ref = await store.saveSnapshot(JSON.stringify(evidence, null, 2));
    log(`incident ${rec.id}: heal attempt ${attempt} — "${prompt.slice(0, 100)}…"`);
    await store.audit({ event: "heal_start", id: rec.id, attempt, prompt });

    const heal = await bd.heal(deps.collectorId, prompt, { url: hitUrl, timeoutSec: 1800 });
    if (heal.status !== "awaiting_approval") {
      priorFailures.push(`heal call returned status=${heal.status}`);
      await store.audit({ event: "heal_failed", id: rec.id, attempt, status: heal.status });
      continue;
    }

    // V1 · pre-approval gate on preview rows.
    const rows: PreviewRow[] = previewRows(heal).map((r) => {
      const { _snapshot_html, url, error_code, ...fields } = r;
      return { url, fields };
    });
    const v1 = verifyV1(contract, rows, currentSnapshots, failingFields);
    rec.heal_attempts.push({ prompt, diff_summary: heal.diff_summary ?? "", verdict: v1, phase: "v1", ts: Date.now() });
    await store.audit({ event: "verify_v1", id: rec.id, attempt, pass: v1.pass, confidence: v1.confidence, gates: v1.gates });

    if (!v1.pass) {
      // Mandatory reject before any re-heal.
      await bd.reject(deps.collectorId);
      await store.audit({ event: "reject", id: rec.id, attempt, reason: "v1_failed" });
      priorFailures.push(v1.gates.filter((g) => !g.pass).map((g) => `${g.gate}: ${g.detail}`).join("; "));
      log(`incident ${rec.id}: V1 failed (${v1.gates.filter((g) => !g.pass).map((g) => g.gate).join(", ")}) — rejected pending fix`);
      continue;
    }

    // Promote, then V2 on the full canary sweep before the incident closes.
    await bd.approve(deps.collectorId);
    await store.setCollectorState(contract.scraper, "verifying");
    await store.audit({ event: "approved", id: rec.id, attempt });
    const sweep = await canarySweep(deps, contract);
    const v2 = verifyV2(contract, sweep, preIncidentSweep, store.history(contract.scraper));
    rec.heal_attempts.push({ prompt, diff_summary: heal.diff_summary ?? "", verdict: v2, phase: "v2", ts: Date.now() });
    await store.audit({ event: "verify_v2", id: rec.id, pass: v2.pass, confidence: v2.confidence, gates: v2.gates, repin_flags: v2.repin_flags });

    if (v2.pass) {
      for (const run of sweep) {
        await store.appendRun({ ...run, scraper: contract.scraper, healthy: true });
      }
      if (v2.repin_flags.length) {
        log(`incident ${rec.id}: promoted value drifted from golden anchor — flagged for human re-pin: ${JSON.stringify(v2.repin_flags)}`);
      }
      await store.setCollectorState(contract.scraper, "watching");
      log(`incident ${rec.id}: promoted (confidence ${v2.confidence.toFixed(2)})`);
      return finish("promoted", "gate");
    }

    // V2 regression after approve: rollback is dashboard-only.
    await store.setCollectorState(contract.scraper, "quarantined");
    log(`incident ${rec.id}: V2 FAILED after approve — roll back via the Versions menu in the dashboard (no CLI rollback), collector quarantined`);
    return finish("rolled_back");
  }

  // Two failed heals: reject any pending fix already handled above; quarantine.
  await store.setCollectorState(contract.scraper, "quarantined");
  log(`incident ${rec.id}: ${MAX_HEAL_ATTEMPTS} heal attempts failed — QUARANTINED, human attention required`);
  return finish("quarantined");
}
