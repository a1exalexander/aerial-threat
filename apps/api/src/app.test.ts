import { loadApiEnv } from '@aerial/config';
import { ApiError } from '@aerial/contracts';
import type { Database } from '@aerial/db';
import { createLogger } from '@aerial/observability';
import { describe, expect, it } from 'vitest';
import { buildApp } from './app';

const env = loadApiEnv({ DATABASE_URL: 'postgres://u@localhost:1/none', CORS_ORIGINS: 'http://allowed.test' });
const logger = createLogger({ name: 'test', level: 'silent' });
const downDb = { sql: () => Promise.reject(new Error('db down')) } as unknown as Database;

describe('api app', () => {
  it('serves liveness with a request id', async () => {
    const res = await buildApp({ db: downDb, env, logger }).inject('/health/live');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('reports not-ready without details when the database is down', async () => {
    const res = await buildApp({ db: downDb, env, logger }).inject('/health/ready');
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'unavailable' });
  });

  it('returns the error envelope for unknown routes and hides 5xx details', async () => {
    const app = buildApp({ db: downDb, env, logger });
    app.get('/boom', async () => {
      throw new Error('secret internals');
    });
    const notFound = await app.inject('/v1/nope');
    expect(ApiError.parse(notFound.json())).toMatchObject({ code: 'not_found', requestId: notFound.headers['x-request-id'] });

    const boom = await app.inject('/boom');
    expect(boom.statusCode).toBe(500);
    expect(ApiError.parse(boom.json()).code).toBe('internal');
    expect(boom.body).not.toMatch(/secret internals|at .*\.ts/);
  });

  it('allows only configured CORS origins', async () => {
    const app = buildApp({ db: downDb, env, logger });
    const ok = await app.inject({ url: '/health/live', headers: { origin: 'http://allowed.test' } });
    const bad = await app.inject({ url: '/health/live', headers: { origin: 'http://evil.test' } });
    expect(ok.headers['access-control-allow-origin']).toBe('http://allowed.test');
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
  });
});
