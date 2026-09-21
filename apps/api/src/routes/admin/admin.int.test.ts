import { loadApiEnv } from '@aerial/config';
import { AdminCommandResult, AdminOpsResponse, AdminReviewResponse, ApiError, OpsResponse, ReviewQueueResponse } from '@aerial/contracts';
import { PROCESS_REVISION, auditLog, claims, incidentEvidence, incidents, jobs, sources } from '@aerial/db';
import { and, eq, like } from '@aerial/db/orm';
import { AGGREGATE_CLAIM, REBUILD_INCIDENT } from '@aerial/db/repos/admin';
import { createTestDb } from '@aerial/db/testing';
import { createLogger } from '@aerial/observability';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app';
import { useDevKey } from '../../auth/testing';
import { SEED_TEXT, seedAdmin } from './__seed__';

type Role = 'viewer' | 'reviewer' | 'admin';
let t: Awaited<ReturnType<typeof createTestDb>>;
let app: ReturnType<typeof buildApp>;
let ids: Awaited<ReturnType<typeof seedAdmin>>;
const tokens = {} as Record<Role, string>;

beforeAll(async () => {
  t = await createTestDb();
  const dev = await useDevKey();
  for (const role of ['viewer', 'reviewer', 'admin'] as const) tokens[role] = await dev({ roles: [role], sub: `${role}-1` });
  ids = await seedAdmin(t.db);
  const env = loadApiEnv({ DATABASE_URL: t.url, APP_ENV: 'test' });
  app = buildApp({ db: { db: t.db, sql: t.sql, close: async () => {} }, env, logger: createLogger({ name: 't', level: 'silent' }) });
});
afterAll(async () => {
  await app?.close();
  await t?.drop();
});

const call = (method: 'GET' | 'POST', url: string, role: Role | null, payload?: object) =>
  app.inject({ method, url: `/v1/admin${url}`, headers: role ? { authorization: `Bearer ${tokens[role]}` } : {}, payload });
let n = 0;
const key = () => `test-key-${++n}`;
const auditsFor = (idempotencyKey: string) => t.db.select().from(auditLog).where(eq(auditLog.idempotencyKey, idempotencyKey));
const evidenceOf = (incidentId: string) => t.db.select().from(incidentEvidence).where(eq(incidentEvidence.incidentId, incidentId));
const revisionOf = async (id: string) => (await t.db.select().from(incidents).where(eq(incidents.id, id)))[0]!.revision;

describe('GET /v1/admin/review', () => {
  it('serves the review contract: redacted text, context, candidates, incident, and failed runs beside it', async () => {
    expect((await call('GET', '/review', null)).statusCode).toBe(401);
    const res = await call('GET', '/review', 'viewer');
    expect(res.statusCode).toBe(200);
    ReviewQueueResponse.parse(res.json()); // the web operator screens' contract
    const {
      data: [item, ...rest],
      failedRuns,
    } = AdminReviewResponse.parse(res.json());
    expect(rest).toEqual([]);
    expect(item!.claim.id).toBe(ids.claims.b);
    expect(item!.message).toMatchObject({
      sourceDisplayName: 'Синтетичний канал',
      messageExternalId: '102',
      messageUrl: 'https://t.me/synthetic_channel/102',
    });
    expect(item!.message.text).not.toContain('+380');
    expect(item!.message.text).toHaveLength(SEED_TEXT.b.length); // evidence spans stay valid
    expect(item!.context).toEqual([expect.objectContaining({ relation: 'context', messageExternalId: '101', text: SEED_TEXT.a })]);
    expect(item!.candidates).toEqual([{ placeId: 'ua-pl-c-poltava', name: 'Полтава' }]);
    expect(item!.incident).toEqual({ id: ids.incidents.i1, revision: 1, summary: 'Синтетичне зведення' });
    expect(failedRuns).toEqual([
      expect.objectContaining({ runId: ids.runs.c, error: 'gateway timeout', messageId: ids.messages.c.messageId, messageVersion: 1 }),
    ]);
  });
});

