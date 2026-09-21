# 0002. PostgreSQL, SQL-file migrations and an in-database job queue

Status: accepted (2026-09-21)

## Context

Ingestion must write a revision and its processing job atomically (doc 03). Several units change the schema in parallel. Deploys must allow expand → migrate → contract, with no automatic destructive rollback (doc 08).

## Decision

- **PostgreSQL 17** is the single source of truth. drizzle-orm provides typed queries and the schema mirror (`packages/db/src/schema.ts`).
- **Migrations are plain SQL files** `packages/db/migrations/NNNN_<slug>.sql`. They are applied in filename order, each in its own transaction, under an advisory lock, and tracked in `schema_migrations` with a checksum. An edited applied file is refused. `schema.int.test.ts` checks that `schema.ts` and the SQL agree. There is no drizzle-kit journal, so parallel branches only add files.
- Migrations run as a **one-shot** step (`migrate` service / `node db/migrate.js` in the worker image) before new code rolls out. In production a separate migrator role owns the schema and the apps use a DML-only role (see `docs/runbooks.md`).
- **The queue is the `jobs` table**: `FOR UPDATE SKIP LOCKED`, lease plus heartbeat, retry with backoff, and a `dead` state after `max_attempts`. Priorities run live edits first, then live posts, then archive. A partial unique index on `dedupe_key` keeps one live job per unit of work. Completing a job and applying its result happen in one transaction.
- **Retention** is a worker loop with a versioned policy (`retention-v1`). Post text and raw payloads are scrubbed after 30 days, keeping IDs and hashes. Done jobs are deleted after 14 days, and incidents and audit after 180 days. Every age counts from storage time, not post time.

## Consequences

- There is no Redis or broker to run. Queue throughput is bounded by Postgres, which is ample for two channels. Revisit this only on measured lag.
- Schema changes need discipline: additive first, drop later, never edit an applied file. There are no down-migrations.
- Physical retention and display freshness are separate mechanisms. Scrubbed revisions keep their IDs and hashes, so provenance links survive, and re-importing an unchanged post stays `unchanged` without bringing the text back. Imports should stay inside the 30-day window: a post edited since then would be re-pointed at its scrubbed revision (see the runbook).
- Incidents, including their summaries, are aggregates deleted after 180 days. Claims keep their structured fields; `retention-v1` does not delete them (they are small rows), and deleting them at 180 days is a later policy version. No projection may copy full post text.
