// Read-only diagnostics against the live account.
//
// Strictly GETs — the same four endpoints the monitor uses, nothing else. It
// cannot start a collection, cannot heal, cannot approve, and spends no page
// loads. Run it inside the agent container, where BRIGHTDATA_API_KEY already is:
//
//   npm run probe
//
// It exists because the monitor's decisions turn on fields the docs describe
// loosely — is `finished` present? does `status` ever arrive? — and guessing at
// those from a log line is how we get bugs like a preview run being deferred
// forever. This prints what the platform actually returns.

import { apiFromEnv, BrightDataApiError, type Job } from "../packages/adapters/brightdata/api.js";
import { classifyJob, isTerminal } from "../packages/core/sense/job-health.js";

const DAY_MS = 24 * 60 * 60_000;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function describeJob(j: Job): string {
  const present = (["status", "queued", "started", "finished", "inputs", "page_loads", "total_pages", "failed_pages", "data_lines", "expired"] as const)
    .filter((k) => j[k] !== undefined)
    .map((k) => `${k}=${JSON.stringify(j[k])}`)
    .join(" ");
  return `${j.id}\n    fields: ${present || "(none beyond id)"}\n    terminal: ${isTerminal(j)}`;
}

async function main(): Promise<void> {
  const api = apiFromEnv();
  if (!api) throw new Error("BRIGHTDATA_API_KEY is not set in this environment");

  const now = Date.now();
  const lookbackDays = Number(process.argv[2] ?? 16);

  const collectors = await api.collectors();
  console.log(`\n=== collectors_list — ${collectors.length} scraper(s) ===`);
  for (const c of collectors) console.log(`  ${c.id}  active=${c.active}  name=${JSON.stringify(c.name)}  last_run=${c.last_run}`);

  for (const c of collectors) {
    if (!c.id) continue;
    const jobs = await api.jobs({ collector: c.id, fromDate: day(now - lookbackDays * DAY_MS), toDate: day(now) });

    console.log(`\n=== jobs for ${c.id} — ${jobs.length} in the last ${lookbackDays}d, in the order the API returned them ===`);
    for (const [i, j] of jobs.entries()) console.log(`  [${i}] ${describeJob(j)}`);

    for (const j of jobs) {
      // jobLog and dataset are exactly what handleJob() reads, so a failure here
      // is the failure the monitor will hit.
      const log = await api.jobLog(j.id).catch((e: unknown) => {
        console.log(`  ${j.id} jobLog  → ${(e as Error).message}`);
        return undefined;
      });
      let rows: Record<string, unknown>[] | undefined;
      try {
        const ds = await api.dataset(j.id);
        if (Array.isArray(ds)) {
          rows = ds;
          const errored = ds.filter((r) => r.error || r.error_code).length;
          console.log(`  ${j.id} dataset → ${ds.length} row(s), ${errored} carrying an error, keys=${JSON.stringify(Object.keys(ds[0] ?? {}))}`);
        } else {
          console.log(`  ${j.id} dataset → not ready: status=${ds.status}`);
        }
      } catch (e) {
        const err = e as BrightDataApiError;
        console.log(`  ${j.id} dataset → ${err.message}  permanent=${err.permanent ?? "?"}`);
      }
      // The endpoint that mattered: a failed run's dataset came back empty while
      // this held the reason. Only asked for on jobs that look failed.
      const looksFailed = (j.failed_pages ?? 0) > 0 || (log?.fails ?? 0) > 0 || (log?.success_rate ?? 1) < 1;
      if (looksFailed) {
        const errs = await api.jobErrors(j.id).catch((e: unknown) => {
          console.log(`  ${j.id} hp_errors → ${(e as Error).message}`);
          return [] as { url?: string; error?: string }[];
        });
        console.log(`  ${j.id} hp_errors → ${errs.length} error(s)${errs.length ? `: ${JSON.stringify(errs.slice(0, 3))}` : ""}`);
        if (errs.length) rows = [...(rows ?? []), ...errs.map((e) => ({ input: e.url, error: e.error }))];
      }

      const health = classifyJob(j, log, rows);
      console.log(`  ${j.id} VERDICT → outcome=${health.outcome} route=${health.route ?? "—"} unexplained=${health.unexplained} totals=${JSON.stringify(health.totals)}`);
    }
  }
  console.log("\nRead-only: nothing was triggered, nothing was spent.\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
