import type { ThreatType } from '@aerial/contracts';
import { extractTimes, type TextSpan, type TimeCandidate } from './time';

/** Version of these extraction rules; part of the processing key (`parser_version`). */
export const EXTRACTION_VERSION = 'claims-rules-v1';

export type KnownThreatType = Exclude<ThreatType, 'unknown'>;
/** A literal threat term. `negated` («БпЛА не зафіксовано») means it is no evidence of a threat. */
export interface ThreatCandidate extends TextSpan {
  threatType: KnownThreatType;
  negated: boolean;
}
/** `value` is a count; a qualitative amount («багато», «група») keeps `value: null` and its literal `text`. */
export interface QuantityCandidate extends TextSpan {
  value: number | null;
  text: string | null;
}
export interface QualifierCandidate extends TextSpan {
  value: 'реактивний';
}
export interface Candidates {
  quantities: QuantityCandidate[];
  threats: ThreatCandidate[];
  qualifiers: QualifierCandidate[];
  times: TimeCandidate[];
  /** «попередньо», «ймовірно»: the author hedges. Post-wide: every fragment gets all of them. */
  tentative: TextSpan[];
  /** Non-negated «відбій», «минула», «чисто»: required evidence for a clear_claim. */
  closures: TextSpan[];
  /** Instructions aimed at the model («ігноруй правила»). Kept as data; they force review. Post-wide. */
  injections: TextSpan[];
}
export interface ClaimFragment {
  /** Text of the fragment; a marker line carries the header lines above it as a first, separate span. */
  spans: TextSpan[];
  candidates: Candidates;
  /** Different counts inside one fragment: never pick or average one. */
  conflict: boolean;
}
export interface ClaimExtraction {
  /** Empty for text without letters or digits (emoji-only, media without caption). */
  fragments: ClaimFragment[];
  /** Several claims that the rules could not split reliably. */
  needsReview: boolean;
  reason: 'multi_claim_unsplit' | null;
}

interface Range {
  start: number;
  end: number;
}

const L = '\\p{L}';
const WS = `(?<!${L})`;
const WE = `(?!${L})`;
const APOS = "['’ʼ‘`]";

// Insertion order is match priority: «балістичні ракети» is ballistic, «керовані авіаційні бомби» is kab.
const THREAT_TERMS: Record<KnownThreatType, string> = {
  ballistic: `балістичн${L}*(?:[ \\t]+ракет${L}*)?|балістик${L}*`,
  kab: `(?:керован${L}*[ \\t]+)?авіа(?:ційн${L}*[ \\t]+)?бомб${L}*|каб(?:и|ів|ами|ам|ах|ом|а|у)?${WE}`,
  missile: `(?:крилат${L}*[ \\t]+)?ракет${L}*|крилат${L}*|бандерол${L}*`,
  aviation: `авіаці${L}*|літак${L}*`,
  uav: `бпла${WE}|бе[зс]п[іи]лотн${L}*|шахед${L}*|шахід${L}*|шах${WE}|мопед${L}*|дрон${L}*`,
};
const THREAT_TYPES = Object.keys(THREAT_TERMS) as KnownThreatType[];
const ANY_THREAT = `${WS}(?:${THREAT_TYPES.map((t) => THREAT_TERMS[t]).join('|')})`;
const THREAT_RE = new RegExp(`${WS}(?:${THREAT_TYPES.map((t) => `(?<${t}>${THREAT_TERMS[t]})`).join('|')})`, 'giu');

// Keys without apostrophes; the pattern accepts any apostrophe variant or none (суржик «пять»).
const NUMBER_WORDS: Record<string, number> = {
  один: 1, одна: 1, одне: 1, одного: 1, одну: 1,
  два: 2, дві: 2, двоє: 2, двох: 2, двома: 2,
  три: 3, троє: 3, трьох: 3, трьома: 3,
  чотири: 4, четверо: 4, чотирьох: 4,
  пять: 5, пятеро: 5, пятьох: 5,
  шість: 6, шесть: 6, шестеро: 6, шістьох: 6,
  сім: 7, семеро: 7, сімох: 7, сімома: 7,
  вісім: 8, восьмеро: 8, вісьмох: 8,
  девять: 9, девятеро: 9,
  десять: 10, десятеро: 10,
};
const NUMBER_ALT = Object.keys(NUMBER_WORDS)
  .map((w) => w.replace(/^(п|дев)/, `$1${APOS}?`))
  .join('|');
