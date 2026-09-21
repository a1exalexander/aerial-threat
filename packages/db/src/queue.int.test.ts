import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { JOB_PRIORITY, LeaseLostError, claim, complete, enqueue, fail, heartbeat, releaseLeases } from './queue';
import { jobs } from './schema';
import { createTestDb } from './testing';

let t: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t?.drop());
beforeEach(() => t.db.delete(jobs));

const expireLease = (id: string) => t.db.update(jobs).set({ leaseUntil: sql`now() - interval '1 second'` }).where(eq(jobs.id, id));
const makeReady = (id: string) => t.db.update(jobs).set({ nextAttemptAt: sql`now() - interval '1 second'` }).where(eq(jobs.id, id));

describe('queue', () => {
  it('enqueue is idempotent on dedupe key while the job is active', async () => {
    const a = await enqueue(t.db, { kind: 'k', dedupeKey: 'k:1' });
    const b = await enqueue(t.db, { kind: 'k', dedupeKey: 'k:1' });
    expect(a.created).toBe(true);
    expect(b).toEqual({ id: a.id, created: false });

    const [job] = await claim(t.db, { kinds: ['k'], owner: 'w1', leaseMs: 60_000 });
    await complete(t.db, job!);
    const c = await enqueue(t.db, { kind: 'k', dedupeKey: 'k:1' });
    expect(c.created).toBe(true); // a finished key can run again
  });

  it('claims by priority and never hands one job to two workers', async () => {
    await enqueue(t.db, { kind: 'k', dedupeKey: 'archive', priority: JOB_PRIORITY.archive });
    await enqueue(t.db, { kind: 'k', dedupeKey: 'edit', priority: JOB_PRIORITY.live_update });
    await enqueue(t.db, { kind: 'k', dedupeKey: 'live', priority: JOB_PRIORITY.live });
    await enqueue(t.db, { kind: 'other', dedupeKey: 'other' });

    const concurrent = await Promise.all([
      claim(t.db, { kinds: ['k'], owner: 'w1', leaseMs: 60_000, limit: 2 }),
      claim(t.db, { kinds: ['k'], owner: 'w2', leaseMs: 60_000, limit: 2 }),
    ]);
    const rest = await claim(t.db, { kinds: ['k'], owner: 'w3', leaseMs: 60_000, limit: 3 });
    const keys = [...concurrent.flat(), ...rest].map((j) => j.dedupeKey);
    expect(keys.sort()).toEqual(['archive', 'edit', 'live']); // each exactly once, other kinds untouched
  });

  it('orders a single worker by live_update > live > archive', async () => {
    await enqueue(t.db, { kind: 'k', dedupeKey: 'archive', priority: JOB_PRIORITY.archive });
    await enqueue(t.db, { kind: 'k', dedupeKey: 'live', priority: JOB_PRIORITY.live });
    await enqueue(t.db, { kind: 'k', dedupeKey: 'edit', priority: JOB_PRIORITY.live_update });
    const got = await claim(t.db, { kinds: ['k'], owner: 'w1', leaseMs: 60_000, limit: 3 });
    expect(got.map((j) => j.dedupeKey)).toEqual(['edit', 'live', 'archive']);
  });

  it('re-claims an expired lease and fences the old owner', async () => {
    await enqueue(t.db, { kind: 'k', dedupeKey: 'k:lease' });
    const [old] = await claim(t.db, { kinds: ['k'], owner: 'w1', leaseMs: 60_000 });
    expect(await claim(t.db, { kinds: ['k'], owner: 'w2', leaseMs: 60_000 })).toEqual([]);
    expect(await heartbeat(t.db, old!, 60_000)).toBe(true);

    await expireLease(old!.id);
    const [taken] = await claim(t.db, { kinds: ['k'], owner: 'w2', leaseMs: 60_000 });
    expect(taken).toMatchObject({ id: old!.id, leaseOwner: 'w2', attempts: 2 });

    expect(await heartbeat(t.db, old!, 60_000)).toBe(false);
    await expect(t.db.transaction((tx) => complete(tx, old!))).rejects.toBeInstanceOf(LeaseLostError);
    await t.db.transaction((tx) => complete(tx, taken!));
    const [row] = await t.db.select().from(jobs).where(eq(jobs.id, old!.id));
    expect(row!.status).toBe('done');
  });

  it('retries with backoff, then dead-letters after max attempts', async () => {
    await enqueue(t.db, { kind: 'k', dedupeKey: 'k:poison', maxAttempts: 2 });
    const [a1] = await claim(t.db, { kinds: ['k'], owner: 'w1', leaseMs: 60_000 });
    expect(await fail(t.db, a1!, new Error('boom'))).toBe('failed');
    expect(await claim(t.db, { kinds: ['k'], owner: 'w1', leaseMs: 60_000 })).toEqual([]); // backoff pending

    await makeReady(a1!.id);
    const [a2] = await claim(t.db, { kinds: ['k'], owner: 'w1', leaseMs: 60_000 });
    expect(await fail(t.db, a2!, new Error('boom again'))).toBe('dead');
    const [row] = await t.db.select().from(jobs).where(eq(jobs.id, a1!.id));
    expect(row).toMatchObject({ status: 'dead', attempts: 2, lastError: 'boom again', leaseOwner: null });
    expect(await claim(t.db, { kinds: ['k'], owner: 'w1', leaseMs: 60_000 })).toEqual([]);
  });

  it('dead-letters a job whose lease expired on its last attempt', async () => {
    await enqueue(t.db, { kind: 'k', dedupeKey: 'k:crash', maxAttempts: 1 });
    const [a] = await claim(t.db, { kinds: ['k'], owner: 'w1', leaseMs: 60_000 });
    await expireLease(a!.id);
    expect(await claim(t.db, { kinds: ['k'], owner: 'w2', leaseMs: 60_000 })).toEqual([]);
    const [row] = await t.db.select().from(jobs).where(eq(jobs.id, a!.id));
    expect(row!.status).toBe('dead');
  });

  it('releases leases on shutdown without burning an attempt', async () => {
    await enqueue(t.db, { kind: 'k', dedupeKey: 'k:release' });
    await claim(t.db, { kinds: ['k'], owner: 'w1', leaseMs: 60_000 });
    expect(await releaseLeases(t.db, 'w1')).toBe(1);
    const [again] = await claim(t.db, { kinds: ['k'], owner: 'w2', leaseMs: 60_000 });
    expect(again).toMatchObject({ attempts: 1, leaseOwner: 'w2' });
  });
});
