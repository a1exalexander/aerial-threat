// Situation question set: one Jev call per window of Kremenchuk posts (statuses + a relevance flag per post).
// Placeholder bodies; implemented by unit 4.
//
// Pure: only type imports reach the AI SDK, so importing this module never loads it.
// Evaluator shape: a small SituationEvaluator (window in, statuses out). The per-post `Evaluator` of
// ../evaluator does not fit: it takes one post plus context and builds its own question set. A gateway-backed
// SituationEvaluator sends `buildSituationRequest(msgs)` through a `Transport` (../gateway) and validates the
// answers with `toAssessments` before `interpretSituation`.
import type { Assessment, SituationStatuses } from '@aerial/contracts';
import type { SituationMessage } from '@aerial/domain/situation';
import type { EvaluationResult } from '../evaluator';
import type { Question } from '../questions/v1';

/** Stored in situation_snapshots.questions_version; part of what makes two evaluations comparable. */
export const SITUATION_QUESTIONS_VERSION = 'situation-v0';

export type SituationResult = { statuses: SituationStatuses; relevantRevisionIds: string[] };
export type SituationEvaluation = SituationResult & Pick<EvaluationResult, 'usage' | 'model' | 'latencyMs' | 'providerRequestId'>;

export interface SituationEvaluator {
  /** A gateway call takes up to ~30 s: never hold a DB transaction across it. */
  evaluate(msgs: SituationMessage[], now: Date, signal?: AbortSignal): Promise<SituationEvaluation>;
}

/**
 * The request for one window. `questions` are keyed by answer ID (the Transport/SDK shape); `messageKeys` maps a
 * post key used in the questions (`m1`, `m2`, ...) to its revision ID.
 */
export function buildSituationRequest(msgs: SituationMessage[]): {
  state: string;
  questions: Record<string, Question>;
  messageKeys: Record<string, string>;
} {
  return { state: '', questions: {}, messageKeys: Object.fromEntries(msgs.map((m, i) => [`m${i + 1}`, m.revisionId])) };
}

const low = <T>(value: T) => ({ value, confidence: 'low' as const, evidenceMessageIds: [] });

/** Validated answers -> statuses (thresholds give high/low confidence) and the relevant revisions. */
export function interpretSituation(_assessments: Assessment[], msgs: SituationMessage[]): SituationResult {
  return {
    statuses: {
      threatNow: low(false),
      threatType: low('unknown'),
      direction: low('unknown'),
      quantity: low('unknown'),
      forecast: low('none'),
      explosions: low(false),
      airDefense: low(false),
    },
    relevantRevisionIds: msgs.map((m) => m.revisionId),
  };
}

export const FAKE_SITUATION_MODEL = 'fake/situation-rules';

/** Local/CI stand-in: the given rules (e.g. rulesSituation from @aerial/domain/situation), no network, no cost. */
export function createFakeSituationEvaluator(rules: (msgs: SituationMessage[], now: Date) => SituationResult): SituationEvaluator {
  return {
    evaluate: async (msgs, now) => ({
      ...rules(msgs, now),
      usage: { inputTokens: 0, outputTokens: 0 },
      model: FAKE_SITUATION_MODEL,
      latencyMs: 0,
      providerRequestId: null,
    }),
  };
}