const QUALITATIVE_ALT = 'багато|чимало|кілька|декілька|кількох|декількох|груп[аиуі]|групою|групами';
// Only adjectives («ворожих», «ударні», «реактивними») may stand between a count and its threat term.
const ADJECTIVE = `(?!груп)[${L}'’ʼ‘\`-]+(?:их|ими|і|ий|а)${WE}`;
// A count needs a threat term right after it (adjectives aside) or the «7х» notation. A bare number
// («15 ОМБр», «16 вересня», «о 14 годині») is never a quantity, a range («3-4 БпЛА») stays text, and
// a count never implies a threat type.
const QUANTITY_RE = new RegExp(
  `(?<![${L}\\d:.,–—-])(?<!${WS}об?[ \\t]+)` +
    `(?:(?<range>\\d{1,3}[ \\t]*[–—-][ \\t]*\\d{1,3})|(?<digits>\\d{1,3}(?:-?(?:ма|ми|ох|ьох|х|ти|ро|ка))?)|(?<word>${NUMBER_ALT})|(?<qual>${QUALITATIVE_ALT}))${WE}` +
    `(?:[ \\t]+${ADJECTIVE}){0,2}?[ \\t]+${ANY_THREAT}` +
    `|(?<![${L}\\d:.,])(?<mult>\\d{1,3}[хx×])(?![${L}\\d])`,
  'giud',
);
const QUALIFIER_RE = new RegExp(`${WS}реактивн${L}*`, 'giu');
const TENTATIVE_RE = new RegExp(`${WS}(?:попередньо|ймовірно|імовірно|можливо|нібито|не[ \\t]+підтверджен${L}*)${WE}`, 'giu');
// «минула ніч» is last night, not an all-clear.
const CLOSURE_RE = new RegExp(
  `${WS}(?:відбій|відбою|відбоєм|минул[аоиі](?![ \\t]+(?:ніч|доб|тиж|рік|рок|міс|годин|вихідн))|чисто|зник(?:ла|ли|ло)?)${WE}`,
  'giu',
);
// «Не ігноруйте правила безпеки» is ordinary safety advice.
const INJECTION_RE = new RegExp(
  `(?<!${WS}не[ \\t]+)${WS}(?:ігнор${L}*|игнор${L}*|забудь${L}*)(?:[ \\t]+${L}+){0,3}?[ \\t]+(?:правил${L}*|інструкці${L}*|инструкци${L}*|вказівк${L}*|промпт${L}*)` +
    `|${WS}ignore[ \\t]+(?:${L}+[ \\t]+){0,3}?(?:instructions|rules|prompts?)${WE}|${WS}system[ \\t]+prompt`,
  'giu',
);
// Negation of presence or of an all-clear («не зафіксовано», «немає», «не минула», «не було»), not any «не»:
// «не менше 10 шахедів» and «шахеди не зупиняються» still report a threat.
const NEGATION_RE = new RegExp(
  `${WS}(?:немає|нема|відсутн${L}*|(?:не|ні)[ \\t]+(?:зафіксован|виявлен|спостеріга|фіксу|помічен|бул|підтверджен|минул|зник)${L}*)`,
  'iu',
);
const CLAUSE_BREAK = /[.,!?;:\n]/;

const ARROWS = '→➡⬅↗↘↖↙⤴⤵➔➜⇒';
const ARROW_LINE = new RegExp(`^[${ARROWS}]`, 'u');
// Telegram emoji bullets carry VS16 (U+FE0F).
const BULLET_LINE = /^(?:[-–—•▪▫◾◽●*🔸🔹]\uFE0F?|\d{1,2}[.)])\s/u;
// Anything that can carry a claim of its own; footers, bank details and quotes do not.
const SIGNAL_RE = new RegExp(
  `[${ARROWS}]|${ANY_THREAT}|(?<![${L}\\d])\\d{1,3}[хx×](?![${L}\\d])|` +
    `${WS}(?:тривог|загроз|відбі|відбо|вибух|небезпек|курс|напрям|бік${WE}|чисто|зник|прил[іе]т|прильот|влуч|збит|уламк|заліт|залет|лет[иія]т|кружля|пуск|зліт|атак)`,
  'iu',
);
const MEANINGFUL = /[\p{L}\p{N}]/u;
const PARAGRAPH_RE = /(?:[^\n]|\n(?![ \t\r]*\n))+/g;
const LINE_RE = /[^\n]+/g;

const span = (text: string, r: Range): TextSpan => ({ start: r.start, end: r.end, surface: text.slice(r.start, r.end) });
const matchSpan = (m: RegExpMatchArray): TextSpan => ({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, surface: m[0] });
const spans = (text: string, re: RegExp): TextSpan[] => [...text.matchAll(re)].map(matchSpan);

function isNegated(text: string, start: number, end: number): boolean {
  // ponytail: the clause is bounded by punctuation and capped at 120 chars each way; no syntax parsing.
  let a = start;
  while (a > 0 && start - a < 120 && !CLAUSE_BREAK.test(text[a - 1] ?? '')) a--;
  let b = end;
  while (b < text.length && b - end < 120 && !CLAUSE_BREAK.test(text[b] ?? '')) b++;
  return NEGATION_RE.test(text.slice(a, b));
}

