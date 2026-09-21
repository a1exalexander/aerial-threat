// Drizzle mirror of migrations/*.sql (the SQL files are the source of truth; schema.int.test.ts checks parity).
// There is no `places` table: the place dictionary is versioned code in @aerial/geo (DICTIONARY_VERSION),
// so place_id/area_id columns hold stable geo IDs validated at write time, not FKs.
import type { Assessment, EvidenceSpan, Uncertainty } from '@aerial/contracts';
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/** Postgres bigint exposed as a decimal string (postgres.js returns int8 as text); never a JS number. */
const bigintString = customType<{ data: string; driverData: string }>({ dataType: () => 'bigint' });
const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const id = () => uuid('id').primaryKey().default(sql`gen_random_uuid()`);
const createdAt = () => tstz('created_at').notNull().defaultNow();
const updatedAt = () => tstz('updated_at').notNull().defaultNow();

export const sources = pgTable(
  'sources',
  {
    id: id(),
    provider: text('provider').notNull(),
    externalId: text('external_id').notNull(),
    username: text('username'),
    displayName: text('display_name'),
    defaultPlaceId: text('default_place_id'),
    enabled: boolean('enabled').notNull().default(true),
    trustPolicyVersion: text('trust_policy_version'),
    version: integer('version').notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('sources_provider_external_id_key').on(t.provider, t.externalId)],
);

export const importRuns = pgTable(
  'import_runs',
  {
    id: id(),
    sourceId: uuid('source_id').references(() => sources.id),
    fileHash: text('file_hash').notNull(),
    status: text('status').notNull().default('running'), // running | succeeded | failed
    counters: jsonb('counters').$type<Record<string, number>>().notNull().default({}),
    report: jsonb('report').$type<Record<string, unknown>>().notNull().default({}),
    error: text('error'),
    startedAt: tstz('started_at').notNull().defaultNow(),
    finishedAt: tstz('finished_at'),
  },
  (t) => [index('import_runs_file_hash_idx').on(t.fileHash)],
);

export const messages = pgTable(
  'messages',
  {
    id: id(),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => sources.id),
    externalMessageId: bigintString('external_message_id').notNull(),
    publishedAt: tstz('published_at').notNull(),
    receivedAt: tstz('received_at').notNull().defaultNow(),
    latestRevisionId: uuid('latest_revision_id').references((): AnyPgColumn => messageRevisions.id),
    replyToExternalId: bigintString('reply_to_external_id'),
    deletedAt: tstz('deleted_at'),
    mode: text('mode').notNull(), // archive | live
    version: integer('version').notNull().default(1),
  },
  (t) => [
    uniqueIndex('messages_source_external_key').on(t.sourceId, t.externalMessageId),
    index('messages_source_published_idx').on(t.sourceId, t.publishedAt),
  ],
);

/** Immutable: a content change is a new row. raw_payload is nullable so retention can drop it. */
export const messageRevisions = pgTable(
  'message_revisions',
  {
    id: id(),
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id),
    revisionHash: text('revision_hash').notNull(),
    editedAt: tstz('edited_at'),
    rawPayload: jsonb('raw_payload').$type<Record<string, unknown>>(),
    rawText: text('raw_text').notNull(),
    normalizedText: text('normalized_text').notNull(),
    cleanedText: text('cleaned_text').notNull(),
    mediaFlags: text('media_flags').array().notNull().default(sql`'{}'::text[]`),
    observedAt: tstz('observed_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('message_revisions_message_hash_key').on(t.messageId, t.revisionHash)],
);

export const processingRuns = pgTable(
  'processing_runs',
  {
    id: id(),
    revisionId: uuid('revision_id')
      .notNull()
      .references(() => messageRevisions.id),
    contextHash: text('context_hash').notNull(),
    model: text('model').notNull(),
    questionsVersion: text('questions_version').notNull(),
    parserVersion: text('parser_version').notNull(),
    policyVersion: text('policy_version').notNull(),
    status: text('status').notNull(), // ProcessingStatus
    latencyMs: integer('latency_ms'),
    usage: jsonb('usage').$type<Record<string, unknown>>(),
    providerRequestId: text('provider_request_id'),
    error: text('error'),
    startedAt: tstz('started_at').notNull().defaultNow(),
    finishedAt: tstz('finished_at'),
  },
  (t) => [
    uniqueIndex('processing_runs_key').on(
      t.revisionId,
      t.contextHash,
      t.parserVersion,
      t.questionsVersion,
      t.model,
      t.policyVersion,
    ),
  ],
);

/** Context graph: which revisions a run read (reply parent, recent posts). An edit of one re-evaluates dependants. */
export const processingDependencies = pgTable(
  'processing_dependencies',
  {
    runId: uuid('run_id')
      .notNull()
      .references(() => processingRuns.id),
    dependsOnRevisionId: uuid('depends_on_revision_id')
      .notNull()
      .references(() => messageRevisions.id),
    relation: text('relation').notNull(), // reply_parent | context
  },
  (t) => [
    primaryKey({ columns: [t.runId, t.dependsOnRevisionId] }),
    index('processing_dependencies_revision_idx').on(t.dependsOnRevisionId),
  ],
);

export const claims = pgTable(
  'claims',
  {
    id: id(),
    runId: uuid('run_id')
      .notNull()
      .references(() => processingRuns.id),
    revisionId: uuid('revision_id')
      .notNull()
      .references(() => messageRevisions.id),
    ordinal: integer('ordinal').notNull().default(0),
    kind: text('kind').notNull(),
    threatType: text('threat_type').notNull(),
    threatQualifier: jsonb('threat_qualifier').$type<{ value: string; evidence: EvidenceSpan } | null>(),
    temporalScope: text('temporal_scope').notNull(),
    quantity: integer('quantity'),
    quantityText: text('quantity_text'),
    placeId: text('place_id'),
    geoBasis: text('geo_basis').notNull(),
    movementMention: text('movement_mention'),
    evidence: jsonb('evidence').$type<EvidenceSpan[]>().notNull(),
    assessments: jsonb('assessments').$type<Assessment[]>().notNull().default([]),
    publicationDecision: text('publication_decision').notNull(),
    uncertainty: jsonb('uncertainty').$type<Uncertainty>().notNull(),
    active: boolean('active').notNull().default(true),
    version: integer('version').notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('claims_revision_idx').on(t.revisionId), index('claims_run_idx').on(t.runId)],
);

export const incidents = pgTable(
  'incidents',
  {
    id: id(),
    kind: text('kind').notNull(),
    threatType: text('threat_type'),
    areaId: text('area_id'),
    mode: text('mode').notNull(), // archive | live: archive replays never feed the live projection
    lifecycle: text('lifecycle').notNull(),
    firstSeenAt: tstz('first_seen_at').notNull(),
    lastEvidenceAt: tstz('last_evidence_at').notNull(),
    summary: text('summary'),
    hasConflict: boolean('has_conflict').notNull().default(false),
    closureClaimId: uuid('closure_claim_id').references(() => claims.id),
    /** Optimistic concurrency: every change is `... WHERE revision = $expected` then revision + 1. */
    revision: integer('revision').notNull().default(1),
    policyVersion: text('policy_version').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('incidents_area_lifecycle_evidence_idx').on(t.areaId, t.lifecycle, t.lastEvidenceAt)],
);

export const incidentEvidence = pgTable(
  'incident_evidence',
  {
    incidentId: uuid('incident_id')
      .notNull()
      .references(() => incidents.id),
    claimId: uuid('claim_id')
      .notNull()
      .references(() => claims.id),
    relation: text('relation').notNull(), // EvidenceRelation
    originGroup: text('origin_group'),
    reason: text('reason'),
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.incidentId, t.claimId] }), index('incident_evidence_claim_idx').on(t.claimId)],
);