describe('GET /v1/admin/ops', () => {
  it('reports queue lanes, connector health and 24 h AI usage', async () => {
    const res = await call('GET', '/ops', 'viewer');
    expect(res.statusCode).toBe(200);
    OpsResponse.parse(res.json());
    const ops = AdminOpsResponse.parse(res.json()).data;
    expect(ops.queue).toEqual([
      { lane: 'live', queued: 4, running: 0, dead: 0, oldestQueuedAgeMs: expect.any(Number) },
      { lane: 'archive', queued: 0, running: 0, dead: 0, oldestQueuedAgeMs: null },
    ]);
    expect(ops.connectors).toEqual([
      expect.objectContaining({ id: ids.sourceId, displayName: 'Синтетичний канал', availability: 'ok', version: 1, lagMs: 1200 }),
    ]);
    expect(ops.ai).toMatchObject({
      requests: 4,
      failures: 1,
      lastErrorKind: 'gateway timeout',
      inputTokens: 310,
      outputTokens: 31,
      costUsd: null,
    });
    expect(ops.ai.lastFailureAt).not.toBeNull();
  });
});

describe('POST /v1/admin/claims/:id/review', () => {
  it('forbids viewers, then lets a reviewer confirm with an audit row and a re-aggregation job', async () => {
    const body = { action: 'confirm', expectedVersion: 1, idempotencyKey: key(), reason: 'Checked against the source' };
    expect((await call('POST', `/claims/${ids.claims.b}/review`, 'viewer', body)).statusCode).toBe(403);
    expect(await auditsFor(body.idempotencyKey)).toHaveLength(0);

    const res = await call('POST', `/claims/${ids.claims.b}/review`, 'reviewer', body);
    expect(res.statusCode).toBe(200);
    const result = AdminCommandResult.parse(res.json());
    expect(result).toMatchObject({ entityId: ids.claims.b, version: 2 });
    const [claim] = await t.db.select().from(claims).where(eq(claims.id, ids.claims.b));
    expect(claim).toMatchObject({ publicationDecision: 'publish', version: 2 });
    const [audit] = await auditsFor(body.idempotencyKey);
    expect(audit).toMatchObject({
      id: result.auditId,
      actor: 'reviewer-1',
      action: 'claim.confirm',
      entityType: 'claim',
      entityId: ids.claims.b,
      reason: body.reason,
      requestId: res.headers['x-request-id'],
      before: expect.objectContaining({ publicationDecision: 'review', version: 1 }),
      after: expect.objectContaining({ publicationDecision: 'publish', version: 2 }),
    });
    const [job] = await t.db.select().from(jobs).where(eq(jobs.id, result.jobIds[0]!));
    expect(job).toMatchObject({ kind: AGGREGATE_CLAIM, priority: 20, payload: { claimId: ids.claims.b, auditId: result.auditId } });
  });

  it('answers a stale expectedVersion with 409 version_conflict and changes nothing', async () => {
    const body = { action: 'exclude', expectedVersion: 1, idempotencyKey: key(), reason: 'Advertisement' };
    const res = await call('POST', `/claims/${ids.claims.b}/review`, 'reviewer', body);
    expect(res.statusCode).toBe(409);
    expect(ApiError.parse(res.json()).code).toBe('version_conflict');
    expect(await auditsFor(body.idempotencyKey)).toHaveLength(0);
    expect((await t.db.select().from(claims).where(eq(claims.id, ids.claims.b)))[0]?.publicationDecision).toBe('publish');
  });

  it('replays the same idempotency key with the same result and one effect; another body is 422', async () => {
    const body = {
      action: 'correct',
      expectedVersion: 1,
      idempotencyKey: key(),
      reason: 'The post names Poltava',
      correction: { placeId: 'ua-pl-c-poltava', geoBasis: 'explicit' },
    };
    const first = await call('POST', `/claims/${ids.claims.a}/review`, 'reviewer', body);
    const again = await call('POST', `/claims/${ids.claims.a}/review`, 'reviewer', body);
    expect(first.statusCode).toBe(200);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual(first.json());
    expect(await auditsFor(body.idempotencyKey)).toHaveLength(1);
    expect((await t.db.select().from(claims).where(eq(claims.id, ids.claims.a)))[0]).toMatchObject({
      placeId: 'ua-pl-c-poltava',
      version: 2,
    });

    const other = await call('POST', `/claims/${ids.claims.a}/review`, 'reviewer', { ...body, reason: 'A different reason' });
    expect(other.statusCode).toBe(422);
    expect(ApiError.parse(other.json()).code).toBe('idempotency_key_reused');
    const byOther = await call('POST', `/claims/${ids.claims.a}/review`, 'admin', body);
    expect(byOther.statusCode).toBe(422);
  });

  it('validates the claim, the body and place IDs', async () => {
    const body = { action: 'confirm', expectedVersion: 1, idempotencyKey: key(), reason: 'ok ok' };
    expect((await call('POST', '/claims/0b3c1f9e-8a3b-4a51-9d2e-2a4f3f7c1b10/review', 'reviewer', body)).statusCode).toBe(404);
    expect((await call('POST', '/claims/not-a-uuid/review', 'reviewer', body)).statusCode).toBe(400);
    const bad = { ...body, action: 'correct', expectedVersion: 2, correction: { placeId: 'ua-nowhere' } };
    const res = await call('POST', `/claims/${ids.claims.a}/review`, 'reviewer', bad);
    expect(res.statusCode).toBe(422);
    expect(ApiError.parse(res.json()).code).toBe('invalid_command');
  });

  it('derives geoBasis for a place sent alone and rejects a place/basis contradiction', async () => {
    const body = { action: 'correct', expectedVersion: 2, reason: 'The post names Poltava' };
    const contradiction = { ...body, idempotencyKey: key(), correction: { placeId: null, geoBasis: 'explicit' } };
    expect((await call('POST', `/claims/${ids.claims.b}/review`, 'reviewer', contradiction)).statusCode).toBe(422);
    const placeOnly = { ...body, idempotencyKey: key(), correction: { placeId: 'ua-pl-c-poltava' } };
    expect((await call('POST', `/claims/${ids.claims.b}/review`, 'reviewer', placeOnly)).statusCode).toBe(200);
    const [claim] = await t.db.select().from(claims).where(eq(claims.id, ids.claims.b));
    expect(claim).toMatchObject({ placeId: 'ua-pl-c-poltava', geoBasis: 'explicit', version: 3 });
  });
});

