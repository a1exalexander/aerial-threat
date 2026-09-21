import type { ClaimKind, GeoBasis, ThreatType } from '@aerial/contracts';
import { ancestors, byId } from '@aerial/geo';
import { activeClosures, activeReports, disagreements, type Incident, type IncidentEvidence } from './incident';

/** One summary sentence and the claims it was built from: removing those claims removes the sentence. */
export interface SummarySentence {
  text: string;
  claimIds: string[];
}

const THREAT: Record<ThreatType, string> = {
  uav: 'БпЛА',
  missile: 'ракети',
  ballistic: 'балістичні ракети',
  aviation: 'активність авіації',
  kab: 'КАБ',
  unknown: 'загрозу невизначеного типу',
};

const NOT_OFFICIAL = 'це твердження каналу, а не офіційний стан тривоги';

const BASIS: Partial<Record<GeoBasis, string>> = {
  explicit: 'Місце визначено з тексту.',
  reply_context: 'Місце визначено з допису, на який відповідає канал.',
  channel_default: 'Місце — лише припущення за типовим регіоном каналу.',
};

const kyivTime = new Intl.DateTimeFormat('uk-UA', { timeZone: 'Europe/Kyiv', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const plural = new Intl.PluralRules('uk');
const channels = (n: number) => `${n} ${{ one: 'канал', few: 'канали' }[plural.select(n) as string] ?? 'каналів'}`;
const unique = <T>(xs: T[]) => [...new Set(xs)];
const nameOf = (placeId: string) => byId(placeId)?.name ?? placeId;

function kindPhrase(kind: ClaimKind, reports: IncidentEvidence[]): string {
  const known = unique(reports.map((e) => e.claim.threatType)).filter((t) => t !== 'unknown');
  const qualifiers = unique(reports.flatMap((e) => e.claim.threatQualifier?.value ?? []));
  const types = known.length ? known.map((t) => THREAT[t]).join(', ') : THREAT.unknown;
  const threats = qualifiers.length ? `${types} (за текстом: ${qualifiers.join(', ')})` : types;
  switch (kind) {
    case 'threat_report':
      return threats;
    case 'alert_claim':
      return 'тривогу — це повідомлення каналу, а не дані NEPTUN';
    case 'aftermath':
      return `наслідки атаки${known.length ? ` (${threats})` : ''}`;
    case 'clear_claim':
      return `відбій — ${NOT_OFFICIAL}`;
    default:
      return 'подію невизначеного типу';
  }
}

/**
 * Template summary (doc 06), built only from the incident's active claims:
 * territory → message type → time → sources → uncertainty. Unknown place is stated, unknown quantity is
 * omitted, counts from different channels are never summed, and nothing here is ever derived from the
 * absence of data (no «загрози немає»): an incident without active claims has an empty summary.
 */
export function buildSummary(incident: Incident): SummarySentence[] {
  const reports = activeReports(incident);
  if (reports.length === 0) return [];
  const out: SummarySentence[] = [];
  const say = (text: string, from: IncidentEvidence[]) => {
    if (from.length) out.push({ text, claimIds: unique(from.map((e) => e.claim.id)) });
  };

  const conflict = disagreements(reports);
  const placed = reports.filter((e) => e.claim.placeId);
  const places = unique(placed.map((e) => e.claim.placeId!)).sort((a, b) => ancestors(b).length - ancestors(a).length);
  say(
    conflict.place.length
      ? `Канали називають різні місця: ${places.map(nameOf).join('; ')}.`
      : `Територія: ${places.map(nameOf).join(', ')}.`,
    placed,
  );
  say('Місце не визначено.', reports.filter((e) => !e.claim.placeId));
  const moving = reports.filter((e) => e.claim.movementMention);
  say(`Напрямок за текстом: ${unique(moving.map((e) => e.claim.movementMention)).join('; ')}.`, moving);

  const sources = new Set(reports.map((e) => e.claim.sourceId)).size;
  const who = sources === 1 ? 'Канал повідомляє' : `${channels(sources)} повідомляють`;
  say(`${who} про ${kindPhrase(incident.kind, reports)}.`, reports);

  const counts = unique(conflict.counts.map((e) => e.claim.quantity));
  say(
    conflict.quantity.length
      ? `Кількість різниться між каналами: ${counts.join(' або ')}; значення не сумуються.`
      : `Кількість за повідомленням: ${counts[0]}.`,
    conflict.counts,
  );
  const described = reports.filter((e) => e.claim.quantity === null && e.claim.quantityText);
  say(`Кількість за текстом: ${unique(described.map((e) => e.claim.quantityText)).join('; ')}.`, described);
  for (const [basis, text] of Object.entries(BASIS)) say(text, placed.filter((e) => e.claim.geoBasis === basis));

  const lastAt = Math.max(...reports.map((e) => e.claim.publishedAt.getTime()));
  say(`Оновлено о ${kyivTime.format(lastAt)}.`, reports.filter((e) => e.claim.publishedAt.getTime() === lastAt));
  const closures = activeClosures(incident);
  if (closures.length) {
    const closedAt = Math.max(...closures.map((e) => e.claim.publishedAt.getTime()));
    say(`Канал повідомив про відбій о ${kyivTime.format(closedAt)} — ${NOT_OFFICIAL}.`, closures);
  }

  if (sources > 1) {
    const origins = new Set(reports.map((e) => e.originGroup));
    const copies = [...origins].some((g) => new Set(reports.filter((e) => e.originGroup === g).map((e) => e.claim.sourceId)).size > 1);
    say(
      origins.size === 1
        ? `Джерела: ${channels(sources)}, одне спільне походження (репост або копія).`
        : `Джерела: ${channels(sources)}${copies ? ', частина — копії спільного допису' : ''}; незалежність не встановлена.`,
      reports,
    );
  }

  say('Потребує перевірки оператором.', reports.filter((e) => e.claim.publicationDecision === 'review'));
  say(
    'Джерело висловлюється попередньо.',
    reports.filter((e) => e.claim.uncertainty.classification.includes('tentative_language')),
  );
  return out;
}

export const summaryText = (sentences: SummarySentence[]): string => sentences.map((s) => s.text).join(' ');
