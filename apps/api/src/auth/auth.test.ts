// Direct-HTTP auth checks. No database: every request here is answered before a repository is touched
// (401/403, or 400 for an empty body once authentication and the role check have passed).
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { loadApiEnv } from '@aerial/config';
import { ApiError } from '@aerial/contracts';
import type { Database } from '@aerial/db';
import { createLogger } from '@aerial/observability';
import { type CryptoKey, exportJWK, generateKeyPair } from 'jose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app';
import { signToken, useDevKey } from './testing';

const logger = createLogger({ name: 'test', level: 'silent' });
const noDb = {} as Database;
const ID = '0b3c1f9e-8a3b-4a51-9d2e-2a4f3f7c1b10';
const OIDC = { OIDC_ISSUER: 'https://idp.test', OIDC_AUDIENCE: 'aerial-api' };

let dev: Awaited<ReturnType<typeof useDevKey>>;
let idpKey: CryptoKey;
let jwksUrl: string;
const server = createServer();

beforeAll(async () => {
  dev = await useDevKey();
  const idp = await generateKeyPair('ES256');
  idpKey = idp.privateKey;
  const keys = [{ ...(await exportJWK(idp.publicKey)), kid: 'idp-1', alg: 'ES256', use: 'sig' }];
  server.on('request', (_req, res) => res.setHeader('content-type', 'application/json').end(JSON.stringify({ keys })));
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  jwksUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/jwks`;
});
afterAll(() => new Promise((done) => server.close(done)));

const app = (APP_ENV: string, oidc = true) =>
  buildApp({
    db: noDb,
    env: loadApiEnv({ DATABASE_URL: 'postgres://u@localhost:1/none', APP_ENV, ...(oidc ? { ...OIDC, OIDC_JWKS_URL: jwksUrl } : {}) }),
    logger,
  });
const oidcToken = (opts: Parameters<typeof signToken>[1]) =>
  signToken(idpKey, { iss: OIDC.OIDC_ISSUER, aud: OIDC.OIDC_AUDIENCE, kid: 'idp-1', ...opts });

async function post(env: string, token: string | null, path = `/v1/admin/claims/${ID}/review`, oidc = true) {
  const res = await app(env, oidc).inject({
    method: 'POST',
    url: path,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    payload: {},
  });
  return { status: res.statusCode, body: ApiError.parse(res.json()), headers: res.headers };
}

describe('operator auth', () => {
  it('rejects a missing or malformed bearer token with 401', async () => {
    const none = await post('test', null);
    expect(none).toMatchObject({ status: 401, body: { code: 'unauthorized' } });
    expect(none.headers['www-authenticate']).toBe('Bearer');
    expect((await post('test', 'not-a-jwt')).status).toBe(401);
    const get = await app('test').inject('/v1/admin/ops');
    expect(get.statusCode).toBe(401);
  });

  it('rejects bad signatures, expired tokens and the wrong audience or issuer', async () => {
    const { privateKey: stranger } = await generateKeyPair('ES256');
    expect((await post('test', await signToken(stranger, { roles: ['admin'] }))).status).toBe(401);
    expect((await post('test', await dev({ roles: ['admin'], exp: Math.floor(Date.now() / 1000) - 3600 }))).status).toBe(401);
    expect((await post('test', await dev({ roles: ['admin'], aud: 'someone-else' }))).status).toBe(401);
    expect((await post('test', await dev({ roles: ['admin'], sub: null }))).status).toBe(401);
    expect((await post('test', await oidcToken({ roles: ['admin'], iss: 'https://evil.test' }))).status).toBe(401);
    expect((await post('test', await oidcToken({ roles: ['admin'], aud: 'other-api' }))).status).toBe(401);
    expect(
      (await post('test', await signToken(stranger, { roles: ['admin'], iss: OIDC.OIDC_ISSUER, aud: OIDC.OIDC_AUDIENCE, kid: 'idp-1' })))
        .status,
    ).toBe(401);
  });

  it('enforces roles: viewer and role-less tokens get 403 on writes, reviewer passes', async () => {
    expect(await post('test', await dev({ roles: ['viewer'] }))).toMatchObject({ status: 403, body: { code: 'forbidden' } });
    expect((await post('test', await oidcToken({}))).status).toBe(403);
    expect((await post('test', await oidcToken({ roles: ['superuser'] }))).status).toBe(403);
    // Authenticated and allowed: the empty body is what fails now.
    expect(await post('test', await dev({ roles: ['reviewer'] }))).toMatchObject({ status: 400, body: { code: 'bad_request' } });
    expect((await post('test', await oidcToken({ roles: ['viewer', 'reviewer'] }))).status).toBe(400);
  });

  it('keeps source pause admin-only', async () => {
    const path = `/v1/admin/sources/${ID}/pause`;
    expect((await post('test', await dev({ roles: ['reviewer'] }), path)).status).toBe(403);
    expect((await post('test', await dev({ roles: ['admin'] }), path)).status).toBe(400);
  });

  it('never accepts dev-key tokens outside local/test', async () => {
    const token = await dev({ roles: ['admin'] });
    expect((await post('local', token)).status).toBe(400);
    for (const env of ['staging', 'production']) {
      expect((await post(env, token)).status).toBe(401);
      expect((await post(env, await oidcToken({ roles: ['admin'] }))).status).toBe(400);
    }
    vi.stubEnv('NODE_ENV', 'production'); // a production image whose APP_ENV was left at the local default
    expect((await post('local', token)).status).toBe(401);
    vi.unstubAllEnvs();
  });

  it('answers 503, not 401, when the IdP key set cannot be fetched', async () => {
    const res = await buildApp({
      db: noDb,
      env: loadApiEnv({
        DATABASE_URL: 'postgres://u@localhost:1/none',
        APP_ENV: 'production',
        ...OIDC,
        OIDC_JWKS_URL: 'http://127.0.0.1:9/jwks',
      }),
      logger,
    }).inject({
      method: 'POST',
      url: `/v1/admin/claims/${ID}/review`,
      headers: { authorization: `Bearer ${await oidcToken({ roles: ['admin'] })}` },
    });
    expect(res.statusCode).toBe(503);
    expect(ApiError.parse(res.json()).code).toBe('auth_unavailable');
  });

  it('rejects every token when OIDC is not configured in production', async () => {
    expect((await post('production', await oidcToken({ roles: ['admin'] }), undefined, false)).status).toBe(401);
  });
});