/** Every rule candidate in `text`; `now` resolves time expressions (usually the post's publishedAt). */
export function extractCandidates(text: string, now: Date): Candidates {
  const quantities = [...text.matchAll(QUANTITY_RE)].map((m): QuantityCandidate => {
    const key = (['range', 'digits', 'word', 'qual', 'mult'] as const).find((k) => m.groups?.[k] !== undefined) ?? 'mult';
    const [start, end] = m.indices?.groups?.[key] ?? [0, 0];
    const surface = text.slice(start, end);
    const textual = key === 'qual' || key === 'range';
    const value = textual
      ? null
      : key === 'word'
        ? (NUMBER_WORDS[surface.toLowerCase().replace(/['’ʼ‘`]/g, '')] ?? null)
        : Number.parseInt(surface, 10);
    return { start, end, surface, value, text: textual ? surface : null };
  });
  const threats = [...text.matchAll(THREAT_RE)].map((m): ThreatCandidate => {
    const s = matchSpan(m);
    const threatType = THREAT_TYPES.find((t) => m.groups?.[t] !== undefined) ?? 'uav';
    return { ...s, threatType, negated: isNegated(text, s.start, s.end) };
  });
  return {
    quantities,
    threats,
    qualifiers: spans(text, QUALIFIER_RE).map((s) => ({ ...s, value: 'реактивний' as const })),
    times: extractTimes(text, now),
    tentative: spans(text, TENTATIVE_RE),
    closures: spans(text, CLOSURE_RE).filter((s) => !isNegated(text, s.start, s.end)),
    injections: spans(text, INJECTION_RE),
  };
}

function trim(text: string, start: number, end: number): Range {
  while (start < end && /\s/.test(text[start] ?? '')) start++;
  while (end > start && /\s/.test(text[end - 1] ?? '')) end--;
  return { start, end };
}

function ranges(text: string, re: RegExp, from: number, to: number): Range[] {
  return [...text.slice(from, to).matchAll(re)]
    .map((m) => trim(text, from + (m.index ?? 0), from + (m.index ?? 0) + m[0].length))
    .filter((r) => MEANINGFUL.test(text.slice(r.start, r.end)) || ARROW_LINE.test(text.slice(r.start, r.end)));
}

type Unit = { header: Range | null; body: Range };

/** Paragraphs, or the marker lines of a paragraph that lists directions/bullets, each with its header. */
function units(text: string): Unit[] {
  const out: Unit[] = [];
  for (const p of ranges(text, PARAGRAPH_RE, 0, text.length)) {
    const lines = ranges(text, LINE_RE, p.start, p.end);
    const kinds = lines.map((l) => {
      const s = text.slice(l.start, l.end);
      return ARROW_LINE.test(s) ? 'arrow' : BULLET_LINE.test(s) && SIGNAL_RE.test(s) ? 'bullet' : null;
    });
    // One arrow line is a direction list. Bullets count only with a claim signal («- Підписатися» is a
    // footer) and need two, since one dash line is usually a quote.
    if (!kinds.includes('arrow') && kinds.filter((k) => k === 'bullet').length < 2) {
      out.push({ header: null, body: p });
      continue;
    }
    // Plain lines head the marker lines below them; plain lines with no marker below stand alone.
    let header: Range | null = null;
    let used = false;
    for (const [i, l] of lines.entries()) {
      if (kinds[i]) {
        out.push({ header, body: l });
        used = true;
      } else if (header && !used) {
        header = { start: header.start, end: l.end };
      } else {
        header = l;
        used = false;
      }
    }
    if (header && !used) out.push({ header: null, body: header });
  }
  return out;
}

function fragment(text: string, all: Candidates, rs: Range[]): ClaimFragment {
  const inside = <T extends Range>(xs: T[]) => xs.filter((x) => rs.some((r) => x.start >= r.start && x.end <= r.end));
  const candidates = {
    ...(Object.fromEntries(Object.entries(all).map(([k, xs]: [string, Range[]]) => [k, inside(xs)])) as unknown as Candidates),
    tentative: all.tentative,
    injections: all.injections,
  };
  const counts = new Set(candidates.quantities.flatMap((q) => (q.value === null ? [] : [q.value])));
  return { spans: rs.map((r) => span(text, r)), candidates, conflict: counts.size > 1 };
}

/**
 * Rule candidates for one revision text, split into claim fragments by paragraphs and direction/bullet
 * lines. Spans index into `text` as given (the revision's normalized text).
 */
export function extractClaimCandidates(text: string, now: Date): ClaimExtraction {
  if (!MEANINGFUL.test(text)) return { fragments: [], needsReview: false, reason: null };
  const all = extractCandidates(text, now);
  const bearing = units(text).filter((u) => SIGNAL_RE.test(text.slice(u.body.start, u.body.end)));
  const groups = bearing.length > 1 ? bearing.map((u) => (u.header ? [u.header, u.body] : [u.body])) : [[trim(text, 0, text.length)]];
  const fragments = groups.map((rs) => fragment(text, all, rs));
  // A fragment that still names several threat types holds claims the rules cannot split. KABs are
  // launched by aviation, so «КАБи … авіацією» is one claim; a route «Ромни ➡️ Лубни» is one claim too.
  const unsplit = fragments.some((f) => {
    const types = new Set(f.candidates.threats.filter((t) => !t.negated).map((t) => t.threatType));
    if (types.has('kab')) types.delete('aviation');
    return types.size > 1;
  });
  return { fragments, needsReview: unsplit, reason: unsplit ? 'multi_claim_unsplit' : null };
}
