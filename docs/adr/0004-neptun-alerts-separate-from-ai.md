# 0004. NEPTUN alert state is separate from AI output

Status: accepted (2026-09-21)

## Context

Official air-raid alert state comes from NEPTUN (REST `/api/v1/alerts` and WS `/api/v1/stream`). Telegram posts often claim "clear" or "threat over". Mixing the two would let a model or a channel post cancel an alert (docs 01 and 04).

## Decision

- `alert_snapshots` and `alert_states` are written **only** by the NEPTUN adapter loop. Nothing in the AI or aggregation pipeline writes there, and `clear_claim` never changes alert state.
- Provider failure never produces "inactive". States go `stale` after 30 s without a successful fetch and `unknown` after 120 s, and the last known state stays visible. Recovery takes a full snapshot. An older REST snapshot never overwrites a newer WS update.
- The UI labels the source ("Стан тривоги за даними NEPTUN"), shows freshness and the required NEPTUN attribution, and presents Telegram claims separately.

## Consequences

- The alert flow keeps working during Gateway outages or queue backlogs (see the runbooks).
- The product has two parallel truths: the provider's alert state and channel claims. The UI must keep them visibly apart, and an empty feed must never read as "safe".
