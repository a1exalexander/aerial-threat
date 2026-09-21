// Transactional job queue on the `jobs` table: FOR UPDATE SKIP LOCKED + lease/heartbeat + dead letter.
// Statuses: queued -> running -> done | failed (retry scheduled) -> ... -> dead (after max_attempts).
import { and, asc, desc, eq, inArray, lt, lte, or, sql } from 'drizzle-orm';
import type { Executor } from './client';
import { jobs } from './schema';

/** Higher runs first: live edits, then new live posts, then archive/replay. */
export const JOB_PRIORITY = { live_update: 30, live: 20, archive: 10 } as const;

export type Job = typeof jobs.$inferSelect;
type LeasedJob = Pick<Job, 'id' | 'leaseOwner'>;

export class LeaseLostError extends Error {
  override name = 'LeaseLostError';
}

const ACTIVE = ['queued', 'running', 'failed'] as const;
const nowPlus = (ms: number) => sql`now() + make_interval(secs => ${ms / 1000})`;

/** Idempotent on dedupeKey while a job with that key is queued/running/failed. Joins the caller's tx. */
export async function enqueue(
  tx: Executor,
  input: { kind: string; dedupeKey: string; payload?: Record<string, unknown>; priority?: number; maxAttempts?: number; runAt?: Date },
): Promise<{ id: string; created: boolean }> {
  // Two tries: the conflicting job may finish between our insert and select.
  for (let i = 0; i < 2; i++) {
    const [row] = await tx
      .insert(jobs)
      .values({
        kind: input.kind,
        dedupeKey: input.dedupeKey,
        payload: input.payload,
        priority: input.priority,
        maxAttempts: input.maxAttempts,
        nextAttemptAt: input.runAt,
      })
      .onConflictDoNothing({ target: jobs.dedupeKey, where: sql`status in ('queued', 'running', 'failed')` })
      .returning({ id: jobs.id });
    if (row) return { id: row.id, created: true };
    const [existing] = await tx
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.dedupeKey, input.dedupeKey), inArray(jobs.status, ACTIVE)));
    if (existing) return { id: existing.id, created: false };
  }
  throw new Error(`enqueue: could not insert or find job ${input.dedupeKey}`);
}

/** Leases up to `limit` ready jobs (highest priority, oldest first). Expired leases are re-claimable. */
export async function claim(
  db: Executor,
  opts: { kinds: string[]; owner: string; leaseMs: number; limit?: number },
): Promise<Job[]> {
  const kinds = inArray(jobs.kind, opts.kinds);
  // A job whose worker died mid-lease on its last attempt is poison: dead-letter it.
  await db
    .update(jobs)
    .set({ status: 'dead', leaseOwner: null, leaseUntil: null, lastError: 'lease expired on last attempt', finishedAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(kinds, eq(jobs.status, 'running'), lt(jobs.leaseUntil, sql`now()`), sql`${jobs.attempts} >= ${jobs.maxAttempts}`));
  const ready = db
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        kinds,
        or(
          and(inArray(jobs.status, ['queued', 'failed']), lte(jobs.nextAttemptAt, sql`now()`)),
          and(eq(jobs.status, 'running'), lt(jobs.leaseUntil, sql`now()`), sql`${jobs.attempts} < ${jobs.maxAttempts}`),
        ),
      ),
    )
    .orderBy(desc(jobs.priority), asc(jobs.nextAttemptAt))
    .limit(opts.limit ?? 1)
    .for('update', { skipLocked: true });
  const rows = await db
    .update(jobs)
    .set({
      status: 'running',
      leaseOwner: opts.owner,
      leaseUntil: nowPlus(opts.leaseMs),
      attempts: sql`${jobs.attempts} + 1`,
      updatedAt: sql`now()`,
    })
    .where(inArray(jobs.id, ready))
    .returning();
  return rows.sort((a, b) => b.priority - a.priority || a.nextAttemptAt.getTime() - b.nextAttemptAt.getTime());
}

const owned = (job: LeasedJob) => and(eq(jobs.id, job.id), eq(jobs.status, 'running'), eq(jobs.leaseOwner, job.leaseOwner ?? ''));

/** Extends the lease; false means another worker took the job over and this one must stop. */
export async function heartbeat(db: Executor, job: LeasedJob, leaseMs: number): Promise<boolean> {
  const rows = await db
    .update(jobs)
    .set({ leaseUntil: nowPlus(leaseMs), updatedAt: sql`now()` })
    .where(owned(job))
    .returning({ id: jobs.id });
  return rows.length > 0;
}

/** Call inside the transaction that applies the job's result; throws LeaseLostError so that tx rolls back. */
export async function complete(tx: Executor, job: LeasedJob): Promise<void> {
  const rows = await tx
    .update(jobs)
    .set({ status: 'done', leaseOwner: null, leaseUntil: null, finishedAt: sql`now()`, updatedAt: sql`now()` })
    .where(owned(job))
    .returning({ id: jobs.id });
  if (rows.length === 0) throw new LeaseLostError(`lease lost for job ${job.id}`);
}

/** Exponential backoff with equal jitter, capped at 10 minutes. `attempt` starts at 1. */
export function backoffMs(attempt: number, random = Math.random): number {
  const base = Math.min(1000 * 2 ** Math.max(attempt - 1, 0), 10 * 60_000);
  return Math.round(base / 2 + (random() * base) / 2);
}

/** Schedules a retry, or dead-letters after max_attempts. Returns the new status, or null if the lease was lost. */
export async function fail(db: Executor, job: Job, err: unknown): Promise<'failed' | 'dead' | null> {
  const dead = job.attempts >= job.maxAttempts;
  const message = (err instanceof Error ? err.message : String(err)).slice(0, 2000);
  const rows = await db
    .update(jobs)
    .set({
      status: dead ? 'dead' : 'failed',
      leaseOwner: null,
      leaseUntil: null,
      lastError: message,
      nextAttemptAt: dead ? job.nextAttemptAt : nowPlus(backoffMs(job.attempts)),
      finishedAt: dead ? sql`now()` : null,
      updatedAt: sql`now()`,
    })
    .where(owned(job))
    .returning({ id: jobs.id });
  return rows.length ? (dead ? 'dead' : 'failed') : null;
}

/** Graceful shutdown: hand this owner's running jobs back without counting the interrupted attempt. */
export async function releaseLeases(db: Executor, owner: string): Promise<number> {
  const rows = await db
    .update(jobs)
    .set({ status: 'queued', attempts: sql`greatest(${jobs.attempts} - 1, 0)`, leaseOwner: null, leaseUntil: null, updatedAt: sql`now()` })
    .where(and(eq(jobs.status, 'running'), eq(jobs.leaseOwner, owner)))
    .returning({ id: jobs.id });
  return rows.length;
}
