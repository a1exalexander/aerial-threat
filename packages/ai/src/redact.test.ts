import { describe, expect, it } from 'vitest';
import { redact } from './redact';

// Synthetic data only: none of these numbers or addresses belong to anyone.
const TEXT =
  'Шахед на Полтаву о 22:30, 7 БпЛА. Збір: картка 4111 1111 1111 1111, IBAN UA213223130000026007233566001, ' +
  'тел. +380 50 123 45 67 або (050) 123-45-67, пишіть на volunteer.test@example.com чи @private_person. Джерело @energy_poltava';

describe('redact', () => {
  const r = redact(TEXT, { keepHandles: ['energy_poltava'] });

  it('replaces phones, cards, IBANs, emails and private handles', () => {
    expect(r.text).toBe(
      'Шахед на Полтаву о 22:30, 7 БпЛА. Збір: картка [CARD], IBAN [IBAN], ' +
        'тел. [PHONE] або [PHONE], пишіть на [EMAIL] чи [HANDLE]. Джерело @energy_poltava',
    );
  });

  it('leaves times, counts and place names alone', () => {
    expect(redact('О 03:15 над Кременчуком 12 цілей, ще 5 на Горішні Плавні').segments).toEqual([]);
  });

  it('catches domestic and +38 phone formats', () => {
    for (const phone of ['0501234567', '+380501234567', '+38 (067) 123-45-67', '38 050 123 45 67']) {
      expect(redact(`дзвоніть ${phone}.`).text).toBe('дзвоніть [PHONE].');
    }
  });

  it('maps spans of untouched text both ways', () => {
    for (const word of ['Полтаву', '7 БпЛА', 'Джерело']) {
      const start = TEXT.indexOf(word);
      const span = { start, end: start + word.length };
      const inRedacted = r.toRedacted(span);
      expect(r.text.slice(inRedacted.start, inRedacted.end)).toBe(word);
      expect(r.toOriginal(inRedacted)).toEqual(span);
    }
  });

  it('expands a span that touches a placeholder to the whole original fragment', () => {
    const start = r.text.indexOf('[EMAIL]');
    const back = r.toOriginal({ start: start + 2, end: start + 4 });
    expect(TEXT.slice(back.start, back.end)).toBe('volunteer.test@example.com');
    const card = TEXT.indexOf('1111 1111');
    const fwd = r.toRedacted({ start: card, end: card + 4 });
    expect(r.text.slice(fwd.start, fwd.end)).toBe('[CARD]');
  });
});