describe('incident split and merge', () => {
  it('splits selected claims into a new incident, keeps the original evidence rows and resolves the review', async () => {
    await t.db.update(claims).set({ publicationDecision: 'review' }).where(eq(claims.id, ids.claims.b));
    const body = { claimIds: [ids.claims.b], expectedVersion: 1, idempotencyKey: key(), reason: 'Different event' };
    const res = await call('POST', `/incidents/${ids.incidents.i1}/split`, 'reviewer', body);
    expect(res.statusCode).toBe(200);
    const { createdIncidentId, version, jobIds } = AdminCommandResult.parse(res.json());
    expect(version).toBe(2);
    expect(jobIds).toHaveLength(2);

    const original = await evidenceOf(ids.incidents.i1);
    expect(original.map((e) => [e.claimId, e.active]).sort()).toEqual(
      [
        [ids.claims.a, true],
        [ids.claims.b, false],
      ].sort(),
    );
    const [moved] = await evidenceOf(createdIncidentId!);
    expect(moved).toMatchObject({ claimId: ids.claims.b, active: true, relation: 'supporting' });
    expect(moved?.reason).toBe(`split from ${ids.incidents.i1}: Different event`);
    expect((await t.db.select().from(claims).where(eq(claims.id, ids.claims.b)))[0]).toMatchObject({
      publicationDecision: 'publish',
      version: 4,
    });
    const [created] = await t.db.select().from(incidents).where(eq(incidents.id, createdIncidentId!));
    expect(created?.firstSeenAt.toISOString()).toBe('2026-09-20T10:05:00.000Z');

    const rebuilds = await t.db.select().from(jobs).where(eq(jobs.kind, REBUILD_INCIDENT));
    expect(rebuilds.map((j) => j.payload.incidentId)).toEqual(expect.arrayContaining([ids.incidents.i1, createdIncidentId]));
  });

  it('refuses a split that names foreign claims or empties the incident', async () => {
    const base = { expectedVersion: 2, reason: 'Different event' };
    for (const claimIds of [[ids.claims.d], [ids.claims.a]]) {
      const res = await call('POST', `/incidents/${ids.incidents.i1}/split`, 'reviewer', { ...base, claimIds, idempotencyKey: key() });
      expect(res.statusCode).toBe(422);
    }
  });

  it('merges evidence into the target, keeps the old rows and bumps both revisions', async () => {
    const body = { targetIncidentId: ids.incidents.i1, expectedVersion: 1, idempotencyKey: key(), reason: 'Same group of drones' };
    const res = await call('POST', `/incidents/${ids.incidents.i2}/merge`, 'reviewer', body);
    expect(res.statusCode).toBe(200);
    expect(AdminCommandResult.parse(res.json()).version).toBe(2);
    expect(await revisionOf(ids.incidents.i1)).toBe(3);

    expect(await evidenceOf(ids.incidents.i2)).toEqual([expect.objectContaining({ claimId: ids.claims.d, active: false })]);
    const [merged] = await t.db
      .select()
      .from(incidentEvidence)
      .where(and(eq(incidentEvidence.incidentId, ids.incidents.i1), eq(incidentEvidence.claimId, ids.claims.d)));
    expect(merged).toMatchObject({ active: true, relation: 'primary', reason: `merged from ${ids.incidents.i2}: Same group of drones` });

    const stale = await call('POST', `/incidents/${ids.incidents.i2}/merge`, 'reviewer', { ...body, idempotencyKey: key() });
    expect(stale.statusCode).toBe(409);
    const empty = await call('POST', `/incidents/${ids.incidents.i2}/merge`, 'reviewer', {
      ...body,
      expectedVersion: 2,
      idempotencyKey: key(),
    });
    expect(empty.statusCode).toBe(422);
    const self = await call('POST', `/incidents/${ids.incidents.i1}/merge`, 'reviewer', {
      ...body,
      expectedVersion: 3,
      idempotencyKey: key(),
    });
    expect(self.statusCode).toBe(422);
  });
});

