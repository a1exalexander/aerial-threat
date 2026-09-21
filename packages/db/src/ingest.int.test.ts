import type { NormalizedMessage } from '@aerial/contracts';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROCESS_REVISION, ingestMessage } from './ingest';
import { JOB_PRIORITY } from './queue';
import { jobs, messageRevisions, messages } from './schema';
import { createTestDb } from './testing';

let t: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t?.drop());

let nextId = 1;
const synthetic = (over: Partial<NormalizedMessage> = {}): NormalizedMessage => ({
  sourceProvider: 'telegram',
  sourceExternalId: '1000000001',
  externalMessageId: String(nextId++),
  publishedAt: '2026-09-14T10:00:00Z',
  editedAt: null,
  replyToExternalId: null,
  rawText: 'Синтетичне повідомлення',
  normalizedText: 'синтетичне повідомлення',
  cleanedText: 'Синтетичне повідомлення',
  mediaFlags: [],
  rawPayload: { views: 1 },
  mode: 'live',
  ...over,
});
const ingest = (m: NormalizedMessage) => t.db.transaction((tx) => ingestMessage(tx, m));
const jobsFor = (revisionId: string) => t.db.select().from(jobs).where(eq(jobs.dedupeKey, `${PROCESS_REVISION}:${revisionId}`));

describe('ingestMessage', () => {
  it('is idempotent for the same content and ignores reaction/view noise', async () => {
    const m = synthetic({ externalMessageId: '9007199254740993' }); // beyond Number.MAX_SAFE_INTEGER
    const first = await ingest(m);
    expect(first.status).toBe('imported');
    const [job] = await jobsFor(first.revisionId);
    expect(job).toMatchObject({ kind: PROCESS_REVISION, priority: JOB_PRIORITY.live, payload: { revisionId: first.revisionId } });

    const again = await ingest({ ...m, rawPayload: { views: 500, reactions: [{ emoji: '👍', count: 9 }] } });
    expect(again).toEqual({ ...first, status: 'unchanged' });
    expect(await t.db.select().from(messageRevisions).where(eq(messageRevisions.messageId, first.messageId))).toHaveLength(1);
    expect(await t.db.select().from(jobs).where(eq(jobs.kind, PROCESS_REVISION))).toHaveLength(1);

    const [row] = await t.db.select().from(messages).where(eq(messages.id, first.messageId));
    expect(row!.externalMessageId).toBe('9007199254740993');
  });

  it('adds a revision and a live_update job when the text is edited', async () => {
    const m = synthetic();
    const first = await ingest(m);
    const edited = await ingest({ ...m, rawText: m.rawText + ' (оновлено)', editedAt: '2026-09-14T10:05:00Z' });
    expect(edited.status).toBe('revised');
    expect(edited.revisionId).not.toBe(first.revisionId);
    const [msg] = await t.db.select().from(messages).where(eq(messages.id, first.messageId));
    expect(msg).toMatchObject({ latestRevisionId: edited.revisionId, version: 2 });
    const [job] = await jobsFor(edited.revisionId);
    expect(job!.priority).toBe(JOB_PRIORITY.live_update);

    // Edited back to the first text: the old revision becomes current again.
    const reverted = await ingest(m);
    expect(reverted).toEqual({ ...first, status: 'revised' });
  });

  it('queues archive imports at archive priority', async () => {
    const r = await ingest(synthetic({ mode: 'archive' }));
    const [job] = await jobsFor(r.revisionId);
    expect(job!.priority).toBe(JOB_PRIORITY.archive);
  });

  it('leaves neither revision nor job when the transaction dies before commit', async () => {
    const m = synthetic();
    await expect(
      t.db.transaction(async (tx) => {
        await ingestMessage(tx, m);
        throw new Error('crash before commit');
      }),
    ).rejects.toThrow('crash before commit');
    const rows = await t.db.select().from(messages).where(eq(messages.externalMessageId, m.externalMessageId));
    expect(rows).toHaveLength(0);
    const replay = await ingest(m);
    expect(replay.status).toBe('imported');
    expect(await jobsFor(replay.revisionId)).toHaveLength(1);
  });

  it('rejects non-decimal IDs at the boundary', async () => {
    await expect(ingest(synthetic({ externalMessageId: '12e3' }))).rejects.toThrow();
  });
});
