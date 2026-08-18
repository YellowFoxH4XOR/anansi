import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { createLabApp } from "../apps/ui/app.js";
import { MemoryKv } from "../apps/ui/kv.js";

let server: Server;
let base: string;

beforeAll(async () => {
  const app = createLabApp(new MemoryKv());
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  const addr = server.address();
  if (typeof addr === "object" && addr) base = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => server.close());

const get = async (path: string) => {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: await res.text(), headers: res.headers };
};

describe("Mutation Lab", () => {
  it("serves the baseline with a stable .price and no-store everywhere", async () => {
    await get("/__control?mutate=none");
    const r = await get("/product/echo-speaker");
    expect(r.status).toBe(200);
    expect(r.body).toContain('class="price">$49.99');
    expect(r.headers.get("cache-control")).toBe("no-store");
  });

  it("M1 renames the class", async () => {
    await get("/__control?mutate=rename");
    const r = await get("/product/echo-speaker");
    expect(r.body).toContain('class="price-now">$49.99');
    expect(r.body).not.toContain('class="price">$49.99');
  });

  it("M2 puts a wrong .price FIRST in the DOM — no error, no null", async () => {
    await get("/__control?mutate=inject");
    const r = await get("/product/echo-speaker");
    const first = r.body.indexOf('class="price">$12.99');
    const real = r.body.indexOf('class="price">$49.99');
    expect(first).toBeGreaterThan(-1);
    expect(real).toBeGreaterThan(-1);
    expect(first).toBeLessThan(real);
    expect(r.status).toBe(200);
  });

  it("M3 hides content behind the consent overlay", async () => {
    await get("/__control?mutate=cookiewall");
    const r = await get("/product/echo-speaker");
    expect(r.body).toContain("consent-overlay");
    expect(r.body).toContain('class="page-content" style="display:none"');
  });

  it("S1 returns 403 on every storefront route", async () => {
    await get("/__control?mutate=block403");
    expect((await get("/")).status).toBe(403);
    expect((await get("/product/echo-speaker")).status).toBe(403);
    // Control stays reachable so a judge can always recover.
    expect((await get("/__control")).status).toBe(200);
  });

  it("S2 re-nests the price under data-testid", async () => {
    await get("/__control?mutate=renest");
    const r = await get("/product/echo-speaker");
    expect(r.body).toContain('data-testid="price-value">$49.99');
    expect(r.body).not.toContain('class="price">$49.99');
  });

  it("RESET restores baseline instantly and /__state reports it", async () => {
    await get("/__control?mutate=none");
    const state = await get("/__state");
    expect(JSON.parse(state.body)).toEqual({ mutation: "none" });
    expect((await get("/product/echo-speaker")).body).toContain('class="price">$49.99');
  });
});
