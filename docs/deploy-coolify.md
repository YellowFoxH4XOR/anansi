# Deploying ANANSI on Coolify

Three containers, two public URLs:

| Service | URL | What it is |
|---|---|---|
| `lab` | `https://lab.<your-domain>` | The Mutation Lab storefront — the patient. Public because Bright Data's cloud scrapers have to reach it. |
| `console` | `https://console.<your-domain>` | The monitoring console — incident trace, split diff, fleet. |
| `agent` | *(no URL)* | The scheduler: sense → diagnose → heal → verify → promote. A worker; the console is how you watch it. |

`console` and `agent` share the `anansi-data` volume — the agent is the only
writer, the console only reads. That is why all three live in **one** Coolify
resource: separate applications cannot share a volume.

```
        internet ─→ lab (:4600) ←── Bright Data scrapers
                     ▲
                     │ canary sweeps
        internet ─→ console (:4700) ──reads──┐
                                             ├── anansi-data volume
                     agent ────────writes────┘
```

## 1 · Create the resource

In your Coolify project: **+ New → Docker Compose**, point it at this repository
(branch `main`), and set the compose file to `docker-compose.yml`. Coolify reads
the `SERVICE_FQDN_*` entries and provisions one domain per service.

## 2 · Set the domains

Coolify generates two domains from the compose file — `SERVICE_FQDN_LAB_4600`
and `SERVICE_FQDN_CONSOLE_4700`. Override them with your own hostnames under
each service's **Domains** field if you want something friendlier than the
generated `lab-xxxx.your-server.sslip.io`.

The Lab must be reachable from the public internet. The console does not have to
be — it just has to be reachable by *you*.

## 3 · Environment variables

Set these on the resource (Coolify → Environment Variables). Every one has a
working default, so a first deploy with none of them set will run in rehearsal
mode against the internal Lab.

| Variable | Default | Meaning |
|---|---|---|
| `ANANSI_ADAPTER` | `live` | `live` = rehearsal (real fetches, simulated heals, no credits) · `real` = the Bright Data CLI · `fake` = banked fixtures |
| `ANANSI_LAB_BASE` | `http://lab:4600` | Origin the canary URLs are rewritten to. Internal DNS is fine for rehearsal; **real mode needs the public Lab URL** (see below) |
| `ANANSI_CADENCE_MINUTES` | contract value (30) | Sweep interval. Set `1`–`2` for a live demo so a fired mutation shows up in the console within a minute |
| `WITH_BRIGHTDATA_CLI` | `false` | Build arg — installs the `brightdata` CLI into the agent image. Flip to `true` for real mode |
| `ANTHROPIC_API_KEY` | *(unset)* | Optional. Claude writes the heal prompt; without it the deterministic template renderer is used |

## 4 · Deploy, then break something

1. Deploy. Watch the agent's logs — you want `ANANSI scheduler: 1 contract(s)`.
2. Open the console. The fleet shows `lab-storefront · healthy` after the first sweep.
3. Open `https://lab.<your-domain>/__control` and fire **M2 · Silent injection**.
4. Within one cadence the console opens an incident, diagnoses it, runs the
   gates and promotes the fix. The fleet card's sparkline dips to `12.99` and
   comes back to `49.99` — the whole incident in one glance.

## Rehearsal mode vs. the real thing

`ANANSI_ADAPTER=live` is **rehearsal mode**, and the console labels it as such
with an amber `rehearsal` badge in the masthead:

- Canary sweeps are real HTTP fetches of the deployed Lab, parsed with the same
  selectors as the hand-authored Studio scraper, so sense / diagnose / verify all
  run against live DOM.
- Heals are **simulated** — no Bright Data call is made, and every
  `diff_summary` is stamped `[SIMULATED HEAL — rehearsal mode, no Bright Data
  call, no credits spent]`, which is what the console's trace and diff pages
  render.
- "Credits spent" is counting page loads, not Bright Data credits.

It exists so the hosted console has a working loop before the account is wired,
and as the demo fallback. **It is not the graded path** — the submission runs the
real adapter.

### Switching to the real adapter

1. `brightdata scraper create` with `scraper/lab-scraper.js`, then put the
   collector id in `contracts/lab-storefront.yaml`.
2. Point the canaries at the **public** Lab URL:
   `ANANSI_LAB_BASE=https://lab.<your-domain>`. This matters — the scrape runs on
   Bright Data's machines, so `http://lab:4600` is unreachable to them.
3. Set `WITH_BRIGHTDATA_CLI=true` and redeploy so the CLI is in the image.
4. Authenticate the CLI inside the agent container (`brightdata login`), or mount
   its credentials — see [brightdata-notes.md](brightdata-notes.md).
5. Set `ANANSI_ADAPTER=real`. The rehearsal badge disappears.

Mind the budget once you switch: every canary in the contract is one page load
per sweep, so a 1-minute cadence over four canaries is ~5,760 loads a day. Put
`ANANSI_CADENCE_MINUTES` back to 30 for anything unattended.

## Running the same stack locally

```bash
docker compose up --build          # lab :4600 · console :4700 · agent
```

Add port mappings if you want to reach them from the host — Coolify handles that
through its proxy, plain Docker does not.

## Notes

- **`/__control` is unauthenticated.** Anyone with the Lab URL can break the
  shop. That is the point of a demo lab; never put anything real behind it.
- **The agent is the only writer.** Scaling it past one replica would mean two
  schedulers racing on the same store — don't.
- **The volume is the system of record.** Bright Data retains results for
  7–16 days; `anansi-data` holds the incidents, snapshots and audit log
  permanently. Back it up before you tear the resource down.
- **`state.json` is mtime-cached**, which is what lets a separate console
  process notice the agent's writes. See `adapters/store/index.ts`.
