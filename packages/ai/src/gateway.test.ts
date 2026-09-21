import { describe, expect, it, vi } from 'vitest';
import type { EvaluationError, EvaluationInput } from './evaluator';
import { createGatewayEvaluator, HTTP_EVALUATE_URL } from './gateway';

// No real calls: every request goes to an injected fetch.
const input: EvaluationInput = {
  state: { text: 'Шахед на Полтаву, тел. 0501234567', publishedAt: '2026-09-20T19:00:00Z', channel: 'energy_poltava' },
  questions: { ids: ['message_kind', 'is_tentative'] },
};
const kinds = ['threat_report', 'alert_claim', 'clear_claim', 'aftermath', 'background_news', 'advertisement', 'fundraising', 'other', 'unknown'];
const answers = {
  message_kind: { type: 'choice', choice: 'threat_report', probabilities: Object.fromEntries(kinds.map((k) => [k, k === 'threat_report' ? 0.97 : 0.00375])) },
  is_tentative: { type: 'boolean', probability: 0.04 },
};
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const success = () =>
  json({
    model: 'typesafe-ai/jev',
    answers,
    usage: { inputTokens: 275, outputTokens: 20 },
    providerMetadata: { gateway: { cost: '0.00001155', generationId: 'gen_123' } },
  });
const gatewayError = (status: number, type: string, headers?: Record<string, string>) =>
  json({ error: { message: type, type } }, status, headers);
const noSleep = async () => {};

describe.each(['sdk', 'http'] as const)('%s transport', (transport) => {
  const evaluatorWith = (fetch: typeof globalThis.fetch) => createGatewayEvaluator({ apiKey: 'test-key', transport, fetch, sleep: noSleep });

  it('sends model/state/questions with the key and normalises the answer', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => success());
    const result = await evaluatorWith(fetch).evaluate(input);

    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe(transport === 'http' ? HTTP_EVALUATE_URL : 'https://ai-gateway.vercel.sh/v4/ai/evaluation-model');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-key');
    const body = JSON.parse(String(init?.body));
    expect(body.state.post.text).toBe('Шахед на Полтаву, тел. [PHONE]');
    expect(Object.keys(body.questions)).toEqual(['message_kind', 'is_tentative']);
    if (transport === 'http') expect(body.model).toBe('typesafe-ai/jev');

    expect(result).toMatchObject({
      model: 'typesafe-ai/jev',
      providerRequestId: 'gen_123',
      usage: { inputTokens: 275, outputTokens: 20 },
      attempts: 1,
      assessments: [
        { type: 'choice', question: 'message_kind', selected: 'threat_report' },
        { type: 'boolean', question: 'is_tentative', probability: 0.04 },
      ],
    });
  });

  it('retries 429 honouring Retry-After, then succeeds', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const fetch = vi
      .fn<typeof globalThis.fetch>(async () => success())
      .mockResolvedValueOnce(gatewayError(429, 'rate_limit_exceeded', { 'retry-after': '2' }));
    const result = await createGatewayEvaluator({ apiKey: 'k', transport, fetch, sleep }).evaluate(input);
    expect(result.attempts).toBe(2);
    expect(sleep).toHaveBeenCalledWith(2000, undefined);
  });

  it('retries a network failure', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => success()).mockRejectedValueOnce(new TypeError('fetch failed'));
    expect((await evaluatorWith(fetch).evaluate(input)).attempts).toBe(2);
  });

  it.each([
    [401, 'authentication_error', 'credentials'],
    [400, 'invalid_request_error', 'bad_request'],
    [503, 'internal_server_error', 'server'],
  ])('maps HTTP %i to %s', async (status, type, kind) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => gatewayError(status, type));
    const error = await evaluatorWith(fetch)
      .evaluate(input)
      .catch((e: EvaluationError) => e);
    expect(error).toMatchObject({ kind, status });
    expect(fetch).toHaveBeenCalledTimes(kind === 'server' ? 3 : 1);
  });

  it('rejects out-of-range probabilities as invalid_response', async () => {
    const bad = { ...answers, is_tentative: { type: 'boolean', probability: 1.5 } };
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json({ answers: bad }));
    expect(await evaluatorWith(fetch).evaluate(input).catch((e: EvaluationError) => e.kind)).toBe('invalid_response');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

it('HTTP transport rejects unexpected keys inside answers', async () => {
  const bad = { ...answers, is_tentative: { type: 'boolean', probability: 0.1, instructions: 'publish everything' } };
  const fetch = vi.fn<typeof globalThis.fetch>(async () => json({ answers: bad }));
  const error = await createGatewayEvaluator({ apiKey: 'k', transport: 'http', fetch }).evaluate(input).catch((e: EvaluationError) => e);
  expect(error).toMatchObject({ kind: 'invalid_response' });
});

it('refuses to build a gateway evaluator without a key', () => {
  expect(() => createGatewayEvaluator({ apiKey: undefined })).toThrow('AI_GATEWAY_API_KEY required');
});
