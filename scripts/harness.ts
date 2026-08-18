// D1 overnight characterization harness: loop M1 → run → heal → bank heal.json
// → REJECT → RESET, all night. By morning: a real latency distribution and a
// bank of heal.json fixtures for offline development.
//
// ⚠ The reject is non-negotiable. Approving would move the collector to
// M1-adapted markup while RESET restores baseline markup — silently corrupting
// every later fixture AND the production scraper. This harness NEVER approves.
//
// Requires: brightdata CLI logged in, the Lab deployed, collector created.
//   ANANSI_LAB=https://anansi-lab.vercel.app ANANSI_COLLECTOR=c_xxx npx tsx scripts/harness.ts

import { writeFile } from "node:fs/promises";
import { RealBrightData } from "../packages/adapters/brightdata/real.js";
import { Store } from "../packages/adapters/store/index.js";
import { rawToRun } from "../apps/agent/incident.js";

const LAB = process.env.ANANSI_LAB ?? "http://localhost:4600";
const COLLECTOR = process.env.ANANSI_COLLECTOR;
const CYCLES = Number(process.env.ANANSI_CYCLES ?? 10);
const CANARY = `${LAB}/product/echo-speaker`;

if (!COLLECTOR) {
  console.error("Set ANANSI_COLLECTOR=c_xxx (from `brightdata scraper create`)");
  process.exit(1);
}

const bd = new RealBrightData();
const store = new Store(process.env.ANANSI_DATA ?? "data");
await store.init();

async function labState(mutation: string): Promise<string> {
  await fetch(`${LAB}/__control?mutate=${mutation}`);
  const r = await fetch(`${LAB}/__state`);
  const j = (await r.json()) as { mutation: string };
  if (j.mutation !== mutation) throw new Error(`Lab state did not stick: wanted ${mutation}, got ${j.mutation} — KV misconfigured?`);
  return j.mutation;
}

function ts(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

for (let cycle = 1; cycle <= CYCLES; cycle++) {
  console.log(`\n=== cycle ${cycle}/${CYCLES} · ${new Date().toISOString()} ===`);
  try {
    // Baseline sanity run (state=none), recorded for CUSUM tuning.
    await labState("none");
    const clean = await bd.runSync(COLLECTOR, CANARY);
    await store.addCredits(1);
    await store.appendRun({ ...(await rawToRun(clean, store, Date.now())), scraper: "lab-storefront", lab_state: "none", healthy: !clean.error_code });
    console.log(`baseline run: price=${clean.price} error=${clean.error_code ?? "none"}`);

    // Fire M1 and capture the broken run (state tagged for later filtering).
    await labState("rename");
    const broken = await bd.runSync(COLLECTOR, CANARY);
    await store.addCredits(1);
    await store.appendRun({ ...(await rawToRun(broken, store, Date.now())), scraper: "lab-storefront", lab_state: "rename", healthy: false });
    console.log(`mutated run: price=${broken.price} error=${broken.error_code ?? "none"}`);

    // Heal with a hand-written M1 diagnosis; time it; bank the response.
    const t0 = Date.now();
    const heal = await bd.heal(
      COLLECTOR,
      "The price field returns null. The page renamed the price element's class from 'price' to 'price-now' inside div.price-block; the value still renders there as text like $49.99. Update the price selector to match the new class and leave title and availability selectors untouched.",
      { url: CANARY, timeoutSec: 1800 },
    );
    const wallMs = Date.now() - t0;
    const fixture = `data/fixtures/heal-m1-${ts()}.json`;
    await writeFile(fixture, JSON.stringify({ wall_ms: wallMs, lab_state: "rename", ...heal }, null, 2));
    console.log(`heal: status=${heal.status} wall=${(wallMs / 1000).toFixed(0)}s → banked ${fixture}`);
    await store.audit({ event: "harness_heal", cycle, wall_ms: wallMs, status: heal.status, fixture });

    // REJECT — always (see header). Then RESET the lab.
    await bd.reject(COLLECTOR);
    console.log("rejected pending fix (collector stays on baseline parser)");
  } catch (e) {
    console.error(`cycle ${cycle} failed:`, e);
    try {
      await bd.reject(COLLECTOR); // never leave a fix dangling at the gate
    } catch {
      /* nothing pending */
    }
  } finally {
    await labState("none").catch(() => console.error("⚠ RESET FAILED — fix the lab before the next cycle"));
  }
}

console.log(`\nDone. Fixtures in data/fixtures/, latency in the audit log:`);
for (const e of store.auditLog().filter((e) => e.event === "harness_heal")) {
  console.log(`  cycle ${e.cycle}: ${(Number(e.wall_ms) / 1000).toFixed(0)}s → ${e.status}`);
}
