// Incident -> stage view-model. Pure: no store, no server, no I/O, so the
// console's claims about what happened can be tested directly.
//
// Every string here is derived from the incident record and its audit events.
// A hardcoded "2 failed heals" previously appeared under any quarantine -
// including quarantines where no heal ran and nothing was spent - which
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
      dead: "URL is gone — not healed, not retried, no heal spend",
      config: "our scraper/output-schema is at fault — selectors cannot repair it",
      retry: "transient platform noise — Bright Data's next scheduled run is the retry",
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
  // "undiagnosable" now means the one thing Diagnose truly cannot work without:
  // no capture of the affected page as it is NOW. A missing last-good is no
  // longer part of it — most collectors keep no HTML and so can never have one,
  // and Diagnose locates known-good values in the live page instead. Either way
  // this is a different outcome from a heal that was tried and rejected, and
  // must not be reported as one.
  const noEvidence = rec.resolution === "undiagnosable" || (!open && attempts === 0 && rec.current_ref == null);
  stages.push({
    name: "2 · DIAGNOSE",
    status: rec.prompt ? "done" : open ? "live" : "fail",
    meta: rec.prompt
      ? `auto-generated heal prompt (${rec.prompt.length} chars): "${rec.prompt}"`
      : noEvidence
        ? "no capture of the affected page yet — the archive could not fetch it this round. Nothing spent; the collector stays watched."
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
      : noEvidence
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
  // A collector with no contract cannot be gated by V1, so its fix is left
  // sitting on the platform for a human instead of being promoted.
  const awaitingHuman = by("awaiting_human_approval").length > 0;
  const failedHeals = rec.heal_attempts.filter((a) => a.verdict?.pass === false).length;
  stages.push({
    name: "5 · PROMOTE (scraper approve)",
    // "undiagnosable" is not a failure of this stage: nothing was proposed, so
    // nothing was rejected. Rendering it red said a promotion had failed and
    // paged a human, when neither happened.
    status: approved
      ? "done"
      : awaitingHuman
        ? "live"
        : rec.resolution === "undiagnosable"
          ? "pending"
          : rec.resolution === "quarantined"
            ? "fail"
            : open
              ? "pending"
              : "fail",
    meta: approved
      ? "gate passed — fix promoted to production"
      : awaitingHuman
        ? "V1 passed but no contract pins this collector — fix left awaiting_approval for a human"
        : rec.resolution === "undiagnosable"
          ? "not reached — there was nothing to diagnose from, so no fix was proposed. Nothing spent, nobody paged, still watching."
          : rec.resolution === "quarantined"
            ? failedHeals > 0
              ? `${failedHeals} failed heal${failedHeals === 1 ? "" : "s"} — rejected pending fix, human paged`
              : `quarantined without a heal being attempted · ${rec.credits_spent} heal attempt(s) — human paged`
            : open
              ? "awaiting the V1 gate"
              : "blocked on V1",
  });

  // The old sixth stage re-collected every canary after promotion. ANANSI no
  // longer triggers collections, so the verification is Bright Data's own next
  // scheduled run (ADR-005) — the console waits for it rather than causing it.
  stages.push({
    name: "6 · AWAITING THE NEXT SCHEDULED RUN",
    status: approved ? "live" : "pending",
    meta: approved
      ? "promoted — Bright Data's next scheduled run verifies the fix; a failure on it quarantines the collector instead of re-healing"
      : "runs after promotion — ANANSI never triggers one",
  });

  return stages;
}
