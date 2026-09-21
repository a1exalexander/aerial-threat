import { z } from 'zod';
import {
  AlertState,
  Claim,
  ClaimKind,
  DecimalId,
  EvidenceRelation,
  EvidenceSpan,
  Freshness,
  GeoBasis,
  Id,
  IncidentLifecycle,
  MessageMode,
  PlaceLevel,
  SourceProvider,
  TemporalScope,
  ThreatType,
  Timestamp,
} from './domain';

/** Every non-2xx response. No stack traces, prompts, sessions or upstream bodies. */
export const ApiError = z.object({ code: z.string(), requestId: z.string(), message: z.string() });
export type ApiError = z.infer<typeof ApiError>;

/** Response envelope; `freshness` describes the projection, an empty `data` is not "all clear". */
export const envelope = <T extends z.ZodType>(data: T) =>
  z.object({
    data,
    generatedAt: Timestamp,
    projectionVersion: z.string(),
    freshness: Freshness,
    nextCursor: z.string().nullable().optional(),
  });
export type Envelope<T> = {
  data: T;
  generatedAt: string;
  projectionVersion: string;
  freshness: Freshness;
  nextCursor?: string | null | undefined;
};

export const AreaDto = z.object({ id: z.string(), name: z.string(), level: PlaceLevel, parentId: z.string().nullable() });
export type AreaDto = z.infer<typeof AreaDto>;

export const SourceAvailability = z.enum(['ok', 'degraded', 'unavailable', 'paused', 'unknown']);
export const SourceDto = z.object({
  id: Id,
  provider: SourceProvider,
  username: z.string().nullable(),
  displayName: z.string(),
  enabled: z.boolean(),
  lastSuccessfulSync: Timestamp.nullable(),
  lastMessageAt: Timestamp.nullable(),
  availability: SourceAvailability,
});
export type SourceDto = z.infer<typeof SourceDto>;

export const AlertStateDto = z.object({
  areaKey: z.string(),
  placeId: z.string().nullable(),
  state: AlertState,
  level: z.string().nullable(),
  since: Timestamp.nullable(),
  freshness: Freshness,
  lastSuccessfulFetchAt: Timestamp.nullable(),
  lastProviderChangeAt: Timestamp.nullable(),
});
export type AlertStateDto = z.infer<typeof AlertStateDto>;

export const IncidentListItem = z.object({
  id: Id,
  kind: ClaimKind,
  threatTypes: z.array(ThreatType),
  areaId: z.string().nullable(),
  geoBasis: GeoBasis,
  lifecycle: IncidentLifecycle,
  mode: MessageMode,
  firstSeenAt: Timestamp,
  lastEvidenceAt: Timestamp,
  summary: z.string(),
  sourceCount: z.int().nonnegative(),
  hasConflict: z.boolean(),
  closureClaimed: z.boolean(),
  revision: z.int().positive(),
});
export type IncidentListItem = z.infer<typeof IncidentListItem>;

export const EvidenceItemDto = z.object({
  claimId: Id,
  sourceId: Id,
  sourceUsername: z.string().nullable(),
  messageExternalId: DecimalId,
  messageUrl: z.url().nullable(),
  publishedAt: Timestamp,
  text: z.string(),
  spans: z.array(EvidenceSpan),
  geoBasis: GeoBasis,
  relation: EvidenceRelation,
  originGroup: z.string().nullable(),
  active: z.boolean(),
});
export type EvidenceItemDto = z.infer<typeof EvidenceItemDto>;

export const IncidentDetail = IncidentListItem.extend({ evidence: z.array(EvidenceItemDto) });
export type IncidentDetail = z.infer<typeof IncidentDetail>;

/** One logically consistent snapshot for the dashboard. */
export const Overview = z.object({
  asOf: Timestamp,
  areaId: z.string().nullable(),
  alerts: z.array(AlertStateDto),
  incidents: z.array(IncidentListItem),
  sources: z.array(SourceDto),
});
export type Overview = z.infer<typeof Overview>;

// Operator commands: optimistic concurrency + idempotency + a mandatory reason for the audit log.
const Command = z.object({
  expectedVersion: z.int().positive(),
  idempotencyKey: z.string().min(8).max(128),
  reason: z.string().trim().min(3).max(1000),
});