export const alertSnapshots = pgTable(
  'alert_snapshots',
  {
    id: id(),
    provider: text('provider').notNull(),
    fetchedAt: tstz('fetched_at').notNull(),
    providerTime: tstz('provider_time'),
    payloadHash: text('payload_hash').notNull(),
    rawPayload: jsonb('raw_payload').$type<unknown>(),
    valid: boolean('valid').notNull(),
    error: text('error'),
  },
  (t) => [index('alert_snapshots_provider_fetched_idx').on(t.provider, t.fetchedAt)],
);

/** Alert projection from the provider only; AI output never writes here. */
export const alertStates = pgTable('alert_states', {
  areaKey: text('area_key').primaryKey(),
  areaKind: text('area_kind').notNull(), // oblast | raion
  placeId: text('place_id'),
  state: text('state').notNull(), // AlertState
  level: text('level'),
  since: tstz('since'),
  freshness: text('freshness').notNull(),
  lastSuccessAt: tstz('last_success_at'),
  lastProviderChangeAt: tstz('last_provider_change_at'),
  snapshotId: uuid('snapshot_id').references(() => alertSnapshots.id),
  updatedAt: updatedAt(),
});

export const JOB_STATUSES = ['queued', 'running', 'failed', 'done', 'dead'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const jobs = pgTable(
  'jobs',
  {
    id: id(),
    kind: text('kind').notNull(),
    dedupeKey: text('dedupe_key').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    priority: integer('priority').notNull().default(0),
    status: text('status').$type<JobStatus>().notNull().default('queued'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    nextAttemptAt: tstz('next_attempt_at').notNull().defaultNow(),
    leaseUntil: tstz('lease_until'),
    leaseOwner: text('lease_owner'),
    lastError: text('last_error'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    finishedAt: tstz('finished_at'),
  },
  (t) => [
    // One live job per logical unit of work; a finished/dead key may be enqueued again.
    uniqueIndex('jobs_dedupe_active_key')
      .on(t.dedupeKey)
      .where(sql`status in ('queued', 'running', 'failed')`),
    index('jobs_ready_idx').on(t.status, t.priority.desc(), t.nextAttemptAt),
  ],
);

export const sourceHealth = pgTable('source_health', {
  sourceId: uuid('source_id')
    .primaryKey()
    .references(() => sources.id),
  lastSuccessAt: tstz('last_success_at'),
  lastMessageAt: tstz('last_message_at'),
  lagMs: integer('lag_ms'),
  errorKind: text('error_kind'),
  updatedAt: updatedAt(),
});

/** Live Telegram collector cursor (pts); advances only in the transaction that stores the updates. */
export const telegramCheckpoints = pgTable('telegram_checkpoints', {
  sourceId: uuid('source_id')
    .primaryKey()
    .references(() => sources.id),
  pts: integer('pts').notNull(),
  updatedAt: updatedAt(),
});

/** Append-only operator audit. idempotency_key makes command retries return the first result. */
export const auditLog = pgTable(
  'audit_log',
  {
    id: id(),
    actor: text('actor').notNull(),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    before: jsonb('before').$type<unknown>(),
    after: jsonb('after').$type<unknown>(),
    reason: text('reason').notNull(),
    idempotencyKey: text('idempotency_key'),
    requestId: text('request_id'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('audit_log_idempotency_key').on(t.idempotencyKey),
    index('audit_log_entity_idx').on(t.entityType, t.entityId),
  ],
);
