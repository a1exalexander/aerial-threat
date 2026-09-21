import { describe, expect, it } from 'vitest';
import { computeMetrics, wilson, type EvalRecord, type Prediction } from './metrics';

describe('wilson', () => {
  it('has no rate or interval without data', () => {
    expect(wilson(0, 0)).toEqual({ numerator: 0, denominator: 0, rate: null, ci95: null });
  });

  it('matches reference 95% intervals', () => {
    const { ci95 } = wilson(95, 100);
    expect(ci95![0]).toBeCloseTo(0.8883, 3);
    expect(ci95![1]).toBeCloseTo(0.9785, 3);
  });

  it('keeps 5/5 far from a 98% release gate', () => {
    const r = wilson(5, 5);
    expect(r.rate).toBe(1);
    expect(r.ci95![0]).toBeCloseTo(0.5655, 3);
    expect(r.ci95![1]).toBe(1);
  });
});

describe('computeMetrics', () => {
  const p = (over: Partial<Prediction>): Prediction => ({ kind: null, temporalScope: null, placeId: null, relationId: null, decision: 'review', ...over });
  const records: EvalRecord[] = [
    // correct publish, explicit place right, correct link
    {
      expected: { kind: 'threat_report', temporalScope: 'current', placeId: 'ua-pl-c-poltava', placeExplicit: true, relationId: 'inc-1' },
      predicted: p({ kind: 'threat_report', temporalScope: 'current', placeId: 'ua-pl-c-poltava', relationId: 'inc-1', decision: 'publish' }),
    },
    // published with the wrong temporal scope, wrong place, missed link
    {
      expected: { kind: 'threat_report', temporalScope: 'current', placeId: 'ua-pl-c-kremenchuk', placeExplicit: true, relationId: 'inc-2' },
      predicted: p({ kind: 'threat_report', temporalScope: 'past', placeId: 'ua-pl-c-poltava', decision: 'publish' }),
    },
    // aftermath sent to review still counts as recalled; wrong auto-link = false merge
    { expected: { kind: 'aftermath', relationId: null }, predicted: p({ kind: 'aftermath', relationId: 'inc-9' }) },
    // fundraising with thematic words excluded: not relevant, not in recall population
    { expected: { kind: 'fundraising' }, predicted: p({ kind: 'fundraising', decision: 'exclude' }) },
    // relevant clear claim lost as other
    { expected: { kind: 'clear_claim' }, predicted: p({ kind: 'other', decision: 'exclude' }) },
  ];
  const m = computeMetrics(records);
  const nd = (r: { numerator: number; denominator: number }) => [r.numerator, r.denominator];

  it('reports each metric as numerator/denominator', () => {
    expect(nd(m.relevantRecall)).toEqual([3, 4]);
    expect(nd(m.relevantRecallCurrent)).toEqual([2, 3]);
    expect(nd(m.relevantRecallAftermath)).toEqual([1, 1]);
    expect(nd(m.publishedPrecision)).toEqual([1, 2]);
    expect(nd(m.explicitPlaceAccuracy)).toEqual([1, 2]);
    expect(nd(m.falseMergeRate)).toEqual([1, 2]);
    expect(nd(m.falseSplitRate)).toEqual([1, 2]);
    expect(nd(m.autoCoverage)).toEqual([2, 4]);
    expect(nd(m.reviewShare)).toEqual([1, 5]);
  });

  it('attaches a confidence interval', () => {
    expect(m.relevantRecall.rate).toBe(0.75);
    expect(m.relevantRecall.ci95![0]).toBeLessThan(0.75);
    expect(m.relevantRecall.ci95![1]).toBeGreaterThan(0.75);
  });
});
