# Deploying ANANSI on Coolify

Three containers, two public URLs:

| Service | URL | What it is |
|---|---|---|
| `lab` | `https://lab.<your-domain>` | The Mutation Lab storefront — the patient. Public because Bright Data's cloud scrapers have to reach it. |
| `console` | `https://console.<your-domain>` | The monitoring console — incident trace, split diff, fleet. |
| `agent` | *(no URL)* | The monitor: watch Bright Data's own runs, then sense → diagnose → heal → verify → promote. A worker; the console is how you watch it. It never starts a collection ([ADR-004](decisions/004-monitor-not-scheduler.md)). |

`console` and `agent` share the `anansi-data` volume — the agent is the only
writer, the console only reads. That is why all three live in **one** Coolify
resource: separate applications cannot share a volume.

```
        internet ─→ lab (:4600) ←── Bright Data scrapers, on Bright Data's schedule
                     ▲
                     │ free archive GET (ours, no credits)
        internet ─→ console (:4700) ──reads──┐
                                             ├── anansi-data volume
                     agent ────────writes────┘
                       │
                       └── polls api.brightdata.com for job history (read-only)
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

Set these on the resource (Coolify → Environment Variables).

`BRIGHTDATA_API_KEY` is the one with no working default: the agent reads job
history over REST and has no other way to see the fleet, so it exits at startup
without one.

| Variable | Default | Meaning |
|---|---|---|
| `BRIGHTDATA_API_KEY` | *(unset)* | **Required.** Reads `collectors_list` and job history. The same key the CLI uses, so one secret covers both |
| `ANANSI_ADAPTER` | `real` | Selects the **heal** seam only: `real` = the Bright Data CLI · `fake` = banked offline fixtures. Reading job history is always REST and is never adapter-selected |
| `ANANSI_LAB_BASE` | `http://lab:4600` | Optional **fetch-side** shortcut: the archive's own free GET of a canary host is redirected here. It does **not** rewrite the contract — see below |
| `ANANSI_POLL_SECONDS` | `10` | How often the agent reads job history. Detection latency, not cost: a poll is 2-3 REST reads (~850ms each) and spends no page loads. Raise it only if the account rate-limits |
| `WITH_BRIGHTDATA_CLI` | `false` | Build arg — installs the `brightdata` CLI into the agent image. Flip to `true` before real heals |
| `GEMINI_API_KEY` | *(unset)* | Optional. Gemini writes the heal prompt; without it the deterministic template renderer is used |

> **`ANANSI_LAB_BASE` is not a way to point the contract somewhere.** A canary
> URL is the join key `evaluate()` matches dataset rows against, and Bright Data
> collects the **public** URL — so `contracts/*.yaml` must carry the public
> origin, always. This variable only redirects the archive's own GET onto the
> compose network. An earlier build rewrote the contract itself, which silently
> disabled every golden and reported a broken page as clean.

## 4 · Deploy, then break something

1. **Set the schedule in Scraper Studio.** ANANSI never triggers a collection,
   so nothing happens until Bright Data is scheduled to run the scraper. This is
   the step that replaced a cadence in our config.
2. Deploy. Watch the agent's logs — you want
   `ANANSI monitor: 1 pinned contract(s), heal adapter=real — Bright Data owns the schedule`.
3. Open the console. Every scraper on the account appears on the fleet board
   without a config edit; `lab-storefront` is the one a contract pins.
4. Open `https://lab.<your-domain>/__control` and fire **L1 · Listing tile renamed**.
5. On Bright Data's **next scheduled run**, the console opens an incident,
   diagnoses it, runs the gate and promotes the fix. Note the run reports
   SUCCESS having collected nothing at all — discovery found no links, so the
   product pages were never visited and every selector on them still works.
   Detection is bounded by that schedule, not by anything ANANSI controls.

## Offline mode

`ANANSI_ADAPTER=fake` swaps the **heal** seam for banked fixtures: no
`scraper heal`, no `approve`, no credits. Reading job history still goes over
REST and still needs a real `BRIGHTDATA_API_KEY`, because there is nothing
useful to fake about "what did the platform actually run?".

> There is no `live` value any more. The rehearsal adapter that simulated a
> scraper (`packages/adapters/brightdata/live.ts`) was deleted with the
> scheduler — ANANSI no longer fetches pages *as* the scraper, so there was
> nothing left for it to rehearse. **`ANANSI_ADAPTER=live` now falls through to
> `real`**: if you set it expecting a dry run, you will get real heals.

### Switching to the real adapter

1. `brightdata scraper create` with `scraper/lab-scraper.js`, then put the
   collector id in `contracts/lab-storefront.yaml`. A scraper with no contract is
   still discovered and still monitored — it just has no goldens.
2. **Check the output schema in Studio.** Parser output is not the production
   payload: the schema renames, retypes and silently drops fields, and it is only
   applied on Save to Production. It must declare exactly `url` (text), `title`
   (text), `price` (**number**, not the `price` type), `sale_price` (number),
   `availability` (text), `page_html` (text). A schema shipping `product_title`
   and a `price` of `{"value":49.99,"currency":"USD"}` fails two required fields
   on every canary, which routes to the **config lane** and quarantines — by
   design, because no selector edit repairs an output schema.
3. Edit the canary URLs in the contract to the **public** Lab URL. They must be
   character-for-character the URLs Bright Data collects, or the goldens join to
   nothing and check nothing. The agent logs `canary URL(s) appear in the
   collected rows` when that happens.
4. Set `WITH_BRIGHTDATA_CLI=true` and redeploy so the CLI is in the image.
5. Authenticate the CLI inside the agent container (`brightdata login`), or mount
   its credentials — see [brightdata-notes.md](brightdata-notes.md).
6. Set the collection schedule in Scraper Studio.

Budget: **page loads are Bright Data's spend now, not ours.** Polling job history
and archiving HTML are free — the archive is a plain GET that never touches
Bright Data. The only spend ANANSI still initiates is a heal, capped at 2 attempts
per incident and 3 per collector per rolling 24h, and refused outright below a
2,000-credit floor.

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
  monitors claiming the same job ledger — don't.
- **The volume is the system of record.** Bright Data retains results for
  7–16 days; `anansi-data` holds the incidents, snapshots and audit log
  permanently. Back it up before you tear the resource down.
- **`state.json` is mtime-cached**, which is what lets a separate console
  process notice the agent's writes. See `adapters/store/index.ts`.
