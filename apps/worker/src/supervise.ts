import { setTimeout as sleep } from 'node:timers/promises';
import type { Loop, LoopContext } from './loops/index';

/** Runs one loop in isolation: a crash is logged and the loop restarts after a delay; others keep running. */
export async function supervise(loop: Loop, ctx: LoopContext, restartDelayMs = 5_000): Promise<void> {
  const log = ctx.logger.child({ loop: loop.name });
  while (!ctx.signal.aborted) {
    try {
      await loop.start(ctx);
      log.info('loop stopped');
      return;
    } catch (err) {
      log.error({ err }, 'loop crashed; restarting');
      await sleep(restartDelayMs, undefined, { signal: ctx.signal }).catch(() => {});
    }
  }
}
