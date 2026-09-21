import { setTimeout as sleep } from 'node:timers/promises';
import type { Database } from '@aerial/db';
import type { Logger } from '@aerial/observability';
import type { Loop } from './index';

/**
 * Storage retention (doc 03 «Індекси та зберігання»). Bump `version` whenever a value changes.
 * Physical retention only: display freshness/TTL of an incident is a different mechanism.
 */
export const RETENTION_POLICY = {
  version: 'retention-v1',
  /** Post text (raw/normalized/cleaned) and raw payloads of message revisions; alert snapshot payloads. */
  rawDays: 30,
  /** Finished jobs. Process logs go to stdout; their retention belongs to the log driver/host. */
  opsDays: 14,
  /**
   * Aggregates: incidents with their evidence links and summaries, audit_log, alert snapshot rows. Claims keep their
   * structured, rule-extracted fields; no projection may copy full post text (read APIs take it from the revision).
   */
  aggregateDays: 180,
} as const;

const DAY_MS = 86_400_000;
const INTERVAL_MS = 60 * 60_000;

type Sql = Database['sql'];

/**
 * One retention pass. Each batch is one short statement (its own transaction) using SKIP LOCKED, so passes are
 * idempotent and safe on several workers. Revisions keep id + hash, so provenance links and re-import dedupe survive.
 * A failing step is logged and does not block the others; the next pass retries it.
 */
export async function runRetention(
  sql: Sql,
  { now, logger, batchSize = 500, signal }: { now: Date; logger: Logger; batchSize?: number; signal?: AbortSignal },
): Promise<Record<string, number>> {
  // ISO strings, not Dates: drizzle's postgres-js setup disables Date serialization on the shared client.
  const before = (days: number) => new Date(now.getTime() - days * DAY_MS).toISOString();
  const raw = before(RETENTION_POLICY.rawDays);
  const ops = before(RETENTION_POLICY.opsDays);
  const aggregate = before(RETENTION_POLICY.aggregateDays);
  const n = batchSize;
  // ponytail: every age filter below is unindexed or not index-usable (fine at MVP volume);
  // add indexes on the age columns (alert_snapshots.fetched_at first) if a pass gets slow.

  // Ages count from when we stored the row, so an archive import of old posts is not purged on arrival.
  // Scrubs lock FOR NO KEY UPDATE: they change no key, so FK checks of concurrent inserts are not blocked.
  const steps: Record<string, () => PromiseLike<{ count: number }>> = {
    revisionTextScrubbed: () => sql`
      update message_revisions set raw_payload = null, raw_text = '', normalized_text = '', cleaned_text = ''
      where id in (
        select id from message_revisions
        where observed_at < ${raw}
          and (raw_payload is not null or raw_text <> '' or normalized_text <> '' or cleaned_text <> '')
        limit ${n} for no key update skip locked)`,
    alertSnapshotsDeleted: () => sql`
      delete from alert_snapshots
      where id in (
        select s.id from alert_snapshots s
        where s.fetched_at < ${aggregate} and not exists (select 1 from alert_states a where a.snapshot_id = s.id)
        limit ${n} for update skip locked)`,
    alertPayloadScrubbed: () => sql`
      update alert_snapshots set raw_payload = null
      where id in (
        select id from alert_snapshots where fetched_at < ${raw} and raw_payload is not null
        limit ${n} for no key update skip locked)`,
    doneJobsDeleted: () => sql`
      delete from jobs
      where id in (
        select id from jobs where status = 'done' and finished_at < ${ops}
        limit ${n} for update skip locked)`,
    incidentsDeleted: () => sql`
      with batch as (
        select id from incidents where created_at < ${aggregate}
        limit ${n} for update skip locked
      ), evidence as (
        delete from incident_evidence where incident_id in (select id from batch)
      )
      delete from incidents where id in (select id from batch)`,
    auditDeleted: () => sql`
      delete from audit_log
      where id in (select id from audit_log where created_at < ${aggregate} limit ${n} for update skip locked)`,
  };

  const counts: Record<string, number> = {};
  for (const [name, step] of Object.entries(steps)) {
    if (signal?.aborted) break;
    counts[name] = 0;
    try {
      for (;;) {
        const { count } = await step();
        counts[name] += count;
        if (count < n || signal?.aborted) break;
      }
    } catch (err) {
      logger.error({ err, step: name }, 'retention step failed');
    }
  }
  return counts;
}

export const retentionLoop: Loop = {
  name: 'retention',
  start: async ({ db, logger, signal }) => {
    const log = logger.child({ loop: 'retention', policy: RETENTION_POLICY.version });
    while (!signal.aborted) {
      const counts = await runRetention(db.sql, { now: new Date(), logger: log, signal });
      log.info({ counts }, 'retention pass done');
      // Hourly with ±10 % jitter so several workers do not sweep in lockstep.
      await sleep(INTERVAL_MS * (0.9 + Math.random() * 0.2), undefined, { signal }).catch(() => {});
    }
  },
  stop: async () => {},
};
