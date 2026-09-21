import { createLogger } from '@aerial/observability';
import { describe, expect, it } from 'vitest';
import type { Loop, LoopContext } from './loops/index';
import { supervise } from './supervise';

const ctx = (signal = new AbortController().signal) =>
  ({ logger: createLogger({ name: 't', level: 'silent' }), signal, owner: 't' }) as unknown as LoopContext;

describe('supervise', () => {
  it('restarts a crashing loop without affecting its neighbours', async () => {
    let crashes = 0;
    const flaky: Loop = {
      name: 'flaky',
      start: async () => {
        if (crashes++ < 2) throw new Error('boom');
      },
      stop: async () => {},
    };
    let healthyRuns = 0;
    const healthy: Loop = { name: 'healthy', start: async () => void healthyRuns++, stop: async () => {} };
    const c = ctx();
    await Promise.all([supervise(flaky, c, 1), supervise(healthy, c, 1)]);
    expect(crashes).toBe(3);
    expect(healthyRuns).toBe(1);
  });

  it('stops restarting once shutdown is signalled', async () => {
    const controller = new AbortController();
    let starts = 0;
    const failing: Loop = {
      name: 'failing',
      start: async () => {
        starts++;
        controller.abort();
        throw new Error('boom');
      },
      stop: async () => {},
    };
    await supervise(failing, ctx(controller.signal), 60_000);
    expect(starts).toBe(1);
  });
});
