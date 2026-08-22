// Entry point: discover the fleet from Bright Data, overlay any pinned
// contracts, start the monitor.
//
// The fleet comes from the platform, not from contracts/: a scraper built in
// Studio must appear in the console with no config edit. Contracts are an
// optional overlay keyed by collector_id — with one, a collector gets goldens,
// CUSUM and invariants; without one, it is still monitored for platform
// failures. An absent or empty contracts/ directory is therefore normal.
//
// ANANSI_ADAPTER selects the HEAL seam only (real CLI vs offline fake). The read
// seam is the REST client and is not adapter-selected: there is nothing to fake
// about reading job history.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseContract } from "../../packages/core/sense/contract.js";
import { RealBrightData } from "../../packages/adapters/brightdata/real.js";
import { FakeBrightData } from "../../packages/adapters/brightdata/fake.js";
import { apiFromEnv } from "../../packages/adapters/brightdata/api.js";
import { defaultLlm } from "../../packages/adapters/llm/index.js";
import { Store } from "../../packages/adapters/store/index.js";
import { Monitor } from "./monitor.js";
import { httpPageFetcher, originRewriter, viaOrigin } from "./archive.js";
import type { Contract } from "../../packages/core/types.js";

function loadContracts(dir: string): Map<string, Contract> {
  const byCollector = new Map<string, Contract>();
  if (!existsSync(dir)) return byCollector;

  for (const f of readdirSync(dir).filter((n) => n.endsWith(".yaml") || n.endsWith(".yml"))) {
    const contract = parseContract(readFileSync(join(dir, f), "utf8"));
    if (!contract.collector_id) {
      // An orphan contract is a config warning, not a reason to withhold
      // monitoring: the collectors it fails to name are still discovered and
      // still watched, just without goldens.
      console.warn(`[${contract.scraper}] ${f} has no collector_id — it cannot be joined to a discovered scraper, so its goldens are inert`);
      continue;
    }
    byCollector.set(contract.collector_id, contract);
  }
  return byCollector;
}

async function main(): Promise<void> {
  const store = new Store(process.env.ANANSI_DATA ?? "data");
  await store.init();

  const api = apiFromEnv();
  if (!api) {
    throw new Error("BRIGHTDATA_API_KEY is required: ANANSI reads job history over REST and has no other way to see the fleet");
  }

  const mode = process.env.ANANSI_ADAPTER ?? "real";
  if (mode !== "real" && mode !== "fake") {
    throw new Error(`ANANSI_ADAPTER must be "real" or "fake", received ${JSON.stringify(mode)}`);
  }
  const heal = mode === "fake" ? new FakeBrightData() : new RealBrightData();
  const contracts = loadContracts(process.env.ANANSI_CONTRACTS ?? "contracts");

  // ANANSI_LAB_BASE is a FETCH-SIDE shortcut only. A canary URL is the join key
  // evaluate() matches dataset rows against, and Bright Data collects the
  // public url — so the contract keeps the public origin and only the archive's
  // own GET is redirected onto the compose network.
  const canaryHosts = [...contracts.values()].flatMap((c) =>
    c.canaries.flatMap((canary) => {
      try {
        return [new URL(canary.url).host];
      } catch {
        return [];
      }
    }),
  );
  const fetchPage = viaOrigin(httpPageFetcher(), originRewriter(canaryHosts, process.env.ANANSI_LAB_BASE));

  const pollSeconds = Number(process.env.ANANSI_POLL_SECONDS);
  const monitor = new Monitor({
    api,
    heal,
    llm: defaultLlm(),
    store,
    contracts,
    fetchPage,
    config: Number.isFinite(pollSeconds) && pollSeconds > 0 ? { pollSeconds } : {},
  });

  await monitor.reconcile();
  console.log(`ANANSI monitor: ${contracts.size} pinned contract(s), heal adapter=${mode} — Bright Data owns the schedule`);
  monitor.start();

  const shutdown = (signal: NodeJS.Signals): void => {
    console.log(`${signal}: stopping ANANSI monitor`);
    monitor.stop();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
