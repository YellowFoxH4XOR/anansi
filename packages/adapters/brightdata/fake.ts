// Fake adapter: replays scripted heal responses / banked heal.json fixtures.
// Not a testing nicety — the only way to develop against a 5–25-minute heal
// backend, and the only offline path through the approval gate.

import type { BrightDataAdapter, HealOpts, HealResponse } from "./types.js";

export type FakeScript = {
  // Sequential heal responses (last repeats). Load from banked heal.json fixtures.
  heals?: HealResponse[];
  balance?: number;
};

export class FakeBrightData implements BrightDataAdapter {
  readonly calls: { op: string; args: unknown[] }[] = [];
  private healIdx = 0;

  constructor(private script: FakeScript = {}) {}

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
