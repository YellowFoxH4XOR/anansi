import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { createAgentControlApp, RESET_CONFIRMATION, type AgentReset } from "../apps/agent/control.js";
import { MonitorBusyError } from "../apps/agent/monitor.js";

async function withControlServer(reset: AgentReset, run: (origin: string) => Promise<void>): Promise<void> {
  const server: Server = createAgentControlApp(reset, () => {}).listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const { port } = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("agent state reset control", () => {
  it("requires the exact destructive-action confirmation", async () => {
    let called = false;
    await withControlServer(
      async () => {
        called = true;
        return { removed: [], collectors: [], errors: [] };
      },
      async (origin) => {
        const response = await fetch(`${origin}/state/reset`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ confirmation: "reset" }),
        });
        expect(response.status).toBe(400);
      },
    );
    expect(called).toBe(false);
  });

  it("returns the cleared paths and freshly discovered collectors", async () => {
    await withControlServer(
      async () => ({
        removed: ["state.json", "runs.jsonl"],
        collectors: [{ collectorId: "c_live", scraper: "c_live", platformName: "Live scraper" }],
        errors: [],
      }),
      async (origin) => {
        const response = await fetch(`${origin}/state/reset`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ confirmation: RESET_CONFIRMATION }),
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          cleared: true,
          removed: ["state.json", "runs.jsonl"],
          collectors: [{ collectorId: "c_live", platformName: "Live scraper" }],
        });
      },
    );
  });

  it("refuses to reset while the monitor is handling a job", async () => {
    await withControlServer(
      async () => {
        throw new MonitorBusyError();
      },
      async (origin) => {
        const response = await fetch(`${origin}/state/reset`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ confirmation: RESET_CONFIRMATION }),
        });
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ error: expect.stringContaining("handling a job") });
      },
    );
  });
});
