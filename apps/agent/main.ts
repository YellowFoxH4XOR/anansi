// Entry point: load contracts, wire adapters (real CLI or fixture fake), start
// the scheduler. ANANSI_ADAPTER=fake keeps everything offline (fixture-first).

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseContract } from "../../packages/core/sense/contract.js";
import { RealBrightData } from "../../packages/adapters/brightdata/real.js";
import { FakeBrightData } from "../../packages/adapters/brightdata/fake.js";
import { LiveLabBrightData } from "../../packages/adapters/brightdata/live.js";
import { defaultLlm } from "../../packages/adapters/llm/index.js";
import { Store } from "../../packages/adapters/store/index.js";
import { Scheduler, type ScheduledScraper } from "./scheduler.js";

async function main(): Promise<void> {
  const store = new Store(process.env.ANANSI_DATA ?? "data");
  await store.init();
  // real (default, the graded path) · live (rehearsal: real fetches of the
  // deployed Lab, simulated heals, no credits) · fake (banked fixtures).
  const mode = process.env.ANANSI_ADAPTER ?? "real";
  const llm = defaultLlm();

  // ANANSI_LAB_BASE swaps the Lab's origin at load time (Coolify domain, local
  // tunnel, …) — only URLs still on the placeholder origin are rewritten, so
  // real-target contracts (books, HN) are never touched.
  const LAB_PLACEHOLDER = "anansi-lab.vercel.app";
  const labBase = process.env.ANANSI_LAB_BASE;

  const contractsDir = process.env.ANANSI_CONTRACTS ?? "contracts";
  const loaded = readdirSync(contractsDir)
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .map((f) => {
      const contract = parseContract(readFileSync(join(contractsDir, f), "utf8"));
      if (labBase) {
        for (const c of contract.canaries) {
          const u = new URL(c.url);
          if (u.host === LAB_PLACEHOLDER) c.url = new URL(u.pathname, labBase).toString();
        }
      }
      // A 30-minute contract cadence is right for a real fleet and far too slow
      // for a live demo — nobody watches a console for half an hour after
      // firing a mutation. The hosted deploy runs at 1–2 minutes.
      const cadence = Number(process.env.ANANSI_CADENCE_MINUTES);
      if (Number.isFinite(cadence) && cadence > 0) contract.cadence_minutes = cadence;

      // A missing collector_id is a static configuration error, not a runtime
      // state: in real mode every call would be `scraper run UNSET`, which the
      // platform answers 404 forever. Such a contract is still loaded, so the
      // console lists its collector, but it is never swept.
      const blocked =
        mode === "real" && !contract.collector_id
          ? `no collector_id — run 'brightdata scraper create', put the returned id in contracts/${f}, redeploy`
          : undefined;
      if (!contract.collector_id && mode !== "real") {
        console.warn(`[${contract.scraper}] no collector_id in contract — set it after 'brightdata scraper create'`);
      }
      // Rehearsal mode needs this contract's canary list to build heal preview
      // rows, so the adapter is built per contract rather than shared.
      const bd =
        mode === "fake"
          ? new FakeBrightData()
          : mode === "live"
            ? new LiveLabBrightData({ canaries: contract.canaries.map((c) => c.url) })
            : new RealBrightData();

      const scraper: ScheduledScraper = {
        contract,
        deps: { bd, llm, store, collectorId: contract.collector_id ?? "UNSET" },
      };
      return { scraper, blocked };
    });

  // Show the fleet in the console from the first tick, not from the first fault.
  // Blocked contracts are registered too, so a misconfigured collector appears
  // in the console rather than silently missing from the fleet.
  for (const l of loaded) await store.ensureCollector(l.scraper.contract.scraper);

  for (const l of loaded) {
    if (l.blocked) console.error(`[${l.scraper.contract.scraper}] NOT SCHEDULED: ${l.blocked}`);
  }

  const runnable = loaded.filter((l) => !l.blocked).map((l) => l.scraper);
  console.log(`ANANSI scheduler: ${runnable.length}/${loaded.length} contract(s) schedulable, adapter=${mode}`);
  if (mode === "live") {
    console.log("rehearsal mode — real fetches of the Lab, SIMULATED heals, no Bright Data calls");
  }

  if (runnable.length === 0) {
    // Exiting here is worse than useless: restart: unless-stopped would loop the
    // container forever over a static config error, burying the one line that
    // explains it. Idle instead — the container stays up, the console keeps
    // serving from the shared volume, and the operator sees a periodic reminder.
    // The timer is also what keeps the event loop alive; with no scheduler
    // intervals Node would otherwise exit 0 and restart just the same.
    setInterval(
      () => console.error(`idle: no schedulable contracts (adapter=${mode}) — fix the config above and redeploy`),
      5 * 60_000,
    );
    return;
  }

  new Scheduler(runnable).start();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
