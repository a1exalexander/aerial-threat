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
| Polling fallback / control snapshot | A REST poll runs every 10 s ± 2 s unless an alert set was confirmed within the last 8 s. It is needed because the stream is silent on unchanged state and heartbeats prove nothing about alerts. In practice this means one REST call every 8–12 s. |
| Stream health | Reconnects back off from 1 s up to a 60 s cap, with jitter. If no frame arrives for 45 s (three missed heartbeats), the connector forces a reconnect. A socket `error` also ends the connection: on a refused connection, Node 22's WebSocket fires `error` but never `close`. |
| Serial apply, no rollback | All events pass through one chain. When provider `updatedAt` values differ, `isOutOfOrder` uses them: a slow, older REST response loses to a newer WS frame, but a slow REST that saw a newer change still wins. When they are equal or missing, observation order decides; REST counts as observed at request start. Nothing ever rolls the state back to an older `updatedAt`. A failure from a request that started before the applied set is dropped. |
| Failures never clear | Each of these becomes a `failure` event: a timeout (5 s), 429, 5xx, any other HTTP error, invalid JSON, a missing list, or an entry without `key`. Only a `snapshot` event, meaning a valid and complete set, can write `inactive`. A stream frame that cannot be classified (not JSON, no envelope) could be a threat track, so it is only logged. |
| Schema drift | Only `key` and both arrays are required. Keys are normalised to NFC, lower case and an ASCII apostrophe before matching the dictionary, because a missed key would read as "no alert". An unknown `level` becomes `unknown` plus a diagnostic. A bad `since` or `updatedAt` becomes `null` plus a diagnostic. Unexpected fields also produce a diagnostic. The stream keeps going, and an unknown event type is logged once. |

## Storage (`@aerial/db/repos/alerts`)

- **`alert_snapshots`**: the payload as received (the REST body, or the WS `alerts` data). Invalid payloads are stored too, with `valid=false` and `error`. Identical consecutive payloads share one row. jsonb rejects NUL and lone surrogates, so those are stored as U+FFFD.
- **`alert_states`**:
  - It has one row per NEPTUN key. That covers every key in the geo dictionary (Полтавська, its 4 raions and the neighbouring oblasts), even when inactive, plus every key ever seen.
  - Keys outside the dictionary are kept with `place_id = null` and logged once. They are never dropped.
  - Territory rules apply to dictionary places only:
    - An oblast-wide alert covers that oblast's raions, taking the higher level and the earliest `since`.
    - A dictionary oblast is `active` while any of its raions is under alert. The raion is matched by the entry's `oblast` name or by the dictionary parent. So an oblast row never reads "no alert" while part of the oblast is alerted; the children show which part.
    - A partial oblast alert never spreads down to the other raions.
  - `last_provider_change_at` moves only when the provider's state, level or `since` changes. It does not move when we mark a row `unknown` or recover from `unknown`.
- **Freshness**:
  - A row is `fresh` while `last_success_at` (the last accepted set) is under 30 s old, and `stale` after 30 s, keeping the last state.
  - After 120 s both `freshness` and `state` become `unknown`. The state is never set to `inactive` here. The last known set is still reachable through `snapshot_id`.
  - The worker ages rows every 5 s. If the worker is down, rows are not aged, so readers should also check `last_success_at` against `ALERT_STALE_AFTER_MS` and `ALERT_UNKNOWN_AFTER_MS`.
- **`source_health`**: the source is `sources(provider='neptun', external_id='alerts')`.
  - `last_success_at` is when the last alert set was accepted (data freshness).
  - `last_message_at` is the last heartbeat or `alerts` frame (transport health only).
  - `error_kind` is the last failure. The next success clears it.

## Known limits

- Run **one** connector per deployment. There is no lease yet, so two workers would both poll NEPTUN and both write states. Add an advisory lock if the worker is scaled out.
- The ordering guard lives in memory. After a restart, the first full set is trusted.
- If NEPTUN's `updatedAt` ever goes backwards for good, every older set is dropped. States then go stale and later unknown, but never falsely clear, until a newer `updatedAt` arrives or the worker restarts. Watch for repeated `dropped out-of-order snapshot` logs.
- A `429` is not backed off beyond the normal 10 s poll, which still respects the 5 s limit. Honour `Retry-After` if NEPTUN starts sending it.
