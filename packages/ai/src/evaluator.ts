import { createHash } from 'node:crypto';
import { APICallError, InvalidResponseDataError, JSONParseError, TypeValidationError } from 'ai';
import { Probability, type Assessment } from '@aerial/contracts';
import { z } from 'zod';
import { QUESTIONS_VERSION, buildQuestions, type Question, type QuestionSelection } from './questions/v1';
import { redact } from './redact';

export type Post = { text: string; publishedAt: string };
/** A rule-extracted place: dictionary ID and name, plus its literal span in `state.text`. */
export type PlaceCandidate = { id: string; name: string; start: number; end: number };
/** A pre-selected incident with our template summary (built from claims, so it is redacted too). */
export type RelationCandidate = { id: string; summary: string };

export type EvaluationInput = {
  /** The post under evaluation. `text` is the revision's normalizedText; candidate spans index into it. */
  state: { text: string; publishedAt: string; channel: string };
  questions: Omit<QuestionSelection, 'placeCandidates' | 'relationCandidates'> & {
    placeCandidates?: readonly PlaceCandidate[];
    relationCandidates?: readonly RelationCandidate[];
  };
  /** Bounded context chosen by the caller (doc 05): reply parent, ≤5 earlier posts, never future ones. */
  context?: { replyParent?: Post | null; recent?: readonly Post[]; truncated?: boolean };
  signal?: AbortSignal;
};

export type EvaluationResult = {
  assessments: Assessment[];
  usage: { inputTokens: number | null; outputTokens: number | null };
  providerRequestId: string | null;
  /** Wall time of the whole call, retries and backoff included. */
  latencyMs: number;
  model: string;
  /** Provider requests made. More than 1 means earlier attempts may have been billed too. */
  attempts: number;
};

export interface Evaluator {
  readonly model: string;
  /**
   * One Jev evaluation. Makes network calls for up to ~30 s: never call it while holding a DB
   * transaction — read inputs, commit, evaluate, then apply the result in a new transaction after
   * checking the revision is still current.
   */
  evaluate(input: EvaluationInput): Promise<EvaluationResult>;
}

/** What a transport sends: channel text only inside `state`, trusted text only inside `questions`. */
export type EvaluationState = ReturnType<typeof buildRequest>['state'];
export type TransportRequest = {
  model: string;
  state: EvaluationState;
  questions: Record<string, Question>;
  signal: AbortSignal;
};
export type TransportResult = {
  /** Unvalidated provider answers; the evaluator checks them against the questions. */
  answers: unknown;
  usage?: { inputTokens?: number; outputTokens?: number };
  providerRequestId?: string | null;
  model?: string;
};
export type Transport = (req: TransportRequest) => Promise<TransportResult>;

export type ErrorKind =
  | 'credentials' // 401/403: needs an operator, never retried
  | 'bad_request' // other 4xx: fix the request, never retried
  | 'rate_limited'
  | 'server'
  | 'network'
  | 'timeout'
  | 'invalid_response' // unexpected keys, bad probabilities: fails the job (queue retry), never reaches UI
  | 'circuit_open' // no request made
  | 'budget_exhausted' // no request made
  | 'aborted';
const TRANSIENT: ReadonlySet<ErrorKind> = new Set(['rate_limited', 'server', 'network', 'timeout']);

