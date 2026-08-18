// Incident -> stage view-model. Pure: no store, no server, no I/O, so the
// console's claims about what happened can be tested directly.
//
// Every string here is derived from the incident record and its audit events.
// A hardcoded "2 failed heals" previously appeared under any quarantine -
// including quarantines where no heal ran and no credits were spent - which
// made the console misreport the very run it exists to explain.

import type { GateResult, IncidentRecord } from "../../packages/core/types.js";
import type { StageView } from "./views.js";

export function stagesFor(rec: IncidentRecord, events: Record<string, unknown>[]): StageView[] {
  const by = (ev: string) => events.filter((e) => e.event === ev);
  const last = (ev: string) => by(ev)[by(ev).length - 1];
  const open = rec.resolution == null;

  const stages: StageView[] = [];
  stages.push({
    name: "1 · SENSE",
    status: "done",
    meta: rec.signal.map((s) => `${s.signal}${s.field ? `:${s.field}` : ""} — ${s.detail}`).join("  ·  "),
  });

  if (rec.route !== "heal") {
    // The lane name and rationale come from the record, not a fixed string: an
    // incident can land in the infra, dead, config or retry lane and each was
    // previously rendered as "infra".
    const why: Record<string, string> = {
      infra: "access problem — healing refused (ADR-003: blocked is never healed)",
      dead: "URL is gone — not healed, not retried, no credits spent",
      config: "our scraper/output-schema is at fault — selectors cannot repair it",
      retry: "transient platform noise — retried on the next cadence tick",
    };
    stages.push({
      name: `TRIAGE — ${rec.route} lane`,
      status: rec.route === "retry" ? "done" : "fail",
      meta: why[rec.route] ?? `routed to the ${rec.route} lane`,
    });
    return stages;
  }

  const healStarts = by("heal_start");
  // Attempts are counted from what actually happened, never assumed.
  const attempts = Math.max(healStarts.length, rec.heal_attempts.length);
  // driveIncident quarantines before diagnosing when it has no last-good
  // snapshot to diff against, which is the normal state of a collector that has
  // not yet recorded one healthy sweep. That is a different outcome from a heal
  // that was tried and rejected, and must not be reported as one.
  const noBaseline = !open && attempts === 0 && rec.last_good_ref == null;
  stages.push({
    name: "2 · DIAGNOSE",
    status: rec.prompt ? "done" : open ? "live" : "fail",
    meta: rec.prompt
      ? `auto-generated heal prompt (${rec.prompt.length} chars): "${rec.prompt}"`
      : noBaseline
        ? "no last-good snapshot to diff against — diagnosis cannot run until one healthy sweep is on record"
        : open
          ? "building evidence pack…"
          : "diagnosis did not complete",
  });

  const v1 = last("verify_v1");
  stages.push({
    name: "3 · HEAL (brightdata scraper heal)",
    status: v1 ? "done" : attempts && open ? "live" : attempts ? "done" : "pending",
    meta: attempts
      ? `${attempts} attempt(s) · stops at the approval gate (never --auto-approve)`
      : noBaseline
        ? "not attempted — no diagnosis to heal from"
        : "waiting on diagnosis",
  });

  stages.push({
    name: "4 · VERIFY V1 — preview vs contract + goldens",
    status: v1 ? ((v1.pass as boolean) ? "done" : "fail") : "pending",
    meta: v1 ? `confidence ${(v1.confidence as number).toFixed(2)} (audit-only; promotion is a conjunction of gates)` : "awaiting preview rows",
    gates: (v1?.gates as GateResult[] | undefined) ?? undefined,
  });

  const approved = by("approved").length > 0;
  const v2 = last("verify_v2");
  const failedHeals = rec.heal_attempts.filter((a) => a.verdict?.pass === false).length;
  stages.push({
    name: "5 · PROMOTE (scraper approve)",
    status: approved ? "done" : rec.resolution === "quarantined" ? "fail" : open ? "pending" : "fail",
    meta: approved
      ? "gate passed — fix promoted to production"
      : rec.resolution === "quarantined"
        ? failedHeals > 0
          ? `${failedHeals} failed heal${failedHeals === 1 ? "" : "s"} — rejected pending fix, human paged`
          : `quarantined without a heal being attempted · ${rec.credits_spent} credit(s) spent — human paged`
        : open
          ? "awaiting the V1 gate"
          : "blocked on V1",
  });

  stages.push({
    name: "VERIFY V2 — full canary sweep post-approval",
    status: v2 ? ((v2.pass as boolean) ? "done" : "fail") : approved && open ? "live" : "pending",
    meta: v2
      ? (v2.pass as boolean)
        ? `sweep clean · incident closed · collector watching${(v2.repin_flags as unknown[])?.length ? " · ⚑ golden re-pin flagged for human" : ""}`
        : "REGRESSION — roll back via the dashboard Versions menu (no CLI rollback exists), collector quarantined"
      : "runs after promotion",
    gates: (v2?.gates as GateResult[] | undefined) ?? undefined,
  });

  return stages;
}
