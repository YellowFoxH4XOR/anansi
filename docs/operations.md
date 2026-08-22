# Operations

ANANSI stores collector state, incidents, snapshots, audit events, and its
at-most-once job ledger under `ANANSI_DATA`. Treat that directory or mounted
volume as the system of record.

## Start and health checks

For a container deployment:

```bash
docker compose up --build -d
docker compose ps
```

The open console health endpoint is `GET /api/state`; it does not require
credentials. The production Lab health endpoint is
`https://anansi-lab.akshatkatiyar.com/__state`. The agent's control listener is
reachable only inside the Compose network on port `4800`; no host port is
published. Use the agent's container status and logs to confirm polling.

The startup log should identify the number of pinned contracts and the selected
heal adapter. An unknown `ANANSI_ADAPTER` value is rejected at startup rather
than silently enabling real writes.

## Backups

Back up the `anansi-data` volume on the same schedule as other operational
state. A backup must include the whole directory so incident records and their
content-addressed snapshots stay consistent.

Stop the agent or snapshot the volume atomically before copying it. Restoring
only `state.json` is not sufficient: diagnosis evidence and the handled-job
ledger live in adjacent files.

## Upgrade an existing data volume

The Node process runs as the unprivileged `node` user (UID/GID 1000). A volume
created by an older root-running image may still be owned by root. The agent
entrypoint now detects an unmigrated volume, changes its ownership once, writes
`/data/.anansi-node-owned-v1`, and then drops to UID/GID 1000 before starting
Node.

Back up the volume before the first upgraded start. The one-time recursive
ownership pass can make startup slower when the snapshot archive is large. Do
not make the volume world-writable as a workaround.

If a platform overrides the image entrypoint, run the migration manually before
starting the agent:

```bash
docker compose run --rm --user root agent chown -R node:node /data
```

## Recover a quarantined collector

Quarantine is sticky. Fix the underlying scraper or access problem first, then
inspect the held collectors:

```bash
npm run collector:release
```

Release one collector and re-offer its deferred jobs on the next poll:

```bash
npm run collector:release -- <collector-name>
```

To reset detector persistence after an operator has repaired the collector:

```bash
npm run collector:reset -- <collector-name> "reason for reset"
```

Both commands preserve incidents, runs, snapshots, and audit history. Do not
clear the store to recover a collector; deleting snapshots removes the baseline
needed to diagnose the next failure.

## Reset all console state

The Fleet page contains an open **Danger zone** action. Expanding it and typing
`RESET ALL STATE` permanently removes:

- incidents and run history;
- snapshots and audit events;
- the handled-job ledger;
- detector state and monitor cursors; and
- heal-attempt accounting.

The console delegates the operation to the agent's internal control listener,
so the agent remains the only writer to the data volume. The monitor pauses,
clears runtime state, reloads only current collector identity from Bright Data,
and then resumes normal polling. Development heal fixtures are preserved.

The action returns `409` while a poll or heal is in progress. Wait for that work
to finish and retry.

The console has no authentication. Any visitor who can reach it can perform
this reset. Keep the console's network exposure consistent with that choice and
take a backup before using the action on data that matters.

The CLI remains available when the console is not running:

```bash
npm run store:clear -- --yes
```

A CLI clear happens outside the live agent process, so restart the agent after
it completes.

## Real and fake adapters

`ANANSI_ADAPTER=fake` prevents heal, approve, and reject writes. Reads still use
the live Bright Data REST API and still require `BRIGHTDATA_API_KEY`.

Before enabling `ANANSI_ADAPTER=real`:

1. install the Bright Data CLI in the agent image;
2. verify non-interactive authentication;
3. confirm contracts reference the exact URLs present in dataset rows;
4. verify the Scraper Studio output schema includes every required field; and
5. take a current data-volume backup.

## Scaling and shutdown

Run one agent replica per data volume. Multiple console replicas may read the
same volume, but only the agent may write it.

The agent stops scheduling polls on `SIGTERM` or `SIGINT`. The console stops
accepting new connections and drains its HTTP server. Use the platform's normal
grace period rather than sending an immediate kill.
