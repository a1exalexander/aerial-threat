import type {
  AlertState,
  AlertStateDto,
  AreaDto,
  ClaimKind,
  EvidenceRelation,
  Freshness,
  GeoBasis,
  IncidentLifecycle,
  SourceDto,
  ThreatType,
} from '@aerial/contracts';

// Presentation rules (doc 01): Ukrainian labels, Europe/Kyiv display, missing data is "unknown", never "safe".

const kyivFormat = new Intl.DateTimeFormat('uk-UA', {
  timeZone: 'Europe/Kyiv',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});
export const formatKyiv = (iso: string) => kyivFormat.format(new Date(iso));

const kyivParts = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Kyiv',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** Kyiv wall time "YYYY-MM-DDTHH:mm" of an instant, the value format of <input type="datetime-local">. */
export function toKyivLocal(ms: number): string {
  const p = Object.fromEntries(kyivParts.formatToParts(ms).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

/** Inverse of toKyivLocal: Kyiv wall time -> UTC ISO; null for malformed, rolled-over or non-existent (DST gap) times. */
export function kyivLocalToIso(local: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local)) return null;
  const wall = Date.parse(`${local}:00Z`);
  if (Number.isNaN(wall)) return null;
  let t = wall;
  // offset = (Kyiv wall clock of t read as UTC) - t; a second pass settles DST transitions.
  for (let i = 0; i < 2 && !Number.isNaN(t); i++) t = wall - (Date.parse(`${toKyivLocal(t)}Z`) - t);
  return !Number.isNaN(t) && toKyivLocal(t) === local ? new Date(t).toISOString() : null;
}

const TELEGRAM_USERNAME = /^[A-Za-z][A-Za-z0-9_]{3,31}$/;
/** Link built only from a verified public username and a numeric message ID; never from a server-sent URL. */
export const telegramUrl = (username: string | null, messageId: string): string | null =>
  username && TELEGRAM_USERNAME.test(username) && /^\d{1,20}$/.test(messageId) ? `https://t.me/${username}/${messageId}` : null;

export const NEPTUN_URL = 'https://neptun.in.ua/';
export const MAP_UNAVAILABLE = 'Карта недоступна. Усі дані є в розділах «Стан тривоги» та «Повідомлення каналу».';

/** A failed or unknown-freshness reading is shown as "unknown", never as "no alert". */
export const alertDisplayState = (a: AlertStateDto): AlertState =>
  a.freshness === 'unknown' || a.state === 'unknown' ? 'unknown' : a.state;

/**
 * Map state of an area. Only its own reading can say "no alert"; the parent (oblast-wide alert) can only
 * raise it to active or degrade it to unknown. No own reading = unknown.
 */
export function areaAlertState(alerts: readonly AlertStateDto[], id: string, parentId: string | null): AlertState {
  const own = alerts.filter((a) => a.placeId === id).map(alertDisplayState);
  const parent = parentId === null ? [] : alerts.filter((a) => a.placeId === parentId).map(alertDisplayState);
  if (own.includes('active') || parent.includes('active')) return 'active';
  if (own.length === 0 || own.includes('unknown') || parent.includes('unknown')) return 'unknown';
  return 'inactive';
}

/** Nearest area (itself or an ancestor) that `ids` contains, e.g. city -> its raion polygon. */
export function nearestArea(areas: ReadonlyMap<string, AreaDto>, id: string, ids: ReadonlySet<string>): string | null {
  for (let cur: string | null = id, hops = 0; cur && hops < 10; cur = areas.get(cur)?.parentId ?? null, hops++) {
    if (ids.has(cur)) return cur;
  }
  return null;
}

export const ALERT_LABEL: Record<AlertState, string> = {
  active: 'Тривога',
  inactive: 'Тривоги немає',
  unknown: 'Невідомо',
};

export const FRESHNESS_LABEL: Record<Freshness, string> = {
  fresh: 'Дані актуальні',
  stale: 'Дані застарілі',
  unknown: 'Актуальність невідома',
};

export const KIND_LABEL: Record<ClaimKind, string> = {
  threat_report: 'Повідомлення про загрозу',
  alert_claim: 'Повідомлення про тривогу',
  clear_claim: 'Повідомлення про відбій',
  aftermath: 'Наслідки',
  background_news: 'Новини',
  advertisement: 'Реклама',
  fundraising: 'Збір коштів',
  other: 'Інше',
  unknown: 'Тип не визначено',
};

export const THREAT_LABEL: Record<ThreatType, string> = {
  uav: 'БпЛА',
  missile: 'ракета',
  ballistic: 'балістика',
  aviation: 'авіація',
  kab: 'КАБ',
  unknown: 'тип загрози не визначено',
};

export const GEO_BASIS_LABEL: Record<GeoBasis, string> = {
  explicit: 'Місце названо в тексті',
  reply_context: 'Місце взято з контексту відповіді',
  channel_default: 'Припущення: типовий регіон каналу',
  unresolved: 'Місце не визначено',
};

export const LIFECYCLE_LABEL: Record<IncidentLifecycle, string> = {
  candidate: 'Розбір триває',
  reported: 'Актуальне повідомлення',
  stale: 'Без оновлень понад 15 хв',
  archived: 'Архів',
  retracted: 'Відкликано',
};

export const RELATION_LABEL: Record<EvidenceRelation, string> = {
  primary: 'Основне',
  supporting: 'Додаткове',
  conflicting: 'Суперечить іншим',
  closure: 'Відбій від каналу',
};

export const AVAILABILITY_LABEL: Record<SourceDto['availability'], string> = {
  ok: 'працює',
  degraded: 'з перебоями',
  unavailable: 'недоступне',
  paused: 'призупинене',
  unknown: 'стан невідомий',
};
