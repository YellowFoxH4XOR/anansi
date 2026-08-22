// Express app for the Mutation Lab. Rules that keep each scenario deterministic:
// - the KV is read on EVERY request (no module-level caching of state)
// - Cache-Control: no-store on EVERY response, /__control included
// - RESET returns to baseline instantly

import express, { type Express } from "express";
import type { Kv } from "./kv.js";
import {
  MUTATIONS,
  PRODUCTS,
  controlPage,
  listingPage,
  productPage,
  type Mutation,
} from "./pages.js";

const STATE_KEY = "anansi:lab:mutation";
const VALID = new Set(MUTATIONS.map((m) => m.id));

export function createLabApp(kv: Kv): Express {
  const app = express();
  app.disable("x-powered-by");

  app.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    next();
  });

  const state = async (): Promise<Mutation> => {
    const v = await kv.get(STATE_KEY);
    return v && VALID.has(v as Mutation) ? (v as Mutation) : "none";
  };

  app.get("/__control", async (req, res) => {
    const wanted = req.query.mutate;
    if (typeof wanted === "string" && VALID.has(wanted as Mutation)) {
      await kv.set(STATE_KEY, wanted);
    }
    res.send(controlPage(await state()));
  });

  // Machine-readable state — the overnight harness tags every banked fixture
  // with the Lab state at capture time via this endpoint.
  app.get("/__state", async (_req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.send(JSON.stringify({ mutation: await state() }));
  });

  app.get("/", async (_req, res) => {
    res.send(listingPage(await state()));
  });

  // Deliberately does not read mutation state. A product page is stage 2's
  // target and never mutates: the point of every scenario is that discovery
  // broke while the pages it never reached stayed perfect.
  app.get("/product/:sku", (req, res) => {
    const p = PRODUCTS.find((x) => x.sku === req.params.sku);
    if (!p) return res.status(404).send("Not found");
    res.send(productPage(p));
  });

  return app;
}
