import type { SituationStatuses } from '@aerial/contracts';
import { describe, expect, it } from 'vitest';
import { meaningfullyEdited, statusViews } from './present';

const st = <T,>(value: T, confidence: 'high' | 'low' = 'low') => ({ value, confidence, evidenceMessageIds: [] });

describe('statusViews', () => {
  it('shows facts only: none / unknown / no are hidden at any confidence', () => {
    const s: SituationStatuses = {
      threatNow: st(false),
      threatType: st('none' as const),
      direction: st('unknown' as const),
      quantity: st('unknown' as const),
      forecast: st('none' as const),
      explosions: st(false),
      airDefense: st(false, 'high'),
    };
    expect(statusViews(s)).toEqual([]);
  });

  it('keeps a low-confidence positive value, marked low', () => {
    const s: SituationStatuses = {
      threatNow: st(true),
      threatType: st('jet_shahed' as const),
      direction: st('passing' as const, 'high'),
      quantity: st('1' as const),
      forecast: st('none' as const),
      explosions: st(false),
      airDefense: st(true),
    };
    expect(statusViews(s).map((v) => [v.key, v.low])).toEqual([
      ['threatType', true],
      ['direction', false],
      ['quantity', true],
      ['airDefense', true],
    ]);
  });
});

describe('meaningfullyEdited', () => {
  const at = '2026-09-21T13:00:00Z';
  it('ignores quick fixes and flags later edits', () => {
    expect(meaningfullyEdited({ publishedAt: at, editedAt: null })).toBe(false);
    expect(meaningfullyEdited({ publishedAt: at, editedAt: '2026-09-21T13:00:10Z' })).toBe(false);
    expect(meaningfullyEdited({ publishedAt: at, editedAt: '2026-09-21T13:05:00Z' })).toBe(true);
  });
});
