// Operator commands and read models behind /v1/admin/*. Every command runs in ONE transaction:
// idempotency check -> row lock + expectedVersion check -> domain change -> jobs -> audit_log row.
import { createHash, randomUUID } from 'node:crypto';
import type {
  AdminCommandResult,
  AdminOpsDto,
  Assessment,
  Claim,
  ClaimReviewCommand,
  FailedRunDto,
  IncidentMergeCommand,
  IncidentSplitCommand,
  MessageReprocessCommand,
  ReviewItemDto,
  ReviewMessageDto,
  SourceDto,
  SourcePauseCommand,
  SourceProvider,
} from '@aerial/contracts';
import { byId } from '@aerial/geo';
import { and, asc, desc, eq, gt, inArray, isNull, ne, notExists, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Db, Executor, Tx } from '../../client';
import { PROCESS_REVISION } from '../../ingest';
import { JOB_PRIORITY, enqueue } from '../../queue';
import {
  auditLog,
  claims,
  incidentEvidence,
  incidents,
  jobs,
  messageRevisions,
  messages,
  processingDependencies,
  processingRuns,
  sourceHealth,
  sources,
} from '../../schema';

// Jobs for the processing pipeline to consume (payload always names the audit row that caused it):
/** { incidentId }: rebuild the incident's projection (summary, lifecycle, times) from its active evidence. */
export const REBUILD_INCIDENT = 'rebuild_incident';
/** { claimId }: an operator changed the claim; re-link it (attach, move or drop) and rebuild the incidents it touches. */
export const AGGREGATE_CLAIM = 'aggregate_claim';

