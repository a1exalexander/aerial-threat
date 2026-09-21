import { setTimeout as delay } from 'node:timers/promises';
import type { WorkerEnv } from '@aerial/config';
import { JOB_PRIORITY, PROCESS_REVISION, jobs, messageRevisions, messages, sourceHealth, sources, telegramCheckpoints } from '@aerial/db';
import { eq } from '@aerial/db/orm';
import { createTestDb } from '@aerial/db/testing';
import { createLogger } from '@aerial/observability';
import { FakeTelegramSource, TelegramAuthLost, TelegramChannelUnavailable, TelegramFloodWait } from '@aerial/telegram/live';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LoopContext } from './index';
import { type TelegramLoopOptions, createTelegramLoop } from './telegram';

const CH = '1000000001';
const HOUR = 3_600_000;

let t: Awaited<ReturnType<typeof createTestDb>>;
let fake: FakeTelegramSource;
beforeEach(async () => {
  t = await createTestDb();
  fake = new FakeTelegramSource();
  fake.addChannel('ppo_energy_poltava', CH, 'Energy');
});
afterEach(() => t?.drop());

function start(over: Partial<TelegramLoopOptions> = {}, source = fake) {
  const controller = new AbortController();
  const sleeps: number[] = [];
  const loop = createTelegramLoop({
    createSource: () => source,
    channels: ['ppo_energy_poltava'],
    syncIntervalMs: 60_000,
    leaseRetryMs: 10,
    sleep: async (ms) => {
      sleeps.push(ms);
      await delay(5);
    },
    random: () => 0.5,
    ...over,
  });
  const ctx: LoopContext = {
    db: { db: t.db, sql: t.sql, close: async () => {} },
    env: { TELEGRAM_SESSION_SECRET_REF: 'test.session' } as WorkerEnv,
    logger: createLogger({ name: 'test', level: 'silent' }),
    owner: 'test',
    signal: controller.signal,
  };
  const done = loop.start(ctx);
  return {
    done,
    sleeps,
    stop: async () => {
      controller.abort();
      await done;
    },
  };
}

async function until(check: () => Promise<boolean>, ms = 5000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('timed out waiting for the collector');
    await delay(10);
  }
}
const checkpoint = async () => (await t.db.select().from(telegramCheckpoints))[0]?.pts;
const reached = (pts: number) => until(async () => (await checkpoint()) === pts);
const revisions = () => t.db.select().from(messageRevisions);
const processJobs = () => t.db.select().from(jobs).where(eq(jobs.kind, PROCESS_REVISION));
const health = async () => (await t.db.select().from(sourceHealth))[0];

