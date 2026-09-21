// Synthetic rows for the operator API tests and the local e2e: no real posts, no personal data
// (the phone number is a placeholder that exercises redaction).
// CLI: `DATABASE_URL=... pnpm --filter @aerial/api exec tsx src/routes/admin/__seed__.ts` prints the IDs.
import { fileURLToPath } from 'node:url';
import type { Assessment, NormalizedMessage } from '@aerial/contracts';
import {
  type Db,
  claims,
  createDb,
  incidentEvidence,
  incidents,
  ingestMessage,
  processingDependencies,
  processingRuns,
  sourceHealth,
  sources,
} from '@aerial/db';
import { eq } from '@aerial/db/orm';

const SOURCE = '1000000008';
export const SEED_TEXT = {
  a: 'Синтетика: група БпЛА з півночі',
  b: 'Синтетика: БпЛА над містом, контакт +380 00 000 00 00',
  c: 'Синтетика: допис, розбір якого впав',
  d: 'Синтетика: БпЛА курсом на Кременчук',
};

const message = (id: string, publishedAt: string, text: string): NormalizedMessage => ({
  sourceProvider: 'telegram',
  sourceExternalId: SOURCE,
  externalMessageId: id,
  publishedAt,
  editedAt: null,
  replyToExternalId: null,
  rawText: text,
  normalizedText: text,
  cleanedText: text,
  mediaFlags: [],
  rawPayload: {},
  mode: 'live',
});

export async function seedAdmin(db: Db) {
  return db.transaction(async (tx) => {
    const a = await ingestMessage(tx, message('101', '2026-09-20T10:00:00Z', SEED_TEXT.a));
    const b = await ingestMessage(tx, message('102', '2026-09-20T10:05:00Z', SEED_TEXT.b));
    const c = await ingestMessage(tx, message('103', '2026-09-20T10:10:00Z', SEED_TEXT.c));
    const d = await ingestMessage(tx, message('104', '2026-09-20T10:15:00Z', SEED_TEXT.d));
    const [source] = await tx
      .update(sources)
      .set({ username: 'synthetic_channel', displayName: 'Синтетичний канал', defaultPlaceId: 'ua-pl' })
      .where(eq(sources.externalId, SOURCE))
      .returning({ id: sources.id });
    const sourceId = source!.id;
    await tx
      .insert(sourceHealth)
      .values({ sourceId, lastSuccessAt: new Date(), lastMessageAt: new Date('2026-09-20T10:15:00Z'), lagMs: 1200 })
      .onConflictDoNothing();

    const run = async (revisionId: string, status: string, usage: Record<string, number> | null, error: string | null = null) => {
      const [row] = await tx
        .insert(processingRuns)
        .values({
          revisionId,
          contextHash: 'synthetic',
          model: 'fake-evaluator',
          questionsVersion: 'q-test',
          parserVersion: 'p-test',
          policyVersion: 'policy-test',
          status,
          usage,
          error,
          finishedAt: new Date(),
        })
        .returning({ id: processingRuns.id });
      return row!.id;
    };
    const runA = await run(a.revisionId, 'succeeded', { inputTokens: 100, outputTokens: 10 });
    const runB = await run(b.revisionId, 'succeeded', { inputTokens: 120, outputTokens: 12 });
    const runC = await run(c.revisionId, 'failed', null, 'gateway timeout');
    const runD = await run(d.revisionId, 'succeeded', { inputTokens: 90, outputTokens: 9 });
    await tx.insert(processingDependencies).values({ runId: runB, dependsOnRevisionId: a.revisionId, relation: 'context' });

    const claim = async (
      runId: string,
      revisionId: string,
      text: string,
      over: Partial<typeof claims.$inferInsert> & { assessments?: Assessment[] } = {},
    ) => {
      const [row] = await tx
        .insert(claims)
        .values({
          runId,
          revisionId,
          kind: 'threat_report',
          threatType: 'uav',
          temporalScope: 'current',
          placeId: 'ua-pl',
          geoBasis: 'channel_default',
          evidence: [{ revisionId, start: 0, end: text.length, rawStart: 0, rawEnd: text.length }],
          publicationDecision: 'publish',
          uncertainty: { time: [], geo: ['from_channel_default'], classification: [] },
          ...over,
        })
        .returning({ id: claims.id });
      return row!.id;
    };
    const claimA = await claim(runA, a.revisionId, SEED_TEXT.a);
    const claimB = await claim(runB, b.revisionId, SEED_TEXT.b, {
      placeId: null,
      geoBasis: 'unresolved',
      publicationDecision: 'review',
      uncertainty: { time: [], geo: ['ambiguous_place'], classification: ['small_margin'] },
      assessments: [
        { type: 'choice', question: 'place_candidate', selected: 'unknown', probabilities: { 'ua-pl-c-poltava': 0.45, unknown: 0.55 } },
      ],
    });
    const claimD = await claim(runD, d.revisionId, SEED_TEXT.d, { placeId: 'ua-pl-c-kremenchuk', geoBasis: 'explicit' });

    const incident = async (at: string, evidence: [string, string][]) => {
      const [row] = await tx
        .insert(incidents)
        .values({
          kind: 'threat_report',
          threatType: 'uav',
          areaId: 'ua-pl',
          mode: 'live',
          lifecycle: 'reported',
          firstSeenAt: new Date(at),
          lastEvidenceAt: new Date(at),
          summary: 'Синтетичне зведення',
          policyVersion: 'policy-test',
        })
        .returning({ id: incidents.id });
      await tx.insert(incidentEvidence).values(evidence.map(([claimId, relation]) => ({ incidentId: row!.id, claimId, relation })));
      return row!.id;
    };
    const incident1 = await incident('2026-09-20T10:00:00Z', [
      [claimA, 'primary'],
      [claimB, 'supporting'],
    ]);
    const incident2 = await incident('2026-09-20T10:15:00Z', [[claimD, 'primary']]);

    return {
      sourceId,
      messages: { a, b, c, d },
      runs: { a: runA, b: runB, c: runC, d: runD },
      claims: { a: claimA, b: claimB, d: claimD },
      incidents: { i1: incident1, i2: incident2 },
    };
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const { db, close } = createDb(url);
  console.log(JSON.stringify(await seedAdmin(db), null, 2));
  await close();
}
