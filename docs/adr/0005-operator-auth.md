# 0005. Operator auth: OIDC bearer tokens plus a local dev key

Status: accepted (2026-09-21); the provider is still open (0007)

## Context

Operators review claims, merge and split incidents, reprocess messages and pause sources. The public read API needs no login. Doc 08 asks for a ready-made OIDC provider or a vetted library, MFA where the provider supports it, and minimal privileges.

## Decision

- The API verifies `Authorization: Bearer <JWT>` with `jose` against `OIDC_ISSUER`, `OIDC_AUDIENCE` and `OIDC_JWKS_URL`. A `roles` claim maps to `viewer`, `reviewer` or `admin`, and the server enforces roles on every admin route regardless of the UI.
- The web client uses `oidc-client-ts` with Authorization Code + PKCE. Tokens are sent as bearer headers, never as cookies, so there is no CSRF surface.
- Every write carries `expectedVersion` (409 on conflict), an idempotency key and a mandatory reason. It appends to `audit_log` in the same transaction.
- **Dev mode:** a local signing key (`DEV_JWT_KEY`) and `cli mint-dev-token` are accepted only when `APP_ENV` is `local` or `test`. Production images run with `APP_ENV=production`, so the dev path is off.

## Consequences

- We store no passwords or sessions. MFA and account lifecycle belong to the chosen IdP, which is still open (0007). Until one is configured, admin routes return 401 in production.
- Audit rows are immutable until retention deletes them after 180 days.

## Update (web)

The web operator screens (`/review`, `/ops`, OIDC login) were removed when the web became a single public Kremenchuk screen. The operator API (`/v1/admin/*`) and its bearer-token auth described here remain.