describe('POST /v1/admin/messages/:id/reprocess', () => {
  it('enqueues a new versioned job without touching earlier jobs or runs', async () => {
    const { messageId, revisionId } = ids.messages.c;
    const body = { expectedVersion: 1, idempotencyKey: key(), reason: 'Gateway is back' };
    const res = await call('POST', `/messages/${messageId}/reprocess`, 'reviewer', body);
    expect(res.statusCode).toBe(200);
    const { auditId, jobIds } = AdminCommandResult.parse(res.json());
    const all = await t.db
      .select()
      .from(jobs)
      .where(like(jobs.dedupeKey, `${PROCESS_REVISION}:${revisionId}%`));
    expect(all.map((j) => j.dedupeKey).sort()).toEqual([
      `${PROCESS_REVISION}:${revisionId}`,
      `${PROCESS_REVISION}:${revisionId}:reprocess:${auditId}`,
    ]);
    expect(all.find((j) => j.id === jobIds[0])?.payload).toEqual({ revisionId, messageId, reprocess: auditId });

    const again = await call('POST', `/messages/${messageId}/reprocess`, 'reviewer', { ...body, idempotencyKey: key() });
    expect(again.statusCode).toBe(409);
  });
});

describe('POST /v1/admin/sources/:id/pause', () => {
  it('is admin-only and toggles sources.enabled with an audit row', async () => {
    const body = { paused: true, expectedVersion: 1, idempotencyKey: key(), reason: 'Channel posts spam' };
    expect((await call('POST', `/sources/${ids.sourceId}/pause`, 'reviewer', body)).statusCode).toBe(403);
    const res = await call('POST', `/sources/${ids.sourceId}/pause`, 'admin', body);
    expect(res.statusCode).toBe(200);
    expect((await t.db.select().from(sources).where(eq(sources.id, ids.sourceId)))[0]).toMatchObject({ enabled: false, version: 2 });
    expect((await auditsFor(body.idempotencyKey))[0]).toMatchObject({ actor: 'admin-1', action: 'source.pause' });
  });
});
