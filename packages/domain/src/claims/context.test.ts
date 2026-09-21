import { describe, expect, it } from 'vitest';
import { selectContext, type ContextPost } from './context';
import { POLICY } from './policy';

const CHANNEL = '1000000001';
const T0 = Date.parse('2026-09-16T06:00:00Z');

function post(id: number, minutesFromT0: number, extra: Partial<ContextPost> = {}): ContextPost {
  return {
    sourceExternalId: CHANNEL,
    externalMessageId: String(id),
    publishedAt: new Date(T0 + minutesFromT0 * 60_000).toISOString(),
    replyToExternalId: null,
    revisionId: `rev-${id}`,
    ...extra,
  };
}

const message = post(100, 0);
const now = new Date(T0 + 60_000);
const ids = (posts: ContextPost[]) => posts.map((p) => p.externalMessageId);

describe('selectContext', () => {
  it('takes up to 5 prior same-channel posts from the last 15 minutes (ties ordered by ID), oldest first', () => {
    const candidates = [post(90, -20), post(91, -15), post(92, -10), post(93, -1), post(94, 0), post(5, -3, { sourceExternalId: '2000000002' })];
    const ctx = selectContext({ message, candidates, now });
    expect(ids(ctx.prior)).toEqual(['91', '92', '93', '94']);
    expect(ctx).toMatchObject({ replyParent: null, missingContext: false, truncated: false, truncatedReason: null, policyVersion: POLICY.version });
  });

  it('never uses posts published after the message or after the virtual clock', () => {
    const candidates = [post(99, 0), post(101, 0), post(102, 2), post(98, -2)];
    expect(ids(selectContext({ message, candidates, now }).prior)).toEqual(['98', '99']);
    const replayed = post(103, 5);
    expect(ids(selectContext({ message: replayed, candidates, now }).prior)).toEqual(['98', '99', '101']);
  });

  it('flags truncation when more posts were eligible than the policy allows', () => {
    const candidates = [1, 2, 3, 4, 5, 6, 7].map((i) => post(90 + i, -i));
    const ctx = selectContext({ message, candidates, now });
    expect(ids(ctx.prior)).toEqual(['95', '94', '93', '92', '91']);
    expect(ctx).toMatchObject({ truncated: true, truncatedReason: 'max_prior_posts' });
    expect(selectContext({ message, candidates, now, policy: { ...POLICY, maxPriorPosts: 7 } }).truncated).toBe(false);
  });

  it('adds the reply parent even outside the window, without repeating it', () => {
    const reply = post(100, 0, { replyToExternalId: '50' });
    const candidates = [post(50, -120), post(51, -5), post(50, -5, { sourceExternalId: '2000000002' })];
    const ctx = selectContext({ message: reply, candidates, now });
    expect(ctx.replyParent).toMatchObject({ externalMessageId: '50', sourceExternalId: CHANNEL });
    expect(ids(ctx.prior)).toEqual(['51']);
    expect(ctx.missingContext).toBe(false);

    const recentParent = selectContext({ message: post(100, 0, { replyToExternalId: '51' }), candidates, now });
    expect(ids(recentParent.prior)).toEqual([]);
  });

  it('marks a reply whose parent is unavailable as missing context', () => {
    const ctx = selectContext({ message: post(100, 0, { replyToExternalId: '7' }), candidates: [post(99, -1)], now });
    expect(ctx).toMatchObject({ replyParent: null, missingContext: true });
    expect(ids(ctx.prior)).toEqual(['99']);
  });

  it('hashes the selected revisions deterministically', () => {
    const candidates = [post(98, -2), post(99, -1)];
    const hash = selectContext({ message, candidates, now }).contextHash;
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(selectContext({ message, candidates: [...candidates].reverse(), now }).contextHash).toBe(hash);
    expect(selectContext({ message, candidates: [post(98, -2), post(99, -1, { revisionId: 'rev-99b' })], now }).contextHash).not.toBe(hash);
    expect(selectContext({ message, candidates, now, policy: { ...POLICY, version: 'other' } }).contextHash).not.toBe(hash);
  });
});
