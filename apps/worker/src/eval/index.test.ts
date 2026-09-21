import { createFakeEvaluator, LabeledDataset } from '@aerial/ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { predict, run, runEval } from './index';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('eval-live', () => {
  it('refuses to run without AI_GATEWAY_API_KEY', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', '');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await run(['--dataset', 'x', '--budget', '10'])).toBe(2);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('AI_GATEWAY_API_KEY required'));
  });

  it('requires a dataset and an explicit budget', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', 'test-key');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await run(['--dataset', 'x'])).toBe(2);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('usage: cli eval-live'));
  });
});

describe('runEval', () => {
  const dataset = LabeledDataset.parse({
    parserVersion: 'export-v1',
    items: [
      {
        id: 'synthetic-1',
        text: 'Шахед на Полтаву',
        publishedAt: '2026-09-20T19:00:00Z',
        placeCandidates: [{ id: 'ua-pl-c-poltava', name: 'Полтава', start: 9, end: 16 }],
        expected: { kind: 'threat_report', temporalScope: 'current', placeId: 'ua-pl-c-poltava', placeExplicit: true },
      },
      {
        id: 'synthetic-2',
        text: 'Збираємо на дрон для ППО, картка 4111 1111 1111 1111',
        publishedAt: '2026-09-20T19:05:00Z',
        expected: { kind: 'fundraising' },
      },
      { id: 'synthetic-3', text: 'Схоже, чисто', publishedAt: '2026-09-20T19:30:00Z', expected: { kind: 'clear_claim' } },
    ],
  });
  const fixtures = {
    'Шахед на Полтаву': { message_kind: 'threat_report', temporal_scope: 'current', threat_type: 'uav', place_candidate: 'ua-pl-c-poltava', is_tentative: 0.02, contains_multiple_claims: 0.01, needs_context: 0.01 },
    'Збираємо на дрон для ППО, картка [CARD]': { message_kind: 'fundraising' },
    'Схоже, чисто': { message_kind: 'clear_claim', is_tentative: 0.93 },
  };

  it('computes metrics with versions and never stores text', async () => {
    const report = await runEval(dataset, createFakeEvaluator(fixtures));
    expect(report).toMatchObject({ model: 'fake/jev', parserVersion: 'export-v1', counts: { items: 3, evaluated: 3, errors: 0, skipped: 0 } });
    expect(report.items.map((i) => i.decision)).toEqual(['publish', 'exclude', 'review']);
    expect(report.metrics.relevantRecall).toMatchObject({ numerator: 2, denominator: 2 });
    expect(report.metrics.publishedPrecision).toMatchObject({ numerator: 1, denominator: 1 });
    expect(report.metrics.explicitPlaceAccuracy).toMatchObject({ numerator: 1, denominator: 1 });
    expect(JSON.stringify(report)).not.toMatch(/Шахед|Збираємо|чисто/);
  });

  it('stops at the request budget and reports the rest as skipped', async () => {
    const report = await runEval(dataset, createFakeEvaluator(fixtures, { maxRequests: 2 }));
    expect(report.counts).toEqual({ items: 3, evaluated: 2, errors: 0, skipped: 1, stoppedBy: 'budget' });
    expect(report.usage.requests).toBe(2);
  });
});

describe('predict', () => {
  it('reviews anything below the score or margin threshold', () => {
    const probabilities = { threat_report: 0.6, other: 0.4 };
    expect(predict([{ type: 'choice', question: 'message_kind', selected: 'threat_report', probabilities }]).decision).toBe('review');
  });
});
