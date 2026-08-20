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





  it("L1 renames the listing tile and leaves the product pages alone", async () => {
    await get("/__control?mutate=cardrename");
    const listing = (await get("/")).body;
    expect(listing).not.toContain('class="card"');
    expect(listing).toContain('class="product-tile"');
    // The pages discovery never reaches are still perfect — which is why a
    // stage-2 check finds nothing wrong.
    expect((await get("/product/echo-speaker")).body).toContain('class="price">$49.99');
  });

  it("L2 renders half the catalogue and offers the rest behind a button", async () => {
    await get("/__control?mutate=paginate");
    const listing = (await get("/")).body;
    expect((listing.match(/class="card"/g) ?? []).length).toBe(2);
    expect(listing).toContain("load-more");
    expect(listing).toContain('data-remaining="2"');
  });

  it("L3 keeps the anchors matching but empties their href", async () => {
    await get("/__control?mutate=jslinks");
    const listing = (await get("/")).body;
    // The selector still matches — that is what makes it silent.
    expect((listing.match(/class="card-link"/g) ?? []).length).toBe(4);
    expect(listing).toContain('href="#"');
    expect(listing).toContain('data-href="/product/echo-speaker"');
  });


  it("RESET restores baseline instantly and /__state reports it", async () => {
    await get("/__control?mutate=none");
    const state = await get("/__state");
    expect(JSON.parse(state.body)).toEqual({ mutation: "none" });
    expect((await get("/product/echo-speaker")).body).toContain('class="price">$49.99');
  });
});
