# ANANSI

**A guarded self-healing control plane for Bright Data scraper fleets.**

Bright Data Scraper Studio can generate a repair for a broken scraper, but an
operator still has to notice the failure, explain it, and decide whether the
repair is safe. ANANSI closes that loop:

1. discovers collectors and reads completed jobs;
2. detects hard failures and plausible-but-wrong output;
3. diagnoses page drift from archived DOM snapshots;
4. asks Scraper Studio to produce a candidate repair;
5. verifies preview rows against contracts, invariants, and golden records; and
6. approves a passing repair or rejects and quarantines a failing one.

ANANSI is a **monitor, not a scheduler**. It never starts a collection. Bright
Data owns collection cadence, while ANANSI observes the jobs that already ran.
The write-side adapter deliberately has no trigger method; see
[ADR-004](docs/decisions/004-monitor-not-scheduler.md).

## Safety model

- **No blind auto-approval.** Candidate repairs stop at Bright Data's approval
  gate and must pass deterministic verification.
- **Access failures are never healed.** Blocks, captchas, and proxy failures are
  routed to infrastructure handling rather than code generation.
- **Two failed repairs quarantine the collector.** This caps spend and prevents
  an unattended repair loop.
- **No-contract collectors remain human-gated.** They are monitored for platform
  failures, but ANANSI will not approve a repair without data to verify.
- **The next scheduled job confirms production behavior.** A promoted collector
  remains in `watching` until Bright Data's next real run passes.

## Architecture

```mermaid
flowchart TD
    P["POLL<br/>discover collectors and completed jobs"] --> S["SENSE<br/>job health and contract signals"]
    S --> T{"TRIAGE"}
    T -->|"blocked / captcha / proxy"| I["INFRA<br/>never heal"]
    T -->|"transient"| R["RETRY<br/>wait for the next scheduled job"]
    T -->|"page drift"| D["DIAGNOSE<br/>archived DOM diff to bounded prompt"]
    D --> H["HEAL<br/>Bright Data candidate repair"]
    H --> V{"VERIFY<br/>contract + invariants + goldens"}
    V -->|"pass"| A["APPROVE"]
    V -->|"no contract"| U["HUMAN APPROVAL"]
    V -->|"fail"| X["REJECT AND RETRY"]
    X -->|"two attempts"| Q["QUARANTINE"]
    A --> W["WATCHING"]
    W -->|"next scheduled job passes"| OK["HEALTHY"]
    W -->|"next scheduled job fails"| Q
```

Detailed design:

- [Architecture](docs/architecture.md)
- [Data contracts and detection](docs/data-contract.md)
- [Architecture decisions](docs/decisions/)
- [Bright Data integration notes](docs/brightdata-notes.md)

## Requirements

- Node.js 22 or newer
- npm 10 or newer
- A Bright Data API key with access to the collectors being monitored
- The Bright Data CLI for the `real` heal adapter
- Docker with Compose for container deployment

## Configuration

Copy the environment template and fill in the required values:

```bash
cp .env.example .env
```

| Variable | Default | Purpose |
|---|---|---|
| `BRIGHTDATA_API_KEY` | none | Required for collector discovery and job history |
| `ANANSI_ADAPTER` | `real` | `real` uses the Bright Data CLI; `fake` keeps writes offline |
| `ANANSI_POLL_SECONDS` | `10` | Job-history polling interval |
| `ANANSI_LAB_PORT` | `4600` | Host port for local access to the production Mutation Lab |
| `ANANSI_CONTRACTS` | `contracts` | Directory containing optional YAML contracts |
| `ANANSI_DATA` | `data` | Runtime state, snapshots, job ledger, and audit log |
| `GEMINI_API_KEY` | none | Optional LLM prompt generation; deterministic fallback otherwise |

Contracts are optional overlays keyed by `collector_id`. A collector without a
contract is still discovered and monitored, but its repair remains at the human
approval gate because ANANSI has no trustworthy output specification to apply.
Copy [the Lab contract template](contracts/examples/lab-storefront.yaml) into
`contracts/`, then replace its collector ID. Its canary URLs already point to
`https://anansi-lab.akshatkatiyar.com/`.