/** Carries no provider payload or request body, so it is safe to log. */
export class EvaluationError extends Error {
  override name = 'EvaluationError';
  attempts = 0;
  constructor(
    readonly kind: ErrorKind,
    message: string,
    readonly status?: number,
    /** Provider Retry-After, or the circuit cooldown left: when to reschedule the job. */
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

export type AiEvent =
  | { type: 'budget_warning'; percent: 50 | 80 | 100; used: number; limit: number }
  | { type: 'circuit'; state: 'open' | 'half_open' | 'closed' }
  | { type: 'credentials_error'; status: number };

export type EvaluatorOptions = {
  transport: Transport;
  model: string;
  timeoutMs?: number;
  maxRetries?: number;
  /** A longer backoff or Retry-After fails fast instead of sleeping in the worker. */
  maxRetryDelayMs?: number;
  /** Requests per UTC day; budget warnings are relative to it. */
  dailyRequestLimit?: number;
  /** Lifetime cap that never resets, e.g. the budget of one eval run. */
  maxRequests?: number;
  concurrency?: number;
  /** Consecutive failed attempts that open the circuit. */
  breakerThreshold?: number;
  /** How long the circuit stays open before a single half-open probe. */
  breakerCooldownMs?: number;
  onEvent?: (event: AiEvent) => void;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
};

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(timer), reject(signal.reason)), { once: true });
  });

function buildRequest({ state, questions, context = {} }: EvaluationInput) {
  const keepHandles = [state.channel];
  const post = redact(state.text, { keepHandles });
  const clean = (p: Post) => ({ text: redact(p.text, { keepHandles }).text, publishedAt: p.publishedAt });
  return {
    questions: buildQuestions(questions),
    state: {
      post: { text: post.text, publishedAt: state.publishedAt, channel: state.channel },
      replyParent: context.replyParent ? clean(context.replyParent) : null,
      recentPosts: (context.recent ?? []).map(clean),
      contextTruncated: context.truncated ?? false,
      placeCandidates: (questions.placeCandidates ?? []).map((c) => {
        const span = post.toRedacted(c);
        return { id: c.id, name: c.name, mention: post.text.slice(span.start, span.end) };
      }),
      relationCandidates: (questions.relationCandidates ?? []).map((c) => ({ id: c.id, summary: redact(c.summary).text })),
    },
  };
}

const SUM_TOLERANCE = 0.01; // providers round distributions

function answerSchema(q: Question): z.ZodType {
  if (q.type === 'boolean') return z.strictObject({ type: z.literal('boolean'), probability: Probability });
  const keys = q.type === 'choice' ? Object.keys(q.criteria) : q.criteria.map((_, i) => String(i));
  const distribution = z
    .record(z.enum(keys as [string, ...string[]]), Probability)
    .refine((p) => Math.abs(Object.values(p).reduce((a, b) => a + b, 0) - 1) <= SUM_TOLERANCE, 'probabilities must sum to 1');
  if (q.type === 'score') {
    return z.strictObject({ type: z.literal('score'), score: z.number().min(0).max(keys.length - 1), probabilities: distribution.optional() });
  }
  return z
    .strictObject({ type: z.literal('choice'), choice: z.enum(keys as [string, ...string[]]), probabilities: distribution.optional() })
    .refine(
      ({ choice, probabilities: p }) => !p || p[choice]! >= Math.max(...Object.values(p)) - 1e-9,
      'choice must be the most probable option',
    );
}

/**
 * Validates provider answers against the asked questions: exactly one answer per question, no
 * extra keys, probabilities in [0, 1] summing to 1, choices among the offered options.
 */
export function toAssessments(questions: Record<string, Question>, answers: unknown): Assessment[] {
  const schema = z.strictObject(Object.fromEntries(Object.entries(questions).map(([id, q]) => [id, answerSchema(q)])));
  const parsed = schema.safeParse(answers);
  if (!parsed.success) {
    // Paths only: never echo provider output or channel text into errors/logs.
    const where = parsed.error.issues.map((i) => i.path.join('.') || '(root)').join(', ');
    throw new EvaluationError('invalid_response', `AI response failed validation at ${where}`);
  }
  return Object.entries(parsed.data as Record<string, { type: string; [k: string]: unknown }>).map(([question, a]): Assessment => {
    if (a.type === 'boolean') return { type: 'boolean', question, probability: a.probability as number };
    if (a.type === 'choice') {
      // Distributions are optional in the SDK contract; an empty one reads as "not confident" downstream.
      return { type: 'choice', question, selected: a.choice as string, probabilities: (a.probabilities ?? {}) as Record<string, number> };
    }
    return { type: 'score', question, score: a.score as number };
  });
}

