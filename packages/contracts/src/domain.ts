import { z } from 'zod';

/** Our own record IDs. */
export const Id = z.uuid();
/** Provider IDs (Telegram channel/message IDs) as decimal strings: they do not fit a JS number safely. */
export const DecimalId = z.string().regex(/^-?\d{1,20}$/, 'expected a decimal ID string');
/** UTC instant as ISO-8601 on every JSON boundary. Display in Europe/Kyiv is a UI concern. */
export const Timestamp = z.iso.datetime({ offset: true });
export const Probability = z.number().min(0).max(1);

export const SourceProvider = z.enum(['telegram', 'neptun']);
export type SourceProvider = z.infer<typeof SourceProvider>;

export const MessageMode = z.enum(['archive', 'live']);
export type MessageMode = z.infer<typeof MessageMode>;

export const MediaFlag = z.enum([
  'photo',
  'video',
  'animation',
  'audio',
  'voice',
  'video_note',
  'sticker',
  'document',
  'poll',
  'location',
  'contact',
  'webpage',
  'unsupported',
]);
export type MediaFlag = z.infer<typeof MediaFlag>;

export const ClaimKind = z.enum([
  'threat_report',
  'alert_claim',
  'clear_claim',
  'aftermath',
  'background_news',
  'advertisement',
  'fundraising',
  'other',
  'unknown',
]);
export type ClaimKind = z.infer<typeof ClaimKind>;

export const ThreatType = z.enum(['uav', 'missile', 'ballistic', 'aviation', 'kab', 'unknown']);
export type ThreatType = z.infer<typeof ThreatType>;

/** When the described event happens relative to the post; publishedAt is not the event time. */
export const TemporalScope = z.enum(['current', 'past', 'future', 'unknown']);
export type TemporalScope = z.infer<typeof TemporalScope>;

export const GeoBasis = z.enum(['explicit', 'reply_context', 'channel_default', 'unresolved']);
export type GeoBasis = z.infer<typeof GeoBasis>;

export const PublicationDecision = z.enum(['publish', 'review', 'exclude']);
export type PublicationDecision = z.infer<typeof PublicationDecision>;

export const PlaceLevel = z.enum(['oblast', 'raion', 'hromada', 'city', 'village']);
export type PlaceLevel = z.infer<typeof PlaceLevel>;

export const TimeUncertaintyReason = z.enum([
  'no_explicit_time',
  'relative_time',
  'event_time_differs_from_published',
  'edited_after_publish',
  'archive_last_text_only',
]);
export const GeoUncertaintyReason = z.enum([
  'no_place_mention',
  'ambiguous_place',
  'not_in_dictionary',
  'direction_only',
  'region_level_only',
  'from_reply_context',
  'from_channel_default',
]);
export const ClassificationUncertaintyReason = z.enum([
  'low_score',
  'small_margin',
  'multiple_claims',
  'needs_context',
  'missing_context',
  'context_truncated',
  'tentative_language',
  'conflicting_context',
  'suspected_prompt_injection',
]);
/** Separate reasons per axis instead of one universal "confidence". */
export const Uncertainty = z.object({
  time: z.array(TimeUncertaintyReason),
  geo: z.array(GeoUncertaintyReason),
  classification: z.array(ClassificationUncertaintyReason),
});
export type Uncertainty = z.infer<typeof Uncertainty>;

/** Half-open [start, end) span on the revision's normalizedText, plus the same span mapped onto rawText. */
export const EvidenceSpan = z
  .object({
    revisionId: Id,
    start: z.int().nonnegative(),
    end: z.int().nonnegative(),
    rawStart: z.int().nonnegative(),
    rawEnd: z.int().nonnegative(),
  })
  .refine((s) => s.start <= s.end && s.rawStart <= s.rawEnd, 'span end must not precede start');
export type EvidenceSpan = z.infer<typeof EvidenceSpan>;

/** Normalised Jev answers. Probabilities answer the asked question; they are not a danger probability. */
export const BooleanAssessment = z.object({ type: z.literal('boolean'), question: z.string(), probability: Probability });
export const ChoiceAssessment = z.object({
  type: z.literal('choice'),
  question: z.string(),
  selected: z.string(),
  probabilities: z.record(z.string(), Probability),
});
export const ScoreAssessment = z.object({ type: z.literal('score'), question: z.string(), score: z.number() });
export const Assessment = z.discriminatedUnion('type', [BooleanAssessment, ChoiceAssessment, ScoreAssessment]);
export type Assessment = z.infer<typeof Assessment>;

export const Claim = z.object({
  id: Id,
  runId: Id,
  revisionId: Id,
  kind: ClaimKind,
  threatType: ThreatType,
  /** Literal refinement such as «реактивний», with its own evidence. */
  threatQualifier: z.object({ value: z.string(), evidence: EvidenceSpan }).nullable(),
  temporalScope: TemporalScope,
  quantity: z.int().nonnegative().nullable(),
  /** Qualitative amount («багато») kept as text, never turned into a number. */
  quantityText: z.string().nullable(),
  placeId: z.string().nullable(),
  geoBasis: GeoBasis,
  /** Literal direction from the text; never a computed trajectory. */
  movementMention: z.string().nullable(),
  evidence: z.array(EvidenceSpan).min(1),
  assessments: z.array(Assessment),
  publicationDecision: PublicationDecision,
  uncertainty: Uncertainty,
  active: z.boolean(),
  version: z.int().positive(),
});
export type Claim = z.infer<typeof Claim>;

/** Adapter output and the only input of ingestion. A media caption is the text of a media post. */
export const NormalizedMessage = z.object({
  sourceProvider: z.literal('telegram'),
  sourceExternalId: DecimalId,
  externalMessageId: DecimalId,
  publishedAt: Timestamp,
  editedAt: Timestamp.nullable(),
  replyToExternalId: DecimalId.nullable(),
  rawText: z.string(),
  normalizedText: z.string(),
  cleanedText: z.string(),
  mediaFlags: z.array(MediaFlag),
  /** Provider JSON as received; may hold personal data, never log it. */
  rawPayload: z.record(z.string(), z.unknown()),
  mode: MessageMode,
});
export type NormalizedMessage = z.infer<typeof NormalizedMessage>;

export const ProcessingStatus = z.enum(['running', 'succeeded', 'failed', 'superseded']);
export type ProcessingStatus = z.infer<typeof ProcessingStatus>;

export const IncidentLifecycle = z.enum(['candidate', 'reported', 'stale', 'archived', 'retracted']);
export type IncidentLifecycle = z.infer<typeof IncidentLifecycle>;

export const EvidenceRelation = z.enum(['primary', 'supporting', 'conflicting', 'closure']);
export type EvidenceRelation = z.infer<typeof EvidenceRelation>;

export const Freshness = z.enum(['fresh', 'stale', 'unknown']);
export type Freshness = z.infer<typeof Freshness>;

/** Provider alert state of an area. Missing or failed data is `unknown`, never `inactive`. */
export const AlertState = z.enum(['active', 'inactive', 'unknown']);
export type AlertState = z.infer<typeof AlertState>;
