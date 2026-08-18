// Fake adapter: replays scripted responses / banked heal.json fixtures. Not a
// testing nicety — the only way to develop against a 5–25-minute heal backend.

import { readFile } from "node:fs/promises";
import type { BrightDataAdapter, HealOpts, HealResponse, RawRow } from "./types.js";

export type FakeScript = {
  // Per-URL queues: each runSync shifts one row (last row repeats when the queue drains).
  runs?: Record<string, RawRow[]>;
  // Sequential heal responses (last repeats). Load from banked heal.json fixtures.
  heals?: HealResponse[];
  balance?: number;
};

export class FakeBrightData implements BrightDataAdapter {
  readonly calls: { op: string; args: unknown[] }[] = [];
  private healIdx = 0;
  private runIdx = new Map<string, number>();

  constructor(private script: FakeScript = {}) {}

  private next(url: string): RawRow {
    const q = this.script.runs?.[url];
    if (!q || q.length === 0) return { url, error_code: "dead_page" };
    const i = this.runIdx.get(url) ?? 0;
    this.runIdx.set(url, i + 1);
    return { ...q[Math.min(i, q.length - 1)]!, url };
  }

  async runSync(collectorId: string, url: string): Promise<RawRow> {
    this.calls.push({ op: "runSync", args: [collectorId, url] });
    return this.next(url);
  }

  async runBatch(collectorId: string, urls: string[]): Promise<RawRow[]> {
    this.calls.push({ op: "runBatch", args: [collectorId, urls] });
    return urls.map((u) => this.next(u));
  }

  async heal(collectorId: string, prompt: string, opts: HealOpts = {}): Promise<HealResponse> {
    this.calls.push({ op: "heal", args: [collectorId, prompt, opts] });
    if (prompt.length > 1000) throw new Error(`heal prompt ${prompt.length} chars > CLI cap 1000`);
    const heals = this.script.heals ?? [];
    if (heals.length === 0) return { status: "failed", diff_summary: "no heal fixture scripted" };
    const h = heals[Math.min(this.healIdx, heals.length - 1)]!;
    this.healIdx++;
    return h;
  }

  async approve(collectorId: string): Promise<void> {
    this.calls.push({ op: "approve", args: [collectorId] });
  }

  async reject(collectorId: string): Promise<void> {
    this.calls.push({ op: "reject", args: [collectorId] });
  }

  async budgetBalance(): Promise<number | null> {
    return this.script.balance ?? 38_000;
  }
}

// Load a banked heal.json (captured by the D1 characterization harness) as a fixture.
export async function healFixture(path: string): Promise<HealResponse> {
  return JSON.parse(await readFile(path, "utf8")) as HealResponse;
}
