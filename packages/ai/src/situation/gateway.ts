// Separate subpath so importers of '@aerial/ai/situation' never load the AI SDK.
import { createEvaluationCall } from '../evaluator';
import { DEFAULT_MODEL, gatewayTransport, type GatewayEvaluatorOptions } from '../gateway';
import { buildSituationRequest, interpretSituation, type SituationEvaluator } from './index';

export type GatewaySituationEvaluatorOptions = GatewayEvaluatorOptions;

/**
 * Real Jev situation evaluator: one Evaluation API call per window, with the per-post evaluator's timeout, retries,
 * Retry-After, circuit breaker, daily limit and concurrency cap (its own counters). Refuses without an API key.
 */
export function createGatewaySituationEvaluator({
  apiKey,
  model = DEFAULT_MODEL,
  transport,
  fetch,
  ...rest
}: GatewaySituationEvaluatorOptions): SituationEvaluator {
  const call = createEvaluationCall({ ...rest, model, transport: gatewayTransport({ apiKey, transport, fetch }) });
  return {
    async evaluate(msgs, now, signal) {
      const window = [...msgs]; // the caller's array may change during the call; m<k> keys must stay stable
      const { state, questions } = buildSituationRequest(window, now);
      const { assessments, usage, model, latencyMs, providerRequestId } = await call({ state, questions, signal });
      return { ...interpretSituation(assessments, window), usage, model, latencyMs, providerRequestId };
    },
  };
}
