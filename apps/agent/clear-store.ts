// Wipe the store's runtime data so the console starts from nothing.
//
//   npm run store:clear -- --yes
//   npm run store:clear -- --yes --include-fixtures
//
// This is irreversible and the volume is the system of record (Bright Data
// keeps results only 7-16 days), so it refuses to run without --yes.
//
// Banked heal fixtures under fixtures/ are development assets produced by
// scripts/harness.ts, not runtime data, so they survive unless explicitly
// included.

import { readdir, rm, stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { join, resolve } from "node:path";
import { Store } from "../../packages/adapters/store/index.js";

const RUNTIME_FILES = ["runs.jsonl", "incidents.jsonl", "audit.jsonl", "jobs.jsonl", "state.json"];

async function removeIfPresent(path: string): Promise<boolean> {
  try {
    await stat(path);
  } catch {
    return false;
  }
  await rm(path, { recursive: true, force: true });
  return true;
}

async function clearDirContents(dir: string): Promise<number> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return 0;
  }
  let n = 0;
  for (const e of entries) {
    await rm(join(dir, e), { recursive: true, force: true });
    n++;
  }
  return n;
}

export async function clearStore(
  dir: string,
  opts: { includeFixtures?: boolean } = {},
): Promise<{ removed: string[] }> {
  const removed: string[] = [];

  for (const f of RUNTIME_FILES) {
    if (await removeIfPresent(join(dir, f))) removed.push(f);
  }

  const snapshots = await clearDirContents(join(dir, "snapshots"));
  if (snapshots > 0) removed.push(`snapshots/ (${snapshots} file(s))`);

  if (opts.includeFixtures) {
    const fixtures = await clearDirContents(join(dir, "fixtures"));
    if (fixtures > 0) removed.push(`fixtures/ (${fixtures} file(s))`);
  }

  // Recreate the directory layout so the agent and console can write again
  // without a restart.
  await new Store(dir).init();
  return { removed };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dir = process.env.ANANSI_DATA ?? "data";

  if (!argv.includes("--yes")) {
    console.error(
      `refusing to clear ${dir} without --yes\n` +
        `this permanently deletes incidents, runs, snapshots, the audit log and credit accounting\n` +
        `  npm run store:clear -- --yes [--include-fixtures]`,
    );
    process.exitCode = 1;
    return;
  }

  const includeFixtures = argv.includes("--include-fixtures");
  const { removed } = await clearStore(dir, { includeFixtures });

  if (removed.length === 0) {
    console.log(`${dir} was already empty`);
    return;
  }
  console.log(`cleared ${dir}:`);
  for (const r of removed) console.log(`  - ${r}`);
  if (!includeFixtures) console.log("  (fixtures/ preserved; pass --include-fixtures to remove)");
  console.log("restart the agent so it re-registers the fleet");
}

const invokedAsScript = process.argv[1] != null && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedAsScript) {
  main().catch((err) => {
    console.error((err as Error).message);
    process.exitCode = 1;
  });
}
