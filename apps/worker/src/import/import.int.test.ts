import { readFileSync } from 'node:fs';
import { importRuns, ingestMessage, jobs, messageRevisions, messages, sources } from '@aerial/db';
import { count, eq } from '@aerial/db/orm';
import { createTestDb } from '@aerial/db/testing';
import { manifest, telegramExportPath } from '@aerial/test-fixtures';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { importTelegramExport } from './index';

let t: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t?.drop());

const totals = async () => ({
  messages: (await t.db.select({ n: count() }).from(messages))[0]!.n,
  revisions: (await t.db.select({ n: count() }).from(messageRevisions))[0]!.n,
  jobs: (await t.db.select({ n: count() }).from(jobs))[0]!.n,
});
const exportBytes = (messagesJson: unknown[], id = 900) =>
  Buffer.from(JSON.stringify({ name: 'Synthetic', type: 'public_channel', id, messages: messagesJson }));
const post = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  type: 'message',
  date: '2026-09-19T19:00:00',
  date_unixtime: String(1789830000 + id),
  text: `допис ${id}`,
  ...over,
});

// Hundreds of small transactions against the shared Postgres: generous timeouts for parallel CI load.
describe('importTelegramExport', { timeout: 60_000 }, () => {
  it('imports a fixture export once; a rerun of the same file changes nothing', async () => {
    const bytes = readFileSync(telegramExportPath('energy'));
    const n = manifest.files.energy.records.length;

    const first = await importTelegramExport(t.db, { bytes, username: 'ppo_energy_poltava' });
    expect(first.counters).toMatchObject({ total: n, imported: n, unchanged: 0, invalid: 0, unsupported: 0, missingContext: 1 });
    expect(first.report.missingContext).toEqual([{ id: '13790', replyTo: '13789' }]);
    // One revision per post: the export holds only the last text, so no earlier revisions are invented.
    expect(await totals()).toEqual({ messages: n, revisions: n, jobs: n });
    const modes = await t.db.selectDistinct({ mode: messages.mode }).from(messages);
    expect(modes).toEqual([{ mode: 'archive' }]);
    expect(await t.db.selectDistinct({ priority: jobs.priority }).from(jobs)).toEqual([{ priority: 10 }]);
    const [source] = await t.db.select().from(sources).where(eq(sources.id, first.source.id));
    expect(source).toMatchObject({ externalId: '1706408894', username: 'ppo_energy_poltava', displayName: 'ППО - Energy Полтава⚡️' });

    const second = await importTelegramExport(t.db, { bytes });
    expect(second.counters).toMatchObject({ total: n, imported: 0, unchanged: n, missingContext: 1 });
    expect(second.fileHash).toBe(first.fileHash);
    expect(await totals()).toEqual({ messages: n, revisions: n, jobs: n });

    const runs = await t.db.select().from(importRuns).where(eq(importRuns.fileHash, first.fileHash));
    expect(runs.map((r) => [r.status, r.counters.imported, r.sourceId])).toEqual([
      ['succeeded', n, first.source.id],
      ['succeeded', 0, first.source.id],
    ]);
  });

  it('accounts for every record: quarantines invalid ones, skips service records, links replies in a second pass', async () => {
    const records = [
      post(3, { reply_to_message_id: 1 }), // parent is later in the file: linked, not missing
      post(1),
      post(2, { date_unixtime: undefined }), // no unix time: quarantined, never read from `date`
      { id: 4, type: 'service', date_unixtime: '1789830004', action: 'pin_message', text: '' },
      post(5, { reply_to_message_id: 777 }), // parent not in the export
      post(6, { text: '', photo: '(File not included.)' }), // media without text
      post(1, { text: 'дубль' }),
      'garbage',
    ];
    const r = await importTelegramExport(t.db, { bytes: exportBytes(records) });
    expect(r.counters).toEqual({
      total: 8,
      imported: 4,
      unchanged: 0,
      invalid: 3,
      unsupported: 1,
      revised: 0,
      skippedLive: 0,
      skippedOlder: 0,
      mediaOnly: 1,
      missingContext: 1,
    });
    expect(r.report.quarantine.map((q) => [q.index, q.id])).toEqual([
      [2, '2'],
      [6, '1'],
      [7, null],
    ]);
    expect(r.report.unsupported).toEqual([{ index: 3, id: '4', reason: 'service:pin_message' }]);
    expect(r.report.missingContext).toEqual([{ id: '5', replyTo: '777' }]);
    const [run] = await t.db.select().from(importRuns).where(eq(importRuns.id, r.runId));
    expect(run).toMatchObject({ status: 'succeeded', counters: r.counters, report: r.report });
  });

  it('records a failed run for a file that is not a channel export', async () => {
    const bytes = Buffer.from(JSON.stringify({ name: 'x', type: 'personal_chat', id: 1, messages: [] }));
    await expect(importTelegramExport(t.db, { bytes })).rejects.toThrow(/not a Telegram channel export/);
    await expect(importTelegramExport(t.db, { bytes: Buffer.from('{') })).rejects.toThrow(/not valid JSON/);
    const failed = await t.db.select().from(importRuns).where(eq(importRuns.status, 'failed'));
    expect(failed).toHaveLength(2);
  });

  it('revises an edited archive post but never touches a post owned by the live collector', async () => {
    await importTelegramExport(t.db, { bytes: exportBytes([post(10), post(11)], 901) });
    await t.db.transaction((tx) =>
      ingestMessage(tx, {
        sourceProvider: 'telegram',
        sourceExternalId: '901',
        externalMessageId: '12',
        publishedAt: '2026-09-19T19:00:12Z',
        editedAt: null,
        replyToExternalId: null,
        rawText: 'live',
        normalizedText: 'live',
        cleanedText: 'live',
        mediaFlags: [],
        rawPayload: {},
        mode: 'live',
      }),
    );
    const before = await totals();
    const edited = { text: 'виправлено', edited: '2026-09-19T19:10:00', edited_unixtime: '1789830600' };
    const r = await importTelegramExport(t.db, { bytes: exportBytes([post(10), post(11, edited), post(12)], 901) });
    expect(r.counters).toMatchObject({ imported: 1, revised: 1, unchanged: 2, skippedLive: 1 });
    expect(await totals()).toEqual({ ...before, revisions: before.revisions + 1, jobs: before.jobs + 1 });

    // An older export (taken before the edit) must not roll post 11 back to its earlier text.
    const older = await importTelegramExport(t.db, { bytes: exportBytes([post(11)], 901) });
    expect(older.counters).toMatchObject({ imported: 0, unchanged: 1, skippedOlder: 1 });
    expect(await totals()).toEqual({ ...before, revisions: before.revisions + 1, jobs: before.jobs + 1 });
  });

  it('imports the kremenchuk-mykolai fixture under its bare channel id and the export name', async () => {
    const bytes = readFileSync(telegramExportPath('kremenchuk-mykolai'));
    const n = manifest.files['kremenchuk-mykolai'].records.length;
    const first = await importTelegramExport(t.db, { bytes });
    expect(first.counters).toMatchObject({ total: n, imported: n, invalid: 0, unsupported: 0, mediaOnly: 1, missingContext: 1 });
    expect(first.report.missingContext).toEqual([{ id: '24096', replyTo: '23886' }]);
    const [source] = await t.db.select().from(sources).where(eq(sources.id, first.source.id));
    // No username in the export: the live collector fills it when it resolves the channel by username.
    expect(source).toMatchObject({ externalId: '2432204405', username: null, displayName: 'Кременчуцький Миколай' });
    const before = await totals();
    expect((await importTelegramExport(t.db, { bytes })).counters).toMatchObject({ imported: 0, unchanged: n });
    expect(await totals()).toEqual(before);
  });
});