function retryAfterMs(value: string | undefined, now: number): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

function classify(error: unknown, abortedBy: 'caller' | 'timeout' | null, now: number): EvaluationError {
  if (error instanceof EvaluationError) return error;
  if (abortedBy === 'caller') return new EvaluationError('aborted', 'AI evaluation aborted by caller');
  if (abortedBy === 'timeout') return new EvaluationError('timeout', 'AI evaluation timed out');
  if (InvalidResponseDataError.isInstance(error) || TypeValidationError.isInstance(error) || JSONParseError.isInstance(error)) {
    return new EvaluationError('invalid_response', 'AI response failed validation');
  }
  // SDK errors wrap the HTTP-level APICallError (status, headers) in GatewayError causes.
  let api: APICallError | undefined;
  for (let c: unknown = error, depth = 0; c && !api && depth < 5; c = (c as { cause?: unknown }).cause, depth++) {
    if (APICallError.isInstance(c)) api = c;
  }
  const outer = (error as { statusCode?: unknown } | null)?.statusCode;
  const status = api ? api.statusCode : typeof outer === 'number' ? outer : undefined;
  if (status === undefined) return new EvaluationError('network', 'AI Gateway unreachable');
  const kind: ErrorKind =
    status < 400
      ? 'invalid_response'
      : status === 401 || status === 403
        ? 'credentials'
        : status === 408
          ? 'timeout'
          : status === 429
            ? 'rate_limited'
            : status >= 500
              ? 'server'
              : 'bad_request';
  return new EvaluationError(kind, `AI Gateway responded ${status}`, status, retryAfterMs(api?.responseHeaders?.['retry-after'], now));
}

