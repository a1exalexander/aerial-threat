// Situation loop: evaluates the Kremenchuk window (rules, and AI on the alert-gated cadence) into
// situation_snapshots. The logic lives in ../situation; this only drives it on the wall clock.
import { setTimeout as sleep } from 'node:timers/promises';
import { isKremenchukAlertActive } from '@aerial/db/repos/situation';
import { drainRevisionJobs, restoreState, runSituationTick, situationContext } from '../situation/index';
import type { Loop } from './index';

const TICK_MS = 5_000;

export const situationLoop: Loop = {
  name: 'situation',
  async start({ db, env, logger, owner, signal }) {
    const log = logger.child({ loop: 'situation' });
    const ctx = situationContext(db.db, env, log, {
      signal,
      state: await restoreState(db.db),
      pollNewPosts: () => drainRevisionJobs(db.db, owner, env.KREMENCHUK_SOURCES),
      alertActive: (now) => isKremenchukAlertActive(db.db, now),
    });
    log.info({ evaluator: ctx.evaluator ? env.AI_EVALUATOR : 'rules-only', sources: ctx.sources }, 'situation loop started');
    while (!signal.aborted) {
      await runSituationTick(ctx, new Date()).catch((err) => log.error({ err }, 'situation tick failed'));
      await sleep(TICK_MS, undefined, { signal }).catch(() => {});
    }
  },
  // start() follows ctx.signal: an in-flight tick finishes, then it resolves.
  stop: async () => {},
};
