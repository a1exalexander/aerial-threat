import { readFileSync } from 'node:fs';
import { createDb, importRuns, jobs, messageRevisions, messages, sources } from '@aerial/db';
import { asc, count, eq } from '@aerial/db/orm';
import { createTestDb } from '@aerial/db/testing';
import { telegramExportPath } from '@aerial/test-fixtures';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { importTelegramExport } from '../import/index';
import { replayWindow } from './index';

let t: Awaited<ReturnType<typeof createTestDb>>;
let targetUrl: string;
beforeAll(async () => {
  t = await createTestDb();
  const url = new URL(t.url);
  url.pathname = `${url.pathname}_replay`;
  targetUrl = url.toString();
  await importTelegramExport(t.db, { bytes: readFileSync(telegramExportPath('energy')), username: 'ppo_energy_poltava' });
  await importTelegramExport(t.db, { bytes: readFileSync(telegramExportPath('kremenchuk')), username: 'h_kremenchug' });
}, 60_000);
afterAll(async () => {
  const admin = createDb(t.url, { max: 1 });
  await admin.sql.unsafe(`drop database if exists ${new URL(targetUrl).pathname.slice(1)} with (force)`);
  await admin.close();
  await t?.drop();
});

const from = new Date('2026-09-19T16:00:00Z');
const to = new Date('2026-09-19T17:00:00Z');
const sourceCounts = async () =>
  Promise.all([messages, messageRevisions, jobs, importRuns, sources].map(async (tbl) => (await t.db.select({ n: count() }).from(tbl))[0]!.n));

describe('replayWindow', { timeout: 60_000 }, () => {
  it('replays a window in publish order on a virtual clock into a fresh *_replay db, reading the source only', async () => {
    const before = await sourceCounts();
    const sleeps: number[] = [];
    const r = await replayWindow({ sourceUrl: t.url, targetUrl, from, to, speed: 60, sleep: async (ms) => void sleeps.push(ms) });
    expect(r).toMatchObject({ delivered: 2, clock: to });
    expect(sleeps.reduce((a, b) => a + b, 0)).toBeCloseTo(60_000); // one virtual hour at x60 = one real minute
    expect(await sourceCounts()).toEqual(before);

    const dest = createDb(targetUrl, { max: 1 });
    try {
      const rows = await dest.db
        .select({ id: messages.externalMessageId, mode: messages.mode, publishedAt: messages.publishedAt, receivedAt: messages.receivedAt, username: sources.username })
        .from(messages)
        .innerJoin(sources, eq(sources.id, messages.sourceId))
        .orderBy(asc(messages.receivedAt));
      // Кременчук 101889 and Energy 13810: the same OVA report, replayed in publish order, stamped with virtual arrival.
      expect(rows.map((x) => [x.id, x.mode, x.username])).toEqual([
        ['101889', 'archive', 'h_kremenchug'],
        ['13810', 'archive', 'ppo_energy_poltava'],
      ]);
      expect(rows.every((x) => x.receivedAt.getTime() === x.publishedAt.getTime())).toBe(true);
    } finally {
      await dest.close();
    }

    // A rerun starts from a fresh database again instead of reporting everything as unchanged.
    expect((await replayWindow({ sourceUrl: t.url, targetUrl, from, to, speed: Infinity, sleep: async () => {} })).delivered).toBe(2);
  });

  it('refuses a target that is not a dedicated *_replay database', async () => {
    await expect(replayWindow({ sourceUrl: t.url, targetUrl: t.url, from, to, speed: 1, sleep: async () => {} })).rejects.toThrow(/_replay/);
  });
});
