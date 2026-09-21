// Situation loop: evaluates the Kremenchuk window (rules, and AI on alert) into situation_snapshots.
// Placeholder; implemented by unit 3.
import { once } from 'node:events';
import type { Loop } from './index';

export const situationLoop: Loop = {
  name: 'situation',
  async start({ logger, signal }) {
    logger.child({ loop: 'situation' }).info('situation loop not implemented');
    if (!signal.aborted) await once(signal, 'abort');
  },
  stop: async () => {},
};
