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

The console health endpoint is `GET /api/state` and requires the same HTTP Basic
Auth credentials as the UI. The agent has no HTTP listener; use its container
status and logs to confirm successful polling.

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

## Clear a non-production store

The destructive clear command requires explicit confirmation:

```bash
npm run store:clear -- --yes
```

Use it only for disposable local or demonstration data. Restart the agent
afterward so it re-discovers the fleet.

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
