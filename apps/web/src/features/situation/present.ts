import {
  KREMENCHUK,
  type Confidence,
  type RouteStop,
  type SituationDirection,
  type SituationDto,
  type SituationQuantity,
  type SituationStatuses,
  type SituationThreatType,
  type SituationTile,
} from '@aerial/contracts';
// The place dictionary is static public data like the geometry (no Node, no secrets): needed for "stop is in the raion".
// eslint-disable-next-line no-restricted-imports
import { ancestors } from '@aerial/geo';
import type { IconName } from './icons';

// Presentation rules: Ukrainian labels, Europe/Kyiv display, missing data is "unknown", never "safe".

export const NEPTUN_URL = 'https://neptun.in.ua/';

const kyivTime = new Intl.DateTimeFormat('uk-UA', { timeZone: 'Europe/Kyiv', hour: '2-digit', minute: '2-digit' });
const kyivSeconds = new Intl.DateTimeFormat('uk-UA', {
  timeZone: 'Europe/Kyiv',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});
const kyivDay = new Intl.DateTimeFormat('uk-UA', { timeZone: 'Europe/Kyiv', day: '2-digit', month: '2-digit' });

/** "14:05" for today in Kyiv, "20.09, 14:05" for another day. */
export function kyivShort(iso: string, now = Date.now()): string {
  const d = new Date(iso);
  const day = kyivDay.format(d);
  return day === kyivDay.format(now) ? kyivTime.format(d) : `${day}, ${kyivTime.format(d)}`;
}
export const kyivClock = (t: number) => kyivSeconds.format(t);

export const TILE: Record<SituationTile, { label: string; icon: IconName; note: string }> = {
  alert: { label: 'ТРИВОГА', icon: 'siren', note: 'Офіційна тривога в Кременчуцькому районі' },
  threat: { label: 'ЗАГРОЗА', icon: 'warning', note: 'за даними каналів, офіційної тривоги немає' },
  clear: { label: 'ВІДБІЙ', icon: 'shield', note: 'Офіційної тривоги в Кременчуцькому районі немає' },
  unknown: { label: 'НЕВІДОМО', icon: 'question', note: 'немає свіжих даних NEPTUN' },
};

/** NEPTUN alert level as text, so it never depends on colour alone. */
const LEVEL: Record<string, string> = { red: 'червоний рівень', yellow: 'жовтий рівень', unknown: 'рівень невідомий' };
export const levelLabel = (level: string) => (Object.hasOwn(LEVEL, level) ? LEVEL[level] : `рівень: ${level}`);

const THREAT_TYPE: Record<SituationThreatType, string> = {
  shahed: 'Шахед',
  jet_shahed: 'Реактивний шахед',
  missile: 'Ракета',
  ballistic: 'Балістика',
  kab: 'КАБ',
  aviation: 'Авіація',
  unknown: 'Невідомо',
  none: 'Не згадується',
};
const DIRECTION: Record<SituationDirection, string> = {
  towards: 'Курс на Кременчук',
  passing: 'Пролітає повз',
  away: 'Віддаляється',
  downed: 'Збито',
  unknown: 'Невідомо',
  none: 'Не згадується',
};
const QUANTITY: Record<SituationQuantity, string> = { '1': '1', '2': '2', '3': '3', '4+': '4+', unknown: 'Невідомо' };

export const FORECAST_LABEL = {
  alert_expected: 'Канали: очікується тривога',
  clear_expected: 'Канали: очікується відбій',
} as const;

export type StatusView = { key: string; label: string; icon: IconName; value: string; low: boolean; danger: boolean };

type Status = { value: unknown; confidence: Confidence };
/** A confident "none"/"no" is left out instead of filling the screen with negatives. */
const hidden = (s: Status) => (s.value === 'none' || s.value === false) && s.confidence === 'high';

/** Status tiles shown under the alert tile; `forecast` is rendered separately as a channel-attributed chip. */
export function statusViews(s: SituationStatuses): StatusView[] {
  const view = (key: string, status: Status, label: string, icon: IconName, value: string, danger = false) =>
    hidden(status) ? [] : [{ key, label, icon, value, low: status.confidence === 'low', danger }];
  return [
    ...view('threatType', s.threatType, 'Тип загрози', 'target', THREAT_TYPE[s.threatType.value]),
    ...view('direction', s.direction, 'Напрямок', 'arrow', DIRECTION[s.direction.value], s.direction.value === 'towards'),
    // Nothing to count when no threat is mentioned at all.
    ...(s.threatType.value === 'none' ? [] : view('quantity', s.quantity, 'Кількість', 'stack', QUANTITY[s.quantity.value])),
    ...view('explosions', s.explosions, 'Вибухи', 'burst', s.explosions.value ? 'Чути' : 'Не чути', s.explosions.value),
    ...view('airDefense', s.airDefense, 'Робота ППО', 'radar', s.airDefense.value ? 'Працює' : 'Не працює'),
  ];
}

/** Statuses fit to show: an evaluation of unknown freshness is too old to present as the current picture. */
export const currentStatuses = (s: SituationDto) => (s.evaluation?.freshness === 'unknown' ? null : s.statuses);

/** Revision IDs any status was derived from; their feed cards get the «доказ» marker. */
export const evidenceIds = (s: SituationStatuses | null) =>
  new Set(s ? Object.values(s).flatMap((x) => x.evidenceMessageIds) : []);

const WATER = /^на\s+воду$/i;
export const isWater = (stop: RouteStop) => WATER.test(stop.name.trim());
/** «на воду» (out over the Dnipro) always closes the route. */
export const orderRoute = (route: RouteStop[]) => [...route.filter((s) => !isWater(s)), ...route.filter(isWater)];
export const inRaion = (placeId: string | null) =>
  placeId !== null && (placeId === KREMENCHUK.raionId || ancestors(placeId).some((p) => p.id === KREMENCHUK.raionId));

/** Only real t.me post links become anchors; anything else from the server is dropped. */
export const telegramLink = (link: string | null) => (link?.startsWith('https://t.me/') ? link : null);
