// Situation rules: free statuses over a window of Kremenchuk posts, plus the noise filter. Pure, no I/O.
// Also the fake evaluator for local dev and tests (@aerial/ai/situation).
import {
  KREMENCHUK,
  type SituationDirection,
  type SituationForecast,
  type SituationQuantity,
  type SituationStatus,
  type SituationStatuses,
  type SituationThreatType,
} from '@aerial/contracts';
import { ancestors } from '@aerial/geo';
import { extractPlaceCandidates } from '@aerial/geo/match';
import * as X from './lexicon';

/** Bump whenever a rule or the lexicon changes; stored in situation_snapshots.rules_version. */
export const SITUATION_RULES_VERSION = 'situation-rules-v1';

/** One post of the evaluated window. IDs are strings: revision/source UUIDs, Telegram message ID as decimal. */
export type SituationMessage = {
  revisionId: string;
  sourceId: string;
  sourceName: string;
  messageId: string;
  publishedAt: Date;
  text: string;
  replyToText: string | null;
  /** Rule-extracted places (@aerial/geo/match PlaceCandidate) when the caller has them. */
  placeCandidates?: unknown[];
};

const MIN = 60_000;
/** threatNow, explosions, air defense: what is happening now. */
const NOW_MS = 15 * MIN;
/** Threat type, direction, quantity: older posts are ignored. */
const TRACK_MS = 45 * MIN;
const FORECAST_MS = 30 * MIN;
/** One explicit post this fresh is enough for `high`. */
const EXPLICIT_MS = 10 * MIN;
const MAX_EVIDENCE = 3;

// «не чисто», «не летить», «не на нас»; «відбою ще не буде», «шахедів не зафіксовано». Text is folded (ні → ни).
const NEG_BEFORE = /(?<!\p{L})(?:не|ни)\s+(?:\p{L}+\s+)?$/u;
const NEG_AFTER = /^\s+(?:(?:ще|еще|вже|уже)\s+)?(?:не|ни|нет|нету|нема|немае)(?!\p{L})/u;
const affirmed = (t: string, start: number, end: number) =>
  !NEG_BEFORE.test(t.slice(Math.max(0, start - 24), start)) && !NEG_AFTER.test(t.slice(end, end + 16));
/** Offset of the last match that is not negated around it, -1 for none. */
const lastAt = (re: RegExp, t: string) =>
  Math.max(-1, ...[...t.matchAll(new RegExp(re, 'gu'))].filter((m) => affirmed(t, m.index, m.index + m[0].length)).map((m) => m.index));
const has = (re: RegExp, t: string) => lastAt(re, t) >= 0;

function threatTypeOf(t: string): X.KnownThreat | null {
  return X.THREATS.find(([, re]) => has(re, t))?.[0] ?? null;
}

/** The last forecast phrase of the post; `none` for a negated one («відбою не буде», «відбій буде не скоро») or a question. */
function forecastOf(t: string): { value: SituationForecast; at: number } | null {
  const found = (
    [
      ['clear_expected', X.CLEAR_EXPECTED],
      ['alert_expected', X.ALERT_EXPECTED],
    ] as const
  ).flatMap(([value, re]) => [...t.matchAll(new RegExp(re, 'gu'))].map((m) => ({ value, at: m.index, text: m[0] })));
  const last = found.sort((a, b) => a.at - b.at).at(-1);
  if (!last) return null;
  const rest = t.slice(last.at + last.text.length).split(/[.!\n]/, 1)[0]!;
  const negated = X.NEGATION.test(last.text) || !affirmed(t, last.at, last.at + last.text.length);
  return { value: negated || rest.includes('?') ? 'none' : last.value, at: last.at };
}

type Place = { placeId: string | null; relation: string };
const isPlace = (c: unknown): c is Place =>
  typeof c === 'object' && c !== null && 'placeId' in c && 'relation' in c && typeof (c as Place).relation === 'string';
const inRaion = (id: string) => id === KREMENCHUK.raionId || ancestors(id).some((p) => p.id === KREMENCHUK.raionId);

/** Direction from the places of the post: the city itself, a route through the raion, a turn away from it. */
function directionFromPlaces(t: string, places: Place[]): SituationDirection | null {
  const known = places.filter((p): p is Place & { placeId: string } => p.placeId !== null);
  if (known.some((p) => p.placeId === KREMENCHUK.placeId && ['towards', 'over', 'in', 'near'].includes(p.relation))) return 'towards';
  const last = known.at(-1);
  if (known.length >= 2 && known.some((p) => inRaion(p.placeId)) && last && !inRaion(last.placeId)) return 'passing';
  if (known.some((p) => inRaion(p.placeId) && p.relation === 'towards')) return 'towards';
  if (has(X.TURN, t) && known.some((p) => !inRaion(p.placeId) && p.relation === 'towards')) return 'away';
  return null;
}

type Carried<T> = { value: T; explicit: boolean } | null;
type Cues = {
  /** Reports something in the air now. */
  threat: boolean;
  /** Says it is over: downed, all clear, clear expected. */
  stop: boolean;
  threatType: Carried<SituationThreatType>;
  direction: Carried<SituationDirection>;
  quantity: Carried<SituationQuantity>;
  forecast: Carried<SituationForecast>;
  explosions: boolean;
  airDefense: boolean;
  hedged: boolean;
};

