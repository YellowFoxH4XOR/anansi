// Live-Lab (rehearsal) adapter. Every case runs against real Mutation Lab
// markup from lab/pages.ts — if the storefront's DOM drifts, these fail.

import { describe, expect, it } from "vitest";
import { LiveLabBrightData, SIMULATED } from "../packages/adapters/brightdata/live.js";
import { PRODUCTS, challengePage, productPage, type Mutation } from "../apps/ui/pages.js";
import { routeErrorCode } from "../packages/core/sense/triage.js";

const echo = PRODUCTS.find((p) => p.sku === "echo-speaker")!;
const aurora = PRODUCTS.find((p) => p.sku === "aurora-lamp")!;
const URL_ECHO = "https://lab.test/product/echo-speaker";

/** Serve one page for every URL. */
function serve(html: string, status = 200): typeof fetch {
  return (async () => new Response(html, { status })) as unknown as typeof fetch;
}

function adapter(html: string, status = 200, canaries: string[] = [URL_ECHO]): LiveLabBrightData {
  return new LiveLabBrightData({ canaries, fetchImpl: serve(html, status) });
}

const run = (m: Mutation, product = echo) => adapter(productPage(product, m)).runSync("c_x", URL_ECHO);

describe("live adapter · baseline", () => {
  it("extracts the contract fields from a healthy product page", async () => {
    const row = await run("none");
    expect(row.error_code).toBeUndefined();
    expect(row.title).toBe("Echo Portable Speaker");
    expect(row.price).toBe(49.99);
    expect(row.availability).toBe("in stock");
    expect(row.url).toBe(URL_ECHO);
  });

  it("carries the DOM snapshot the diff pipeline needs", async () => {
    const row = await run("none");
    expect(row._snapshot_html).toContain('class="price"');
  });
});

describe("live adapter · mutations reproduce the platform's signals", () => {
  it("M1 rename → parse_error (naive .price selector finds nothing) → heal lane", async () => {
    const row = await run("rename");
    expect(row.price).toBeNull();
    expect(row.error_code).toBe("parse_error");
    expect(routeErrorCode(row.error_code!)).toBe("heal");
    // The snapshot still rides along — a broken page's DOM is the evidence.
    expect(row._snapshot_html).toContain("price-now");
  });

  it("M2 inject → silently WRONG price, no error at all", async () => {
    const row = await run("inject");
    expect(row.error_code).toBeUndefined();
    expect(row.price).toBe(12.99); // the cross-sell strip's price, not the product's
  });

  it("M3 cookie wall → wait_element_timeout → heal lane", async () => {
    const row = await run("cookiewall");
    expect(row.error_code).toBe("wait_element_timeout");
    expect(routeErrorCode(row.error_code!)).toBe("heal");
  });

  it("S2 re-nest → parse_error, since the naive selector cannot see the new node", async () => {
    const row = await run("renest");
    expect(row.error_code).toBe("parse_error");
  });

  it("S1 403 challenge → blocked → infra lane, never healed", async () => {
    const row = await adapter(challengePage(), 403).runSync("c_x", URL_ECHO);
    expect(row.error_code).toBe("blocked");
    expect(routeErrorCode(row.error_code!)).toBe("infra");
  });
});

describe("live adapter · transport failures map onto the error taxonomy", () => {
  it("404 → dead_page → dead lane", async () => {
    const row = await adapter("not found", 404).runSync("c_x", URL_ECHO);
    expect(row.error_code).toBe("dead_page");
    expect(routeErrorCode(row.error_code!)).toBe("dead");
  });

  it("503 → retry lane", async () => {
    const row = await adapter("boom", 503).runSync("c_x", URL_ECHO);
    expect(routeErrorCode(row.error_code!)).toBe("retry");
  });

  it("an unreachable Lab is transient, not a heal trigger", async () => {
    const bd = new LiveLabBrightData({
      fetchImpl: (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    });
    const row = await bd.runSync("c_x", URL_ECHO);
    expect(row.error_code).toMatch(/^net_err_/);
    expect(routeErrorCode(row.error_code!)).toBe("retry");
  });
});

describe("live adapter · the simulated heal", () => {
  it("returns awaiting_approval with preview rows parsed by the proposed fix", async () => {
    const bd = adapter(productPage(echo, "inject"));
    const heal = await bd.heal("c_x", "price is wrong");
    expect(heal.status).toBe("awaiting_approval");
    const rows = heal.preview_result as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    // The healed selector scopes past the cross-sell strip to the real price.
    expect(rows[0]!.price).toBe(49.99);
  });

  it("stamps every heal SIMULATED so it cannot pass for a platform heal", async () => {
    const heal = await adapter(productPage(echo, "inject")).heal("c_x", "p");
    expect(heal.diff_summary).toContain(SIMULATED);
  });

  it("honours the CLI's 1000-char prompt cap", async () => {
    await expect(adapter(productPage(echo, "none")).heal("c_x", "x".repeat(1001))).rejects.toThrow(/1000/);
  });

  it("approve promotes the fix — later sweeps read the right price", async () => {
    const bd = adapter(productPage(echo, "inject"));
    expect((await bd.runSync("c_x", URL_ECHO)).price).toBe(12.99);
    await bd.heal("c_x", "fix it");
    await bd.approve("c_x");
    expect((await bd.runSync("c_x", URL_ECHO)).price).toBe(49.99);
  });

  it("reject leaves the collector on the old parser", async () => {
    const bd = adapter(productPage(echo, "inject"));
    await bd.heal("c_x", "fix it");
    await bd.reject("c_x");
    expect((await bd.runSync("c_x", URL_ECHO)).price).toBe(12.99);
  });

  it("approve without a pending fix changes nothing", async () => {
    const bd = adapter(productPage(echo, "inject"));
    await bd.approve("c_x");
    expect((await bd.runSync("c_x", URL_ECHO)).price).toBe(12.99);
  });

  it("the healed parser also reads through the cookie wall (the close_popup fix)", async () => {
    const bd = adapter(productPage(echo, "cookiewall"));
    expect((await bd.runSync("c_x", URL_ECHO)).error_code).toBe("wait_element_timeout");
    await bd.heal("c_x", "wall");
    await bd.approve("c_x");
    const row = await bd.runSync("c_x", URL_ECHO);
    expect(row.error_code).toBeUndefined();
    expect(row.price).toBe(49.99);
  });
});

describe("live adapter · scheduler contract", () => {
  it("reports no budget, which disables the spend guard", async () => {
    expect(await adapter(productPage(echo, "none")).budgetBalance()).toBeNull();
  });

  it("a discounted page keeps the contract invariant sale_price <= price", async () => {
    // Regression guard: aurora-lamp shows .price $29.99 over a struck-through
    // .was $34.50. Collecting .was as sale_price would violate the contract's
    // `sale_price <= price` invariant and open a spurious incident on the very
    // first sweep, so price tracks the shown value and sale_price stays null.
    const row = await adapter(productPage(aurora, "none")).runSync("c_x", URL_ECHO);
    expect(row.price).toBe(29.99); // dead centre of the golden, not 34.50
    expect(row.sale_price).toBeNull();
  });
});
