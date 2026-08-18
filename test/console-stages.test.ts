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
    const stages = stagesFor(incident({ resolution: "quarantined", last_good_ref: undefined }), []);

    const promote = stage(stages, "5 ·");
    expect(promote.meta).not.toContain("2 failed heals");
    expect(promote.meta).toContain("without a heal being attempted");

    expect(stage(stages, "3 ·").meta).toContain("not attempted");
    // And it must say *why* diagnosis never ran, not "building evidence pack…".
    expect(stage(stages, "2 ·").meta).toContain("no last-good snapshot");
  });

  it("reports the real number of failed heals", () => {
    const rec = incident({
      resolution: "quarantined",
      last_good_ref: "ref",
      prompt: "fix the price selector",
      heal_attempts: [
        { prompt: "p", diff_summary: "", verdict: { pass: false }, phase: "v1", ts: 1 },
        { prompt: "p", diff_summary: "", verdict: { pass: false }, phase: "v1", ts: 2 },
        { prompt: "p", diff_summary: "", verdict: { pass: false }, phase: "v1", ts: 3 },
      ],
    } as Partial<IncidentRecord>);
    // Three attempts must not render as the old hardcoded two.
    expect(stage(stagesFor(rec, []), "5 ·").meta).toContain("3 failed heals");
  });

  it("singularises a lone failed heal", () => {
    const rec = incident({
      resolution: "quarantined",
      last_good_ref: "ref",
      heal_attempts: [{ prompt: "p", diff_summary: "", verdict: { pass: false }, phase: "v1", ts: 1 }],
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
});
