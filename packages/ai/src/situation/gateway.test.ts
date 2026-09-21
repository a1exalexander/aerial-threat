import type { SituationMessage } from '@aerial/domain/situation';
import { describe, expect, it, vi } from 'vitest';
import type { EvaluationError } from '../evaluator';
import { HTTP_EVALUATE_URL } from '../gateway';
import { createGatewaySituationEvaluator } from './gateway';
import { buildSituationRequest } from './index';

// No real calls: every request goes to an injected fetch. Synthetic paraphrases only.
const msg = (revisionId: string, at: string, text: string): SituationMessage => ({
  revisionId,
  sourceId: 'src-1',
  sourceName: 'Канал А',
  messageId: '7',
  publishedAt: new Date(at),
  text,
  replyToText: null,
});
const msgs = [msg('rev-1', '2026-09-21T10:00:00Z', 'Реклама: знижки на генератори'), msg('rev-2', '2026-09-21T10:05:00Z', 'Мопед на нас, тел. 0501234567')];
const NOW = new Date('2026-09-21T10:06:00Z');

/** Provider-shaped answers for every asked question: booleans at `p`, choices one-hot on `picks` (else the first option). */
function answersFor(picks: Record<string, string>, p: Record<string, number>) {
  const { questions } = buildSituationRequest(msgs, NOW);
  return Object.fromEntries(
    Object.entries(questions).map(([id, q]) => {
      if (q.type !== 'choice') return [id, { type: 'boolean', probability: p[id] ?? 0.05 }];
      const options = Object.keys(q.criteria);
      const choice = picks[id] ?? options[0]!;
      return [id, { type: 'choice', choice, probabilities: Object.fromEntries(options.map((o) => [o, o === choice ? 1 : 0])) }];
    }),
  );
}
const answers = answersFor({ threat_type: 'shahed', direction: 'towards', quantity: '1', forecast: 'none' }, { threat_now: 0.97, m1_relevant: 0.02, m2_relevant: 0.99 });
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const success = () =>
  json({
    model: 'typesafe-ai/jev',
    answers,
    usage: { inputTokens: 1200, outputTokens: 40 },
    providerMetadata: { gateway: { generationId: 'gen_sit' } },
  });
const noSleep = async () => {};

describe.each(['sdk', 'http'] as const)('%s transport', (transport) => {
  const evaluatorWith = (fetch: typeof globalThis.fetch) => createGatewaySituationEvaluator({ apiKey: 'test-key', transport, fetch, sleep: noSleep });

  it('sends one request per window and maps the answers to statuses', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => success());
    const result = await evaluatorWith(fetch).evaluate(msgs, NOW);

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    if (transport === 'http') expect(String(url)).toBe(HTTP_EVALUATE_URL);
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-key');
    const body = JSON.parse(String(init?.body));
    expect(body.state.posts.map((p: { id: string; text: string }) => [p.id, p.text])).toEqual([
      ['m1', 'Реклама: знижки на генератори'],
      ['m2', 'Мопед на нас, тел. [PHONE]'],
    ]);
    expect(Object.keys(body.questions)).toContain('m2_relevant');

    expect(result).toMatchObject({
      model: 'typesafe-ai/jev',
      providerRequestId: 'gen_sit',
      usage: { inputTokens: 1200, outputTokens: 40 },
      relevantRevisionIds: ['rev-2'],
      statuses: {
        threatNow: { value: true, confidence: 'high', evidenceMessageIds: ['rev-2'] },
        threatType: { value: 'shahed', confidence: 'high' },
        direction: { value: 'towards', confidence: 'high' },
        quantity: { value: '1', confidence: 'high' },
        explosions: { value: false, confidence: 'high' },
      },
    });
  });

  it('retries a 503, then succeeds', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => success()).mockResolvedValueOnce(json({ error: { message: 'x', type: 'internal_server_error' } }, 503));
    await expect(evaluatorWith(fetch).evaluate(msgs, NOW)).resolves.toMatchObject({ relevantRevisionIds: ['rev-2'] });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('surfaces a 401 as a credentials error without retrying', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json({ error: { message: 'x', type: 'authentication_error' } }, 401));
    const error = await evaluatorWith(fetch)
      .evaluate(msgs, NOW)
      .catch((e: EvaluationError) => e);
    expect(error).toMatchObject({ kind: 'credentials', status: 401 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects answers for questions that were not asked', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json({ answers: { ...answers, m3_relevant: { type: 'boolean', probability: 1 } } }));
    expect(await evaluatorWith(fetch).evaluate(msgs, NOW).catch((e: EvaluationError) => e.kind)).toBe('invalid_response');
  });
});

it('refuses to build a situation evaluator without a key', () => {
  expect(() => createGatewaySituationEvaluator({ apiKey: undefined })).toThrow('AI_GATEWAY_API_KEY required');
});
