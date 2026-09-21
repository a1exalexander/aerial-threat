import { describe, expect, it } from 'vitest';
import type { NormalizedMessage } from './domain';
import { computeRevisionHash } from './hash';

const msg: NormalizedMessage = {
  sourceProvider: 'telegram',
  sourceExternalId: '1000000001',
  externalMessageId: '42',
  publishedAt: '2026-09-14T10:00:00Z',
  editedAt: null,
  replyToExternalId: null,
  rawText: 'Синтетичний текст\nрядок 2',
  normalizedText: 'синтетичний текст рядок 2',
  cleanedText: 'Синтетичний текст рядок 2',
  mediaFlags: ['photo'],
  rawPayload: { id: 42, reactions: { results: [{ count: 3 }] }, views: 100 },
  mode: 'archive',
};

describe('computeRevisionHash', () => {
  it('is pinned so the format never changes silently', () => {
    expect(computeRevisionHash(msg)).toMatchInlineSnapshot(`"54b3a66d3e11bcb7edb0507679cc0bfc2c83a94486330d1e7d7d8b0412630be0"`);
  });

  it('ignores reactions, views and derived texts', () => {
    const noisy = {
      ...msg,
      rawPayload: { id: 42, reactions: { results: [{ count: 99 }] }, views: 5000 },
      normalizedText: 'other',
      cleanedText: 'other',
      editedAt: '2026-09-14T10:05:00Z',
    };
    expect(computeRevisionHash(noisy)).toBe(computeRevisionHash(msg));
  });

  it('ignores media flag order/duplicates and CRLF vs LF', () => {
    expect(computeRevisionHash({ ...msg, mediaFlags: ['photo', 'webpage'] })).toBe(
      computeRevisionHash({ ...msg, mediaFlags: ['webpage', 'photo', 'photo'], rawText: msg.rawText.replace('\n', '\r\n') }),
    );
  });

  it('changes on text, reply or media changes', () => {
    const base = computeRevisionHash(msg);
    expect(computeRevisionHash({ ...msg, rawText: msg.rawText + '!' })).not.toBe(base);
    expect(computeRevisionHash({ ...msg, replyToExternalId: '41' })).not.toBe(base);
    expect(computeRevisionHash({ ...msg, mediaFlags: [] })).not.toBe(base);
  });
});
