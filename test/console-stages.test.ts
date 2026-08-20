// The console explains what the agent did. If a stage asserts something the
// record does not support, the console is lying at exactly the moment someone
// is reading it to understand a failure.
//
// Regression for incident 9708ba89: quarantined before any heal (0 attempts,
// 0 credits, 0s wall) yet stage 5 read "2 failed heals — rejected pending fix",
// a hardcoded string shown under every quarantine.

import { describe, expect, it } from "vitest";
import { stagesFor } from "../apps/console/stages.js";
import type { IncidentRecord } from "../packages/core/types.js";

function incident(over: Partial<IncidentRecord> = {}): IncidentRecord {
  return {
    id: "test",
    scraper: "lab-storefront",
    opened_at: 0,
    signal: [{ signal: "golden_band", field: "price", detail: "golden field is null" }],
    route: "heal",
    heal_attempts: [],
    credits_spent: 0,
    ...over,
  } as IncidentRecord;
}

const stage = (stages: ReturnType<typeof stagesFor>, prefix: string) =>
  stages.find((s) => s.name.startsWith(prefix))!;

describe("console stage view-model", () => {
  it("does not claim heals that never happened", () => {
    // Exactly incident 9708ba89: no baseline snapshot, so it quarantined
    // before diagnosing. No heal ran and nothing was spent.
    const stages = stagesFor(incident({ resolution: "quarantined", current_ref: undefined }), []);

    const promote = stage(stages, "5 ·");
    expect(promote.meta).not.toContain("2 failed heals");
    expect(promote.meta).toContain("without a heal being attempted");

    expect(stage(stages, "3 ·").meta).toContain("not attempted");
    // And it must say *why* diagnosis never ran, not "building evidence pack…".
    expect(stage(stages, "2 ·").meta).toContain("no capture of the affected page");
  });

  it("reports the real number of failed heals", () => {
    const rec = incident({
      resolution: "quarantined",
      last_good_ref: "ref",
      prompt: "fix the price selector",
      heal_attempts: [
        { prompt: "p", diff_summary: "", verdict: { pass: false }, ts: 1 },
        { prompt: "p", diff_summary: "", verdict: { pass: false }, ts: 2 },
        { prompt: "p", diff_summary: "", verdict: { pass: false }, ts: 3 },
      ],
    } as Partial<IncidentRecord>);
    // Three attempts must not render as the old hardcoded two.
    expect(stage(stagesFor(rec, []), "5 ·").meta).toContain("3 failed heals");
  });

  it("singularises a lone failed heal", () => {
    const rec = incident({
      resolution: "quarantined",
      last_good_ref: "ref",
      heal_attempts: [{ prompt: "p", diff_summary: "", verdict: { pass: false }, ts: 1 }],
    } as Partial<IncidentRecord>);
    const meta = stage(stagesFor(rec, []), "5 ·").meta;
    expect(meta).toContain("1 failed heal ");
    expect(meta).not.toContain("1 failed heals");
  });

  it("names the lane the incident actually took", () => {
    // Previously every non-heal lane rendered as "TRIAGE — infra lane".
    for (const route of ["config", "dead", "retry"] as const) {
      const stages = stagesFor(incident({ route, resolution: "quarantined" }), []);
      const triage = stage(stages, "TRIAGE");
      expect(triage.name).toContain(`${route} lane`);
      expect(triage.name).not.toContain("infra");
    }
    const infra = stagesFor(incident({ route: "infra" }), []);
    expect(stage(infra, "TRIAGE").meta).toContain("ADR-003");
  });

  it("counts heal attempts from audit events when the record lags", () => {
    const stages = stagesFor(incident({ prompt: "p" }), [
      { event: "heal_start", id: "test" },
      { event: "heal_start", id: "test" },
    ]);
    expect(stage(stages, "3 ·").meta).toContain("2 attempt(s)");
  });

  it("ends the trace at the next scheduled run, not at a post-approval sweep", () => {
    // V2 re-collected every canary after promotion, which meant ANANSI
    // triggering a collection. That is gone (ADR-005): the verification is
    // Bright Data's own next run, so the last stage waits rather than acts.
    const stages = stagesFor(incident({ prompt: "p", resolution: "promoted" }), [{ event: "approved", id: "test" }]);

    expect(stages.some((s) => s.name.includes("V2"))).toBe(false);
    const last = stages[stages.length - 1]!;
    expect(last.name).toContain("AWAITING THE NEXT SCHEDULED RUN");
    expect(last.meta).toContain("next scheduled run");
    expect(last.status).toBe("live");
  });

  it("never claims a golden re-pin, which only the deleted V2 could flag", () => {
    const stages = stagesFor(incident({ prompt: "p", resolution: "promoted" }), [
      { event: "approved", id: "test" },
      // A legacy store still holds these events. They must not resurrect the stage.
      { event: "verify_v2", id: "test", pass: true, repin_flags: [{ field: "price" }] },
    ]);
    const text = stages.map((s) => `${s.name} ${s.meta}`).join(" ");
    expect(text).not.toContain("re-pin");
    expect(text).not.toContain("sweep");
  });

  it("says a contract-less collector's fix is parked for a human", () => {
    // Without goldens V1 cannot gate, so driveIncident leaves the fix
    // awaiting_approval on the platform. Stage 5 must not read as "blocked".
    const stages = stagesFor(incident({ prompt: "p" }), [{ event: "awaiting_human_approval", id: "test", attempt: 1 }]);
    const promote = stage(stages, "5 ·");
    expect(promote.status).toBe("live");
    expect(promote.meta).toContain("awaiting_approval");
    expect(promote.meta).toContain("human");
  });

  it("does not promise a retry it cannot perform", () => {
    // Nothing in ANANSI retries: the next run is Bright Data's to schedule.
    const meta = stage(stagesFor(incident({ route: "retry" }), []), "TRIAGE").meta;
    expect(meta).not.toContain("cadence");
    expect(meta).toContain("next scheduled run");
  });
});

describe("an incident with nothing to diff is not a quarantine", () => {
  // This used to quarantine, which halted the collector permanently, and the
  // console reported it as "human paged" — for an incident where nothing was
  // attempted, nothing was spent and nobody needed to do anything.
  it("does not say a human was paged", () => {
    const stages = stagesFor(incident({ resolution: "undiagnosable", last_good_ref: undefined }), []);
    const promote = stage(stages, "5 ·");
    expect(promote.meta).not.toContain("human paged");
    expect(promote.meta).toContain("still watching");
    // Nothing failed at the promote stage, so it must not render as a failure.
    expect(promote.status).not.toBe("fail");
  });

  it("names the capture of the live page as what is missing", () => {
    // A missing last-good is no longer a reason to stop: most collectors keep no
    // HTML and can never have one, so Diagnose locates known-good values in the
    // live page instead. The only true blocker is having no live page.
    const stages = stagesFor(incident({ resolution: "undiagnosable", current_ref: undefined }), []);
    expect(stage(stages, "2 ·").meta).toContain("no capture of the affected page");
  });

  it("does not stall an incident merely because no baseline was ever archived", () => {
    const healed = incident({ resolution: "promoted", last_good_ref: undefined, current_ref: "cur", prompt: "fix price" });
    expect(stage(stagesFor(healed, []), "2 ·").meta).toContain("fix price");
  });
});
