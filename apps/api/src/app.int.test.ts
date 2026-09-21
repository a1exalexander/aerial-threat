import { loadApiEnv } from '@aerial/config';
import { createTestDb } from '@aerial/db/testing';
import { createLogger } from '@aerial/observability';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { buildApp } from './app';

let t: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t?.drop());

it('is ready when the database answers', async () => {
  const env = loadApiEnv({ DATABASE_URL: t.url });
  const app = buildApp({ db: { db: t.db, sql: t.sql, close: async () => {} }, env, logger: createLogger({ name: 't', level: 'silent' }) });
  const res = await app.inject('/health/ready');
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ status: 'ok' });
  await app.close();
});
