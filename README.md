# Aerial Threat

This app aggregates air-threat posts from Telegram channels and classifies them with Jev through the Vercel AI Gateway. It shows them next to NEPTUN alert states. It is a pnpm and Turborepo monorepo: TypeScript (strict), ESM, and `@aerial/*` packages.

## Setup

```sh
nvm use                           # Node 22 (.nvmrc)
corepack enable                   # pnpm 10.22 (packageManager)
docker compose up -d postgres     # Postgres 17 on 127.0.0.1:54329, user/pass/db aerial
cp .env.example .env              # never commit .env
pnpm install
pnpm db:migrate                   # applies packages/db/migrations/*.sql
pnpm dev                          # api (tsx watch), worker (tsx watch), web (vite)
```

## Commands

| Command | What it does |
| --- | --- |
| `pnpm build` | Bundles `apps/*` into `dist/` (api/worker with tsup, web with Vite). Packages are JIT TS source and have no build step. |
| `pnpm lint` / `pnpm typecheck` | Runs ESLint with import boundaries, and `tsc --noEmit`. |
| `pnpm test:unit` | Runs pure vitest tests (`*.test.ts`, excluding `*.int.test.ts`). |
| `pnpm test:integration` | Runs `*.int.test.ts` against Postgres (`TEST_DATABASE_URL`). Not cached. |
| `pnpm db:migrate` | Applies pending SQL migrations to `DATABASE_URL`. A rerun is a no-op. |
| `pnpm --filter @aerial/worker cli <import\|replay\|eval-live\|mint-dev-token>` | Runs admin/dev commands. |

## Kremenchuk situation screen

`GET /v1/situation` returns a `SituationResponse` (`@aerial/contracts`): the NEPTUN state of Кременчуцький район, the alert tile (`situationTile`: alert / threat / clear / unknown), statuses aggregated from the `KREMENCHUK_SOURCES` channels, and a feed of their relevant posts. The worker's `situation` loop writes the statuses to `situation_snapshots`: a free rules snapshot every `SITUATION_RULES_INTERVAL_S`, and AI (`AI_EVALUATOR=fake|gateway`) only on new posts, at most every `SITUATION_ALERT_INTERVAL_S` during an alert and every `SITUATION_QUIET_AI_INTERVAL_S` without one. Every variable, with its default, is in `.env.example`.

To run the web without a backend, use the msw mocks: `VITE_MOCKS=1 pnpm --filter @aerial/web dev`.

## Layout and boundaries

- `apps/api`: Fastify 5 read and operator API. `apps/worker`: connectors, job loops, CLI. `apps/web`: React 19 + Vite.
- `packages/contracts` is the bottom layer (zod schemas and DTOs). `domain` and `geo` are pure. `telegram`, `neptun` and `ai` are adapters. `db` holds the schema, migrations, queue, `ingestMessage` and repositories. `config` parses server env. `observability` provides the pino logger and trace context.
- Lint enforces two import rules. No app imports another app. `apps/web` may import only `@aerial/contracts` and `@aerial/geo/geometry` from the workspace, and no Node built-ins. Only `VITE_*` env reaches the browser.
- Migrations are plain SQL files `packages/db/migrations/NNNN_<slug>.sql`, applied in filename order and tracked in `schema_migrations` with a checksum. **Never edit an applied file**, because the runner refuses. Add a new file and update `packages/db/src/schema.ts` to match; `schema.int.test.ts` checks that the two agree.

## Testing with the shared database

All integration tests share one Postgres (docker compose locally, a service container in CI). `createTestDb()` from `@aerial/db/testing` connects to `TEST_DATABASE_URL`, which defaults to `postgres://aerial:aerial@localhost:54329/postgres`. It creates a random `aerial_t_<hex>` database, runs migrations, and returns `{ db, sql, url, drop }`. Test files therefore run in parallel without touching each other or the dev `aerial` database. Call `drop()` in `afterAll`.

## Data rules

Never commit raw Telegram exports (`result.json` is gitignored), sessions, `.env` files or personal data. The repo is public, so fixtures must be redacted (see `packages/test-fixtures`). Telegram IDs are decimal strings in JS and `bigint` in SQL. Timestamps are stored in UTC and displayed in `Europe/Kyiv`. AI never changes alert state. Missing data is `stale`/`unknown`, never "safe".
