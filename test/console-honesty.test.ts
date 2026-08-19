// The console is the only thing an operator reads while trying to trust the
// agent, so a false sentence here is worse than a missing feature. Two claims
// in particular were true of the scheduler and are now lies:
//
//   1. that ANANSI scans / sweeps on a cadence — Bright Data owns the schedule
//      and ANANSI triggers nothing;
//   2. that ANANSI spends page-load credits — polling and the HTML archive are
//      free, and only a heal costs anything.
//
// Both were spread across ten files in copy, titles and empty states, so this
// guard is a source scan rather than a render test. Every banned phrase below
// is quoted verbatim from the pre-pivot console, which is what makes this fail
// against the old behaviour.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["apps/console", "apps/console-ui/src"];

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sources(p);
    return /\.(ts|tsx|html)$/.test(name) ? [p] : [];
  });
}

const FILES = ROOTS.flatMap(sources).map((path) => ({ path, text: readFileSync(path, "utf8") }));

// Verbatim from the deleted console. Each one asserted a cadence, a sweep of
// ours, or Bright Data spend caused by ANANSI.
const BANNED = [
  "last scan",
  "Last scan",
  "No sweep has completed",
  "cadence tick",
  "canary sweep",
  "credits spent",
  "credits spent across all incidents",
  "scans shown",
  "Scan history",
  "No scans recorded",
  "contract(s) schedulable",
  "seed the demo fleet",
];

describe("console honesty", () => {
  it("finds the console source it is meant to be guarding", () => {
    // A refactor that moves or renames these directories must not silently
    // turn this whole suite into a no-op.
    expect(FILES.length).toBeGreaterThan(8);
    expect(FILES.map((f) => f.path)).toContain("apps/console-ui/src/pages/Runs.tsx");
  });

  it("claims no scan, sweep, cadence or credit spend anywhere", () => {
    const offenders = FILES.flatMap((f) => BANNED.filter((p) => f.text.includes(p)).map((p) => `${f.path}: "${p}"`));
    expect(offenders).toEqual([]);
  });

  it("never becomes a second Bright Data client", () => {
    // The console holds no API key and reads a shared volume. An import of the
    // platform client here would make it a second caller of an API the agent is
    // rate-limited against — and would put a credential in a public-facing web
    // process.
    const importers = FILES.filter((f) => /from\s+["'][^"']*brightdata/.test(f.text)).map((f) => f.path);
    expect(importers).toEqual([]);

    const callers = FILES.filter((f) => /\b(runSync|runBatch|\.trigger\()\s*\(/.test(f.text)).map((f) => f.path);
    expect(callers).toEqual([]);
  });

  it("says who owns the schedule where an operator will look for it", () => {
    const runs = FILES.find((f) => f.path.endsWith("pages/Runs.tsx"))!.text;
    expect(runs).toContain("Bright Data owns the schedule");
    // The empty fleet is the moment someone wonders whether they must write a
    // config file. They must not.
    expect(FILES.find((f) => f.path.endsWith("pages/Fleet.tsx"))!.text).toContain("ANANSI reads the fleet from Bright Data");
  });

  it("has no V2 phase left to render", () => {
    // HealAttempt.phase is gone from the record; a UI still branching on it
    // would render a stage that can never happen again.
    const offenders = FILES.filter((f) => /"v2"|'v2'|verify_v2|repin/.test(f.text)).map((f) => f.path);
    expect(offenders).toEqual([]);
  });
});
