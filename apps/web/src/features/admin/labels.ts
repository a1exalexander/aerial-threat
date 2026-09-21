import type {
  Assessment,
  Claim,
  ClaimKind,
  ConnectorDto,
  GeoBasis,
  PublicationDecision,
  TemporalScope,
  ThreatType,
  Uncertainty,
} from '@aerial/contracts';

export const KIND: Record<ClaimKind, string> = {
  threat_report: 'Повідомлення про загрозу',
  alert_claim: 'Згадка про тривогу',
  clear_claim: 'Твердження про відбій',
  aftermath: 'Наслідки',
  background_news: 'Фонова новина',
  advertisement: 'Реклама',
  fundraising: 'Збір коштів',
  other: 'Інше',
  unknown: 'Невідомо',
};

export const THREAT: Record<ThreatType, string> = {
  uav: 'БпЛА',
  missile: 'Ракета',
  ballistic: 'Балістика',
  aviation: 'Авіація',
  kab: 'КАБ',
  unknown: 'Невідомо',
};

export const TEMPORAL: Record<TemporalScope, string> = {
  current: 'Зараз',
  past: 'У минулому',
  future: 'Очікується',
  unknown: 'Невідомо',
};

export const GEO_BASIS: Record<GeoBasis, string> = {
  explicit: 'явна згадка',
  reply_context: 'визначено за контекстом (відповідь)',
  channel_default: 'визначено за контекстом (типова область каналу)',
  unresolved: 'не визначено — потребує перевірки',
};

export const DECISION: Record<PublicationDecision, string> = {
  publish: 'Опубліковано',
  review: 'На перевірці',
  exclude: 'Виключено',
};

type Reason = Uncertainty['time'][number] | Uncertainty['geo'][number] | Uncertainty['classification'][number];
export const REASON: Record<Reason, string> = {
  no_explicit_time: 'час не вказано явно',
  relative_time: 'відносний час («щойно», «за 10 хв»)',
  event_time_differs_from_published: 'час події відрізняється від часу публікації',
  edited_after_publish: 'допис відредаговано після публікації',
  archive_last_text_only: 'архів: відома лише остання версія тексту',
  no_place_mention: 'місце не згадано',
  ambiguous_place: 'неоднозначна назва місця',
  not_in_dictionary: 'місця немає в довіднику',
  direction_only: 'лише напрямок руху',
  region_level_only: 'лише рівень області',
  from_reply_context: 'місце з допису, на який відповідають',
  from_channel_default: 'місце за типовою областю каналу',
  low_score: 'низька оцінка відповіді',
  small_margin: 'малий відрив між варіантами',
  multiple_claims: 'кілька тверджень в одному дописі',
  needs_context: 'зрозуміло лише з контексту',
  missing_context: 'контекст недоступний',
  context_truncated: 'контекст обрізано',
  tentative_language: 'автор висловлюється непевно',
  conflicting_context: 'суперечить контексту',
  suspected_prompt_injection: 'підозра на інструкції в тексті допису',
};

export const QUESTION: Record<string, string> = {
  message_kind: 'Тип повідомлення',
  temporal_scope: 'Час події',
  contains_multiple_claims: 'Кілька тверджень',
  threat_type: 'Тип загрози',
  is_tentative: 'Непевне формулювання',
  needs_context: 'Потрібен контекст',
  place_candidate: 'Місце',
  relation_candidate: "Зв'язок з подією",
};

/**
 * What the operator sees instead of a model probability (doc 05: a probability answers the question asked,
 * it is not a danger probability). Uncertain answers need review; context-derived answers say so.
 */
export type Basis = 'явна згадка' | 'визначено за контекстом' | 'потребує перевірки';
export function assessmentBasis(a: Assessment, claim: Pick<Claim, 'geoBasis' | 'uncertainty'>): Basis {
  if (a.type === 'boolean' && a.probability > 0.1 && a.probability < 0.9) return 'потребує перевірки';
  if (a.type === 'choice') {
    const [top = 0, second = 0] = Object.values(a.probabilities).sort((x, y) => y - x);
    const p = a.probabilities[a.selected] ?? 0;
    if (p < 0.9 || p < top || top - second < 0.2 || a.selected === 'unknown' || a.selected === 'none') return 'потребує перевірки';
  }
  if (a.question === 'place_candidate') {
    if (claim.geoBasis === 'unresolved') return 'потребує перевірки';
    if (claim.geoBasis !== 'explicit') return 'визначено за контекстом';
  }
  return claim.uncertainty.classification.includes('needs_context') ? 'визначено за контекстом' : 'явна згадка';
}

/** Readable answer without numbers: the chosen option or так/ні. */
export function assessmentAnswer(a: Assessment, placeName: (id: string) => string): string {
  if (a.type === 'boolean') return a.probability >= 0.5 ? 'так' : 'ні';
  if (a.type === 'score') return String(a.score);
  if (a.question === 'place_candidate') return a.selected === 'none' || a.selected === 'unknown' ? 'не визначено' : placeName(a.selected);
  return (
    KIND[a.selected as ClaimKind] ?? THREAT[a.selected as ThreatType] ?? TEMPORAL[a.selected as TemporalScope] ?? a.selected
  );
}

const SILENCE_MS = 30 * 60_000;
const STALE_SYNC_MS = 5 * 60_000;
export type ConnectorStatus = { label: string; tone: 'ok' | 'warn' | 'error' | 'muted' };
/** Tells a quiet channel (connector fine, no posts) apart from a broken connector. `now` = server generatedAt. */
export function connectorStatus(c: ConnectorDto, now: string): ConnectorStatus {
  if (!c.enabled || c.availability === 'paused') return { label: 'Призупинено', tone: 'muted' };
  if (c.errorKind || c.availability === 'unavailable') return { label: 'Збій конектора', tone: 'error' };
  if (c.availability === 'degraded') return { label: 'Працює з перебоями', tone: 'warn' };
  if (c.availability === 'unknown' || !c.lastSuccessfulSync) return { label: 'Стан невідомий', tone: 'warn' };
  if (Date.parse(now) - Date.parse(c.lastSuccessfulSync) > STALE_SYNC_MS)
    return { label: 'Немає синхронізації понад 5 хв', tone: 'warn' };
  const quiet = !c.lastMessageAt || Date.parse(now) - Date.parse(c.lastMessageAt) > SILENCE_MS;
  if (c.provider === 'telegram' && quiet) return { label: 'Тиша каналу — конектор працює', tone: 'ok' };
  return { label: 'Працює', tone: 'ok' };
}

const kyiv = new Intl.DateTimeFormat('uk-UA', {
  timeZone: 'Europe/Kyiv',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});
/** UTC instant → Europe/Kyiv wall time. */
export const formatKyiv = (iso: string) => kyiv.format(new Date(iso));

export function formatAge(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} с`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} хв ${s % 60} с`;
  return `${Math.floor(m / 60)} год ${m % 60} хв`;
}
