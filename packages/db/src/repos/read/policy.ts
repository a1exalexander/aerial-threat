// Pure presentation rules of the read API: freshness, availability, area scope, public links.
// Missing or old data always degrades to stale/unknown, never to "fresh", "ok" or "inactive".
import { type AlertStateDto, AlertState, Freshness, type GeoBasis, type SourceDto } from '@aerial/contracts';
import { PLACES, type Place, ancestors, byId, children } from '@aerial/geo';

// Doc 04: an alert projection is stale 30 s after the last confirmed snapshot and unknown after 120 s.
export const ALERT_STALE_AFTER_MS = 30_000;
export const ALERT_UNKNOWN_AFTER_MS = 120_000;
// ponytail: connector thresholds are policy guesses until the collectors' heartbeat cadence is measured.
export const SOURCE_DEGRADED_AFTER_MS = 5 * 60_000;
export const SOURCE_UNAVAILABLE_AFTER_MS = 15 * 60_000;

const RANK: Record<Freshness, number> = { fresh: 0, stale: 1, unknown: 2 };

/** The least fresh input; with nothing to judge by the answer is `unknown`. */
export const worstFreshness = (values: Freshness[]): Freshness =>
  values.reduce<Freshness | null>((a, b) => (a === null || RANK[b] > RANK[a] ? b : a), null) ?? 'unknown';

export function ageFreshness(lastSuccessAt: Date | null, now: Date): Freshness {
  if (!lastSuccessAt) return 'unknown';
  const age = now.getTime() - lastSuccessAt.getTime();
  return age > ALERT_UNKNOWN_AFTER_MS ? 'unknown' : age > ALERT_STALE_AFTER_MS ? 'stale' : 'fresh';
}

export type AlertRow = {
  areaKey: string;
  placeId: string | null;
  state: string;
  level: string | null;
  since: Date | null;
  freshness: string;
  lastSuccessAt: Date | null;
  lastProviderChangeAt: Date | null;
};

/**
 * One NEPTUN area as published. Freshness is recomputed from last_success_at so a dead connector cannot leave
 * a "fresh" row behind; no row, or a row too old to trust, reports state `unknown` (never `inactive`).
 */
export function alertDto(areaKey: string, place: Place | undefined, row: AlertRow | undefined, now: Date): AlertStateDto {
  const stored = Freshness.safeParse(row?.freshness).data ?? 'unknown';
  const freshness = row ? worstFreshness([stored, ageFreshness(row.lastSuccessAt, now)]) : 'unknown';
  return {
    areaKey,
    placeId: place?.id ?? row?.placeId ?? null,
    state: freshness === 'unknown' ? 'unknown' : (AlertState.safeParse(row?.state).data ?? 'unknown'),
    level: row?.level ?? null,
    since: row?.since?.toISOString() ?? null,
    freshness,
    lastSuccessfulFetchAt: row?.lastSuccessAt?.toISOString() ?? null,
    lastProviderChangeAt: row?.lastProviderChangeAt?.toISOString() ?? null,
  };
}

/**
 * Area filter rule: an area matches itself and every place inside it (oblast -> raions -> cities/villages),
 * never the areas containing it. A city filter does not return raion- or oblast-level reports
 * («на Полтавщині» is not Полтава); an oblast filter does return its cities.
 */
export const subtree = (id: string): string[] => [id, ...children(id).flatMap((c) => subtree(c.id))];

/** Places whose NEPTUN alert concerns the area: the areas containing it, itself, the areas inside it. */
export function alertPlaces(areaId: string | null): Place[] {
  const scope = areaId === null ? PLACES : [...ancestors(areaId).reverse(), ...subtree(areaId).flatMap((id) => byId(id) ?? [])];
  return scope.filter((p) => p.neptunKeys.length > 0);
}

type Availability = SourceDto['availability'];

/** Connector health, not channel activity: a quiet channel with a healthy connector is `ok`. */
export function sourceAvailability(
  s: { enabled: boolean; lastSuccessAt: Date | null; errorKind: string | null },
  now: Date,
): Availability {
  if (!s.enabled) return 'paused';
  if (!s.lastSuccessAt) return 'unknown';
  const age = now.getTime() - s.lastSuccessAt.getTime();
  if (age > SOURCE_UNAVAILABLE_AFTER_MS) return 'unavailable';
  return s.errorKind || age > SOURCE_DEGRADED_AFTER_MS ? 'degraded' : 'ok';
}

const AVAILABILITY_FRESHNESS: Record<Exclude<Availability, 'paused'>, Freshness> = {
  ok: 'fresh',
  degraded: 'stale',
  unavailable: 'unknown',
  unknown: 'unknown',
};

/** Freshness of whatever the given sources feed; paused sources do not count, none at all is `unknown`. */
export const sourcesFreshness = (list: SourceDto[]): Freshness =>
  worstFreshness(list.flatMap((s) => (s.availability === 'paused' ? [] : [AVAILABILITY_FRESHNESS[s.availability]])));

/** Freshness of the incident feed: the Telegram collectors that fill it. */
export const feedFreshness = (list: SourceDto[]) => sourcesFreshness(list.filter((s) => s.provider === 'telegram'));

// Telegram public usernames: 5-32 chars, a letter first, letters/digits/underscores, no trailing underscore.
const USERNAME = /^[A-Za-z][A-Za-z0-9_]{3,30}[A-Za-z0-9]$/;

/** A username safe to publish and link to; anything else is withheld. */
export const publicUsername = (provider: string, username: string | null) =>
  provider === 'telegram' && username && USERNAME.test(username) ? username : null;

/** Link to the original post, built only from a verified public username and a positive message ID. */
export const telegramUrl = (username: string | null, messageId: string) =>
  username && /^[1-9]\d{0,19}$/.test(messageId) ? `https://t.me/${username}/${messageId}` : null;

const GEO_STRENGTH: GeoBasis[] = ['explicit', 'reply_context', 'channel_default', 'unresolved'];

/** How the incident's area was established: its strongest claim basis; no area is `unresolved`. */
export const incidentGeoBasis = (areaId: string | null, bases: string[]): GeoBasis =>
  areaId === null ? 'unresolved' : (GEO_STRENGTH.find((b) => bases.includes(b)) ?? 'unresolved');
