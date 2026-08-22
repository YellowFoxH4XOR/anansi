import { once } from "node:events";
import type { AddressInfo } from "node:net";
import express from "express";
import { describe, expect, it } from "vitest";
import { securityHeaders } from "../apps/console/security.js";

describe("console response hardening", () => {
  it("sets passive security headers without requiring credentials", async () => {
    const app = express();
    app.use(securityHeaders);
    app.get("/", (_req, res) => res.status(204).end());

    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");

    try {
      const { port } = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${port}`);

      expect(response.status).toBe(204);
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("x-frame-options")).toBe("DENY");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
