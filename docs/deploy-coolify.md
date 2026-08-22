# Deploying ANANSI on Coolify

The production Compose stack contains two services:

| Service | Exposure | Purpose |
|---|---|---|
| `agent` | private worker | Discovers collectors, evaluates completed jobs, and drives guarded repairs |
| `console` | open HTTP | Read-only fleet, incident, and diagnosis UI |

Both services mount `anansi-data`. The agent is the only writer; the console
mounts the same volume read-only.

## Prerequisites

- A Bright Data API key with access to the collectors being monitored
- Persistent volume backups
- An intentional network-exposure policy for the open console

## Create the resource

In Coolify, create a Docker Compose resource from this repository and use
`docker-compose.yml`.

Configure a domain for the console's internal port `4700`. Do not expose the
agent: it has no HTTP listener and needs only outbound access to Bright Data and
the configured canary sites.

## Environment

Set these variables on the Compose resource:

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `BRIGHTDATA_API_KEY` | yes | none | Collector discovery and job-history reads |
| `ANANSI_ADAPTER` | no | `real` | `real` for CLI writes; `fake` for offline writes |
| `WITH_BRIGHTDATA_CLI` | no | `true` | Installs the CLI in the agent image |
| `ANANSI_POLL_SECONDS` | no | `10` | Job-history polling interval |
| `GEMINI_API_KEY` | no | none | Optional LLM prompt generation |

`ANANSI_ADAPTER` selects only the heal/approve/reject seam. REST reads remain
live in both modes and always require `BRIGHTDATA_API_KEY`.

## Deploy

1. Set the environment values before the first build.
2. Deploy the Compose resource.
3. Confirm the `agent` log reports its contract count and selected adapter.
4. Open `/api/state` through the console domain and verify it responds without
   credentials.
5. Confirm the fleet matches the collectors visible in Bright Data.
6. Configure collection schedules in Scraper Studio. ANANSI does not start
   collections.

When `ANANSI_ADAPTER=real`, confirm the Bright Data CLI can authenticate
non-interactively inside the agent container before allowing a repair incident.

## Contracts

Collectors are auto-discovered. Contracts are optional and join to collectors
by `collector_id`.

Canary URLs must exactly match the `input.url` values emitted by the production
dataset. Scraper Studio's output schema must retain every field required by the
contract, including `input.url` when row attribution is needed.

## Console exposure

The console contains collected values, incident evidence, and DOM snapshots.
It has no built-in authentication and is open to every client that can reach
it. The default local Compose binding is loopback-only. In Coolify, configure
the domain and network policy deliberately:

- keep the console private when possible;
- use a Coolify or upstream access-control layer if the network is untrusted;
- terminate TLS at the proxy when exposing it over a network; and
- do not place the agent on a public route.

## Optional Mutation Lab

The Mutation Lab is a testing fixture, not a production dependency. Deploy it
as a separate Coolify resource from `apps/ui/Dockerfile` only when you need a
controlled breakage target.

For local evaluation, use the Compose overlay:

```bash
docker compose -f docker-compose.yml -f docker-compose.demo.yml up --build
```

The Lab's `/__control` endpoint is intentionally unauthenticated and can change
the served markup. Never point it at real data or expose it as a production
service.

## Persistence and scaling

- Back up the complete `anansi-data` volume. Bright Data's result retention is
  shorter than ANANSI's audit requirements.
- Run exactly one agent replica per data volume. The file-backed job ledger is
  not a distributed lock.
- Console replicas may share a read-only snapshot of the volume, but a single
  console is sufficient for the default deployment.
- Follow [the operations guide](operations.md) for collector recovery and
  destructive store maintenance.
