import express, { type Express } from "express";
import type { Server } from "node:http";
import { MonitorBusyError, type StoreResetReport } from "./monitor.js";

export const RESET_CONFIRMATION = "RESET ALL STATE";

export type AgentReset = () => Promise<StoreResetReport>;

export function createAgentControlApp(
  reset: AgentReset,
  log: (message: string) => void = console.log,
): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1kb" }));

  app.post("/state/reset", async (req, res) => {
    if (req.body?.confirmation !== RESET_CONFIRMATION) {
      return res.status(400).json({ error: `confirmation must equal ${JSON.stringify(RESET_CONFIRMATION)}` });
    }

    try {
      const result = await reset();
      log(`state reset: removed ${result.removed.length} runtime path(s), refreshed ${result.collectors.length} collector(s)`);
      return res.json({ cleared: true, ...result });
    } catch (error) {
      if (error instanceof MonitorBusyError) {
        return res.status(409).json({ error: error.message });
      }
      log(`state reset failed: ${(error as Error).message}`);
      return res.status(500).json({ error: "state reset failed" });
    }
  });

  return app;
}

export function startAgentControlServer(opts: {
  reset: AgentReset;
  host: string;
  port: number;
  log?: (message: string) => void;
}): Server {
  const log = opts.log ?? console.log;
  return createAgentControlApp(opts.reset, log).listen(opts.port, opts.host, () => {
    log(`ANANSI control: http://${opts.host}:${opts.port}`);
  });
}