function quantityOf(t: string): SituationQuantity | null {
  const m = t.matchAll(X.QUANTITY).next().value;
  const raw = m?.slice(1).find((g) => g !== undefined);
  if (!raw) return null;
  // A range counts as its upper bound: «2-3 бандеролі» → 3.
  const n = X.NUMBER_WORDS[raw] ?? Number.parseInt(raw.split(/[-–]/).at(-1)!, 10);
  if (Number.isNaN(n)) return 'unknown';
  return n >= 4 ? '4+' : n >= 1 ? (String(n) as SituationQuantity) : null;
}

function cues(m: SituationMessage): Cues {
  const t = X.fold(m.text);
  const hedged = has(X.HEDGE, t) || X.QUESTION.test(t);
  const own = threatTypeOf(t);
  const none: Cues = { threat: false, stop: false, threatType: null, direction: null, quantity: null, forecast: null, explosions: false, airDefense: false, hedged };
  // News of consequences («пошкоджено», «вночі») is shown in the feed but says nothing about the sky now.
  if (has(X.AFTERMATH, t) && !has(X.MOVE, t)) return { ...none, explosions: has(X.EXPLOSIONS, t), airDefense: has(X.AIR_DEFENSE, t) };

  const forecast = forecastOf(t);
  const clearOfficial = has(X.CLEAR_OFFICIAL, t);
  // «Скоро буде повітряна тривога» is a forecast, not an alert that is on.
  const alertOfficial = has(X.ALERT_OFFICIAL, t) && forecast?.value !== 'alert_expected';
  const downedAt = lastAt(X.DOWNED, t);
  const clearAt = Math.max(lastAt(X.CLEAR, t), lastAt(X.CLEAR_OFFICIAL, t));
  // The area list of an official alert/all-clear post is not a route.
  const routeAt = clearOfficial || alertOfficial ? -1 : lastAt(X.ROUTE, m.text);
  const moveAt = Math.max(...[X.MOVE, X.TOWARDS, X.PASSING, X.AWAY].map((re) => lastAt(re, t)), routeAt);
  // «1 мінус, ще 1 летить» still flies; «пролетять і буде відбій» flies until then; «летіли, тепер чисто» is over.
  const flying = moveAt > Math.max(downedAt, clearAt);
  const stop = !flying && (downedAt >= 0 || clearAt >= 0 || forecast?.value === 'clear_expected');
  const threat = flying || (!stop && (own !== null || alertOfficial));
  const cleared = !flying && clearAt >= 0 && downedAt < 0;

  const replyType = m.replyToText ? threatTypeOf(X.fold(m.replyToText)) : null;
  const threatType: Carried<SituationThreatType> = own
    ? { value: own, explicit: true }
    : threat && replyType
      ? { value: replyType, explicit: false }
      : cleared
        ? { value: 'none', explicit: true }
        : null;

  let direction: Carried<SituationDirection> = null;
  if (!flying && downedAt >= 0) direction = { value: 'downed', explicit: true };
  else if (cleared) direction = { value: 'none', explicit: true };
  else if (threat) {
    const text = has(X.AWAY, t) ? 'away' : has(X.TOWARDS, t) ? 'towards' : has(X.PASSING, t) ? 'passing' : has(X.OTHER_OBLAST, t) ? 'away' : null;
    const places = (m.placeCandidates ?? extractPlaceCandidates(m.text)).filter(isPlace);
    const fromPlaces = text ? null : directionFromPlaces(t, places);
    direction = text ? { value: text, explicit: true } : fromPlaces ? { value: fromPlaces, explicit: false } : null;
  }

  const qty = cleared ? 'unknown' : quantityOf(t);
  return {
    threat,
    stop,
    threatType,
    direction,
    quantity: qty ? { value: qty, explicit: qty !== 'unknown' } : null,
    // An official alert or all-clear fulfils whatever was expected.
    forecast: alertOfficial || clearOfficial ? { value: 'none', explicit: true } : forecast ? { value: forecast.value, explicit: true } : null,
    explosions: has(X.EXPLOSIONS, t),
    airDefense: has(X.AIR_DEFENSE, t),
    hedged,
  };
}

/**
 * Ads, job posts, fundraising, emoji-only posts and emoji greetings/thanks. Conservative: a post that reports
 * movement, a route, a forecast, a downing, explosions or air defense is never noise; a threat word saves chit-chat.
 * «До нас» alone does not save an ad («завітайте до нас») or a fundraiser («звернулися до нас»).
 */
