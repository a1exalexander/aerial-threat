// Operator authentication: `Authorization: Bearer <JWT>` verified with jose against the OIDC issuer's JWKS,
// roles from the `roles` claim (viewer < reviewer < admin), checked server-side on every admin request.
// Tokens travel only in the Authorization header; cookies are never read, so there is no CSRF surface.
// In APP_ENV local/test only, tokens from `cli mint-dev-token` (dev issuer, ES256 key file) are accepted too.
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { ApiEnv } from '@aerial/config';
import type { ApiError } from '@aerial/contracts';
import type { FastifyBaseLogger, FastifyReply, FastifyRequest, onRequestHookHandler } from 'fastify';
import { type JWK, type JWTPayload, type JWTVerifyGetKey, createRemoteJWKSet, decodeJwt, errors, importJWK, jwtVerify } from 'jose';

export const ROLES = ['viewer', 'reviewer', 'admin'] as const;
export type Role = (typeof ROLES)[number];
/** `role` is the highest recognised role in the token, or null when it has none. */
export type Operator = { sub: string; role: Role | null };

declare module 'fastify' {
  interface FastifyRequest {
    operator: Operator | null;
  }
}

// Must match apps/worker/src/cli/mint-dev-token.ts, which signs these tokens.
export const DEV_ISSUER = 'aerial-dev';
export const DEV_AUDIENCE = 'aerial-api-dev';

/** DEV_JWT_KEY_FILE, else `.dev-jwt-key.json` at the workspace root (gitignored; mint-dev-token creates it). */
export function devKeyFile(): string {
  if (process.env.DEV_JWT_KEY_FILE) return process.env.DEV_JWT_KEY_FILE;
  for (let dir = process.cwd(); dirname(dir) !== dir; dir = dirname(dir)) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return join(dir, '.dev-jwt-key.json');
  }
  return resolve('.dev-jwt-key.json');
}

/** Public half of the dev key, read per request (local/test only) so a re-minted key needs no restart. */
async function devPublicKey() {
  const { d: _private, ...jwk } = JSON.parse(await readFile(devKeyFile(), 'utf8')) as JWK;
  return importJWK(jwk, 'ES256');
}

const rank = (role: Role | null) => (role ? ROLES.indexOf(role) : -1);

function highestRole(claim: unknown): Role | null {
  const roles = Array.isArray(claim) ? ROLES.filter((r) => claim.includes(r)) : [];
  return roles.at(-1) ?? null;
}

const CODES = { 401: 'unauthorized', 403: 'forbidden', 503: 'auth_unavailable' } as const;

function deny(req: FastifyRequest, reply: FastifyReply, status: keyof typeof CODES, message: string) {
  if (status === 401) reply.header('www-authenticate', 'Bearer');
  const body: ApiError = { code: CODES[status], requestId: req.id, message };
  return reply.status(status).send(body);
}

/** The IdP's key set could not be fetched: a 503 outage, not a bad token. */
class IdpUnavailable extends Error {}
const JWKS_DOWN = new Set(['ERR_JWKS_TIMEOUT', 'ERR_JWKS_INVALID', 'ERR_JOSE_GENERIC']);

function remoteKeys(url: string): JWTVerifyGetKey {
  const jwks = createRemoteJWKSet(new URL(url)); // cached, refetched on an unknown kid (with cooldown)
  return async (header, token) => {
    try {
      return await jwks(header, token);
    } catch (err) {
      if (!(err instanceof errors.JOSEError) || JWKS_DOWN.has(err.code)) throw new IdpUnavailable(String(err), { cause: err });
      throw err;
    }
  };
}

/** onRequest hook: verifies the bearer token and sets `req.operator`, or answers 401 (503 if the IdP is down). */
export function authenticate(env: ApiEnv, log: FastifyBaseLogger): onRequestHookHandler {
  const oidc =
    env.OIDC_ISSUER && env.OIDC_AUDIENCE && env.OIDC_JWKS_URL
      ? { keys: remoteKeys(env.OIDC_JWKS_URL), issuer: env.OIDC_ISSUER, audience: env.OIDC_AUDIENCE }
      : null;
  // NODE_ENV=production (set by the images) wins over an APP_ENV that was left at its `local` default.
  const devKeys = (env.APP_ENV === 'local' || env.APP_ENV === 'test') && process.env.NODE_ENV !== 'production';
  // APP_ENV defaults to local, so say loudly when dev tokens are on; a deployment must set APP_ENV explicitly.
  if (devKeys) log.warn({ appEnv: env.APP_ENV, keyFile: devKeyFile() }, 'operator tokens signed by the local dev key are accepted');
  if (!oidc && !devKeys) log.warn('OIDC is not configured: every /v1/admin request will be rejected');

  const verify = async (token: string): Promise<JWTPayload> => {
    if (devKeys && decodeJwt(token).iss === DEV_ISSUER) {
      return (
        await jwtVerify(token, await devPublicKey(), {
          issuer: DEV_ISSUER,
          audience: DEV_AUDIENCE,
          algorithms: ['ES256'],
          requiredClaims: ['exp'],
        })
      ).payload;
    }
    if (!oidc) throw new Error('OIDC is not configured');
    return (
      await jwtVerify(token, oidc.keys, { issuer: oidc.issuer, audience: oidc.audience, clockTolerance: 30, requiredClaims: ['exp'] })
    ).payload;
  };

  return async (req, reply) => {
    const token = /^Bearer +(\S+)$/i.exec(req.headers.authorization ?? '')?.[1];
    if (!token) return deny(req, reply, 401, 'Bearer token required');
    try {
      const payload = await verify(token);
      if (!payload.sub) throw new Error('token has no sub');
      req.operator = { sub: payload.sub, role: highestRole(payload.roles) };
    } catch (err) {
      if (err instanceof IdpUnavailable) {
        req.log.warn({ err: err.message }, 'OIDC key set unavailable');
        return deny(req, reply, 503, 'Identity provider unavailable, retry later');
      }
      req.log.info({ reason: (err as { code?: string }).code ?? (err as Error).message }, 'operator token rejected');
      return deny(req, reply, 401, 'Invalid or expired token');
    }
  };
}

/** Route-level onRequest hook (runs after `authenticate`): 403 unless the operator has at least `min`. */
export const requireRole =
  (min: Role): onRequestHookHandler =>
  async (req, reply) => {
    if (rank(req.operator?.role ?? null) < rank(min)) return deny(req, reply, 403, `Requires the ${min} role`);
  };