export function createEvaluator(options: EvaluatorOptions): Evaluator {
  const {
    transport,
    model,
    timeoutMs = 8_000,
    maxRetries = 2,
    maxRetryDelayMs = 30_000,
    dailyRequestLimit = Infinity,
    maxRequests = Infinity,
    concurrency = Infinity,
    breakerThreshold = 5,
    breakerCooldownMs = 30_000,
    onEvent = () => {},
    now = Date.now,
    sleep = defaultSleep,
    random = Math.random,
  } = options;

  // ponytail: per-process counters; with several worker processes the daily limit applies per process.
  // Seed from processing_runs (or move to a DB counter) if we scale out or restart often.
  let day = '';
  let used = 0;
  let warned = 0;
  let total = 0;
  const checkBudget = () => {
    const today = new Date(now()).toISOString().slice(0, 10); // UTC day
    if (today !== day) [day, used, warned] = [today, 0, 0];
    if (used >= dailyRequestLimit) throw new EvaluationError('budget_exhausted', `daily AI request limit (${dailyRequestLimit}) reached`);
    if (total >= maxRequests) throw new EvaluationError('budget_exhausted', `AI request cap (${maxRequests}) reached`);
  };
  const countRequest = () => {
    used++; // counted before the call, so in-flight requests are inside the limit
    total++;
    for (const percent of [50, 80, 100] as const) {
      if (percent > warned && used >= (dailyRequestLimit * percent) / 100) {
        warned = percent;
        onEvent({ type: 'budget_warning', percent, used, limit: dailyRequestLimit });
      }
    }
  };

  let failures = 0;
  let openedAt: number | null = null;
  let probing = false;
  /** Returns true when this attempt is the half-open probe. */
  const enterBreaker = (): boolean => {
    if (openedAt === null) return false;
    const wait = openedAt + breakerCooldownMs - now();
    if (probing || wait > 0) throw new EvaluationError('circuit_open', 'AI circuit breaker is open', undefined, Math.max(wait, 1000));
    probing = true;
    onEvent({ type: 'circuit', state: 'half_open' });
    return true;
  };
  const exitBreaker = (probe: boolean, failed: boolean) => {
    if (probe) probing = false;
    if (!failed) {
      failures = 0;
      if (openedAt !== null) {
        openedAt = null;
        onEvent({ type: 'circuit', state: 'closed' });
      }
      return;
    }
    failures++;
    if (probe || (openedAt === null && failures >= breakerThreshold)) {
      openedAt = now();
      onEvent({ type: 'circuit', state: 'open' });
    }
  };

  let active = 0;
  const waiting: (() => void)[] = [];
  const acquire = () => (active < concurrency ? (active++, Promise.resolve()) : new Promise<void>((r) => waiting.push(r)));
  const release = () => {
    const next = waiting.shift();
    if (next) next(); // hand the slot over without freeing it
    else active--;
  };

  async function attemptOnce(
    req: Omit<TransportRequest, 'signal'>,
    signal: AbortSignal | undefined,
    calls: { count: number },
  ): Promise<TransportResult> {
    await acquire();
    try {
      checkBudget();
      const probe = enterBreaker();
      countRequest();
      calls.count++;
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(), timeoutMs);
      try {
        const result = await transport({ ...req, signal: signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal });
        exitBreaker(probe, false);
        return result;
      } catch (e) {
        const error = classify(e, signal?.aborted ? 'caller' : timeout.signal.aborted ? 'timeout' : null, now());
        // Only an unreachable/unhealthy or unauthorised gateway counts against the circuit.
        exitBreaker(probe, TRANSIENT.has(error.kind) || error.kind === 'credentials');
        if (error.kind === 'credentials') onEvent({ type: 'credentials_error', status: error.status ?? 0 });
        throw error;
      } finally {
        clearTimeout(timer);
      }
    } finally {
      release();
    }
  }

  return {
    model,
    async evaluate(input) {
      const { state, questions } = buildRequest(input);
      const started = now();
      const calls = { count: 0 };
      const withAttempts = (e: unknown) => Object.assign(e as EvaluationError, { attempts: calls.count });
      for (let attempt = 1; ; attempt++) {
        let result: TransportResult;
        try {
          result = await attemptOnce({ model, state, questions }, input.signal, calls);
        } catch (e) {
          const error = withAttempts(e);
          const delay = error.retryAfterMs ?? 1000 * 2 ** (attempt - 1) * (0.5 + random() / 2);
          if (!TRANSIENT.has(error.kind) || attempt > maxRetries || delay > maxRetryDelayMs) throw error;
          await sleep(delay, input.signal).catch(() => {
            throw withAttempts(new EvaluationError('aborted', 'AI evaluation aborted by caller'));
          });
          continue;
        }
        let assessments: Assessment[];
        try {
          assessments = toAssessments(questions, result.answers);
        } catch (e) {
          throw withAttempts(e);
        }
        return {
          assessments,
          usage: { inputTokens: result.usage?.inputTokens ?? null, outputTokens: result.usage?.outputTokens ?? null },
          providerRequestId: result.providerRequestId ?? null,
          latencyMs: now() - started,
          model: result.model ?? model,
          attempts: calls.count,
        };
      }
    },
  };
}

/**
 * Result cache key (doc 05): the same text in another channel, context window or candidate set is a
 * different decision. `contextHash` must cover the source ID and the context posts/window.
 */
export function cacheKey(p: {
  textHash: string;
  contextHash: string;
  candidateIds: readonly string[];
  parserVersion: string;
  policyVersion: string;
  model: string;
  questionsVersion?: string;
}): string {
  const parts = [
    'ai-cache-v1',
    p.textHash,
    p.contextHash,
    [...new Set(p.candidateIds)].sort(),
    p.questionsVersion ?? QUESTIONS_VERSION,
    p.parserVersion,
    p.model,
    p.policyVersion,
  ];
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}
