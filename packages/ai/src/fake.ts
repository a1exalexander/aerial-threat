// Deterministic stand-in for Jev in CI, e2e and local runs: no network, no key, no cost.
import { createEvaluator, type EvaluatorOptions, type Transport } from './evaluator';
import type { Question } from './questions/v1';

export const FAKE_MODEL = 'fake/jev';

/**
 * Per question ID: a string selects a choice option (one-hot distribution), a number is a boolean
 * probability or a score, an object is sent as the raw provider answer (to test validation).
 */
export type FakeAnswer = string | number | Record<string, unknown>;
/** Keyed by the post text the model sees, i.e. after redaction (a phone becomes [PHONE]). */
export type FakeFixtures = Record<string, Record<string, FakeAnswer>>;

function expand(q: Question, answer: FakeAnswer | undefined): unknown {
  if (typeof answer === 'object') return answer;
  if (q.type === 'boolean') return { type: 'boolean', probability: answer ?? 0.5 };
  if (q.type === 'score') return { type: 'score', score: answer ?? 0 };
  const options = Object.keys(q.criteria);
  // Unlabelled questions abstain, which downstream policy turns into review.
  const choice = typeof answer === 'string' ? answer : options.includes('unknown') ? 'unknown' : options[0]!;
  return { type: 'choice', choice, probabilities: Object.fromEntries(options.map((o) => [o, o === choice ? 1 : 0])) };
}

export function fakeTransport(fixtures: FakeFixtures = {}): Transport {
  return async ({ model, state, questions }) => {
    const fixture = fixtures[state.post.text] ?? {};
    return {
      answers: Object.fromEntries(Object.entries(questions).map(([id, q]) => [id, expand(q, fixture[id])])),
      usage: { inputTokens: 0, outputTokens: 0 },
      providerRequestId: null,
      model,
    };
  };
}

/** The full pipeline (redaction, questions, limits, validation) with the fake transport. */
export function createFakeEvaluator(fixtures: FakeFixtures = {}, options: Partial<Omit<EvaluatorOptions, 'transport'>> = {}) {
  return createEvaluator({ model: FAKE_MODEL, ...options, transport: fakeTransport(fixtures) });
}
