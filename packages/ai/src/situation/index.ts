// Situation question set: one Jev call per window of Kremenchuk posts (statuses + a relevance flag per post).
//
// Pure: only type imports reach the AI SDK, so importing this module never loads it (index.test.ts enforces it).
// The gateway-backed evaluator (./gateway) sends `buildSituationRequest(msgs, now)` through the shared transport,
// retry and budget logic of ../evaluator, which validates answers with `toAssessments` before `interpretSituation`.
import type { Assessment, SituationStatus, SituationStatuses } from '@aerial/contracts';
import type { SituationMessage } from '@aerial/domain/situation';
import { EvaluationError } from '../errors';
import type { EvaluationResult } from '../evaluator';
import type { Question } from '../questions/v1';
import { redact } from '../redact';
import * as uk from './instructions/situation-v1.uk';

/** Stored in situation_snapshots.questions_version; covers the questions, instructions and SITUATION_THRESHOLDS. */
export const SITUATION_QUESTIONS_VERSION = 'situation-v1';

/** Answer → confidence mapping. Part of SITUATION_QUESTIONS_VERSION: change a value, bump the version. */
export const SITUATION_THRESHOLDS = {
  /** Boolean: value = p ≥ 0.5; high confidence at p ≥ booleanHigh or p ≤ 1 - booleanHigh. */
  booleanHigh: 0.85,
  /**
   * Choice: high confidence when the top option has ≥ choiceTop and leads the runner-up by ≥ choiceMargin (the margin
   * only bites if choiceTop drops below ~0.6, since validated distributions sum to 1).
   */
  choiceTop: 0.75,
  choiceMargin: 0.2,
  relevant: 0.5,
  /** Evidence for a positive status: relevant posts within 15 min of the newest relevant one, newest first. */
  evidenceWindowMs: 15 * 60_000,
  evidenceMax: 3,
} as const;

const TEXT_MAX = 600;
const REPLY_MAX = 200;

export type SituationResult = { statuses: SituationStatuses; relevantRevisionIds: string[] };
export type SituationEvaluation = SituationResult & Pick<EvaluationResult, 'usage' | 'model' | 'latencyMs' | 'providerRequestId'>;

export interface SituationEvaluator {
  /** A gateway call takes up to ~30 s: never hold a DB transaction across it. */
  evaluate(msgs: SituationMessage[], now: Date, signal?: AbortSignal): Promise<SituationEvaluation>;
}

/** What the model sees. Channel text only here, never in `questions`. */
export type SituationState = {
  now: string;
  area: string;
  posts: { id: string; time: string; minutesAgo: number; source: string; text: string; replyTo: string | null }[];
};

const instructions = (preamble: string, { question, notes = [], counterExamples = [] }: uk.Text) =>
  [preamble, question, ...notes, ...(counterExamples.length ? ['Контрприклади:', ...counterExamples.map((e) => `- ${e}`)] : [])].join('\n');
const booleanQuestion = (text: uk.Text): Question => ({ type: 'boolean', instructions: instructions(uk.PREAMBLE, text) });
const choiceQuestion = (text: uk.Text & { criteria: Record<string, string> }): Question => ({
  type: 'choice',
  instructions: instructions(uk.PREAMBLE, text),
  criteria: text.criteria,
});

const STATUS_QUESTIONS = {
  threat_now: booleanQuestion(uk.threatNow),
  threat_type: choiceQuestion(uk.threatType),
  direction: choiceQuestion(uk.direction),
  quantity: choiceQuestion(uk.quantity),
  forecast: choiceQuestion(uk.forecast),
  explosions: booleanQuestion(uk.explosions),
  air_defense: booleanQuestion(uk.airDefense),
} satisfies Record<string, Question>;

const relevantQuestion = (key: string): Question => ({
  type: 'boolean',
  instructions: instructions(uk.relevant.preamble, { question: uk.relevant.question(key), notes: uk.relevant.notes }),
});

/** Time order, ties by revision ID; `m<k>` keys follow it, so build and interpret must both use this. */
const ordered = (msgs: SituationMessage[]) =>
  [...msgs].sort((a, b) => a.publishedAt.getTime() - b.publishedAt.getTime() || (a.revisionId < b.revisionId ? -1 : a.revisionId > b.revisionId ? 1 : 0));
const questionsFor = (n: number): Record<string, Question> => ({
  ...STATUS_QUESTIONS,
  ...Object.fromEntries(Array.from({ length: n }, (_, i) => [`m${i + 1}_relevant`, relevantQuestion(`m${i + 1}`)])),
});

const kyiv = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Kyiv',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
/** Never cuts a surrogate pair: a lone surrogate can make the gateway reject the whole request. */
const cap = (s: string, max: number) => {
  if (s.length <= max) return s;
  const end = /[\uD800-\uDBFF]/.test(s[max - 2]!) ? max - 2 : max - 1;
  return `${s.slice(0, end)}…`;
};
// Callers redact already; redacting again leaves placeholders alone (though any kept @handle becomes [HANDLE])
// and keeps PII off the wire if a caller forgets.
const clean = (s: string, max: number) => cap(redact(s.trim()).text, max);

