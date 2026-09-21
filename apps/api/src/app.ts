import { randomUUID } from 'node:crypto';
import type { ApiEnv } from '@aerial/config';
import type { ApiError } from '@aerial/contracts';
import type { Database } from '@aerial/db';
import { type Logger, withTrace } from '@aerial/observability';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyError } from 'fastify';
import { adminRoutes } from './routes/admin/index';
import { publicRoutes } from './routes/public/index';

declare module 'fastify' {
  interface FastifyInstance {
    db: Database;
    env: ApiEnv;
  }
}

const CODES: Record<number, string> = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  413: 'payload_too_large',
  415: 'unsupported_media_type',
  429: 'rate_limited',
};

const withTimeout = <T>(p: PromiseLike<T>, ms: number) =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms).unref())]);

export function buildApp({ db, env, logger }: { db: Database; env: ApiEnv; logger: Logger }) {
  const app = Fastify({ loggerInstance: logger, genReqId: () => randomUUID(), bodyLimit: 64 * 1024 });
  app.decorate('db', db);
  app.decorate('env', env);

  app.addHook('onRequest', (req, reply, done) => {
    reply.header('x-request-id', req.id);
    withTrace(req.id, done);
  });

  // Every error leaves as { code, requestId, message }; 5xx details stay in the log only.
  app.setErrorHandler((err: FastifyError, req, reply) => {
    const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500;
    if (status >= 500) req.log.error({ err }, 'request failed');
    const body: ApiError = {
      code: CODES[status] ?? (status >= 500 ? 'internal' : 'error'),
      requestId: req.id,
      message: status >= 500 ? 'Internal server error' : err.message,
    };
    return reply.status(status).send(body);
  });
  app.setNotFoundHandler((req, reply) =>
    reply.status(404).send({ code: 'not_found', requestId: req.id, message: 'Not found' } satisfies ApiError),
  );

  app.register(cors, { origin: env.CORS_ORIGINS, methods: ['GET', 'POST'], exposedHeaders: ['x-request-id', 'etag'] });
  app.register(rateLimit, { max: 300, timeWindow: '1 minute' });

  app.get('/health/live', { config: { rateLimit: false } }, async () => ({ status: 'ok' }));
  app.get('/health/ready', { config: { rateLimit: false } }, async (_req, reply) => {
    try {
      await withTimeout(db.sql`select 1`, 2000);
      return { status: 'ok' };
    } catch {
      return reply.status(503).send({ status: 'unavailable' });
    }
  });

  app.register(publicRoutes, { prefix: '/v1' });
  app.register(adminRoutes, { prefix: '/v1/admin' });
  return app;
}
