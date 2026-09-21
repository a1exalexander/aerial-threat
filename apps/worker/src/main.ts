import { hostname } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { loadWorkerEnv } from '@aerial/config';
import { createDb, releaseLeases } from '@aerial/db';
import { createLogger } from '@aerial/observability';
import { type LoopContext, loops } from './loops/index';
import { supervise } from './supervise';

const DRAIN_TIMEOUT_MS = 30_000;

const env = loadWorkerEnv();
const logger = createLogger({ name: 'worker', level: env.LOG_LEVEL });
const db = createDb(env.DATABASE_URL);
const controller = new AbortController();
const ctx: LoopContext = { db, env, logger, owner: `${hostname()}:${process.pid}`, signal: controller.signal };

const running = Promise.all(loops.map((loop) => supervise(loop, ctx)));
logger.info({ loops: loops.map((l) => l.name), owner: ctx.owner }, 'worker started');

// Shutdown: stop claiming (abort), let loops drain in-flight work, hand back any leases still held, close the pool.
async function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down');
  controller.abort();
  await Promise.allSettled(loops.map((l) => l.stop()));
  const drained = await Promise.race([running.then(() => true), sleep(DRAIN_TIMEOUT_MS, false, { ref: false })]);
  if (!drained) logger.warn('drain timed out');
  const released = await releaseLeases(db.db, ctx.owner);
  await db.close();
  logger.info({ released }, 'worker stopped');
  process.exit(0);
}
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

await running;
if (!controller.signal.aborted) {
  logger.warn('all loops exited');
  await db.close();
}
