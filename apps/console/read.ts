// The console's only data source: the shared volume the agent writes.
//
// Everything the console shows is assembled here, so a test can build a Store,
// write what the monitor writes, and assert on exactly what an operator sees.
// There is no other seam — in particular there is no Bright Data client in this
// process, by design: the agent holds the key, and the console holds none.

import type { Store } from "../../packages/adapters/store/index.js";
import { buildFleet, discoveredIds, lastPoll, type CursorLike, type FleetEntry } from "./fleet.js";
import { jobRows, type JobRow, type RunRow } from "./jobs.js";

// The monitor stamps job_id on every row it stores; StoredRun does not declare
// it, so the join reads rows through this narrower shape.
function runRows(store: Store, names: readonly string[]): RunRow[] {
  return names.flatMap((name) => store.runs(name) as RunRow[]);
}

export function readJobs(store: Store, collector?: string): JobRow[] {
  const names = collector ? [collector] : Object.keys(store.collectors());
  return jobRows(store.jobLedger(collector), runRows(store, names));
}

export function readCursors(store: Store): Record<string, CursorLike> {
  return Object.fromEntries(Object.keys(store.collectors()).map((n) => [n, store.monitorCursor(n)]));
}

export function readFleet(store: Store, jobs: JobRow[] = readJobs(store), nowMs = Date.now()): FleetEntry[] {
  return buildFleet(
    {
      collectors: store.collectors(),
      discovered: discoveredIds(store.auditLog()),
      cursors: readCursors(store),
      jobs,
    },
    nowMs,
  );
}

export function readLastPoll(store: Store): number | null {
  return lastPoll(readCursors(store));
}
