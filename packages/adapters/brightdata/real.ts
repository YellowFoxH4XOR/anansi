// Real adapter: shells out to the `brightdata` CLI for the three write
// operations — heal, approve, reject. JSON lands in a temp file via -o (stdout
// carries progress noise). Heal prompts are pre-capped at 1000 chars by
// core/diagnose/prompt.ts; we assert rather than silently truncate.
//
// `scraper run` is deliberately absent: Bright Data owns the schedule.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrightDataAdapter, HealOpts, HealResponse } from "./types.js";

const exec = promisify(execFile);

export class RealBrightData implements BrightDataAdapter {
  constructor(private bin = "brightdata") {}

  private async cli(args: string[], timeoutMs: number): Promise<string> {
    const { stdout } = await exec(this.bin, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  }

  private async cliJson<T>(args: string[], timeoutMs: number): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), "anansi-bd-"));
    const out = join(dir, "out.json");
    try {
      await this.cli([...args, "-o", out], timeoutMs);
      return JSON.parse(await readFile(out, "utf8")) as T;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async heal(collectorId: string, prompt: string, opts: HealOpts = {}): Promise<HealResponse> {
    if (prompt.length > 1000) throw new Error(`heal prompt ${prompt.length} chars > CLI cap 1000`);
    const timeout = Math.max(opts.timeoutSec ?? 1800, 1800); // never the 600s default
    const args = ["scraper", "heal", collectorId, prompt, "--timeout", String(timeout)];
    if (opts.url) args.push("--url", opts.url);
    if (opts.maxRetries != null) args.push("--max-retries", String(opts.maxRetries));
    const res = await this.cliJson<HealResponse>(args, (timeout + 120) * 1000);
    return { ...res, raw: res };
  }

  /** Approve AND save. `--auto-save` is not a convenience flag: without it the
   *  heal is approved but the healed template is never published, so the
   *  collector keeps running the version that was already broken.
   *
   *  Observed live on 2026-08-20 — incident 855c4ad8 passed every gate and
   *  promoted, and the runs after it still carried template
   *  t_msyy9dxtjbuxhxeu6.3, the same one that failed. Every promotion ANANSI
   *  had ever made was a no-op on the platform.
   *
   *  It polls the save through to completion, so it gets heal-sized patience
   *  rather than the 120s a fire-and-forget call needed. */
  async approve(collectorId: string): Promise<void> {
    await this.cli(["scraper", "approve", collectorId, "--auto-save", "--timeout", "900"], 960_000);
  }

  async reject(collectorId: string): Promise<void> {
    await this.cli(["scraper", "approve", collectorId, "--reject"], 120_000);
  }

  async budgetBalance(): Promise<number | null> {
    try {
      const out = await this.cli(["budget", "balance", "--json"], 60_000);
      const j = JSON.parse(out) as Record<string, unknown>;
      const v = j.balance ?? j.credits ?? j.remaining;
      return typeof v === "number" ? v : Number(v) || null;
    } catch {
      return null;
    }
  }
}
