import { describe, expect, it } from 'vitest';
import { type SituationSnapshot, pickCurrent, pickSnapshot } from './situation';

const now = new Date('2026-09-21T16:00:00Z');
const snap = (mode: 'ai' | 'rules', minutesAgo: number, revisionIds: string[]) =>
  ({ mode, evaluatedAt: new Date(now.getTime() - minutesAgo * 60_000), revisionIds }) as SituationSnapshot;

describe('pickSnapshot', () => {
  it('keeps the AI result while rules have seen nothing new', () => {
    const ai = snap('ai', 2, ['a', 'b']);
    expect(pickSnapshot(ai, snap('rules', 0, ['b']), now)).toBe(ai);
    expect(pickSnapshot(ai, snap('rules', 0, []), now)).toBe(ai);
  });

  it('switches to the newer rules snapshot once it has seen a post the AI has not', () => {
    const rules = snap('rules', 0, ['a', 'c']);
    expect(pickSnapshot(snap('ai', 2, ['a']), rules, now)).toBe(rules);
  });

  it('never keeps an expired AI result', () => {
    const rules = snap('rules', 0, []);
    expect(pickSnapshot(snap('ai', 30, ['a']), rules, now)).toBe(rules);
  });

  it('falls back to whichever exists', () => {
    const ai = snap('ai', 30, []);
    expect(pickSnapshot(ai, null, now)).toBe(ai);
    expect(pickSnapshot(null, null, now)).toBeNull();
  });

  it('a newer rules run that saw nothing new re-confirms the AI result (checkedAt)', () => {
    const ai = snap('ai', 10, ['a']);
    const rules = snap('rules', 0, []);
    expect(pickCurrent(ai, rules, now)).toEqual({ snapshot: ai, checkedAt: rules.evaluatedAt });
  });
});
