import { describe, expect, it } from 'vitest';
import { ClaimReviewCommand, EvidenceSpan, IncidentListItem, NormalizedMessage, envelope } from './index';

const revisionId = '0b3c1f9e-8a3b-4a51-9d2e-2a4f3f7c1b10';

describe('contracts', () => {
  it('keeps Telegram IDs as decimal strings beyond 2^53', () => {
    const base = {
      sourceProvider: 'telegram',
      sourceExternalId: '1706408894',
      externalMessageId: '9007199254740993',
      publishedAt: '2026-09-14T10:00:00Z',
      editedAt: null,
      replyToExternalId: null,
      rawText: '',
      normalizedText: '',
      cleanedText: '',
      mediaFlags: [],
      rawPayload: {},
      mode: 'live',
    };
    expect(NormalizedMessage.parse(base).externalMessageId).toBe('9007199254740993');
    expect(NormalizedMessage.safeParse({ ...base, externalMessageId: 42 }).success).toBe(false);
  });

  it('rejects inverted evidence spans', () => {
    expect(EvidenceSpan.safeParse({ revisionId, start: 5, end: 2, rawStart: 5, rawEnd: 7 }).success).toBe(false);
  });

  it('builds typed envelopes', () => {
    const Page = envelope(IncidentListItem.array());
    const page = Page.parse({ data: [], generatedAt: '2026-09-14T10:00:00Z', projectionVersion: 'p1', freshness: 'unknown' });
    expect(page.data).toEqual([]);
    expect(Page.safeParse({ data: [], generatedAt: 'yesterday', projectionVersion: 'p1', freshness: 'fresh' }).success).toBe(false);
  });

  it('requires version, idempotency key, reason and a real correction', () => {
    const cmd = { expectedVersion: 3, idempotencyKey: 'key-12345', reason: 'wrong place' };
    expect(ClaimReviewCommand.safeParse({ ...cmd, action: 'confirm' }).success).toBe(true);
    expect(ClaimReviewCommand.safeParse({ ...cmd, action: 'correct', correction: {} }).success).toBe(false);
    expect(ClaimReviewCommand.safeParse({ action: 'confirm', reason: 'x' }).success).toBe(false);
  });
});
