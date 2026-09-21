# @aerial/ai

Jev (`typesafe-ai/jev`) adapter over Vercel AI Gateway. Server-only: the worker owns the Gateway key.

## Transports

- `sdk` (default): AI SDK `experimental_evaluate` with `createGateway({ apiKey }).evaluationModel(model)`. Both exist in the pinned `ai@7.0.107` / `@ai-sdk/gateway@4.0.87`. The SDK's own retries are off (`maxRetries: 0`), because this package does its own.
- `http`: plain `POST https://ai-gateway.vercel.sh/v1/evaluate` with `model`, `state` and `questions`. This is not the TypeSafe-compatible API (`/typesafe/v1/systemone`), whose field names are different.

Both transports end up as `@aerial/contracts` `Assessment[]`. Answers go through strict validation: one answer per question, no extra keys, probabilities in [0, 1] that sum to 1, and choices from the offered options only. Anything else throws `invalid_response`.

## Using `Evaluator.evaluate({ state, questions, context })`

- **Never hold a DB transaction during the call.** With retries it can take about 30 s. Read the inputs and commit. Then evaluate. Then apply the result in a new transaction, after you check that the revision is still current.
- Store `model`, `QUESTIONS_VERSION`, `usage`, `providerRequestId` and `latencyMs` in `processing_runs`. If `attempts > 1`, the earlier attempts may have been billed too.
- Channel text travels only inside `state`, after redaction: phones, cards, IBANs, emails and @handles (the post's own channel handle is kept). Instructions and criteria hold only the trusted text from `instructions/v1.uk.ts`, plus candidate IDs and dictionary names.
- `EvaluationError.kind` tells the caller what to do:
  - `circuit_open` and `rate_limited`: reschedule the job after `retryAfterMs`.
  - `budget_exhausted`: reschedule the job for the next UTC day.
  - `credentials`: alert an operator.
  - `invalid_response` and `bad_request`: fail the job. The UI never sees them.
- A probability answers the question as it was asked. It is not the probability of real danger. The AI never changes alert state.

Reliability settings and their defaults:

| Setting | Default |
| --- | --- |
| Timeout per attempt | 8 s |
| Retries (network/429/5xx only) | 2, with exponential backoff and jitter |
| `Retry-After` | honoured; a wait over 30 s fails fast |
| 400/401/403 | never retried |
| Circuit breaker | opens after 5 straight failures; one half-open probe after 30 s |
| Daily request limit (UTC day) | set by the caller; `budget_warning` events fire at 50, 80 and 100 % |
| `maxRequests` | optional hard cap that never resets (used by `eval-live --budget`) |
| Concurrency cap | set by the caller |

The limit and breaker counters live in each process.

## CI and e2e

`createFakeEvaluator(fixtures)` runs the full pipeline with a deterministic transport. Fixtures are keyed by the redacted post text. A string answer picks a choice, a number sets a boolean probability, and an object is sent unchanged as the raw answer. Questions with no fixture answer `unknown` (or 0.5 for a boolean).

## Offline evaluation

`pnpm --filter @aerial/worker cli eval-live --dataset <labels.json> --budget <n>` needs `AI_GATEWAY_API_KEY`, and every call it makes is billed. The dataset follows the `LabeledDataset` schema in `src/metrics.ts`. The report records numerator, denominator and Wilson 95 % CI for each doc 09 metric. It never contains message text.
