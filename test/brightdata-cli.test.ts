// What ANANSI actually asks the CLI to do. These assertions exist because the
// arguments are the behaviour: a missing flag here is invisible in every unit
// test, passes every gate, and silently does nothing on the platform.

import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RealBrightData } from "../packages/adapters/brightdata/real.js";

let dir: string;
let log: string;

/** A stand-in for `brightdata` that records its argv and answers with JSON. */
function stubCli(): string {
  const bin = join(dir, "brightdata-stub");
  writeFileSync(
    bin,
    [
      "#!/bin/sh",
      `echo "$@" >> ${JSON.stringify(log)}`,
      // heal/approve write their payload to the path after -o
      'prev=""; for a in "$@"; do if [ "$prev" = "-o" ]; then echo \'{"status":"awaiting_approval"}\' > "$a"; fi; prev="$a"; done',
      "exit 0",
    ].join("\n"),
  );
  chmodSync(bin, 0o755);
  return bin;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "anansi-cli-"));
  log = join(dir, "argv.log");
});

const argv = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);

describe("the write seam's actual arguments", () => {
  it("approve saves the template, not just approves it", async () => {
    // Without --auto-save the heal is approved and never published, so the
    // collector keeps running the template that was already broken. Observed
    // live: incident 855c4ad8 promoted, and every run after it still carried
    // t_msyy9dxtjbuxhxeu6.3 — the version that failed.
    await new RealBrightData(stubCli()).approve("c_1");
    expect(argv()[0]).toContain("--auto-save");
  });

  it("reject does not save anything", async () => {
    await new RealBrightData(stubCli()).reject("c_1");
    expect(argv()[0]).toContain("--reject");
    expect(argv()[0]).not.toContain("--auto-save");
  });

  it("heal never accepts the CLI's 600s default", async () => {
    // A heal can run 25 minutes; timing out at 600s abandons a fix mid-flight
    // that the platform still applies.
    await new RealBrightData(stubCli()).heal("c_1", "fix price", { timeoutSec: 60 });
    expect(argv()[0]).toContain("--timeout 1800");
  });

  it("refuses a prompt over the CLI's hard cap instead of truncating it", async () => {
    await expect(new RealBrightData(stubCli()).heal("c_1", "x".repeat(1001))).rejects.toThrow(/1000/);
    expect(argv()).toEqual([]);
  });

  it("never asks the CLI to start a collection", async () => {
    const bd = new RealBrightData(stubCli());
    await bd.heal("c_1", "p");
    await bd.approve("c_1");
    await bd.reject("c_1");
    // ADR-004: Bright Data owns the schedule. `scraper run` is the one command
    // that would spend page loads, and nothing here may reach for it.
    expect(argv().join(" ")).not.toContain("scraper run");
  });
});