export type CommandErrorCode = 'not_found' | 'version_conflict' | 'idempotency_key_reused' | 'invalid_command';
export class CommandError extends Error {
  override name = 'CommandError';
  constructor(
    readonly code: CommandErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** Who is acting (the verified token `sub`) and the HTTP request ID, both stored in the audit row. */
export type CommandContext = { actor: string; requestId: string };

// ponytail: regex masking for display (phones, card/IBAN digit runs, e-mails); swap for @aerial/ai's redactor when it lands.
const PRIVATE = [/\+?\d(?:[ \xa0()-]{0,2}\d){9,}/g, /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g];
/** Masks private details character by character, so evidence span offsets stay valid. */
export const redact = (text: string): string => PRIVATE.reduce((t, re) => t.replace(re, (m) => '•'.repeat(m.length)), text);

// ---------------------------------------------------------------------------------------------
// Reads

// ponytail: same rules as repos/read/policy.ts (read API unit); import them from there once both have landed.
const SOURCE_DEGRADED_AFTER_MS = 5 * 60_000;
const SOURCE_UNAVAILABLE_AFTER_MS = 15 * 60_000;
const USERNAME = /^[A-Za-z][A-Za-z0-9_]{3,30}[A-Za-z0-9]$/;

/** Connector health, not channel activity: a quiet channel with a healthy connector is `ok`. */
function availability(s: { enabled: boolean; lastSuccessAt: Date | null; errorKind: string | null }, now: Date): SourceDto['availability'] {
  if (!s.enabled) return 'paused';
  if (!s.lastSuccessAt) return 'unknown';
  const age = now.getTime() - s.lastSuccessAt.getTime();
  if (age > SOURCE_UNAVAILABLE_AFTER_MS) return 'unavailable';
  return s.errorKind || age > SOURCE_DEGRADED_AFTER_MS ? 'degraded' : 'ok';
}

const iso = (d: Date | null) => d?.toISOString() ?? null;
const firstLine = (text: string | null, max = 200) => (text === null ? null : redact(text.split('\n')[0]!).slice(0, max));
const displayName = (s: { displayName: string | null; username: string | null; externalId: string }) =>
  s.displayName ?? s.username ?? s.externalId;

/** Columns that make a ReviewMessageDto: the revision's text with its message and source. */
const messageCols = {
  provider: sources.provider,
  sourceId: sources.id,
  username: sources.username,
  displayName: sources.displayName,
  externalId: sources.externalId,
  messageId: messages.id,
  messageVersion: messages.version,
  externalMessageId: messages.externalMessageId,
  publishedAt: messages.publishedAt,
  revisionId: messageRevisions.id,
  text: messageRevisions.normalizedText,
};
type MessageRow = {
  provider: string;
  sourceId: string;
  username: string | null;
  displayName: string | null;
  externalId: string;
  externalMessageId: string;
  publishedAt: Date;
  text: string;
};

function toMessage(r: MessageRow): ReviewMessageDto {
  const linkable = r.provider === 'telegram' && r.username !== null && USERNAME.test(r.username) && /^[1-9]\d*$/.test(r.externalMessageId);
  return {
    sourceId: r.sourceId,
    sourceUsername: r.username,
    sourceDisplayName: displayName(r),
    messageExternalId: r.externalMessageId,
    messageUrl: linkable ? `https://t.me/${r.username}/${r.externalMessageId}` : null,
    publishedAt: r.publishedAt.toISOString(),
    text: redact(r.text),
  };
}

/** The place candidates the model chose among: options of choice assessments that are dictionary places. */
const candidates = (assessments: Assessment[]) =>
  [...new Set(assessments.flatMap((a) => (a.type === 'choice' ? [a.selected, ...Object.keys(a.probabilities)] : [])))].flatMap((id) => {
    const place = byId(id);
    return place ? [{ placeId: place.id, name: place.name }] : [];
  });

/**
 * Active claims with publicationDecision=review (newest first), plus the revisions whose latest processing run
 * failed. Texts are redacted with the same length, so evidence spans still point at the right characters.
 */
export async function reviewQueue(
  db: Executor,
  { limit }: { limit: number },
): Promise<{ items: ReviewItemDto[]; failedRuns: FailedRunDto[] }> {
  const later = alias(processingRuns, 'later_run');
  const [claimRows, failedRows] = await Promise.all([
    db
      .select({ claim: claims, ...messageCols })
      .from(claims)
      .innerJoin(messageRevisions, eq(messageRevisions.id, claims.revisionId))
      .innerJoin(messages, eq(messages.id, messageRevisions.messageId))
      .innerJoin(sources, eq(sources.id, messages.sourceId))
      .where(and(eq(claims.publicationDecision, 'review'), eq(claims.active, true), isNull(messages.deletedAt)))
      .orderBy(desc(messages.publishedAt), asc(claims.ordinal))
      .limit(limit),
    db
      .select({
        runId: processingRuns.id,
        error: processingRuns.error,
        startedAt: processingRuns.startedAt,
        finishedAt: processingRuns.finishedAt,
        ...messageCols,
      })
      .from(processingRuns)
      .innerJoin(messageRevisions, eq(messageRevisions.id, processingRuns.revisionId))
      .innerJoin(messages, and(eq(messages.id, messageRevisions.messageId), eq(messages.latestRevisionId, messageRevisions.id)))
      .innerJoin(sources, eq(sources.id, messages.sourceId))
      .where(
        and(
          eq(processingRuns.status, 'failed'),
          isNull(messages.deletedAt),
          notExists(
            db
              .select({ one: sql`1` })
              .from(later)
              .where(and(eq(later.revisionId, processingRuns.revisionId), gt(later.startedAt, processingRuns.startedAt))),
          ),
        ),
      )
      .orderBy(desc(messages.publishedAt))
      .limit(limit),
  ]);

  const runIds = [...new Set(claimRows.map((r) => r.claim.runId))];
  const claimIds = claimRows.map((r) => r.claim.id);
  const [context, linked] = await Promise.all([
    runIds.length
      ? db
          .select({ runId: processingDependencies.runId, relation: processingDependencies.relation, ...messageCols })
          .from(processingDependencies)
          .innerJoin(messageRevisions, eq(messageRevisions.id, processingDependencies.dependsOnRevisionId))
          .innerJoin(messages, eq(messages.id, messageRevisions.messageId))
          .innerJoin(sources, eq(sources.id, messages.sourceId))
          .where(inArray(processingDependencies.runId, runIds))
          .orderBy(asc(messages.publishedAt))
      : [],
    claimIds.length
      ? db
          .select({ claimId: incidentEvidence.claimId, id: incidents.id, revision: incidents.revision, summary: incidents.summary })
          .from(incidentEvidence)
          .innerJoin(incidents, eq(incidents.id, incidentEvidence.incidentId))
          .where(and(inArray(incidentEvidence.claimId, claimIds), eq(incidentEvidence.active, true)))
          .orderBy(desc(incidents.lastEvidenceAt))
      : [],
  ]);

  const items = claimRows.map(({ claim: { ordinal: _o, createdAt: _c, updatedAt: _u, ...claim }, ...r }): ReviewItemDto => {
    const incident = linked.find((l) => l.claimId === claim.id);
    return {
      claim: claim as Claim,
      message: toMessage(r),
      context: context
        .filter((c) => c.runId === claim.runId)
        .map((c) => ({ ...toMessage(c), relation: c.relation === 'reply_parent' ? ('reply_parent' as const) : ('context' as const) })),
      candidates: candidates(claim.assessments),
      incident: incident ? { id: incident.id, revision: incident.revision, summary: incident.summary ?? '' } : null,
    };
  });
  const failedRuns = failedRows.map((r): FailedRunDto => ({
    runId: r.runId,
    error: firstLine(r.error),
    failedAt: (r.finishedAt ?? r.startedAt).toISOString(),
    messageId: r.messageId,
    messageVersion: r.messageVersion,
    revisionId: r.revisionId,
    message: toMessage(r),
  }));
  return { items, failedRuns };
}

/** Connectors, queue lanes (live = priority >= JOB_PRIORITY.live, so replay never masks live lag) and 24 h AI usage. */
export async function opsSnapshot(db: Executor, now = new Date()): Promise<AdminOpsDto> {
  // Inlined constant: a bound parameter would make the SELECT and GROUP BY expressions differ for Postgres.
  const lane = sql<'live' | 'archive'>`case when ${jobs.priority} >= ${sql.raw(String(JOB_PRIORITY.live))} then 'live' else 'archive' end`;
  const waiting = sql`${jobs.status} in ('queued', 'failed')`; // failed = waiting for its retry
  const last24h = sql`now() - interval '24 hours'`;
  const tokens = (key: string) =>
    sql<number>`coalesce(sum(case when jsonb_typeof(${processingRuns.usage} -> ${key}) = 'number' then (${processingRuns.usage} ->> ${key})::numeric end), 0)::float8`;
  const [lanes, connectorRows, [ai], [lastFailure]] = await Promise.all([
    db
      .select({
        lane,
        queued: sql<number>`(count(*) filter (where ${waiting}))::int`,
        running: sql<number>`(count(*) filter (where ${jobs.status} = 'running'))::int`,
        dead: sql<number>`(count(*) filter (where ${jobs.status} = 'dead'))::int`,
        oldestQueuedAgeMs: sql<
          number | null
        >`(extract(epoch from now() - min(${jobs.createdAt}) filter (where ${waiting})) * 1000)::float8`,
      })
      .from(jobs)
      .where(ne(jobs.status, 'done'))
      .groupBy(lane),
    db
      .select({
        id: sources.id,
        provider: sources.provider,
        username: sources.username,
        displayName: sources.displayName,
        externalId: sources.externalId,
        enabled: sources.enabled,
        version: sources.version,
        lastSuccessAt: sourceHealth.lastSuccessAt,
        lastMessageAt: sourceHealth.lastMessageAt,
        lagMs: sourceHealth.lagMs,
        errorKind: sourceHealth.errorKind,
      })
      .from(sources)
      .leftJoin(sourceHealth, eq(sourceHealth.sourceId, sources.id))
      .orderBy(sources.provider, sources.displayName),
    db
      .select({
        requests: sql<number>`count(*)::int`,
        failures: sql<number>`(count(*) filter (where ${processingRuns.status} = 'failed'))::int`,
        inputTokens: tokens('inputTokens'),
        outputTokens: tokens('outputTokens'),
      })
      .from(processingRuns)
      .where(gt(processingRuns.startedAt, last24h)),
    db
      .select({
        error: processingRuns.error,
        at: sql`coalesce(${processingRuns.finishedAt}, ${processingRuns.startedAt})`.mapWith(processingRuns.startedAt),
      })
      .from(processingRuns)
      .where(and(eq(processingRuns.status, 'failed'), gt(processingRuns.startedAt, last24h)))
      .orderBy(desc(processingRuns.startedAt))
      .limit(1),
  ]);
  return {
    connectors: connectorRows.map((s) => ({
      id: s.id,
      provider: s.provider as SourceProvider,
      username: s.username,
      displayName: displayName(s),
      enabled: s.enabled,
      version: s.version,
      lastSuccessfulSync: iso(s.lastSuccessAt),
      lastMessageAt: iso(s.lastMessageAt),
      availability: availability(s, now),
      lagMs: s.lagMs === null ? null : Math.max(0, s.lagMs),
      errorKind: s.errorKind,
    })),
    queue: (['live', 'archive'] as const).map((name) => {
      const l = lanes.find((x) => x.lane === name);
      const age = l?.oldestQueuedAgeMs ?? null;
      return {
        lane: name,
        queued: l?.queued ?? 0,
        running: l?.running ?? 0,
        dead: l?.dead ?? 0,
        oldestQueuedAgeMs: age === null ? null : Math.max(0, Math.round(age)),
      };
    }),
    ai: {
      windowHours: 24,
      requests: ai?.requests ?? 0,
      failures: ai?.failures ?? 0,
      lastErrorKind: firstLine(lastFailure?.error?.split(':')[0] ?? null, 80),
      lastFailureAt: iso(lastFailure?.at ?? null),
      inputTokens: Math.round(ai?.inputTokens ?? 0),
      outputTokens: Math.round(ai?.outputTokens ?? 0),
      costUsd: null, // no agreed tariff yet: never a guessed amount
      dailyRequestLimit: null, // AI_DAILY_REQUEST_LIMIT is worker config, not visible to the API
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Commands

type Applied = {
  entityType: 'claim' | 'incident' | 'message' | 'source';
  before: unknown;
  after: unknown;
  version: number;
  createdIncidentId?: string;
  jobIds: string[];
};

/** JSON with sorted object keys, so the request hash does not depend on key order. */
const canonical = (v: unknown) =>
  JSON.stringify(v, (_k, val: unknown) =>
    val && typeof val === 'object' && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val).sort(([a], [b]) => (a < b ? -1 : 1)))
      : val,
  );

async function command(
  db: Db,
  ctx: CommandContext,
  action: string,
  entityId: string,
  { idempotencyKey, ...request }: { idempotencyKey: string; reason: string },
  apply: (tx: Tx, auditId: string) => Promise<Applied>,
): Promise<AdminCommandResult> {
  const requestHash = createHash('sha256')
    .update(canonical([ctx.actor, action, entityId, request]))
    .digest('hex');
  return db.transaction(async (tx) => {
    // Serializes retries of one key (class 8 = operator commands), so a replay never races its original.
    await tx.execute(sql`select pg_advisory_xact_lock(8, hashtext(${idempotencyKey}))`);
    const [prior] = await tx
      .select({ requestHash: auditLog.requestHash, response: auditLog.response })
      .from(auditLog)
      .where(eq(auditLog.idempotencyKey, idempotencyKey));
    if (prior) {
      if (prior.requestHash !== requestHash) {
        throw new CommandError('idempotency_key_reused', 'This idempotency key was already used for a different request');
      }
      return prior.response as AdminCommandResult;
    }
    const auditId = randomUUID();
    const { entityType, before, after, ...result } = await apply(tx, auditId);
    const response: AdminCommandResult = { auditId, entityId, ...result };
    await tx.insert(auditLog).values({
      id: auditId,
      actor: ctx.actor,
      action,
      entityType,
      entityId,
      before,
      after,
      reason: request.reason,
      idempotencyKey,
      requestId: ctx.requestId,
      requestHash,
      response,
    });
    return response;
  });
}

async function found<T>(query: PromiseLike<T[]>, what: string): Promise<T> {
  const [row] = await query;
  if (!row) throw new CommandError('not_found', `${what} not found`);
  return row;
}

function checkVersion(current: number, expected: number) {
  if (current !== expected) {
    throw new CommandError('version_conflict', `Expected version ${expected} but the current one is ${current}; re-read and retry`);
  }
}

const priorityFor = (mode: string) => (mode === 'archive' ? JOB_PRIORITY.archive : JOB_PRIORITY.live);

/** One rebuild job per incident and command (the key names the audit row), so no change is folded into a running rebuild. */
async function rebuild(tx: Tx, targets: { id: string; mode: string }[], auditId: string): Promise<string[]> {
  const ids: string[] = [];
  for (const { id: incidentId, mode } of targets) {
    const job = await enqueue(tx, {
      kind: REBUILD_INCIDENT,
      dedupeKey: `${REBUILD_INCIDENT}:${incidentId}:${auditId}`,
      payload: { incidentId, auditId },
      priority: priorityFor(mode),
    });
    ids.push(job.id);
  }
  return ids;
}

const reviewFields = (c: typeof claims.$inferSelect) => ({
  kind: c.kind,
  threatType: c.threatType,
  temporalScope: c.temporalScope,
  placeId: c.placeId,
  geoBasis: c.geoBasis,
  publicationDecision: c.publicationDecision,
  version: c.version,
});

/**
 * confirm -> publish, exclude -> exclude, correct -> apply the correction and publish. Kind, place or decision may
 * change incident membership, so the claim goes back to aggregation (AGGREGATE_CLAIM), not just a rebuild.
 */
export function reviewClaim(db: Db, ctx: CommandContext, claimId: string, cmd: ClaimReviewCommand) {
  return command(db, ctx, `claim.${cmd.action}`, claimId, cmd, async (tx, auditId) => {
    const claim = await found(tx.select().from(claims).where(eq(claims.id, claimId)).for('update'), 'Claim');
    if (!claim.active) throw new CommandError('invalid_command', 'Claim is no longer active (superseded by a newer revision or run)');
    checkVersion(claim.version, cmd.expectedVersion);
    const correction: Extract<ClaimReviewCommand, { action: 'correct' }>['correction'] = cmd.action === 'correct' ? cmd.correction : {};
    const patch: Partial<typeof claims.$inferInsert> = {
      ...correction,
      publicationDecision: cmd.action === 'exclude' ? 'exclude' : 'publish',
    };
    if (correction.placeId !== undefined || correction.geoBasis !== undefined) {
      // Place and basis must agree (no place <=> unresolved); a place sent alone gets its basis derived.
      const placeId = correction.placeId !== undefined ? correction.placeId : claim.placeId;
      if (placeId !== null && !byId(placeId)) throw new CommandError('invalid_command', `Unknown place ID "${placeId}"`);
      patch.geoBasis =
        correction.geoBasis ?? (placeId === null ? 'unresolved' : claim.geoBasis === 'unresolved' ? 'explicit' : claim.geoBasis);
      if ((placeId === null) !== (patch.geoBasis === 'unresolved')) {
        throw new CommandError('invalid_command', 'placeId and geoBasis disagree: only an unresolved claim has no place');
      }
    }
    const [updated] = await tx
      .update(claims)
      .set({ ...patch, version: claim.version + 1, updatedAt: sql`now()` })
      .where(eq(claims.id, claimId))
      .returning();
    const [message] = await tx
      .select({ mode: messages.mode })
      .from(messageRevisions)
      .innerJoin(messages, eq(messages.id, messageRevisions.messageId))
      .where(eq(messageRevisions.id, claim.revisionId));
    const job = await enqueue(tx, {
      kind: AGGREGATE_CLAIM,
      dedupeKey: `${AGGREGATE_CLAIM}:${claimId}:${auditId}`,
      payload: { claimId, auditId },
      priority: priorityFor(message?.mode ?? 'live'),
    });
    return {
      entityType: 'claim',
      before: reviewFields(claim),
      after: reviewFields(updated!),
      version: claim.version + 1,
      jobIds: [job.id],
    };
  });
}

/** Moves the incident's active evidence into the target. The old rows stay (inactive) as original evidence. */
export function mergeIncident(db: Db, ctx: CommandContext, incidentId: string, cmd: IncidentMergeCommand) {
  return command(db, ctx, 'incident.merge', incidentId, cmd, async (tx, auditId) => {
    const targetId = cmd.targetIncidentId.toLowerCase();
    if (targetId === incidentId) throw new CommandError('invalid_command', 'An incident cannot be merged into itself');
    // Both rows locked in id order, so two opposite merges cannot deadlock.
    const rows = await tx
      .select()
      .from(incidents)
      .where(inArray(incidents.id, [incidentId, targetId]))
      .orderBy(asc(incidents.id))
      .for('update');
    const source = rows.find((r) => r.id === incidentId);
    const target = rows.find((r) => r.id === targetId);
    if (!source) throw new CommandError('not_found', 'Incident not found');
    checkVersion(source.revision, cmd.expectedVersion);
    if (!target) throw new CommandError('invalid_command', 'Target incident not found');
    if (source.mode !== target.mode) throw new CommandError('invalid_command', 'Archive and live incidents cannot be merged');

    const moved = await tx
      .update(incidentEvidence)
      .set({ active: false })
      .where(and(eq(incidentEvidence.incidentId, incidentId), eq(incidentEvidence.active, true)))
      .returning();
    if (!moved.length) throw new CommandError('invalid_command', 'Incident has no active evidence to merge');
    const [targetEvidence] = await tx
      .select({ claimId: incidentEvidence.claimId })
      .from(incidentEvidence)
      .where(and(eq(incidentEvidence.incidentId, targetId), eq(incidentEvidence.active, true)))
      .limit(1);
    if (!targetEvidence) throw new CommandError('invalid_command', 'Target incident has no active evidence (merged away?)');
    await tx
      .insert(incidentEvidence)
      .values(
        moved.map((e) => ({
          incidentId: targetId,
          claimId: e.claimId,
          relation: e.relation,
          originGroup: e.originGroup,
          reason: `merged from ${incidentId}: ${cmd.reason}`,
        })),
      )
      // A claim the target once had (e.g. split off earlier) comes back as moved; an active row stays as it is.
      .onConflictDoUpdate({
        target: [incidentEvidence.incidentId, incidentEvidence.claimId],
        set: { active: true, relation: sql`excluded.relation`, originGroup: sql`excluded.origin_group`, reason: sql`excluded.reason` },
        setWhere: eq(incidentEvidence.active, false),
      });
    await tx
      .update(incidents)
      .set({ revision: source.revision + 1, updatedAt: sql`now()` })
      .where(eq(incidents.id, incidentId));
    await tx
      .update(incidents)
      .set({
        revision: target.revision + 1,
        firstSeenAt: source.firstSeenAt < target.firstSeenAt ? source.firstSeenAt : target.firstSeenAt,
        lastEvidenceAt: source.lastEvidenceAt > target.lastEvidenceAt ? source.lastEvidenceAt : target.lastEvidenceAt,
        updatedAt: sql`now()`,
      })
      .where(eq(incidents.id, targetId));
    return {
      entityType: 'incident',
      before: { revision: source.revision, claimIds: moved.map((e) => e.claimId), targetRevision: target.revision },
      after: { revision: source.revision + 1, mergedInto: targetId, targetRevision: target.revision + 1 },
      version: source.revision + 1,
      jobIds: await rebuild(tx, [source, target], auditId),
    };
  });
}

/** Moves the selected claims into a new incident. Their rows in the old incident stay (inactive) as original evidence. */
export function splitIncident(db: Db, ctx: CommandContext, incidentId: string, cmd: IncidentSplitCommand) {
  return command(db, ctx, 'incident.split', incidentId, cmd, async (tx, auditId) => {
    const source = await found(tx.select().from(incidents).where(eq(incidents.id, incidentId)).for('update'), 'Incident');
    checkVersion(source.revision, cmd.expectedVersion);
    const claimIds = [...new Set(cmd.claimIds.map((c) => c.toLowerCase()))];
    const evidence = await tx
      .select()
      .from(incidentEvidence)
      .where(and(eq(incidentEvidence.incidentId, incidentId), eq(incidentEvidence.active, true)));
    const moving = evidence.filter((e) => claimIds.includes(e.claimId));
    if (moving.length !== claimIds.length)
      throw new CommandError('invalid_command', 'Every claim must be active evidence of this incident');
    if (moving.length === evidence.length)
      throw new CommandError('invalid_command', 'A split must leave at least one claim in the incident');

    const [span] = await tx
      .select({
        first: sql`min(${messages.publishedAt})`.mapWith(messages.publishedAt),
        last: sql`max(${messages.publishedAt})`.mapWith(messages.publishedAt),
      })
      .from(claims)
      .innerJoin(messageRevisions, eq(messageRevisions.id, claims.revisionId))
      .innerJoin(messages, eq(messages.id, messageRevisions.messageId))
      .where(inArray(claims.id, claimIds));
    const [created] = await tx
      .insert(incidents)
      .values({
        kind: source.kind,
        threatType: source.threatType,
        areaId: source.areaId,
        mode: source.mode,
        lifecycle: source.lifecycle,
        firstSeenAt: span?.first ?? source.firstSeenAt,
        lastEvidenceAt: span?.last ?? source.lastEvidenceAt,
        policyVersion: source.policyVersion,
      })
      .returning({ id: incidents.id, mode: incidents.mode });
    const createdId = created!.id;
    await tx.insert(incidentEvidence).values(
      moving.map((e) => ({
        incidentId: createdId,
        claimId: e.claimId,
        relation: e.relation,
        originGroup: e.originGroup,
        reason: `split from ${incidentId}: ${cmd.reason}`,
      })),
    );
    await tx
      .update(incidentEvidence)
      .set({ active: false })
      .where(and(eq(incidentEvidence.incidentId, incidentId), inArray(incidentEvidence.claimId, claimIds)));
    // Splitting a claim out is the operator's verdict that it reports its own event, so it leaves the review queue.
    const published = await tx
      .update(claims)
      .set({ publicationDecision: 'publish', version: sql`${claims.version} + 1`, updatedAt: sql`now()` })
      .where(and(inArray(claims.id, claimIds), eq(claims.publicationDecision, 'review')))
      .returning({ id: claims.id });
    await tx
      .update(incidents)
      .set({ revision: source.revision + 1, updatedAt: sql`now()` })
      .where(eq(incidents.id, incidentId));
    return {
      entityType: 'incident',
      before: { revision: source.revision, claimIds: evidence.map((e) => e.claimId) },
      after: {
        revision: source.revision + 1,
        splitClaimIds: claimIds,
        createdIncidentId: createdId,
        publishedClaimIds: published.map((c) => c.id),
      },
      version: source.revision + 1,
      createdIncidentId: createdId,
      jobIds: await rebuild(tx, [source, created!], auditId),
    };
  });
}

/** Enqueues a new process_revision job for the latest revision; earlier jobs, runs and claims are kept. */
export function reprocessMessage(db: Db, ctx: CommandContext, messageId: string, cmd: MessageReprocessCommand) {
  return command(db, ctx, 'message.reprocess', messageId, cmd, async (tx, auditId) => {
    const message = await found(tx.select().from(messages).where(eq(messages.id, messageId)).for('update'), 'Message');
    checkVersion(message.version, cmd.expectedVersion);
    const revisionId = message.latestRevisionId;
    if (!revisionId) throw new CommandError('invalid_command', 'Message has no revision to process');
    if (message.deletedAt) throw new CommandError('invalid_command', 'Message was deleted at the source');
    await tx
      .update(messages)
      .set({ version: message.version + 1 })
      .where(eq(messages.id, messageId));
    // The audit ID is the reprocess nonce: a fresh dedupe key that never collapses into an older job. The pipeline
    // must fold payload.reprocess into its processing_runs key so the new run is stored next to the old ones.
    const job = await enqueue(tx, {
      kind: PROCESS_REVISION,
      dedupeKey: `${PROCESS_REVISION}:${revisionId}:reprocess:${auditId}`,
      payload: { revisionId, messageId, reprocess: auditId },
      priority: priorityFor(message.mode),
    });
    return {
      entityType: 'message',
      before: { version: message.version, revisionId },
      after: { version: message.version + 1, revisionId, jobId: job.id },
      version: message.version + 1,
      jobIds: [job.id],
    };
  });
}

/** paused=true disables the source (connectors skip it); paused=false enables it again. */
export function pauseSource(db: Db, ctx: CommandContext, sourceId: string, cmd: SourcePauseCommand) {
  return command(db, ctx, cmd.paused ? 'source.pause' : 'source.resume', sourceId, cmd, async (tx) => {
    const source = await found(tx.select().from(sources).where(eq(sources.id, sourceId)).for('update'), 'Source');
    checkVersion(source.version, cmd.expectedVersion);
    await tx
      .update(sources)
      .set({ enabled: !cmd.paused, version: source.version + 1, updatedAt: sql`now()` })
      .where(eq(sources.id, sourceId));
    return {
      entityType: 'source',
      before: { enabled: source.enabled, version: source.version },
      after: { enabled: !cmd.paused, version: source.version + 1 },
      version: source.version + 1,
      jobIds: [],
    };
  });
}
