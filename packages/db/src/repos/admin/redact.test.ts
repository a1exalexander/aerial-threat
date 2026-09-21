import { expect, it } from 'vitest';
import { redact } from './index';

it('masks phones, card/IBAN digits and e-mails with the same length, leaving threat details alone', () => {
  const kept = '7 БпЛА о 10:30, 21.09.2026, повідомлення 13745';
  const text = `Тел. +380 (00) 000-00-00, картка 4111 1111 1111 1111, UA00 0000 0000 0000 0000 0000 0000 0, пошта test.user@example.com. ${kept}`;
  const out = redact(text);
  expect(out).toHaveLength(text.length);
  expect(out).not.toMatch(/380|4111|0000|example/);
  expect(out.endsWith(kept)).toBe(true);
});
