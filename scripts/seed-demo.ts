// Seeds a data dir with a complete M2 (silent injection) incident driven
// through the fake heal adapter — powers console development and video prep
// without touching the real backend or spending credits.
//
// It fabricates the dataset rows a scheduled Bright Data run would have
// produced. That is exactly how replayed rows reach the pipeline in production,
// which is why this survived the pivot when the overnight harness did not: it
// never triggered a collection in the first place.
//
//   npx tsx scripts/seed-demo.ts [dataDir=data]

import { readFileSync } from "node:fs";
import { evaluate } from "../packages/core/sense/evaluate.js";
import { parseContract } from "../packages/core/sense/contract.js";
import { FakeBrightData } from "../packages/adapters/brightdata/fake.js";
import { TemplateLlm } from "../packages/adapters/llm/index.js";
import { Store } from "../packages/adapters/store/index.js";
import { driveIncident } from "../apps/agent/incident.js";
import { productPage, PRODUCTS } from "../apps/ui/pages.js";
import type { RunRecord } from "../packages/core/types.js";

const contract = parseContract(readFileSync("contracts/lab-storefront.yaml", "utf8"));
const echo = PRODUCTS.find((p) => p.sku === "echo-speaker")!;
const echoUrl = contract.canaries[0]!.url;
const baselineHtml = productPage(echo, "none");
const injectedHtml = productPage(echo, "renest");
const goodFields = { title: "Echo Portable Speaker", price: 49.99, sale_price: null, availability: "in stock" };

const store = new Store(process.argv[2] ?? "data");
await store.init();

const goldenFields = (i: number) => {
  const c = contract.canaries[i]!;
  return {
    title: (c.goldens.title as { value: string }).value,
    price: (c.goldens.price as { value: number }).value,
    sale_price: null,
    availability: "in stock",
  };
};

// 1 · Three healthy runs so CUSUM has a window and the archive has last-good
//     snapshots to diff against.
for (let run = 0; run < 3; run++) {
  const sweepTs = Date.now() - (3 - run) * 30 * 60_000;
  for (const [i, c] of contract.canaries.entries()) {
    await store.appendRun({
      url: c.url,
      fields: goldenFields(i),
      snapshot_ref: await store.saveSnapshot(baselineHtml),
      ts: sweepTs,
      scraper: contract.scraper,
      healthy: true,
      lab_state: "none",
      sweep_ts: sweepTs,
    });
  }
}
await store.setCollectorState(contract.scraper, "healthy");

// 2 · The M2 run: echo-speaker silently returns the injected $12.99.
const records: RunRecord[] = contract.canaries.map((c, i) => ({
  url: c.url,
  fields: i === 0 ? { ...goodFields, price: 12.99 } : goldenFields(i),
  ts: Date.now(),
}));
records[0]!.snapshot_ref = await store.saveSnapshot(injectedHtml);

const { result } = evaluate(contract, records, store.history(contract.scraper, "none"));
if (result.kind !== "incident") throw new Error("expected the M2 run to open an incident");
console.log(`incident opened: ${result.signals.map((s) => `${s.signal}:${s.field}`).join(", ")}`);

// 3 · Drive it through the fake heal → V1 → approve → promoted. Bright Data's
//     next scheduled run is what verifies it, so there is nothing after approve.
const bd = new FakeBrightData({
  heals: [
    {
      status: "awaiting_approval",
      diff_summary: `--- parser.js (v3)\n+++ parser.js (v4, proposed by heal)\n@@\n-  price: priceText('.price'),\n+  // Cross-sell strips render their own .price above the product's; scope\n+  // the selector to the product price block.\n+  price: priceText('.product .price-block .price'),`,
      preview_result: [{ url: echoUrl, ...goodFields }],
    },
  ],
});

const rec = await driveIncident(result, contract, {
  bd,
  llm: new TemplateLlm(),
  store,
  collectorId: "c_demo",
  log: console.log,
});
console.log(`\nresolution: ${rec.resolution} · heal attempts ${rec.credits_spent} · incident id ${rec.id}`);
console.log(`Console: npm run console  →  http://localhost:4700/incident/${rec.id}`);
