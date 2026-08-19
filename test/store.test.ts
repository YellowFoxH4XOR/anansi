// Store, operator recovery and row-normalisation behaviour. These were written
// against the scheduler but never tested it: every one of them is about what
// the Store records and what an operator can undo, which survived the pivot
// from scheduling to monitoring intact.

import { beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseContract } from "../packages/core/sense/contract.js";
import { Store } from "../packages/adapters/store/index.js";
import { rawToRun } from "../apps/agent/incident.js";
import { resetCollector } from "../apps/agent/reset-collector.js";
import { clearStore } from "../apps/agent/clear-store.js";

const contract = parseContract(readFileSync("contracts/lab-storefront.yaml", "utf8"));

let store: Store;

beforeEach(async () => {
  store = new Store(mkdtempSync(join(tmpdir(), "anansi-store-")));
  await store.init();
  await store.ensureCollector(contract.scraper);
});

describe("operator recovery", () => {
  it("unquarantines without deleting history and clears persistent sense flags", async () => {
    await store.ensureCollector(contract.scraper);
    await store.setCollectorState(contract.scraper, "quarantined");
    await store.setFlags(contract.scraper, { fill_rate: ["price"], cusum: ["price|url"] });
    await store.putIncident({ id: "kept", scraper: contract.scraper } as never);

    const result = await resetCollector(store, contract.scraper, "production scraper saved");

    expect(result).toEqual({ from: "quarantined", to: "healthy" });
    expect(store.collectorState(contract.scraper)).toBe("healthy");
    expect(store.flags(contract.scraper)).toEqual({ fill_rate: [], cusum: [] });
    expect(store.incident("kept")).toBeDefined();
    expect(store.auditLog()).toContainEqual(
      expect.objectContaining({
        event: "operator_reset",
        scraper: contract.scraper,
        from: "quarantined",
        to: "healthy",
        reason: "production scraper saved",
      }),
    );
  });

  it("refuses to reset an unknown collector", async () => {
    await expect(resetCollector(store, "missing")).rejects.toThrow("unknown collector 'missing'");
  });
});

describe("platform row normalisation", () => {
  it("reads the snapshot from Studio's page_html and keeps it out of fields", async () => {
    // Shape taken verbatim from a live c_msyy76jk20f9e9mrh5 run.
    const row = {
      url: "https://anansi-lab.akshatkatiyar.com/product/echo-speaker",
      title: "Echo Portable Speaker",
      price: 49.99,
      sale_price: null,
      availability: "in stock",
      page_html: '<html><span class="price">$49.99</span></html>',
      page_html_url: "https://anansi-lab.akshatkatiyar.com/product/echo-speaker",
    };
    const run = await rawToRun(row, store, 1);

    expect(run.snapshot_ref).toBeDefined();
    expect(run.url).toBe(row.url);
    // A 15KB document arriving as a scraped field would corrupt fill-rate,
    // PII and invariant checks, so both tag keys must be stripped.
    expect(Object.keys(run.fields).sort()).toEqual(["availability", "price", "sale_price", "title"]);
  });

  it("still accepts _snapshot_html from fixtures", async () => {
    const run = await rawToRun({ url: "u", title: "t", _snapshot_html: "<html>x</html>" }, store, 1);
    expect(run.snapshot_ref).toBeDefined();
    expect(Object.keys(run.fields)).toEqual(["title"]);
  });

  it("takes the snapshot from the archive when the scraper collected none", async () => {
    // The normal case: dataset rows carry no HTML, so the free self-fetch
    // archive supplies it. Without this a scraper that never collected a
    // snapshot could never be diagnosed.
    const run = await rawToRun({ url: "u", title: "t" }, store, 1, "<html>archived</html>");
    expect(await store.snapshot(run.snapshot_ref!)).toBe("<html>archived</html>");
  });

  it("attributes a dataset row by input when it carries no url", async () => {
    // Dataset rows name the collected page `input`/`prime_input`; only heal
    // previews use `url`. Reading only `url` left every dataset row
    // unattributed, which breaks goldens and last-good snapshot lookup alike.
    const run = await rawToRun({ input: "https://lab/product/echo", title: "t" }, store, 1);
    expect(run.url).toBe("https://lab/product/echo");
    expect(Object.keys(run.fields)).toEqual(["title"]);
  });

  it("surfaces a row-level `error` as a failure and keeps it out of fields", async () => {
    // Per-input failures arrive under `error` OR `error_code`. A row carrying
    // only `error` previously passed as clean AND leaked the message into the
    // fields the contract is evaluated against.
    const run = await rawToRun({ url: "u", error: "dead_page", title: null }, store, 1);
    expect(run.error_code).toBe("dead_page");
    expect(Object.keys(run.fields)).toEqual(["title"]);
  });

  it("degrades a prose `error` to an unroutable code rather than guessing a lane", async () => {
    const run = await rawToRun({ url: "u", error: "the page took too long to render" }, store, 1);
    expect(run.error_code).toBe("row_error");
  });
});

describe("store clear", () => {
  it("removes runtime data but preserves banked fixtures by default", async () => {
    await store.ensureCollector(contract.scraper);
    await store.setCollectorState(contract.scraper, "quarantined");
    await store.addCredits(20);
    await store.appendRun({ url: "u", fields: {}, ts: 1, scraper: contract.scraper });
    await store.putIncident({ id: "old", scraper: contract.scraper } as never);
    await store.saveSnapshot("<html>snap</html>");
    writeFileSync(join(store.dir, "fixtures", "heal-m1.json"), "{}");

    const { removed } = await clearStore(store.dir);

    expect(removed.join(" ")).toContain("state.json");
    expect(removed.join(" ")).toContain("snapshots/");
    // A fresh Store, because the old one caches state keyed on mtime.
    const after = new Store(store.dir);
    expect(after.incidents()).toEqual([]);
    expect(after.runs(contract.scraper)).toEqual([]);
    expect(after.auditLog()).toEqual([]);
    expect(after.creditsSpent()).toBe(0);
    expect(after.collectors()).toEqual({});
    // Banked heal fixtures are dev assets from the harness, not runtime data.
    expect(existsSync(join(store.dir, "fixtures", "heal-m1.json"))).toBe(true);
    // Directory layout must survive so the agent can write without a restart.
    expect(existsSync(join(store.dir, "snapshots"))).toBe(true);
  });

  it("removes fixtures only when explicitly asked", async () => {
    writeFileSync(join(store.dir, "fixtures", "heal-m1.json"), "{}");
    await clearStore(store.dir, { includeFixtures: true });
    expect(existsSync(join(store.dir, "fixtures", "heal-m1.json"))).toBe(false);
  });
});

