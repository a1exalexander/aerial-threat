import type { GatewayEvaluatorOptions } from '../gateway';
import type { SituationEvaluator } from './index';

// Implemented by unit 4 (AI situation question set). Separate subpath so importers of
// '@aerial/ai/situation' never load the AI SDK.
export type GatewaySituationEvaluatorOptions = GatewayEvaluatorOptions;

/** Real Jev situation evaluator (one call per window). Stub: throws until unit 4 lands. */
export function createGatewaySituationEvaluator(_opts: GatewaySituationEvaluatorOptions): SituationEvaluator {
  throw new Error('createGatewaySituationEvaluator not implemented yet (unit 4)');
}
