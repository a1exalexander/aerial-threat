/** Half-open [start, end) range of the analysed text; `text.slice(start, end) === surface`. */
export interface TextSpan {
  start: number;
  end: number;
  surface: string;
}

/**
 * A time expression resolved against the injected `now` on the Europe/Kyiv calendar.
 * `from`/`to` are UTC ISO instants (equal for a point in time). `future`/`past` flag an event
 * clearly after/before `now`; both false means it overlaps the present.
 */
export interface TimeCandidate extends TextSpan {
  kind: 'relative' | 'clock' | 'date';
  from: string;
  to: string;
  future: boolean;
  past: boolean;
}

const MIN = 60_000;
/** Times this far after `now` still count as current (posting delay, clock skew). */
const FUTURE_TOLERANCE_MS = 5 * MIN;
/** Times this far before `now` still count as current: the freshness window of a current report. */
const PAST_TOLERANCE_MS = 15 * MIN;
/** A day word or date this close to a clock time on the same line gives that clock its day. */
const ANCHOR_DISTANCE = 30;
const MONTHS = ['січня', 'лютого', 'березня', 'квітня', 'травня', 'червня', 'липня', 'серпня', 'вересня', 'жовтня', 'листопада', 'грудня'];

const RELATIVE_RE = /(?<!\p{L})(?:щойно|зараз|наразі|вночі|уночі|вчора|учора|сьогодні|завтра)(?!\p{L})/giu;
const CLOCK_RE = /(?:(?<!\p{L})об?[ \t]+)?(?<![\p{L}\d:.,])(?<h>[01]?\d|2[0-3]):(?<m>[0-5]\d)(?![\d:])/giu;
// A dotted clock («о 14.30») needs the preposition; bare «14.30» is too often a price or a date.
const DOT_CLOCK_RE = /(?<!\p{L})об?[ \t]+(?<h>[01]?\d|2[0-3])\.(?<m>[0-5]\d)(?!\d|\.\d)/giu;
const DATE_RE = new RegExp(
  `(?<![\\p{L}\\d])(?<d1>[0-3]?\\d)(?:[ \\t]*[–—-][ \\t]*(?<d2>[0-3]?\\d))?[ \\t]+(?<mon>${MONTHS.join('|')})(?:[ \\t]+(?<y>\\d{4})(?:[ \\t]*року)?)?(?!\\p{L})`,
  'giu',
);

const kyivFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Europe/Kyiv',
  hourCycle: 'h23',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
});

function kyivParts(ms: number): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const p: Record<string, number> = {};
  for (const { type, value } of kyivFormat.formatToParts(ms)) p[type] = Number(value);
  return p as ReturnType<typeof kyivParts>;
}

/** UTC ms of a Europe/Kyiv wall-clock time; day/hour overflow rolls over like Date.UTC. */
export function kyivToUtc(year: number, month: number, day: number, hour = 0, minute = 0): number {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const offset = (ms: number) => {
    const p = kyivParts(ms);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - (ms - (ms % 1000));
  };
  return wall - offset(wall - offset(wall));
}

type Day = [year: number, month: number, day: number];

/** Time expressions in `text`, resolved relative to `now` (usually the post's publishedAt). */
export function extractTimes(text: string, now: Date): TimeCandidate[] {
  const n = now.getTime();
  const k = kyivParts(n);
  const nearest = (values: number[]) => values.reduce((a, b) => (Math.abs(b - n) < Math.abs(a - n) ? b : a));
  const out: TimeCandidate[] = [];
  const anchors: Array<{ start: number; end: number; day: Day }> = [];
  const add = (m: RegExpMatchArray, kind: TimeCandidate['kind'], from: number, to: number) => {
    const start = m.index ?? 0;
    out.push({
      start,
      end: start + m[0].length,
      surface: m[0],
      kind,
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      future: from > n + FUTURE_TOLERANCE_MS,
      past: to < n - PAST_TOLERANCE_MS,
    });
  };

  for (const m of text.matchAll(RELATIVE_RE)) {
    const word = m[0].toLowerCase();
    if (word === 'щойно') add(m, 'relative', n - 10 * MIN, n);
    else if (word === 'зараз' || word === 'наразі') add(m, 'relative', n, n);
    else {
      const day: Day = [k.year, k.month, k.day + (word === 'вчора' || word === 'учора' ? -1 : word === 'завтра' ? 1 : 0)];
      anchors.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, day });
      // ponytail: «вночі» is always the latest 00:00–06:00 Kyiv night; a forward-looking «вночі очікується» is not told apart.
      if (word === 'вночі' || word === 'уночі') add(m, 'relative', kyivToUtc(...day, 0), kyivToUtc(...day, 6));
      else add(m, 'relative', kyivToUtc(...day), kyivToUtc(day[0], day[1], day[2] + 1));
    }
  }

  for (const m of text.matchAll(DATE_RE)) {
    const g = m.groups ?? {};
    const month = MONTHS.indexOf((g.mon ?? '').toLowerCase()) + 1;
    const d1 = Number(g.d1);
    // Without a year, the nearest occurrence: «31 грудня» posted on 1 January is last year.
    const year = g.y ? Number(g.y) : kyivParts(nearest([-1, 0, 1].map((dy) => kyivToUtc(k.year + dy, month, d1)))).year;
    anchors.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, day: [year, month, d1] });
    add(m, 'date', kyivToUtc(year, month, d1), kyivToUtc(year, month, Number(g.d2 ?? g.d1) + 1));
  }

  for (const m of [...text.matchAll(CLOCK_RE), ...text.matchAll(DOT_CLOCK_RE)]) {
    const h = Number(m.groups?.h);
    const min = Number(m.groups?.m);
    const start = m.index ?? 0;
    const end = start + m[0].length;
    const near = (a: number, b: number) => b - a <= ANCHOR_DISTANCE && !text.slice(a, b).includes('\n');
    const anchor = anchors.find((a) => (a.end <= start && near(a.end, start)) || (a.start >= end && near(end, a.start)));
    // Without a day word or date, a clock time means the nearest such moment: yesterday, today or tomorrow.
    const t = anchor ? kyivToUtc(...anchor.day, h, min) : nearest([-1, 0, 1].map((d) => kyivToUtc(k.year, k.month, k.day + d, h, min)));
    add(m, 'clock', t, t);
  }

  return out.sort((a, b) => a.start - b.start);
}
