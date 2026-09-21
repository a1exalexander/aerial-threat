// The Kremenchuk screen (GET /v1/situation): NEPTUN state of the raion, statuses aggregated from the Kremenchuk
// channels (AI or rules), and the feed of relevant posts. AI output never changes the alert state.
import { z } from 'zod';
import { AlertStateDto, SourceDto, envelope } from './api';
import { AlertState, DecimalId, Freshness, Id, Timestamp } from './domain';

/** The only area of the screen; IDs are @aerial/geo dictionary IDs. */
export const KREMENCHUK = {
  placeId: 'ua-pl-c-kremenchuk',
  raionId: 'ua-pl-r-kremenchutskyi',
  oblastId: 'ua-pl',
  name: 'Кременчук',
} as const;

export const SituationThreatType = z.enum(['shahed', 'jet_shahed', 'missile', 'ballistic', 'kab', 'aviation', 'unknown', 'none']);
export type SituationThreatType = z.infer<typeof SituationThreatType>;

/** Relative to Kremenchuk: coming at it, passing by, moving away, or reported downed. */
export const SituationDirection = z.enum(['towards', 'passing', 'away', 'downed', 'unknown', 'none']);
export type SituationDirection = z.infer<typeof SituationDirection>;

export const SituationQuantity = z.enum(['1', '2', '3', '4+', 'unknown']);
export type SituationQuantity = z.infer<typeof SituationQuantity>;

/** What the channels expect next. A labelled hint, never the alert state. */
export const SituationForecast = z.enum(['alert_expected', 'clear_expected', 'none']);
export type SituationForecast = z.infer<typeof SituationForecast>;

export const Confidence = z.enum(['high', 'low']);
export type Confidence = z.infer<typeof Confidence>;

/** One status. `evidenceMessageIds` are message revision IDs, i.e. `FeedItem.id` values. */
export const SituationStatus = <T extends z.ZodType>(value: T) =>
  z.object({ value, confidence: Confidence, evidenceMessageIds: z.array(z.string()) });
export type SituationStatus<T> = { value: T; confidence: Confidence; evidenceMessageIds: string[] };

export const SituationStatuses = z.object({
  threatNow: SituationStatus(z.boolean()),
  threatType: SituationStatus(SituationThreatType),
  direction: SituationStatus(SituationDirection),
  quantity: SituationStatus(SituationQuantity),
  forecast: SituationStatus(SituationForecast),
  explosions: SituationStatus(z.boolean()),
  airDefense: SituationStatus(z.boolean()),
});
export type SituationStatuses = z.infer<typeof SituationStatuses>;

/** A stop of a route list from the channels; placeId is null for a name the dictionary does not know. */
export const RouteStop = z.object({ name: z.string(), placeId: z.string().nullable() });
export type RouteStop = z.infer<typeof RouteStop>;

export const SituationTile = z.enum(['alert', 'threat', 'clear', 'unknown']);
export type SituationTile = z.infer<typeof SituationTile>;

/** How the statuses were produced; also the `mode` column of situation_snapshots. */
export const SituationMode = z.enum(['ai', 'rules']);
export type SituationMode = z.infer<typeof SituationMode>;

/** One post of the feed. `id` is the message revision ID. */
export const FeedItem = z.object({
  id: Id,
  sourceName: z.string(),
  sourceUsername: z.string().nullable(),
  messageId: DecimalId,
  publishedAt: Timestamp,
  editedAt: Timestamp.nullable(),
  text: z.string(),
  replyToText: z.string().nullable().optional(),
  link: z.url().nullable(),
});
export type FeedItem = z.infer<typeof FeedItem>;

export const SituationDto = z.object({
  area: z.object({ id: z.string(), name: z.string() }),
  alert: AlertStateDto.pick({ state: true, level: true, since: true, freshness: true, lastSuccessfulFetchAt: true }),
  tile: SituationTile,
  tileStale: z.boolean(),
  /** null: no snapshot yet (unknown, never "all clear"). */
  statuses: SituationStatuses.nullable(),
  route: z.array(RouteStop).nullable(),
  evaluation: z.object({ mode: SituationMode, evaluatedAt: Timestamp, freshness: Freshness }).nullable(),
  feed: z.array(FeedItem),
  sources: z.array(SourceDto),
});
export type SituationDto = z.infer<typeof SituationDto>;

export const SituationResponse = envelope(SituationDto);
export type SituationResponse = z.infer<typeof SituationResponse>;

/**
 * The alert tile. NEPTUN decides alert/clear; channels can only raise inactive to `threat` (with high confidence).
 * Missing or expired alert data is `unknown`, never `clear`. `stale` marks a last-known state that is aging.
 */
export function situationTile(
  alert: { state: AlertState; freshness: Freshness } | null | undefined,
  statuses: SituationStatuses | null,
): { tile: SituationTile; stale: boolean } {
  const stale = alert?.freshness === 'stale';
  if (alert?.state === 'active') return { tile: 'alert', stale };
  if (!alert || alert.state === 'unknown' || alert.freshness === 'unknown') return { tile: 'unknown', stale };
  const threat = statuses?.threatNow.value === true && statuses.threatNow.confidence === 'high';
  return { tile: threat ? 'threat' : 'clear', stale };
}
