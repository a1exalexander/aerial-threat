# @aerial/neptun

This package is the adapter for NEPTUN official air-raid alerts (https://neptun.in.ua/developers). It holds the runtime contract (`parseAlerts`, `StreamEnvelope`) and a connector (`runNeptunConnector`). The connector sends validated, ordered events to a single serial handler. Storage lives in `@aerial/db/repos/alerts`. The wiring lives in `apps/worker/src/loops/neptun.ts`.

Attribution is required by the NEPTUN terms. Wherever alert data is shown, add a visible link: `Дані: Карта повітряних тривог — NEPTUN` → https://neptun.in.ua/. NEPTUN is an aggregator, not an official warning system.

## Contract, verified live on 2026-09-21

**REST `GET /api/v1/alerts`** (`fixtures/alerts-rest.json`, a trimmed real payload)

- The body is `{version, updatedAt, raions: [...], oblasts: [...]}`. Each entry is `{key, name, oblast, since, level, reasons?}`, where `level` is `red` or `yellow`, and `reasons` (optional) is an array of Ukrainian strings.
- The lists hold **only the areas under alert**. An absent area is not under alert. So every valid payload is a complete set, and an empty pair of lists is a valid "nothing active" answer.
- `updatedAt` is the time of the provider's **last change**, not the fetch time. It has nanosecond precision, which JS truncates to ms. `version` is `updatedAt` in unix seconds, so it is monotonic.
- `raions[].key` values are lowercase adjectives (`кременчуцький`). Keys use an ASCII apostrophe (`куп'янський`), while `name` uses U+2019. `oblasts[]` carries whole-oblast alerts only; today these are the occupied oblasts: Крим, Луганська, Севастополь. Other oblasts appear only through their raions.
- The response headers are `cache-control: public, max-age=5, stale-while-revalidate=25` and `cf-cache-status: DYNAMIC`.

**WebSocket `wss://neptun.in.ua/api/v1/stream`** (`fixtures/stream-frames.json`; threat content is synthetic)

- Every frame is an envelope `{type, ts, data?}`. `ts` is the server send time.
- On connect the server sends `snapshot` (threat tracks), then `alerts`. The `alerts.data` is **deep-equal to the REST body**, so it is the full set.
- After that, `alerts` arrives **only when something changes**, and it is again the full set, not a delta. On an unchanged state the stream sends no alert frames at all.
- `heartbeat` arrives every 15 s as `{type, ts}` with no data. `upsert` and `remove` are threat tracks and are ignored (the threats layer is post-MVP).
- There is no sequence or resume token, so each reconnect starts from full state.

## Adapter rules

| Rule | Implementation |
| --- | --- |
| REST ≤ once per 5 s | One request in flight, shared by concurrent triggers. Request starts are ≥ `REST_MIN_INTERVAL_MS` apart. |
| Snapshot on start and on reconnect | REST runs on start and on every stream open. The stream's own first `alerts` frame also counts. |
| Polling fallback / control snapshot | Every 10 s ± 2 s, a REST poll runs if no alert set was confirmed in the last 10 s. This is needed because the stream is silent on unchanged state and heartbeats prove nothing about alerts. |
| Stream health | Reconnects use backoff from 1 s to 60 s with jitter. If there is no frame for 45 s (three missed heartbeats), the connector forces a reconnect. |
| Serial apply, no rollback | All events pass through one chain. `isOutOfOrder` compares provider `updatedAt` when both snapshots have one: a slow older REST loses to a newer WS frame, while a slow REST that saw a newer change still wins. Without provider times, observation order decides (REST is observed at request start). |
| Failures never clear | Timeout (8 s), 429, 5xx, other HTTP errors, invalid JSON, a missing list or an entry without `key` each become a `failure` event. Only a `snapshot` event (a valid, complete set) can write `inactive`. |
| Schema drift | Only `key` and both arrays are required. An unknown `level` becomes `unknown` plus a diagnostic. A bad `since`/`updatedAt` becomes `null` plus a diagnostic. Unexpected fields produce a diagnostic. The stream keeps going, and an unknown event type is logged once. |

## Storage (`@aerial/db/repos/alerts`)

- **`alert_snapshots`**: the payload exactly as received (the REST body, or the WS `alerts` data). This includes invalid payloads, stored with `valid=false` and `error`. Identical consecutive payloads share one row.
- **`alert_states`**:
  - It has one row per NEPTUN key. That covers every key in the geo dictionary (Полтавська, its 4 raions and the neighbouring oblasts), even when inactive, plus every key ever seen.
  - Keys outside the dictionary are kept with `place_id = null` and logged once. They are never dropped.
  - An oblast row reflects **oblast-wide** alerts only; a raion alert does not make its oblast row active, so readers should combine the children. An oblast-wide alert makes that oblast's dictionary raions active.
- **Freshness**:
  - A row is `fresh` while `last_success_at` (the last accepted set) is under 30 s old, and `stale` after 30 s, keeping the last state.
  - After 120 s both `freshness` and `state` become `unknown`. The state is never set to `inactive` here. The last known set is still reachable through `snapshot_id`.
  - The worker ages rows every 5 s. If the worker is down, rows are not aged, so readers should also check `last_success_at` against `ALERT_STALE_AFTER_MS` and `ALERT_UNKNOWN_AFTER_MS`.
- **`source_health`**: the source is `sources(provider='neptun', external_id='alerts')`.
  - `last_success_at` is when the last alert set was accepted (data freshness).
  - `last_message_at` is the last stream frame (transport health only).
  - `error_kind` is the last failure. The next success clears it.

## Known limits

- Run **one** connector per deployment. There is no lease yet, so two workers would both poll NEPTUN and both write states. Add an advisory lock if the worker is scaled out.
- The ordering guard lives in memory. After a restart, the first full set is trusted.
- A `429` is not backed off beyond the normal 10 s poll, which still respects the 5 s limit. Honour `Retry-After` if NEPTUN starts sending it.
