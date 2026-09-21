import { loadApiEnv } from '@aerial/config';
import { createDb } from '@aerial/db';
import { createLogger } from '@aerial/observability';
import { buildApp } from './app';

const env = loadApiEnv();
const logger = createLogger({ name: 'api', level: env.LOG_LEVEL });
const db = createDb(env.DATABASE_URL);
const app = buildApp({ db, env, logger });

const shutdown = async (signal: string) => {
  logger.info({ signal }, 'shutting down');
  await app.close();
  await db.close();
  process.exit(0);
};
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: '0.0.0.0', port: env.API_PORT });
