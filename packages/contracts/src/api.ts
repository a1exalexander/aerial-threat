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
  // Read API additions, optional so earlier producers stay valid: the exact revision and its times, what the
  // claim states and why it is uncertain. Conflicting variants are listed side by side, never averaged.
  revisionId: Id.optional(),
  receivedAt: Timestamp.optional(),
  editedAt: Timestamp.nullable().optional(),
  ...Claim.pick({
    kind: true,
    threatType: true,
    temporalScope: true,
    quantity: true,
    quantityText: true,
    placeId: true,
    movementMention: true,
    uncertainty: true,
  }).partial().shape,
});
export type EvidenceItemDto = z.infer<typeof EvidenceItemDto>;

export const IncidentDetail = IncidentListItem.extend({ evidence: z.array(EvidenceItemDto) });
export type IncidentDetail = z.infer<typeof IncidentDetail>;

/** One logically consistent snapshot for the dashboard. */
export const Overview = z.object({
  asOf: Timestamp,
  /**
   * `archive` = a history view at `asOf`, not the live state: incidents first seen by then in their latest recorded
   * state, alerts unknown. Optional only for backward compatibility.
   */
  mode: MessageMode.optional(),
  areaId: z.string().nullable(),
  alerts: z.array(AlertStateDto),
  incidents: z.array(IncidentListItem),
  sources: z.array(SourceDto),
});
export type Overview = z.infer<typeof Overview>;

// GET query strings (every value arrives as a string). Range and cursor rules are enforced by the API.
const AreaIdParam = z.string().min(1).max(64);
export const OverviewQuery = z.object({ areaId: AreaIdParam.optional(), asOf: Timestamp.optional() });
export const IncidentsQuery = z.object({
  areaId: AreaIdParam.optional(),
  kind: ClaimKind.optional(),
  lifecycle: IncidentLifecycle.optional(),
  from: Timestamp.optional(),
  to: Timestamp.optional(),
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export const AlertsQuery = z.object({ areaId: AreaIdParam.optional(), freshness: Freshness.optional() });
export const AreasQuery = z.object({ parentId: AreaIdParam.optional(), query: z.string().trim().min(1).max(100).optional() });

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
