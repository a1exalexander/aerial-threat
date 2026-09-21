// Server-only (worker): the Gateway key never leaves this process.
import { createGateway } from '@ai-sdk/gateway';
import { APICallError, experimental_evaluate } from 'ai';
import { z } from 'zod';
import { EvaluationError, createEvaluator, type EvaluatorOptions, type Transport } from './evaluator';

export const DEFAULT_MODEL = 'typesafe-ai/jev';
export const HTTP_EVALUATE_URL = 'https://ai-gateway.vercel.sh/v1/evaluate';

type Fetch = typeof globalThis.fetch;
/** Any JSON state the Evaluation API takes: the per-post object or a situation window. */
export type GatewayState = Parameters<typeof experimental_evaluate>[0]['state'];

const Metadata = z.object({ gateway: z.object({ generationId: z.string() }) });
const requestId = (metadata: unknown, headers?: Record<string, string>) =>
  Metadata.safeParse(metadata).data?.gateway.generationId ?? headers?.['x-vercel-id'] ?? null;

/** AI SDK `experimental_evaluate` through `gateway.evaluationModel()`. Retries are ours, so the SDK's are off. */
export function sdkTransport({ apiKey, fetch }: { apiKey: string; fetch?: Fetch }): Transport<GatewayState> {
  const gateway = createGateway({ apiKey, ...(fetch && { fetch }) });
  return async ({ model, state, questions, signal }) => {
    const result = await experimental_evaluate({
      model: gateway.evaluationModel(model),
      state,
      questions,
      maxRetries: 0,
      abortSignal: signal,
    });
    return {
      answers: result.answers,
      usage: result.usage,
      providerRequestId: requestId(result.providerMetadata, result.response.headers),
      model: result.response.modelId,
    };
  };
}

// Only the envelope is parsed here; answers are validated strictly by the evaluator.
const HttpBody = z.object({
  model: z.string().optional(),
  answers: z.unknown(),
  usage: z.object({ inputTokens: z.number().optional(), outputTokens: z.number().optional() }).optional(),
  providerMetadata: z.unknown().optional(),
});

/** Plain `POST /v1/evaluate` (same model/state/questions fields). Not the TypeSafe-compatible API. */
export function httpTransport({ apiKey, fetch = globalThis.fetch, url = HTTP_EVALUATE_URL }: { apiKey: string; fetch?: Fetch; url?: string }): Transport<GatewayState> {
  return async ({ model, state, questions, signal }) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, state, questions }),
      signal,
    });
    const text = await res.text();
    const headers = Object.fromEntries(res.headers);
    if (!res.ok) {
      // requestBodyValues deliberately omitted: the body holds channel text.
      throw new APICallError({ message: `AI Gateway responded ${res.status}`, url, requestBodyValues: undefined, statusCode: res.status, responseHeaders: headers });
    }
    let body;
    try {
      body = HttpBody.parse(JSON.parse(text));
    } catch {
      throw new EvaluationError('invalid_response', 'AI Gateway returned a malformed body', res.status);
    }
    return {
      answers: body.answers,
      usage: body.usage,
      providerRequestId: requestId(body.providerMetadata, headers),
      model: body.model,
    };
  };
}

export type GatewayEvaluatorOptions = Omit<EvaluatorOptions, 'transport' | 'model'> & {
  apiKey: string | undefined;
  model?: string;
  transport?: 'sdk' | 'http';
  fetch?: Fetch;
};

export function gatewayTransport({ apiKey, transport = 'sdk', fetch }: Pick<GatewayEvaluatorOptions, 'apiKey' | 'transport' | 'fetch'>) {
  // Refuse early: without a key the SDK would silently try Vercel OIDC instead.
  if (!apiKey) throw new EvaluationError('credentials', 'AI_GATEWAY_API_KEY required');
  return transport === 'http' ? httpTransport({ apiKey, fetch }) : sdkTransport({ apiKey, fetch });
}

export function createGatewayEvaluator({ apiKey, model = DEFAULT_MODEL, transport, fetch, ...rest }: GatewayEvaluatorOptions) {
  return createEvaluator({ ...rest, model, transport: gatewayTransport({ apiKey, transport, fetch }) });
}
