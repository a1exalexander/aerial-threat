# Runbooks

Operational procedures for Aerial Threat (spec doc 08). Commands assume the single-host stack in `docker-compose.prod.yml`. With managed Postgres, run the same SQL through `psql "$DATABASE_URL"`.

```sh
export GIT_SHA=$(git rev-parse --short HEAD) POSTGRES_PASSWORD=...   # URL-safe; it is embedded in DATABASE_URL
alias dc='docker compose -f docker-compose.prod.yml'                 # project name is fixed: aerial-prod
alias dsql='docker compose -f docker-compose.prod.yml exec -T db psql -U aerial -d aerial'
```

The prod stack never touches the dev database (`docker-compose.yml`, container `aerial-threat-postgres-1`). Its project, service and volume names (`aerial-prod`, `db`, `dbdata`) are all different.

## Services and configuration

| Service | Image | Notes |
| --- | --- | --- |
| `db` | `postgres:17` | Volume `dbdata`. No host port; use `dc exec db psql`. |
| `migrate` | `aerial-worker:$GIT_SHA` | One-shot `node db/migrate.js`. `api` and `worker` start only after it exits 0. |
| `api` | `aerial-api:$GIT_SHA` | `127.0.0.1:${API_HOST_PORT:-3112}`. The healthcheck calls `/health/ready`. |
| `worker` | `aerial-worker:$GIT_SHA` | Loops: `neptun`, `telegram`, `retention`. SIGTERM drains jobs for up to 30 s. |
| `web` | `aerial-web:$GIT_SHA` | nginx serves the static bundle on `127.0.0.1:${WEB_HOST_PORT:-5212}`. `PUBLIC_API_URL` is baked in at build time. |

- Images carry `APP_REVISION` and the label `org.opencontainers.image.revision`. Check with `docker inspect aerial-api:$GIT_SHA --format '{{.Config.Env}}'`.
- Server secrets go in `.env.prod`, which is gitignored and read by `api` and `worker`: `AI_GATEWAY_API_KEY`, `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `TELEGRAM_SESSION_SECRET_REF`, `OIDC_*`. Every environment gets its own Gateway key and Telegram session. Never run one Telegram session in two environments at once.
- The compose file itself sets `DATABASE_URL` (its own `db`), `APP_ENV=production` and `CORS_ORIGINS` (from `WEB_ORIGIN`). These win over `.env.prod`. For managed Postgres, run the same images on the target platform with that platform's env.
- Ports bind to `127.0.0.1` only. Public traffic goes through a TLS reverse proxy. Before exposing the API, set Fastify `trustProxy` in `apps/api`; without it the rate limit (300/min) counts every client as the proxy's IP.
- `TELEGRAM_SESSION_SECRET_REF` points at a secret file, never the session itself. Mount the file read-only, for example with a compose `secrets:` entry at `/run/secrets/telegram_session`.
- Only `VITE_*` values reach the browser. CI and the web image build both run `node scripts/check-bundle-secrets.mjs apps/web/dist`.
- The admin CLI runs in the worker image: `dc run --rm worker node dist/cli.js <command>`. With no command it prints the list.

### Database roles

In production, migrations use a separate owner role and the apps use a DML-only role. The compose stack uses the single role `aerial`, which is acceptable for a one-host deployment.

```sql
-- Run as the database owner on a fresh database, before the first migration.
CREATE ROLE aerial_migrator LOGIN PASSWORD '...';            -- migrate service only
CREATE ROLE aerial_app LOGIN PASSWORD '...';                 -- api + worker
ALTER SCHEMA public OWNER TO aerial_migrator;                -- PG 15+: PUBLIC can no longer CREATE in public
GRANT USAGE ON SCHEMA public TO aerial_app;
ALTER DEFAULT PRIVILEGES FOR ROLE aerial_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO aerial_app;
```

This was checked on `postgres:17`: the app role can read and write rows, but cannot create or drop tables.

## Deploy

1. **CI green** on the commit: frozen install, lint/typecheck/unit, build, integration, and the bundle secret check.
2. **Build immutable images** tagged with the revision: `dc build`. Keep the previous tag, because it is the rollback target.
3. **Back up**, then check the backup (next section): `dc exec -T db pg_dump -U aerial -Fc aerial > /secure/aerial-$(date +%F-%H%M).dump`. Store it off-host and never in the repo.
4. **Migrate** as a one-shot: `dc run --rm migrate`. It prints `applied: …` or `up to date`. It refuses an edited, already-applied file.
5. **Roll out**: `dc up -d api worker web`.
6. **Smoke**:
   ```sh
   curl -fsS localhost:3112/health/ready                 # {"status":"ok"}
   curl -fsS localhost:3112/v1/overview | head -c 300     # envelope with freshness, not an error
   curl -fsS localhost:3112/v1/sources | head -c 300      # source health
   curl -fsS -o /dev/null -w '%{http_code}\n' localhost:5212/   # 200
   dc logs --since 5m worker | grep -E '"level":(50|60)' || echo 'no worker errors'
   dsql -c "select kind, status, count(*) from jobs group by 1, 2"
   ```
   Also call `GET /v1/admin/ops` with a viewer token. Watch ingestion lag and the error rate for about 30 minutes.

**Schema changes are expand → migrate → contract, spread over releases.** A release adds only what the previous code tolerates: new tables, nullable columns, new indexes. Code that stops using a column ships first. A later release drops that column. Never edit an applied migration; add `packages/db/migrations/NNNN_<slug>.sql` and update `schema.ts`.

**Rollback** means code and policy only: `GIT_SHA=<previous> dc up -d --no-build api worker web`. Without `--no-build`, a missing image is rebuilt from the *current* checkout under the old tag. Keep the previous images on the host or in a registry. Because migrations are expand-only, the previous code still runs. There are no automatic down-migrations. A destructive fix is a new, reviewed migration run by hand after a fresh backup.

## Backup and restore check

The targets are RPO ≤ 15 min and RTO ≤ 2 h. They need a managed Postgres with PITR. With the daily `pg_dump` above, the real RPO is 24 h. Record whichever applies. Restore into a scratch database before relying on a backup:

```sh
dc exec -T db createdb -U aerial restore_check
dc exec -T db pg_restore -U aerial -d restore_check --no-owner < /secure/aerial-<stamp>.dump
dc exec -T db psql -U aerial -d restore_check -c "select max(filename) from schema_migrations" \
  -c "select count(*) from messages" -c "select max(observed_at) from message_revisions"
