# 0001. Stack and monorepo layout

Status: accepted (2026-09-21)

## Context

We need three processes: a static web client, a read/operator API, and a long-running worker that holds Telegram and NEPTUN connections and drains the job queue. They share contracts and domain rules. The spec (doc 02) asks for Turborepo, TypeScript and pinned versions, with no floating `latest` in production.

## Decision

- pnpm 10 workspaces with Turborepo 2, TypeScript strict, ESM only, Node 22 LTS (`.nvmrc`). Every dependency is exact-pinned, and CI installs with `--frozen-lockfile`.
- Apps: `apps/web` (React 19, Vite, react-router, MapLibre), `apps/api` (Fastify 5), `apps/worker` (plain Node with a loops registry and a supervisor).
- Internal `@aerial/*` packages are **JIT**: `exports` point at `src/*.ts` and there is no per-package build. The api and worker are bundled with tsup, which inlines `@aerial/*` and the npm deps reached only through them. The web app is bundled with Vite.
- Lint enforces the boundaries. `contracts` is the bottom layer. `apps/web` may import only `@aerial/contracts` and `@aerial/geo/geometry`, and apps never import each other.
- Delivery: immutable `api` and `worker` images (`Dockerfile.api`, `Dockerfile.worker`) tagged with the git revision. Each is a multi-stage build:
  - a frozen install and a turbo build;
  - the app's own production deps, installed from the same lockfile;
  - a runtime stage with a non-root user and `APP_REVISION`.

  The web app ships as a static bundle. `docker-compose.prod.yml` runs the full stack on one host.

## Consequences

- There is no package build graph to maintain, and editing a package is picked up immediately by tsx, vitest and Vite. The price is that runtime images must never import `@aerial/*` from `node_modules`; everything goes through the bundle.
- Base images are pinned by version (`node:22.23.2-slim`, `nginx:1.29.8-alpine`, `postgres:17`). Pin them by digest once a registry and an update cadence are chosen.
- Redis, a broker or more services are added only after measurement (doc 02).