describe('telegram collector', () => {
  it('backfills the 24 h window once and resumes from the checkpoint after a restart', async () => {
    fake.post(CH, 'older than the window', { date: new Date(Date.now() - 25 * HOUR) });
    fake.post(CH, 'a');
    fake.post(CH, 'b', { replyToId: '2' });
    const c = fake.post(CH, 'c');
    const first = start();
    await reached(c.pts);
    await first.stop();
    expect(await t.db.select().from(messages)).toHaveLength(3);

    fake.post(CH, 'd'); // published while the collector was down
    const e = fake.post(CH, 'e');
    const second = start();
    await reached(e.pts);
    await second.stop();

    const stored = await t.db.select().from(messages);
    expect(stored.map((m) => m.externalMessageId).sort()).toEqual(['2', '3', '4', '5', '6']);
    expect(stored.every((m) => m.mode === 'live')).toBe(true);
    expect(stored.find((m) => m.externalMessageId === '3')?.replyToExternalId).toBe('2');
    expect(await revisions()).toHaveLength(5);
    const queued = await processJobs();
    expect(queued).toHaveLength(5);
    expect(queued.every((j) => j.priority === JOB_PRIORITY.live)).toBe(true);
    const h = await health();
    expect(h).toMatchObject({ errorKind: null });
    expect(h?.lastSuccessAt).toBeInstanceOf(Date);
    expect(h?.lastMessageAt?.toISOString()).toBe(e.message.publishedAt);
  });

  it('stores a duplicate delivery once', async () => {
    const run = start();
    await reached(0);
    const u = fake.post(CH, 'x');
    fake.emit(u);
    fake.emit(u);
    await reached(u.pts);
    await run.stop();
    expect(await revisions()).toHaveLength(1);
    expect(await processJobs()).toHaveLength(1);
  });

  it('dedupes updates buffered during the backfill against the backfilled history', async () => {
    const a = fake.post(CH, 'a');
    fake.post(CH, 'b');
    fake.onRecent = () => {
      fake.onRecent = undefined;
      fake.emit(a); // redelivered while the history is being read
      fake.post(CH, 'c'); // arrives mid-backfill and is also in the history answer
    };
    const run = start();
    await reached(3);
    await run.stop();
    expect(await revisions()).toHaveLength(3);
    expect(await processJobs()).toHaveLength(3);
  });

  it('turns a text edit into a revision with a live_update job; a reaction-only edit changes nothing', async () => {
    const run = start();
    await reached(0);
    const u = fake.post(CH, 'Шахед на Полтаву');
    await reached(u.pts);

    const noise = fake.edit(CH, u.message.externalMessageId, { rawPayload: { views: 999, reactions: [{ emoji: '🙏', count: 7 }] } });
    await reached(noise.pts);
    expect(await revisions()).toHaveLength(1);
    expect(await processJobs()).toHaveLength(1);

    const edit = fake.edit(CH, u.message.externalMessageId, { text: 'Шахед на Полтаву (оновлено)' });
    await reached(edit.pts);
    await run.stop();
    expect(await revisions()).toHaveLength(2);
    const [msg] = await t.db.select().from(messages);
    const job = (await processJobs()).find((j) => j.payload.revisionId === msg?.latestRevisionId);
    expect(job?.priority).toBe(JOB_PRIORITY.live_update);
  });

  it('stores an edit of a post older than the backfill without counting it as ingestion lag', async () => {
    const old = fake.post(CH, 'two months old', { date: new Date(Date.now() - 60 * 24 * HOUR) });
    const run = start();
    await reached(old.pts);
    const edit = fake.edit(CH, old.message.externalMessageId, { text: 'two months old, edited' });
    await reached(edit.pts);
    await run.stop();
    expect(await t.db.select().from(messages)).toHaveLength(1);
    expect(await health()).toMatchObject({ errorKind: null, lagMs: null });
  });

  it('drops a channel that turned private without stalling the others', async () => {
    const OTHER = '1000000002';
    fake.addChannel('h_kremenchug', OTHER, 'Kremenchuk');
    const run = start({ channels: ['h_kremenchug', 'ppo_energy_poltava'] });
    await until(async () => (await t.db.select().from(telegramCheckpoints)).length === 2);
    fake.failNext('getChannelDifference', new TelegramChannelUnavailable('CHANNEL_PRIVATE'));
    fake.emit({ kind: 'tooLong', channelId: OTHER });
    fake.post(CH, 'still collected');
    await until(async () => (await revisions()).length === 1);
    await run.stop();
    const [other] = await t.db.select().from(sources).where(eq(sources.externalId, OTHER));
    const [h] = await t.db.select().from(sourceHealth).where(eq(sourceHealth.sourceId, other!.id));
    expect(h?.errorKind).toBe('unavailable');
  });

  it('recovers updates missed by the push stream on a gap and on reconnect', async () => {
    const run = start();
    await reached(0);
    fake.post(CH, 'missed', { push: false });
    const next = fake.post(CH, 'arrives after a gap'); // pts - ptsCount is ahead of the checkpoint
    await reached(next.pts);
    const lost = fake.post(CH, 'lost while disconnected', { push: false });
    fake.emit({ kind: 'reconnected' });
    await reached(lost.pts);
    await run.stop();
    expect(await revisions()).toHaveLength(3);
  });

  it('pages through a long difference and refills from history when the gap is too long', async () => {
    fake.diffLimit = 1;
    const first = start();
    await reached(0);
    await first.stop();
    fake.post(CH, 'a');
    const b = fake.post(CH, 'b');
    const second = start();
    await reached(b.pts);
    await second.stop();
    expect(fake.calls.filter((c) => c === 'getChannelDifference')).toHaveLength(2);

    fake.minPts = 10; // the server dropped the changes after our checkpoint
    const c = fake.post(CH, 'c');
    const third = start();
    await reached(c.pts);
    await third.stop();
    expect(await revisions()).toHaveLength(3);
  });

  it('marks deletions, from updates and from the recent-window recheck, and requeues them', async () => {
    for (const text of ['a', 'b', 'c']) fake.post(CH, text);
    const last = fake.post(CH, 'd');
    const first = start();
    await reached(last.pts);
    await t.db.update(jobs).set({ status: 'done' }); // processed already
    const d = fake.delete(CH, ['1']);
    await reached(d.pts);
    await first.stop();

    fake.forget(CH, '3'); // Telegram did not report this deletion; 2 and 4 still bound it in the recheck
    const second = start();
    await until(async () => (await t.db.select().from(messages)).filter((m) => m.deletedAt).length === 2);
    await second.stop();

    const byId = new Map((await t.db.select().from(messages)).map((m) => [m.externalMessageId, m]));
    expect(byId.get('1')).toMatchObject({ version: 2 });
    expect(byId.get('1')?.deletedAt).toBeInstanceOf(Date);
    expect(byId.get('3')?.deletedAt).toBeInstanceOf(Date);
    expect(byId.get('2')?.deletedAt).toBeNull();
    expect(byId.get('4')?.deletedAt).toBeNull();
    const requeued = (await processJobs()).filter((j) => j.status === 'queued');
    expect(requeued).toHaveLength(2);
    expect(requeued.every((j) => j.priority === JOB_PRIORITY.live_update)).toBe(true);
  });

  it('waits out FLOOD_WAIT (server seconds plus jitter) and then continues', async () => {
    const u = fake.post(CH, 'a');
    fake.failNext('resolveChannel', new TelegramFloodWait(7));
    const run = start();
    await reached(u.pts);
    await run.stop();
    expect(run.sleeps).toEqual([7000 + 500]); // random 0.5 * max(1 s, 10 % of the wait)
    expect(fake.calls.filter((c) => c === 'resolveChannel')).toHaveLength(2);
    expect(await health()).toMatchObject({ errorKind: null });
  });

  it('leaves the checkpoint behind a transaction that dies before commit, then stores the update once', async () => {
    const run = start();
    await reached(0);
    await t.sql`create function crash_on_marker() returns trigger language plpgsql as $$
      begin if new.raw_text = 'CRASH' then raise exception 'crash before commit'; end if; return new; end $$`;
    await t.sql`create trigger crash before insert on message_revisions for each row execute function crash_on_marker()`;
    const bad = fake.post(CH, 'CRASH');
    await until(async () => run.sleeps.length > 0);
    expect(await checkpoint()).toBe(bad.pts - 1);
    expect(await t.db.select().from(messages)).toHaveLength(0);
    expect(await health()).toMatchObject({ errorKind: 'transient' });

    await t.sql`drop trigger crash on message_revisions`;
    await reached(bad.pts);
    await run.stop();
    expect(await revisions()).toHaveLength(1);
    expect(await health()).toMatchObject({ errorKind: null });
  });

  it('stops only itself on auth loss, marks the source and releases the lease', async () => {
    const run = start();
    await reached(0);
    fake.failNext('getChannelDifference', new TelegramAuthLost('AUTH_KEY_UNREGISTERED'));
    fake.emit({ kind: 'tooLong', channelId: CH });
    await expect(run.done).resolves.toBeUndefined();
    expect(await health()).toMatchObject({ errorKind: 'auth_lost' });
    expect(fake.connected).toBe(false);
    const [locks] = await t.sql<{ n: number }[]>`select count(*)::int as n from pg_locks where locktype = 'advisory'`;
    expect(locks?.n).toBe(0);
  });

  it('keeps one collector per session: a second one waits for the lease', async () => {
    const first = start();
    await reached(0);
    const other = new FakeTelegramSource();
    other.addChannel('ppo_energy_poltava', CH, 'Energy');
    const second = start({}, other);
    await delay(100);
    expect(other.calls).toEqual([]);
    await first.stop();
    await until(async () => other.calls.includes('connect'));
    await second.stop();
  });

  it('updates the username of the same source when the channel is renamed', async () => {
    const first = start();
    await reached(0);
    await first.stop();
    fake.rename(CH, 'ppo_energy_renamed');
    const second = start({ channels: ['ppo_energy_renamed'] });
    await until(async () => (await t.db.select().from(sources))[0]?.username === 'ppo_energy_renamed');
    await second.stop();
    const rows = await t.db.select().from(sources);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ externalId: CH, username: 'ppo_energy_renamed', displayName: 'Energy' });
  });

  it('reports "not configured" and returns without touching Telegram', async () => {
    await t.db.insert(sources).values({ provider: 'telegram', externalId: CH, username: 'ppo_energy_poltava' });
    const run = start({ createSource: () => undefined });
    await expect(run.done).resolves.toBeUndefined();
    expect(await health()).toMatchObject({ errorKind: 'not_configured' });
    expect(fake.calls).toEqual([]);
  });
});
