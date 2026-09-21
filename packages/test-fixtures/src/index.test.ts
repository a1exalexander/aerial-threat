import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type TelegramFixture, loadLabelsTemplate, loadTelegramExport, manifest, telegramExportPath } from './index';

const names = Object.keys(manifest.files) as TelegramFixture[];
const messagesOf = (name: TelegramFixture) => (loadTelegramExport(name) as { messages: Array<{ id: number }> }).messages;

describe('telegram fixtures', () => {
  it.each(names)('%s matches its manifest record by record', (name) => {
    const records = messagesOf(name).map((m) => ({
      id: String(m.id),
      sha256: createHash('sha256').update(JSON.stringify(m)).digest('hex'),
    }));
    expect(records).toEqual(manifest.files[name].records.map(({ id, sha256 }) => ({ id, sha256 })));
  });

  it.each(names)('%s holds no card numbers, phones or payment links', (name) => {
    // The only look-alikes allowed are the redaction placeholders (see manifest `redaction`).
    const placeholders = ['0000 0000 0000 0001', 'https://send.monobank.ua/jar/REDACTED', '+380 00 000 00 00'];
    const text = placeholders.reduce((t, p) => t.replaceAll(p, ''), readFileSync(telegramExportPath(name), 'utf8'));
    expect(text).not.toMatch(/\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{4}/);
    expect(text).not.toMatch(/(?<!\d)(?:\+?38[ -]?\(?0\d{2}\)?|\+?380[ -]?\(?\d{2}\)?|\(?0\d{2}\)?)[ -]?\d{2,3}[ -]?\d{2}[ -]?\d{2,3}(?!\d)/);
    expect(text).not.toMatch(/privat24|monobank/i);
  });

  it('has an all-null labels template entry per fixture record', () => {
    const { records } = loadLabelsTemplate() as { records: Array<Record<string, unknown>> };
    expect(records.map((r) => `${r.source}:${r.id}`)).toEqual(
      names.flatMap((n) => manifest.files[n].records.map((r) => `${n}:${r.id}`)),
    );
    for (const { source: _s, id: _i, ...labels } of records) expect(Object.values(labels).every((v) => v === null)).toBe(true);
  });
});
