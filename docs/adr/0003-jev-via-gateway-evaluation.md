# 0003. Jev through the Vercel AI Gateway Evaluation API

Status: accepted; live quality is still open (see 0007)

## Context

The model is fixed by the user: Jev (`typesafe-ai/jev`) through the Vercel AI Gateway. Jev is an evaluation model. It answers boolean, choice and score questions and does not generate free text or JSON (doc 05). Paid calls must not run in CI, and model instability must not break PRs (doc 09).

## Decision

- Transport: the AI SDK `experimental_evaluate` with the gateway provider. The fallback is HTTP `POST https://ai-gateway.vercel.sh/v1/evaluate`. The TypeSafe API is not mixed in.
- Jev only *evaluates*. Rules produce the candidates (places, numbers, times) with evidence spans. A versioned question set and runtime validation turn the answers into `Assessment`s, and versioned thresholds decide `publish | review | exclude`.
- The key (`AI_GATEWAY_API_KEY`) is available only to the worker. Calls have an 8 s timeout and at most 2 retries on network errors, 429 and 5xx. There is a circuit breaker, a daily request limit, a concurrency cap, and budget warnings at 50, 80 and 100 %.
- **CI uses a fake evaluator** with fixture answers. `eval-live` is an explicit opt-in command that refuses to run without a key and records model, question, parser and policy versions with usage.
- Results are keyed by revision, context hash and all versions, so they are reproducible. A result that arrives for a stale revision is stored for audit but never published.

## Consequences

- There is no automatic fallback to a chat model. If Jev is degraded, jobs wait and the UI shows the gap.
- The quality and cost claims stay unproven until labelled evaluation and shadow mode run with a real key (0007).
