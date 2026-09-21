// PII redaction before anything leaves the worker (doc 08). Offsets are UTF-16 indices, the same as
// String#slice and the EvidenceSpan offsets on normalizedText.
export type Span = { start: number; end: number };
type Segment = { start: number; end: number; rStart: number; rEnd: number };

export type Redaction = {
  text: string;
  /** Replaced ranges: [start, end) in the original, [rStart, rEnd) in the redacted text. */
  segments: readonly Segment[];
  /** Maps a span of the original text onto the redacted text (a span touching a placeholder covers all of it). */
  toRedacted(span: Span): Span;
  /** Maps a span of the redacted text back onto the original text. */
  toOriginal(span: Span): Span;
};

const SEP = '[ \\u00A0-]?';
// Order is priority: an earlier rule wins an overlap (an IBAN is not also a card, an email is not a handle).
// ponytail: card = any 13–19 digit run, no Luhn check; over-redacting a long number costs nothing here.
const RULES: [placeholder: string, re: RegExp][] = [
  ['[EMAIL]', /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}/gu],
  ['[IBAN]', new RegExp(`\\b[A-Z]{2}\\d{2}(?:${SEP}[A-Z0-9]){11,30}\\b`, 'g')],
  ['[CARD]', new RegExp(`(?<!\\d)\\d(?:${SEP}\\d){12,18}(?!\\d)`, 'g')],
  [
    '[PHONE]',
    new RegExp(
      `(?<![\\p{L}\\p{N}])(?:\\+\\d(?:${SEP}\\d){9,13}|(?:\\+?38${SEP})?\\(?0\\d{2}\\)?${SEP}\\d{3}${SEP}\\d{2}${SEP}\\d{2})(?!\\p{N})`,
      'gu',
    ),
  ],
  ['[HANDLE]', /(?<![\p{L}\p{N}_@])@([A-Za-z][A-Za-z0-9_]{3,31})(?![A-Za-z0-9_])/gu],
];

function mapPos(pos: number, segments: readonly Segment[], toOriginal: boolean, isEnd: boolean): number {
  let delta = 0;
  for (const s of segments) {
    const [a0, a1, b0, b1] = toOriginal ? [s.rStart, s.rEnd, s.start, s.end] : [s.start, s.end, s.rStart, s.rEnd];
    if (pos <= a0) break;
    if (pos < a1) return isEnd ? b1 : b0;
    delta = b1 - a1;
  }
  return pos + delta;
}

/**
 * Replaces phones, card numbers, IBANs, emails and @handles with placeholders. `keepHandles` lists
 * public channel usernames (without @) that stay readable; any other handle may be a private person.
 */
export function redact(text: string, { keepHandles = [] }: { keepHandles?: readonly string[] } = {}): Redaction {
  const keep = new Set(keepHandles.map((h) => h.replace(/^@/, '').toLowerCase()));
  const hits: { start: number; end: number; placeholder: string }[] = [];
  for (const [placeholder, re] of RULES) {
    for (const m of text.matchAll(re)) {
      const start = m.index;
      const end = start + m[0].length;
      if (placeholder === '[HANDLE]' && keep.has(m[1]!.toLowerCase())) continue;
      if (hits.some((h) => start < h.end && h.start < end)) continue;
      hits.push({ start, end, placeholder });
    }
  }
  hits.sort((a, b) => a.start - b.start);

  let out = '';
  let cursor = 0;
  const segments: Segment[] = [];
  for (const h of hits) {
    out += text.slice(cursor, h.start);
    segments.push({ start: h.start, end: h.end, rStart: out.length, rEnd: out.length + h.placeholder.length });
    out += h.placeholder;
    cursor = h.end;
  }
  out += text.slice(cursor);

  const map = (span: Span, toOriginal: boolean): Span => ({
    start: mapPos(span.start, segments, toOriginal, false),
    end: mapPos(span.end, segments, toOriginal, true),
  });
  return { text: out, segments, toRedacted: (s) => map(s, false), toOriginal: (s) => map(s, true) };
}