## Development

Install both the backend and console dependencies:

```bash
npm ci
npm ci --prefix apps/console-ui
```

Run the complete validation suite:

```bash
npm run check
```

Useful development commands:

```bash
npm run monitor             # monitor worker
npm run console             # console on http://localhost:4700
npm run lab                 # production Mutation Lab on http://localhost:4600
npx tsx scripts/seed-demo.ts
```

The fake adapter replaces only the write seam. Collector discovery and job
history always use Bright Data's REST API, so `BRIGHTDATA_API_KEY` is required
in both modes:

```bash
BRIGHTDATA_API_KEY=... ANANSI_ADAPTER=fake npm run monitor
```

## Container deployment

The default Compose file runs the agent, the open read-only console, and the
production Mutation Lab:

```bash
docker compose up --build -d
```

The Lab is served publicly at
[`https://anansi-lab.akshatkatiyar.com/`](https://anansi-lab.akshatkatiyar.com/)
so Bright Data can collect it. Its `/__control` route is intentionally able to
change the storefront markup.

The console has no built-in authentication and is bound to `127.0.0.1:4700` by
default. Any client that can reach the console can read it, so change that
binding only when the network exposure is intentional.

Use the demo overlay only to switch the write adapter to fake mode:

```bash
docker compose -f docker-compose.yml -f docker-compose.demo.yml up --build
```

See [the Coolify deployment guide](docs/deploy-coolify.md) and
[the operations guide](docs/operations.md) for network exposure, backups,
quarantine recovery, and safe shutdown procedures.

## Bright Data integration

| Bright Data primitive | ANANSI usage |
|---|---|
| Collector and job REST APIs | Discover the fleet and read jobs that already completed |
| Dataset and per-input error APIs | Evaluate output and recover row-level failure causes |
| `tag_html()` | Capture scraper-visible HTML when the scraper emits it |
| `scraper heal` | Generate a candidate repair from a bounded diagnosis prompt |
| `awaiting_approval` and `preview_result` | Hold the candidate while verification runs |
| `scraper approve --auto-save` | Publish only a verified repair |
| `scraper approve --reject` | Discard a failing candidate before retrying |

The real adapter is implemented in
[packages/adapters/brightdata/real.ts](packages/adapters/brightdata/real.ts);
the offline write adapter is
[packages/adapters/brightdata/fake.ts](packages/adapters/brightdata/fake.ts).

## Repository layout

| Path | Purpose |
|---|---|
| `apps/agent/` | Polling monitor, incident driver, archive, and operator commands |
| `apps/console/` | Read-only data API, agent reset proxy, and SSR fallback |
| `apps/console-ui/` | React console |
| `apps/ui/` | Production Mutation Lab served at `anansi-lab.akshatkatiyar.com` |
| `packages/core/` | Pure sensing, diagnosis, and verification engines |
| `packages/adapters/` | Bright Data, storage, and LLM I/O |
| `contracts/` | Optional per-collector data contracts |
| `scraper/` | Example Scraper Studio implementation |
| `test/` | Offline unit and integration tests |

## Operational limits

- Run exactly one agent replica against a data volume. The file-backed job
  ledger is not a distributed lock.
- Back up the data volume. Bright Data retains source results for a limited
  period, while ANANSI's incident and snapshot store is the long-term record.
- Plain HTTP archive captures are lower fidelity than Bright Data's browser
  rendering. JS-heavy, geo-gated, and challenged pages are marked
  low-confidence and are not used to generate confident repairs.
- The console exposes collected values and incident evidence without built-in
  authentication. Its Danger zone can also erase the full runtime store after
  typed confirmation. Any client that can reach the console can use it.

## Development disclosure

AI coding assistants were used during development. Architecture, statistical
choices, verification rules, and production changes remain reviewable in the
ADRs, tests, and commit history.
