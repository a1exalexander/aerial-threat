import type { PlaceLevel } from '@aerial/contracts';
import { AMBIGUOUS_NAMES, PLACES, SUB_AREAS } from '../dictionary';

export { extractRoute } from './route';

/** How the text relates the threat to the place. Only the literal wording, never a computed position. */
export type PlaceRelation = 'in' | 'towards' | 'over' | 'near' | 'past' | 'region_of' | 'unknown';

export type PlaceCandidate = {
  /** Dictionary place ID; null when the name is ambiguous. */
  placeId: string | null;
  level: PlaceLevel | null;
  /** The matched input text: `text.slice(span.start, span.end) === surface`. */
  surface: string;
  /** Half-open UTF-16 offsets into the input string. */
  span: { start: number; end: number };
  relation: PlaceRelation;
  ambiguous: boolean;
  /** Places an ambiguous name could denote; empty when resolved. */
  alternatives: string[];
  /** City district named in the text (nominative), e.g. «Крюків»; placeId is then its city. */
  subArea: string | null;
};

// Case slots: nominative, genitive, dative, accusative, instrumental, locative.
const ACC = 3;
const LOC = 5;

const LATIN_LOOKALIKES: Record<string, string> = { a: 'а', b: 'в', c: 'с', e: 'е', h: 'н', i: 'і', ï: 'ї', k: 'к', m: 'м', o: 'о', p: 'р', t: 'т', x: 'х', y: 'у' };
const APOSTROPHES = /['’ʼ`‘ʹ]/g;

/** Comparison key: NFC, lower case, one apostrophe, Latin look-alikes folded to Cyrillic, stress marks dropped. */
const key = (s: string) =>
  s
    .normalize('NFC')
    .toLowerCase()
    .replace(/\u0301/g, '')
    .replace(APOSTROPHES, "'")
    .replace(/[abcehikmoptxyï]/g, (ch) => LATIN_LOOKALIKES[ch] ?? ch);

const HUSHING = /[жчшщ]$/;
const soften = (stem: string) => stem.replace(/к$/, 'ц').replace(/г$/, 'з').replace(/х$/, 'с');
/** Genitive plural with a fleeting vowel: Браїлки → Браїлок, Лубни → Лубен. */
const fleeting = (stem: string) =>
  /[^аеєиіїоуюяь'][^аеєиіїоуюяь']$/.test(stem) ? ['о', 'е'].map((v) => stem.slice(0, -1) + v + stem.slice(-1)) : [];

const ABBREVIATIONS: Record<string, string[]> = {
  район: ['р-н', 'р-ну', 'р-ну', 'р-н', 'р-ном', 'р-ні'],
  область: ['обл', 'обл', 'обл', 'обл', 'обл', 'обл'],
};

/**
 * Case forms of one lower-case word. Over-generation is harmless: the result is only a lookup
 * set for whole tokens. Words before the last one of a name are adjectives agreeing with it.
 */
function declineWord(w: string, adjective: boolean): string[][] {
  const s1 = w.slice(0, -1);
  const s2 = w.slice(0, -2);
  if (w.endsWith('ий')) return [[w], [s2 + 'ого'], [s2 + 'ому'], [w], [s2 + 'им'], [s2 + 'ому', s2 + 'ім']];
  if (w.endsWith('е')) return [[w], [s1 + 'ого'], [s1 + 'ому'], [w], [s1 + 'им'], [s1 + 'ому', s1 + 'ім']];
  if (adjective && w.endsWith('а')) return [[w], [s1 + 'ої'], [s1 + 'ій'], [s1 + 'у'], [s1 + 'ою'], [s1 + 'ій']];
  if (adjective && w.endsWith('і')) {
    const hard = [s1 + 'их', s1 + 'іх'];
    return [[w], hard, [s1 + 'им', s1 + 'ім'], [w], [s1 + 'ими', s1 + 'іми'], hard];
  }
  if (w.endsWith('ь')) return [[w], [s1 + 'і'], [s1 + 'і'], [w], [s1 + 'ю'], [s1 + 'і']];
  if (w.endsWith('а')) {
    const h = HUSHING.test(s1);
    return [[w], [s1 + (h ? 'і' : 'и')], [soften(s1) + 'і'], [s1 + 'у'], [s1 + (h ? 'ею' : 'ою')], [soften(s1) + 'і']];
  }
  if (w.endsWith('я')) return [[w], [s1 + 'і'], [s1 + 'і'], [s1 + 'ю'], [s1 + 'ею'], [s1 + 'і']];
  if (w.endsWith('о')) return [[w], [s1 + 'а'], [s1 + 'у'], [w], [s1 + 'ом'], [s1 + 'у', soften(s1) + 'і']];
  if (/[иі]$/.test(w)) {
    const e = w.endsWith('і') ? 'я' : 'а';
    return [[w], [s1, s1 + 'ів', ...fleeting(s1)], [s1 + e + 'м'], [w], [s1 + e + 'ми'], [s1 + e + 'х']];
  }
  // Masculine consonant stem; a final -ів/-їв turns into -ов/-єв in oblique cases (Крюків → Крюкові).
  const o = w.replace(/ів$/, 'ов').replace(/їв$/, 'єв');
  return [[w], [o + 'а', o + 'у'], [o + 'у', o + 'ові'], [w], [o + (HUSHING.test(o) ? 'ем' : 'ом')], [soften(o) + 'і', o + 'у']];
}

/** Case forms of a whole name, per case slot. */
function inflect(name: string): string[][] {
  const words = key(name).split(' ');
  const perWord = words.map((w, i) => {
    const forms = declineWord(w, i < words.length - 1);
    const abbr = ABBREVIATIONS[w];
    return abbr ? forms.map((f, c) => [...f, abbr[c]!]) : forms;
  });
  return [0, 1, 2, 3, 4, 5].map((c) =>
    perWord.reduce<string[]>((acc, forms) => acc.flatMap((a) => forms[c]!.map((f) => (a ? `${a} ${f}` : f))), ['']),
  );
}

type Entry = {
  placeId: string | null;
  level: PlaceLevel | null;
  subArea: string | null;
  ambiguous: boolean;
  /** Settlement names collide with common words (гребінка, заводському, мачухи), so they must be capitalised. */
  proper: boolean;
  cases: Set<number>;
};

const index = new Map<string, Entry[]>();
function add(name: string, entry: Omit<Entry, 'cases'>) {
  inflect(name).forEach((forms, c) => {
    for (const form of forms) {
      const list = index.get(form) ?? [];
      index.set(form, list);
      let e = list.find((x) => x.placeId === entry.placeId && x.subArea === entry.subArea);
      if (!e) list.push((e = { ...entry, cases: new Set() }));
      e.cases.add(c);
    }
  });
}
for (const p of PLACES) {
  for (const alias of p.aliases) add(alias, { placeId: p.id, level: p.level, subArea: null, ambiguous: false, proper: p.level === 'city' || p.level === 'village' });
}
for (const [cityId, names] of Object.entries(SUB_AREAS)) {
  for (const n of names) add(n, { placeId: cityId, level: 'city', subArea: n, ambiguous: false, proper: true });
}
for (const n of AMBIGUOUS_NAMES) add(n, { placeId: null, level: 'village', subArea: null, ambiguous: true, proper: true });
const MAX_WORDS = Math.max(...[...index.keys()].map((k) => k.split(/[ -]/).length));

const NOT_LETTER = '(?<!\\p{L})';
const rule = (pattern: string) => new RegExp(`${NOT_LETTER}(?:${pattern})\\s*$`, 'u');
const RELATION_RULES: [RegExp, PlaceRelation][] = [
  [rule('район[іу]?|р-н[іу]?'), 'region_of'],
  [rule('[ву]\\s+(?:напрям(?:ку|і)?|бік|сторону)|напрям(?:ок)?\\s+на|курс(?:ом)?(?:\\s+(?:на|в|у))?|до'), 'towards'],
  [/(?:→|->|➡️?)\s*$/u, 'towards'],
  [rule('над'), 'over'],
  [rule('повз'), 'past'],
  [rule('біля|поблизу|поруч(?:\\s+з)?|поряд(?:\\s+з)?|неподалік(?:\\s+від)?|під|околиц[іяюь]|(?:північ|півден|схід|захід)ніше'), 'near'],
  [rule('по'), 'in'],
];
const CASE_GOVERNED = rule('на|в|у|ув|во');
const DESIGNATOR = new RegExp(`${NOT_LETTER}(?:м|с|смт|м-н|міст[оаі]|сел[оаі]|селищ[еаі])\\.?\\s*$`, 'u');
const LIST_SEPARATOR = /^\s*(?:[/,]|та|і|й|або|чи)\s*$/u;
const PREPOSITION_PAIR = new RegExp(`${NOT_LETTER}(\\p{L}+)\\s*/\\s*(\\p{L}+)\\s*$`, 'u');

function relationFromPrefix(prefix: string, cases: Set<number>): PlaceRelation {
  for (const [re, relation] of RELATION_RULES) if (re.test(prefix)) return relation;
  if (!CASE_GOVERNED.test(prefix)) return 'unknown';
  // «на/у Полтаві» (locative) is a location; «на Полтаву» (accusative) is a direction.
  if (cases.has(LOC) && !cases.has(ACC)) return 'in';
  if (cases.has(ACC) && !cases.has(LOC)) return 'towards';
  return 'unknown';
}

type Previous = { end: number; relation: PlaceRelation; cases: Set<number> };

/** Relation from the words between the previous match and the name, within the same clause. */
function relationOf(text: string, start: number, cases: Set<number>, prev: Previous | undefined): PlaceRelation {
  // «на Мачухи/Судіївку», «Гадяч/Миргород»: list items in a shared case share the first item's relation.
  if (prev && LIST_SEPARATOR.test(text.slice(prev.end, start)) && [...cases].some((c) => prev.cases.has(c))) return prev.relation;
  let prefix = text.slice(Math.max(0, start - 40, prev?.end ?? 0), start).toLowerCase();
  // «у м. Кременчук»: the preposition governs the designator, so the name's own case says nothing.
  if (DESIGNATOR.test(prefix)) {
    prefix = prefix.replace(DESIGNATOR, '');
    cases = new Set([rule('на').test(prefix) ? ACC : LOC]);
  }
  prefix = prefix.slice(Math.max(...[...'.!?\n;:()«»"'].map((ch) => prefix.lastIndexOf(ch))) + 1);
  // «на/повз Полтаву»: the author left the direction open.
  const pair = PREPOSITION_PAIR.exec(prefix);
  if (pair) {
    const [a, b] = [pair[1], pair[2]].map((p) => relationFromPrefix(`${p} `, cases));
    return a === b ? a! : 'unknown';
  }
  return relationFromPrefix(prefix, cases);
}

// A token starts with a letter: emoji variation selectors (U+FE0F) are marks too.
const TOKEN = /\p{L}[\p{L}\p{M}]*(?:['’ʼ`‘ʹ]\p{L}[\p{L}\p{M}]*)*/gu;
const isUpper = (ch: string) => ch !== ch.toLowerCase();

/**
 * Place mentions in `text` (a revision's normalized text), longest dictionary match first.
 * Oblast, raion and city stay separate levels. Same-name villages are never resolved: they come
 * back ambiguous with placeId null. Names outside the dictionary («біля аеропорту») yield nothing.
 */
export function extractPlaceCandidates(text: string): PlaceCandidate[] {
  const tokens = [...text.matchAll(TOKEN)].map((m) => ({ start: m.index, end: m.index + m[0].length, key: key(m[0]) }));
  const out: PlaceCandidate[] = [];
  let prev: Previous | undefined;
  for (let i = 0; i < tokens.length; ) {
    let matched = 0;
    for (let n = Math.min(MAX_WORDS, tokens.length - i); n > 0 && !matched; n--) {
      let phrase = tokens[i]!.key;
      for (let j = i + 1; j < i + n && phrase; j++) {
        const gap = text.slice(tokens[j - 1]!.end, tokens[j]!.start);
        phrase = gap === '-' ? `${phrase}-${tokens[j]!.key}` : /^\s+$/.test(gap) ? `${phrase} ${tokens[j]!.key}` : '';
      }
      const start = tokens[i]!.start;
      const entries = (index.get(phrase) ?? []).filter((e) => !e.proper || isUpper(text[start]!));
      if (!entries.length) continue;
      matched = n;
      const end = tokens[i + n - 1]!.end;
      const ambiguous = entries.length > 1 || entries.some((e) => e.ambiguous);
      const cases = new Set(entries.flatMap((e) => [...e.cases]));
      const first = entries[0]!;
      const relation = relationOf(text, start, cases, prev);
      prev = { end, relation, cases };
      out.push({
        placeId: ambiguous ? null : first.placeId,
        level: entries.every((e) => e.level === first.level) ? first.level : null,
        surface: text.slice(start, end),
        span: { start, end },
        relation,
        ambiguous,
        alternatives: ambiguous ? [...new Set(entries.flatMap((e) => (e.placeId ? [e.placeId] : [])))] : [],
        subArea: ambiguous ? null : first.subArea,
      });
    }
    i += matched || 1;
  }
  return out;
}