dc exec -T db dropdb -U aerial restore_check
```

## Retention

The worker's `retention` loop runs at start and then hourly (±10 %). Its policy is `RETENTION_POLICY` in `apps/worker/src/loops/retention.ts` (`retention-v1`):

| Data | Kept | Action |
| --- | --- | --- |
| `message_revisions` raw payload and the raw, normalized and cleaned post text; `alert_snapshots.raw_payload` | 30 d | Payloads are set to null and texts to `''`. IDs and hashes stay, so provenance links survive. |
| `jobs` with status `done` | 14 d | Deleted. `dead` jobs stay until an operator deals with them. |
| `incidents` with their `incident_evidence` and summary, `audit_log`, and `alert_snapshots` rows that no `alert_states` row still references | 180 d | Deleted. |
| Process logs | log driver | Compose keeps 5 × 10 MB per container. A hosted platform must be set to about 14 d. |

- **Ages count from storage time** (`observed_at`, `fetched_at`, `created_at`), not post time. An archive import of old posts is therefore not purged on arrival.
- **Claims keep their structured, rule-extracted fields** (place, type, quantity, direction mention) and their evidence spans, which point at the scrubbed revision. `retention-v1` does not delete claims; they are small rows.
- **No projection may copy full post text.** Read APIs take evidence text from the revision, so it disappears at 30 d.
- **Import only exports from inside the 30-day window.** Re-importing an unchanged post stays `unchanged`. But if the post was edited since, `ingestMessage` makes the matching old revision current again, and that revision's text is already scrubbed.

Each pass logs `retention pass done` with counts. A failing step is logged as `retention step failed`, and the other steps still run. To force a pass, restart the worker. Do not shorten the windows ad hoc; change the policy and bump its version.

## Telegram authorization lost

**Symptoms:** the telegram loop logs an auth error, `source_health.error_kind` is set, and `GET /v1/admin/ops` shows the connector unavailable. The API and NEPTUN keep working.

1. Confirm: `dsql -c "select s.username, h.error_kind, h.last_success_at from source_health h join sources s on s.id = h.source_id"`.
2. Do not restart the worker in a loop. The collector stops only itself and does not retry the login.
3. Re-authorize the service account with the interactive Telegram login admin command (`dc run --rm -it worker node dist/cli.js` lists it). Write the new session to the secret that `TELEGRAM_SESSION_SECRET_REF` points to, then `dc restart worker`.
4. The collector backfills about 24 h on reconnect. If the outage was longer, import a Telegram Desktop export for the gap (`node dist/cli.js import --file …`). Treat anything outside that as possibly lost.

## Gateway outage or budget exhausted

**Symptoms:** AI failures or the circuit breaker in `GET /v1/admin/ops`, `process_revision` jobs piling up, and budget warnings at 50, 80 and 100 %.

1. NEPTUN alerts and ingestion keep running. The UI shows claims as unevaluated rather than hiding the gap.
2. Check the Vercel AI Gateway status and usage. With a 401 or 403, rotate `AI_GATEWAY_API_KEY` in `.env.prod`, then `dc up -d worker`.
3. If the budget is exhausted, wait for the daily reset or raise `AI_DAILY_REQUEST_LIMIT` within the agreed budget. Never switch models automatically.
4. Watch the backlog against the storage budget: `dsql -c "select kind, count(*), now() - min(created_at) as oldest from jobs where status in ('queued','failed') group by 1"`. If it grows too large, pause archive imports and replays first.
5. After recovery, queue priority processes live updates first, then live posts, then archive. No action is needed.

## NEPTUN outage

**Symptoms:** `alert_states.freshness` turns `stale` (after 30 s), then `unknown` (after 120 s). States never flip to inactive or "safe".

1. Check the provider: `curl -sS -o /dev/null -w '%{http_code}\n' https://neptun.in.ua/api/v1/alerts`.
2. The loop reconnects with backoff and polls REST (≥ 5 s apart). The last known state stays visible and marked stale.
3. After recovery it takes a full snapshot automatically. Verify with `dsql -c "select freshness, count(*) from alert_states group by 1"`.
4. Schema drift shows up as invalid snapshots: `dsql -c "select fetched_at, error from alert_snapshots where not valid order by fetched_at desc limit 5"`. Fix the adapter; do not hand-edit the states.

