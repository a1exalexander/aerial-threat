# 0007. Open items from stage 0

Status: open. Each item needs an owner decision before the pilot (doc 10, stages 0, 8 and 9).

The code has hooks for every item below, but none of them can be settled in code. Until an item is decided, the default in its right-hand column applies.

| Item | Why it is open | Default until decided |
| --- | --- | --- |
| **Unread ChatGPT conversation** (the shared link from the brief) | It failed to open twice, and the plan attributes no requirements to it (doc 00). | Scope follows `Plans/` only. Reconcile once the text is available and record any differences as a new ADR. |
| **Budget** | There is no agreed monthly amount (doc 08). The lines to price are API/worker compute, PostgreSQL with backup and PITR, the Gateway (Jev), the tile provider, logs and metrics, and traffic. | `AI_DAILY_REQUEST_LIMIT=1000`, `AI_CONCURRENCY=2`, and budget warnings at 50, 80 and 100 % of whatever amount is agreed. |
| **Jev pricing after the promo** | Free use was announced until **25.09.2026**, and permanent free use is not assumed (docs 00 and 05). | Re-price with `requests ≈ messages × AI share × calls × retries × 30` (doc 05), using usage measured by `eval-live`. The promo is not a production budget. |
| **Hosting for persistent processes** | The worker holds Telegram and NEPTUN connections, so serverless does not fit. | A container host running `docker-compose.prod.yml`, or the same images on any container platform. The web app goes to a static CDN. Postgres is managed, with daily backup and PITR (targets RPO ≤ 15 min, RTO ≤ 2 h; record the real numbers). |
| **Tile provider** | MapLibre needs a base map, and its licence, attribution and cost depend on the provider (doc 07). | No base tiles: region polygons only, with NEPTUN and OSM attribution (0006). Choose a provider with a free tier and clear attribution before the pilot. |
| **Telegram access path** | MTProto (GramJS, a dedicated service account) reads public channels. The Bot API sees only channels the bot has joined (docs 00 and 04). There are no credentials yet. | MTProto through GramJS behind the collector interface, tested with a fake client. Live Telegram stays blocked until the account, session storage and channel access are confirmed and the terms of use are checked. |
| **Operator IdP** | Which OIDC provider to use, and whether it enforces MFA. | Admin routes return 401 in production until `OIDC_*` is set (0005). |
| **7-day shadow mode** | It needs calendar time with the live collector and a real Gateway key, and it publishes no conclusions (doc 09). It must cover at least 7 days of real relevant traffic, with at least 100 relevant and 100 irrelevant fresh texts. | Not run. The release gates of doc 09 stay unmet, so the pilot is at most review-only. |
| **Two-person labelling** | Two people label the relevant and ambiguous examples independently, then adjudicate. Splits are by time: 14–17.09 development, 18.09 validation, 19–20.09 holdout (doc 09). | Only the labels manifest template exists (`packages/test-fixtures`). The thresholds (0.90) remain hypotheses. |

## Consequences

The software can be built, tested with fakes and deployed. It must not be announced publicly until the budget, access, IdP, shadow-mode and labelling items are closed. Record each closure as a new ADR that supersedes the matching row.
