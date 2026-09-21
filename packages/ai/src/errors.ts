// SDK-free, so pure modules (e.g. ./situation) can throw the same error type as the evaluator.
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