export const ClaimCorrection = z
  .object({ kind: ClaimKind, threatType: ThreatType, temporalScope: TemporalScope, placeId: z.string().nullable(), geoBasis: GeoBasis })
  .partial()
  .refine((c) => Object.keys(c).length > 0, 'correction must change at least one field');

export const ClaimReviewCommand = z.discriminatedUnion('action', [
  Command.extend({ action: z.literal('confirm') }),
  Command.extend({ action: z.literal('exclude') }),
  Command.extend({ action: z.literal('correct'), correction: ClaimCorrection }),
]);
export type ClaimReviewCommand = z.infer<typeof ClaimReviewCommand>;

export const IncidentMergeCommand = Command.extend({ targetIncidentId: Id });
export type IncidentMergeCommand = z.infer<typeof IncidentMergeCommand>;

export const IncidentSplitCommand = Command.extend({ claimIds: z.array(Id).min(1) });
export type IncidentSplitCommand = z.infer<typeof IncidentSplitCommand>;

export const MessageReprocessCommand = Command;
export type MessageReprocessCommand = z.infer<typeof MessageReprocessCommand>;

export const SourcePauseCommand = Command.extend({ paused: z.boolean() });
export type SourcePauseCommand = z.infer<typeof SourcePauseCommand>;

// Operator read models: GET /v1/admin/review and GET /v1/admin/ops (additive).

/** A post as the operator sees it: text already redacted by the server (no phones, cards, bank details). */
export const ReviewMessageDto = z.object({
  sourceId: Id,
  sourceUsername: z.string().nullable(),
  sourceDisplayName: z.string(),
  messageExternalId: DecimalId,
  messageUrl: z.url().nullable(),
  publishedAt: Timestamp,
  text: z.string(),
});
export type ReviewMessageDto = z.infer<typeof ReviewMessageDto>;

/** One claim awaiting review, with the bounded context and rule candidates it was assessed with. */
export const ReviewItemDto = z.object({
  claim: Claim,
  message: ReviewMessageDto,
  context: z.array(ReviewMessageDto.extend({ relation: z.enum(['reply_parent', 'context']) })),
  /** Rule-extracted place candidates; the model could only choose among these or none/unknown. */
  candidates: z.array(z.object({ placeId: z.string(), name: z.string() })),
  /** Incident the claim feeds; `revision` is the expectedVersion of a split. */
  incident: z.object({ id: Id, revision: z.int().positive(), summary: z.string() }).nullable(),
});
export type ReviewItemDto = z.infer<typeof ReviewItemDto>;
export const ReviewQueueResponse = envelope(z.array(ReviewItemDto));

/** Source health: availability plus error kind tells channel silence apart from a broken connector. */
export const ConnectorDto = SourceDto.extend({ lagMs: z.int().nonnegative().nullable(), errorKind: z.string().nullable() });
export type ConnectorDto = z.infer<typeof ConnectorDto>;

export const QueueLaneDto = z.object({
  lane: MessageMode,
  queued: z.int().nonnegative(),
  running: z.int().nonnegative(),
  dead: z.int().nonnegative(),
  /** Server-computed, so client clock skew does not distort it. */
  oldestQueuedAgeMs: z.int().nonnegative().nullable(),
});
export type QueueLaneDto = z.infer<typeof QueueLaneDto>;

export const AiUsageDto = z.object({
  windowHours: z.int().positive(),
  requests: z.int().nonnegative(),
  failures: z.int().nonnegative(),
  lastErrorKind: z.string().nullable(),
  lastFailureAt: Timestamp.nullable(),
  inputTokens: z.int().nonnegative(),
  outputTokens: z.int().nonnegative(),
  /** null when the tariff is unknown; never a guessed amount. */
  costUsd: z.number().nonnegative().nullable(),
  dailyRequestLimit: z.int().positive().nullable(),
});
export type AiUsageDto = z.infer<typeof AiUsageDto>;

export const OpsDto = z.object({ connectors: z.array(ConnectorDto), queue: z.array(QueueLaneDto), ai: AiUsageDto });
export type OpsDto = z.infer<typeof OpsDto>;
export const OpsResponse = envelope(OpsDto);
