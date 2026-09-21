import {
  alertSnapshots,
  alertStates,
  auditLog,
  claims,
  incidentEvidence,
  incidents,
  jobs,
  messageRevisions,
  messages,
  processingRuns,
  sources,
} from '@aerial/db';
import { createTestDb } from '@aerial/db/testing';
import { createLogger } from '@aerial/observability';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { runRetention } from './retention';

let t: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t?.drop());

const now = new Date('2026-09-21T12:00:00Z');
const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);
const logger = createLogger({ name: 't', level: 'silent' });
const uncertainty = { time: [], geo: [], classification: [] };

async function seedMessage(externalId: string, observedAt: Date) {
  const [source] = await t.db
    .insert(sources)
    .values({ provider: 'telegram', externalId: '1000000001' })
    .onConflictDoUpdate({ target: [sources.provider, sources.externalId], set: { version: 1 } })
    .returning();
  const [message] = await t.db
    .insert(messages)
    .values({ sourceId: source!.id, externalMessageId: externalId, publishedAt: observedAt, mode: 'live' })
    .returning();
  const [revision] = await t.db
    .insert(messageRevisions)
    .values({
      messageId: message!.id,
      revisionHash: `hash-${externalId}`,
      rawPayload: { text: 'Синтетичний текст, тел. 000' },
      rawText: 'Синтетичний текст, тел. 000',
      normalizedText: 'синтетичний текст',
      cleanedText: 'Синтетичний текст',
      observedAt,
    })
    .returning();
  const [run] = await t.db
    .insert(processingRuns)
    .values({ revisionId: revision!.id, contextHash: 'c', model: 'm', questionsVersion: 'q', parserVersion: 'p', policyVersion: 'v', status: 'succeeded' })
    .returning();
  const [claim] = await t.db
    .insert(claims)
    .values({
      runId: run!.id,
      revisionId: revision!.id,
      kind: 'threat_report',
      threatType: 'uav',
      temporalScope: 'current',
      geoBasis: 'explicit',
      movementMention: 'у напрямку Кременчука',
      quantityText: 'багато',
      evidence: [{ revisionId: revision!.id, start: 0, end: 5, rawStart: 0, rawEnd: 5 }],
      publicationDecision: 'publish',
      uncertainty,
    })
    .returning();
  return { revision: revision!, claim: claim! };
}

it('scrubs raw text past 30 d, deletes aggregates past 180 d in batches, and is idempotent', async () => {
  const old = await seedMessage('101', daysAgo(31));
  const fresh = await seedMessage('102', daysAgo(1));

  // Aged by created_at (when we built it), not by the event time of the posts.
  const incident = (createdAt: Date) => ({
    kind: 'threat_report',
    mode: 'archive',
    lifecycle: 'archived',
    firstSeenAt: daysAgo(400),
    lastEvidenceAt: daysAgo(400),
    policyVersion: 'v',
    createdAt,
  });
  const [oldIncident, freshIncident] = await t.db.insert(incidents).values([incident(daysAgo(181)), incident(daysAgo(2))]).returning();
  await t.db.insert(incidentEvidence).values([
    { incidentId: oldIncident!.id, claimId: old.claim.id, relation: 'supports' },
    { incidentId: freshIncident!.id, claimId: fresh.claim.id, relation: 'supports' },
  ]);

  const snapshot = (fetchedAt: Date) => ({ provider: 'neptun', fetchedAt, payloadHash: 'h', rawPayload: { a: 1 }, valid: true });
  const [rawOld, , ancientCurrent, freshSnap] = await t.db
    .insert(alertSnapshots)
    .values([snapshot(daysAgo(31)), snapshot(daysAgo(181)), snapshot(daysAgo(200)), snapshot(daysAgo(1))])
    .returning();
  // A still-current state pins its snapshot even when it is old (quiet area, no provider changes).
  await t.db.insert(alertStates).values({ areaKey: 'ua-pl', areaKind: 'oblast', state: 'active', freshness: 'fresh', snapshotId: ancientCurrent!.id });

  const job = (key: string, status: 'done' | 'dead' | 'queued', finishedAt: Date | null) => ({ kind: 'k', dedupeKey: key, status, finishedAt });
  await t.db.insert(jobs).values([
    job('done-old-1', 'done', daysAgo(15)),
    job('done-old-2', 'done', daysAgo(20)),
    job('done-fresh', 'done', daysAgo(1)),
    job('dead-old', 'dead', daysAgo(30)),
    job('queued', 'queued', null),
  ]);

  const audit = (key: string, createdAt: Date) => ({ actor: 'a', action: 'x', entityType: 'claim', entityId: '1', reason: 'r', idempotencyKey: key, createdAt });
  await t.db.insert(auditLog).values([audit('audit-old', daysAgo(181)), audit('audit-fresh', daysAgo(179))]);

  // batchSize 1 forces the multi-batch path for every step with more than one row.
  const counts = await runRetention(t.sql, { now, logger, batchSize: 1 });
  expect(counts).toEqual({
    revisionTextScrubbed: 1,
    alertPayloadScrubbed: 2, // the unreferenced 181-day-old snapshot is deleted first
    doneJobsDeleted: 2,
    incidentsDeleted: 1,
    alertSnapshotsDeleted: 1,
    auditDeleted: 1,
  });

  const revisions = await t.sql`select id, raw_payload, raw_text, normalized_text, cleaned_text, revision_hash from message_revisions order by observed_at`;
  expect(revisions[0]).toMatchObject({ id: old.revision.id, raw_payload: null, raw_text: '', normalized_text: '', cleaned_text: '', revision_hash: 'hash-101' });
  expect(revisions[1]).toMatchObject({ id: fresh.revision.id, raw_text: 'Синтетичний текст, тел. 000' });

  // Claims are aggregate data: structured fields and evidence spans stay, pointing at the scrubbed revision.
  const [oldClaim] = await t.sql`select revision_id, movement_mention, evidence, version from claims where id = ${old.claim.id}`;
  expect(oldClaim).toMatchObject({ revision_id: old.revision.id, movement_mention: 'у напрямку Кременчука', version: 1 });
  expect(oldClaim!.evidence).toEqual(old.claim.evidence);

  expect((await t.sql`select id from incidents`).map((r) => r.id)).toEqual([freshIncident!.id]);
  expect((await t.sql`select claim_id from incident_evidence`).map((r) => r.claim_id)).toEqual([fresh.claim.id]);

  const snaps = await t.sql`select id, raw_payload from alert_snapshots`;
  expect(new Map(snaps.map((s) => [s.id, s.raw_payload]))).toEqual(
    new Map<string, unknown>([
      [rawOld!.id, null],
      [ancientCurrent!.id, null],
      [freshSnap!.id, { a: 1 }],
    ]),
  );

  expect((await t.sql`select dedupe_key from jobs order by dedupe_key`).map((r) => r.dedupe_key)).toEqual(['dead-old', 'done-fresh', 'queued']);
  expect((await t.sql`select idempotency_key from audit_log`).map((r) => r.idempotency_key)).toEqual(['audit-fresh']);

  const again = await runRetention(t.sql, { now, logger, batchSize: 1 });
  expect(Object.values(again).every((c) => c === 0)).toBe(true);
});
