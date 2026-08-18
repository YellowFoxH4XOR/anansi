// Seeds a data dir with a complete M2 (silent injection) incident driven
// through the fake adapter — powers console development and video prep without
// touching the real backend or spending credits.
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
import type { RawRow } from "../packages/adapters/brightdata/types.js";

const contract = parseContract(readFileSync("contracts/lab-storefront.yaml", "utf8"));
const echo = PRODUCTS.find((p) => p.sku === "echo-speaker")!;
const echoUrl = contract.canaries[0]!.url;
const baselineHtml = productPage(echo, "none");
const injectedHtml = productPage(echo, "inject");
const goodFields = { title: "Echo Portable Speaker", price: 49.99, sale_price: null, availability: "in stock" };

const store = new Store(process.argv[2] ?? "data");
await store.init();

// 1 · A healthy history (three sweeps) so CUSUM has a window and last-good
//     snapshots exist.
const baseline: RunRecord[] = [];
for (let sweep = 0; sweep < 3; sweep++) {
  for (const c of contract.canaries) {
    const run: RunRecord = {
      url: c.url,
      fields: {
        title: (c.goldens.title as { value: string }).value,
        price: (c.goldens.price as { value: number }).value,
        sale_price: null,
        availability: "in stock",
      },
      snapshot_ref: await store.saveSnapshot(baselineHtml),
      ts: Date.now() - (3 - sweep) * 30 * 60_000,
    };
    await store.appendRun({ ...run, scraper: contract.scraper, healthy: true, lab_state: "none" });
    if (sweep === 2) baseline.push(run);
  }
  await store.addCredits(contract.canaries.length);
}
await store.setCollectorState(contract.scraper, "healthy");

// 2 · The M2 sweep: echo-speaker silently returns the injected $12.99.
const records: RunRecord[] = contract.canaries.map((c, i) => ({
  url: c.url,
  fields:
    i === 0
      ? { ...goodFields, price: 12.99 }
      : {
          title: (c.goldens.title as { value: string }).value,
          price: (c.goldens.price as { value: number }).value,
          sale_price: null,
          availability: "in stock",
        },
  snapshot_ref: i === 0 ? undefined : undefined,
  ts: Date.now(),
}));
records[0]!.snapshot_ref = await store.saveSnapshot(injectedHtml);
await store.addCredits(contract.canaries.length);

const { result } = evaluate(contract, records, store.history(contract.scraper, "none"));
if (result.kind !== "incident") throw new Error("expected the M2 sweep to open an incident");
console.log(`incident opened: ${result.signals.map((s) => `${s.signal}:${s.field}`).join(", ")}`);

// 3 · Drive it through the fake heal → V1 → approve → V2 → promoted.
const healedRuns: Record<string, RawRow[]> = {};
for (const c of contract.canaries) {
  healedRuns[c.url] = [
    {
      url: c.url,
      _snapshot_html: baselineHtml,
      title: (c.goldens.title as { value: string }).value,
      price: (c.goldens.price as { value: number }).value,
      sale_price: null,
      availability: "in stock",
    },
  ];
}
const bd = new FakeBrightData({
  runs: healedRuns,
  heals: [
    {
      status: "awaiting_approval",
      diff_summary: `--- parser.js (v3)\n+++ parser.js (v4, proposed by heal)\n@@\n-  price: priceText('.price'),\n+  // Cross-sell strips render their own .price above the product's; scope\n+  // the selector to the product price block.\n+  price: priceText('.product .price-block .price'),`,
      preview_result: [{ url: echoUrl, ...goodFields }],
    },
  ],
});

const rec = await driveIncident(result, contract, baseline, {
  bd,
  llm: new TemplateLlm(),
  store,
  collectorId: "c_demo",
  log: console.log,
});
console.log(`\nresolution: ${rec.resolution} · credits ${rec.credits_spent} · incident id ${rec.id}`);
console.log(`Console: npm run console  →  http://localhost:4700/incident/${rec.id}`);
