// Release a quarantined collector back into monitoring.
//
//   npm run collector:release -- lab-storefront
//   npm run collector:release            # lists what is held, changes nothing
//
// Quarantine is a full stop: a quarantined collector is not dispatchable, so
// every job the monitor sees for it is deferred instead of handled, and nothing
// clears that by itself — a human decided it needed attention, so a human says
// when it has had some. The only existing way out was `store:clear`, which
// deletes snapshots/ along with everything else and would throw away the
// archived last-good pages that Diagnose needs. Hence this: it touches one
// collector's state and nothing else.
//
// Deferred jobs are not lost. They carry their payload in the ledger and are
// re-offered on the next poll once the collector is dispatchable again.

import { pathToFileURL } from "node:url";
import { Store } from "../../packages/adapters/store/index.js";
import type { CollectorState } from "../../packages/core/types.js";

const HELD: CollectorState[] = ["quarantined", "healing", "verifying", "incident_open"];

export async function releaseCollector(store: Store, name?: string): Promise<number> {
  const collectors = store.collectors();
  const held = Object.entries(collectors).filter(([, state]) => HELD.includes(state));

  if (!name) {
    if (held.length === 0) {
      console.log("Nothing is held: every collector is dispatchable.");
      return 0;
    }
    console.log("Held collectors (pass one as an argument to release it):\n");
    for (const [n, state] of held) {
      console.log(`  ${n.padEnd(28)} ${state}  ·  ${store.deferredJobs(n).length} job(s) waiting`);
    }
    return 0;
  }

  const state = collectors[name];
  if (state === undefined) {
    // Naming a collector that does not exist is far more likely a typo than a
    // request to create one, and silently doing nothing would look like success.
    console.error(`No collector "${name}" in the store. Known: ${Object.keys(collectors).join(", ") || "(none)"}`);
    process.exitCode = 1;
    return 0;
  }

  const waiting = store.deferredJobs(name).length;
  if (!HELD.includes(state)) {
    console.log(`"${name}" is already ${state} — nothing to release.`);
    return 0;
  }

  await store.setCollectorState(name, "healthy");
  await store.audit({ event: "collector_released", scraper: name, from: state, deferred_jobs: waiting });
  console.log(
    `"${name}": ${state} → healthy. ${waiting} deferred job(s) will be re-offered on the next poll.\n` +
      "Nothing was deleted: incidents, runs and archived snapshots are untouched.",
  );
  return waiting;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const store = new Store(process.env.ANANSI_DATA ?? "data");
  await store.init();
  await releaseCollector(store, process.argv[2]);
}
