// Canary cadence + per-collector state machine + budget guard.
// The scheduler skips incident-opening sweeps for any collector not in
// healthy/watching — otherwise a cadence tick during a 5–25 min heal opens a
// duplicate incident, burns credits, and eats the 3-wide AI-generation cap.

import type { Contract, RunRecord } from "../../packages/core/types.js";
import { evaluate } from "../../packages/core/sense/evaluate.js";
import { driveIncident, rawToRun, type IncidentDeps } from "./incident.js";

const BUDGET_FLOOR = 2_000; // stop spending when this many page loads remain

export type ScheduledScraper = {
  contract: Contract;
  deps: IncidentDeps;
};

export class Scheduler {
  private lastHealthySweep = new Map<string, RunRecord[]>();
  private running = new Set<string>();

  constructor(
    private scrapers: ScheduledScraper[],
    private log: (msg: string) => void = console.log,
  ) {}

  async sweepOnce(s: ScheduledScraper): Promise<void> {
    const { contract, deps } = s;
    const { store, bd } = deps;
    const name = contract.scraper;
    if (this.running.has(name)) return;

    this.running.add(name);
    try {
      const state = store.collectorState(name);
      if (state !== "healthy" && state !== "watching") {
        this.log(`[${name}] state=${state} — skipping sweep`);
        return;
      }

      // Budget guard: never open spend when the balance is at the floor.
      const balance = await bd.budgetBalance();
      if (balance != null && balance < BUDGET_FLOOR) {
        this.log(`[${name}] budget balance ${balance} below floor ${BUDGET_FLOOR} — refusing to spend`);
        return;
      }

      const records: RunRecord[] = [];
      for (const c of contract.canaries) {
        const raw = await bd.runSync(deps.collectorId, c.url);
        await store.addCredits(1);
        records.push(await rawToRun(raw, store, Date.now()));
      }

      const { result, flags } = evaluate(contract, records, store.history(name), store.flags(name));
      await store.setFlags(name, flags);

      if (result.kind === "healthy") {
        for (const r of records) await store.appendRun({ ...r, scraper: name, healthy: true });
        this.lastHealthySweep.set(name, records);
        if (state === "watching") await store.setCollectorState(name, "healthy");        if (result.warnings.length) {
          this.log(`[${name}] healthy with warnings: ${result.warnings.map((w) => `${w.signal}:${w.field ?? ""}`).join(", ")}`);
        }
        return;
      }

      for (const r of records) await store.appendRun({ ...r, scraper: name, healthy: false });
      this.log(`[${name}] INCIDENT (${result.route}): ${result.signals.map((v) => `${v.signal}${v.field ? `:${v.field}` : ""}`).join(", ")}`);
      const baseline = this.lastHealthySweep.get(name) ?? [];
      await driveIncident(result, contract, baseline, { ...deps, log: this.log });
    } catch (err) {
      // A CLI or transport failure is not a page-shape problem, so it never
      // reaches evaluate(): the taxonomy calls this transient platform noise
      // and the sweep is simply retried on the next tick. Without this catch
      // the rejection escapes start()'s `void` call, becomes an unhandled
      // rejection, and kills the agent — turning one 429 into a restart loop.
      const first = (err as Error).message.split("\n")[0];
      this.log(`[${name}] sweep failed: ${first} — retrying next tick`);
    } finally {
      this.running.delete(name);
    }
  }

  start(): NodeJS.Timeout[] {
    return this.scrapers.map((s) => {
      const ms = Math.max(1, s.contract.cadence_minutes) * 60_000;
      void this.sweepOnce(s);
      return setInterval(() => void this.sweepOnce(s), ms);
    });
  }
}