/**
 * The request for one window. `questions` are keyed by answer ID (the Transport/SDK shape) and depend only on the
 * number of posts; `messageKeys` maps a post key used in the questions (`m1`, `m2`, ...) to its revision ID.
 */
export function buildSituationRequest(
  msgs: SituationMessage[],
  now: Date = new Date(),
): { state: SituationState; questions: Record<string, Question>; messageKeys: Record<string, string> } {
  const posts = ordered(msgs);
  const today = kyiv.format(now).slice(0, 10);
  return {
    state: {
      now: kyiv.format(now),
      area: uk.AREA,
      posts: posts.map((m, i) => {
        const at = kyiv.format(m.publishedAt);
        return {
          id: `m${i + 1}`,
          time: at.startsWith(today) ? at.slice(11) : at,
          minutesAgo: Math.max(0, Math.round((now.getTime() - m.publishedAt.getTime()) / 60_000)),
          source: m.sourceName,
          text: clean(m.text, TEXT_MAX),
          replyTo: m.replyToText ? clean(m.replyToText, REPLY_MAX) : null,
        };
      }),
    },
    questions: questionsFor(posts.length),
    messageKeys: Object.fromEntries(posts.map((m, i) => [`m${i + 1}`, m.revisionId])),
  };
}

const invalid = (where: string) => new EvaluationError('invalid_response', `AI situation answers failed validation: ${where}`);
const inRange = (p: number) => p >= 0 && p <= 1;
const SUM_TOLERANCE = 0.01; // as toAssessments: providers round distributions

/** Exactly one well-formed answer per asked question. Messages name question IDs we asked, never provider text. */
function validate(assessments: Assessment[], questions: Record<string, Question>): Map<string, Assessment> {
  const answers = new Map<string, Assessment>();
  for (const a of assessments) {
    const q = Object.hasOwn(questions, a.question) ? questions[a.question] : undefined;
    if (!q) throw invalid('unexpected question');
    if (answers.has(a.question) || a.type !== q.type) throw invalid(a.question);
    if (a.type === 'boolean' && !inRange(a.probability)) throw invalid(a.question);
    if (a.type === 'choice' && q.type === 'choice') {
      const offered = (k: string) => Object.hasOwn(q.criteria, k);
      const ps = Object.entries(a.probabilities);
      if (!offered(a.selected) || ps.some(([k, p]) => !offered(k) || !inRange(p))) throw invalid(a.question);
      // An empty distribution is allowed (the SDK makes it optional); a present one must sum to 1 and peak at `selected`.
      const top = Math.max(...ps.map(([, p]) => p));
      const sum = ps.reduce((acc, [, p]) => acc + p, 0);
      if (ps.length && (Math.abs(sum - 1) > SUM_TOLERANCE || (a.probabilities[a.selected] ?? 0) < top - 1e-9)) throw invalid(a.question);
    }
    answers.set(a.question, a);
  }
  if (answers.size !== Object.keys(questions).length) throw invalid('missing answers');
  return answers;
}

/** Validated answers -> statuses (thresholds give high/low confidence) and the relevant revisions. */
export function interpretSituation(assessments: Assessment[], msgs: SituationMessage[]): SituationResult {
  const T = SITUATION_THRESHOLDS;
  const posts = ordered(msgs);
  const answers = validate(assessments, questionsFor(posts.length));
  const probability = (id: string) => (answers.get(id) as Extract<Assessment, { type: 'boolean' }>).probability;

  const relevant = posts.filter((_, i) => probability(`m${i + 1}_relevant`) >= T.relevant);
  const end = relevant.at(-1)?.publishedAt.getTime() ?? 0;
  const evidence = relevant
    .filter((m) => m.publishedAt.getTime() >= end - T.evidenceWindowMs)
    .reverse()
    .slice(0, T.evidenceMax)
    .map((m) => m.revisionId);

  const bool = (id: string): SituationStatus<boolean> => {
    const p = probability(id);
    const value = p >= 0.5;
    return { value, confidence: p >= T.booleanHigh || p <= 1 - T.booleanHigh ? 'high' : 'low', evidenceMessageIds: value ? [...evidence] : [] };
  };
  const pick = <V extends string>(id: string): SituationStatus<V> => {
    const { selected, probabilities } = answers.get(id) as Extract<Assessment, { type: 'choice' }>;
    const top = probabilities[selected];
    const runnerUp = Math.max(0, ...Object.entries(probabilities).flatMap(([k, p]) => (k === selected ? [] : [p])));
    const high = top !== undefined && top >= T.choiceTop && top - runnerUp >= T.choiceMargin;
    // validate() checked `selected` against the criteria, whose keys are exactly V.
    const cited = selected !== 'none' && selected !== 'unknown';
    return { value: selected as V, confidence: high ? 'high' : 'low', evidenceMessageIds: cited ? [...evidence] : [] };
  };

  return {
    statuses: {
      threatNow: bool('threat_now'),
      threatType: pick('threat_type'),
      direction: pick('direction'),
      quantity: pick('quantity'),
      forecast: pick('forecast'),
      explosions: bool('explosions'),
      airDefense: bool('air_defense'),
    },
    relevantRevisionIds: relevant.map((m) => m.revisionId),
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
