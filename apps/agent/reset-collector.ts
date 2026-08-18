// Operator recovery for a deliberately quarantined collector.
//
// Run inside the agent container after fixing the underlying scraper/config:
//   npx tsx apps/agent/reset-collector.ts lab-storefront "saved Studio version"
//
// This preserves incident history, runs, snapshots and credit accounting. It
// only returns the collector state machine to healthy and clears persistence
// flags so the next cadence tick starts a clean sweep.

import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { Store } from "../../packages/adapters/store/index.js";
import { NO_PRIOR } from "../../packages/core/sense/evaluate.js";
import type { CollectorState } from "../../packages/core/types.js";

export async function resetCollector(
  store: Store,
  scraper: string,
  reason = "operator reset after correcting scraper/config",
): Promise<{ from: CollectorState; to: "healthy" }> {
  const known = store.collectors();
  if (!(scraper in known)) {
    const names = Object.keys(known);
    throw new Error(`unknown collector '${scraper}'${names.length ? `; known: ${names.join(", ")}` : "; no collectors registered"}`);
  }

  const from = store.collectorState(scraper);
  await store.setFlags(scraper, NO_PRIOR);
  await store.setCollectorState(scraper, "healthy");
  await store.audit({ event: "operator_reset", scraper, from, to: "healthy", reason });
  return { from, to: "healthy" };
}

async function main(): Promise<void> {
  const scraper = process.argv[2];
  if (!scraper) {
    throw new Error("usage: npm run collector:reset -- <scraper> [reason]");
  }
  const reason = process.argv.slice(3).join(" ") || undefined;
  const store = new Store(process.env.ANANSI_DATA ?? "data");
  await store.init();
  const transition = await resetCollector(store, scraper, reason);
  console.log(`[${scraper}] ${transition.from} → ${transition.to}; next cadence tick will sweep`);
}

const invokedAsScript = process.argv[1] != null && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedAsScript) {
  main().catch((err) => {
    console.error((err as Error).message);
    process.exitCode = 1;
  });
}
