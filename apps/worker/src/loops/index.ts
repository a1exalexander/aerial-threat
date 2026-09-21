import type { WorkerEnv } from '@aerial/config';
import type { Database } from '@aerial/db';
import type { Logger } from '@aerial/observability';
import { neptunLoop } from './neptun';
import { retentionLoop } from './retention';
import { situationLoop } from './situation';
import { telegramLoop } from './telegram';

export type LoopContext = {
  db: Database;
  env: WorkerEnv;
  logger: Logger;
  /** Stable per-process lease owner for jobs.lease_owner. */
  owner: string;
  /** Aborted on shutdown: stop claiming new work, finish in-flight work, then resolve start(). */
  signal: AbortSignal;
};

/** A long-running loop. start() resolves once the loop has stopped; a rejection restarts it in isolation. */
export interface Loop {
  name: string;
  start(ctx: LoopContext): Promise<void>;
  stop(): Promise<void>;
}

// Each unit implements its own loop file; this list changes only when a new loop file is added.
export const loops: Loop[] = [neptunLoop, telegramLoop, retentionLoop, situationLoop];