## Wrong merge

1. An operator splits the incident in the review UI or admin API, with a reason. The command checks `expectedVersion` and writes `audit_log` in the same transaction.
2. The split enqueues rebuilds of the incident, its summary and dependent projections. Check that the incident's `revision` went up and that no `rebuild_incident` job is `dead`.
3. Add the case as a redacted regression fixture (`packages/test-fixtures`) with a test in `packages/domain/src/aggregation`, so the merge rule cannot regress.

## Poison jobs (dead letter)

A job that fails `max_attempts` times, or whose lease expires on its last attempt, becomes `dead`.

1. Inspect: `dsql -c "select id, kind, dedupe_key, attempts, left(last_error, 200) from jobs where status = 'dead' order by updated_at desc limit 20"`.
2. Fix the cause and ship it (deploy steps above).
3. Replay under the fixed version. Prefer the operator reprocess command, which creates a new versioned job and an audit row. Use SQL only as a last resort, one job at a time:
   `dsql -c "update jobs set status='queued', attempts=0, next_attempt_at=now(), lease_owner=null, lease_until=null, finished_at=null where id='<id>' and status='dead'"`.
   A unique violation on `jobs_dedupe_active_key` means the same work is already queued; leave the dead row.

## Database unavailable

**Symptoms:** `/health/ready` returns 503. The worker loops crash, and the supervisor restarts them every 5 s.

1. Connectors do not advance durable checkpoints without a commit, so accepted data is not acknowledged as stored.
2. Restore the database: `dc ps db`, `dc logs db`, disk space, or the managed provider's status. If data is lost, restore from backup (section above).
3. After recovery the API turns ready by itself. Telegram backfills its window and NEPTUN takes a fresh snapshot. Check `source_health` and the queue (commands above).
4. Record any gap longer than the source's backfill window as possible data loss in the incident log.