export function isNoise(text: string): boolean {
  if (!/[\p{L}\p{N}]/u.test(text)) return true;
  const t = X.fold(text);
  const report =
    [X.MOVE, X.DOWNED, X.EXPLOSIONS, X.AIR_DEFENSE, X.CLEAR, X.CLEAR_OFFICIAL, X.ALERT_OFFICIAL].some((re) => re.test(t)) ||
    forecastOf(t) !== null ||
    X.ROUTE.test(text);
  if (report) return false;
  if (X.PAYMENT.test(t) || X.CARD.test(text) || X.IBAN.test(text) || X.PHONE.test(text) || X.COMMERCIAL.test(t)) return true;
  return X.EMOJI.test(text) && X.CHATTER.test(t) && (t.match(/\p{L}+/gu)?.length ?? 0) <= 4 && !threatTypeOf(t) && !/\d/.test(text);
}

type Post = { m: SituationMessage; c: Cues; age: number };
const status = <T>(value: T, high: boolean, evidence: Post[]): SituationStatus<T> => ({
  value,
  confidence: high ? 'high' : 'low',
  evidenceMessageIds: evidence.slice(0, MAX_EVIDENCE).map((p) => p.m.revisionId),
});
const low = <T>(value: T, evidence: Post[] = []) => status(value, false, evidence);

/**
 * The newest post within `maxAge` that carries a value wins; the posts agreeing with it are its evidence.
 * `high`: two agreeing posts, or one explicit, unhedged post from the last 10 minutes. `none`/`unknown` stay `low`.
 */
function latest<T extends string>(posts: Post[], maxAge: number, pick: (c: Cues) => Carried<T>): { s: SituationStatus<T>; top: Post } | null {
  const carrying = posts.filter((p) => p.age <= maxAge && pick(p.c));
  const top = carrying[0];
  if (!top) return null;
  const { value, explicit } = pick(top.c)!;
  const agreeing = carrying.filter((p) => pick(p.c)!.value === value);
  const vague = value === 'none' || value === 'unknown';
  return { s: status(value, !vague && (agreeing.length >= 2 || (explicit && !top.c.hedged && top.age <= EXPLICIT_MS)), agreeing), top };
}

/** A flag (explosions, air defense) from the last 15 minutes. */
function flag(posts: Post[], pick: (c: Cues) => boolean): SituationStatus<boolean> {
  const hits = posts.filter((p) => p.age <= NOW_MS && pick(p.c));
  const top = hits[0];
  if (!top) return low(false);
  return status(true, hits.length >= 2 || (!top.c.hedged && top.age <= EXPLICIT_MS), hits);
}

/**
 * Statuses of the window at `now` and the revisions worth showing in the feed (the non-noise ones).
 * Newer posts outrank older ones; nothing reported gives `false`/`none` with `low` confidence, never a «safe» claim.
 */
export function rulesSituation(msgs: SituationMessage[], now: Date): { statuses: SituationStatuses; relevantRevisionIds: string[] } {
  const relevant = msgs.filter((m) => !isNoise(m.text));
  // Newest first. A post a little ahead of the clock (skew) counts as just published.
  const posts: Post[] = relevant
    .map((m) => ({ m, c: cues(m), age: Math.max(0, now.getTime() - m.publishedAt.getTime()) }))
    .filter((p) => p.age <= TRACK_MS)
    .sort((a, b) => a.age - b.age);

  // threatNow: a threat post in the last 15 minutes that no newer downed/clear post answers.
  const lastStop = posts.findIndex((p) => p.c.stop);
  const live = posts.filter((p, i) => p.age <= NOW_MS && p.c.threat && (lastStop < 0 || i < lastStop));
  const top = live[0];
  const threatNow = top
    ? status(true, live.length >= 2 || (top.c.threatType?.explicit === true && !top.c.hedged && top.age <= EXPLICIT_MS), live)
    : low(false, lastStop >= 0 && posts[lastStop]!.age <= NOW_MS ? [posts[lastStop]!] : []);

  // Type and direction: the newest carrying post; after an all-clear or a downing, a newer threat post makes them `unknown`.
  const threats = posts.filter((p) => p.c.threat);
  const tracked = <T extends string>(pick: (c: Cues) => Carried<T>): SituationStatus<T | 'unknown' | 'none'> => {
    const hit = latest(posts, TRACK_MS, pick);
    const over = hit && (hit.s.value === 'none' || hit.s.value === 'downed');
    if (hit && !(over && threats.some((p) => p.age < hit.top.age))) return hit.s;
    return threats.length ? low('unknown', threats) : low('none');
  };

  // Forecast: the latest forecast-bearing post of the last 30 minutes; a newer contrary post voids it.
  const said = latest(posts, FORECAST_MS, (c) => c.forecast);
  const contrary =
    said &&
    posts.find((p) => p.age < said.top.age && (said.s.value === 'clear_expected' ? p.c.threat : said.s.value === 'alert_expected' && p.c.stop));
  const forecast = contrary ? low<SituationForecast>('none', [contrary]) : (said?.s ?? low<SituationForecast>('none'));

  return {
    statuses: {
      threatNow,
      threatType: tracked((c) => c.threatType),
      direction: tracked((c) => c.direction),
      quantity: latest(posts, TRACK_MS, (c) => c.quantity)?.s ?? low('unknown'),
      forecast,
      explosions: flag(posts, (c) => c.explosions),
      airDefense: flag(posts, (c) => c.airDefense),
    },
    relevantRevisionIds: relevant.map((m) => m.revisionId),
  };
}
