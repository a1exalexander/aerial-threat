import { describe, expect, it } from 'vitest';
import { VirtualClock, runReplay } from './runner';

const T0 = new Date('2026-09-19T16:00:00Z');
const at = (min: number) => new Date(T0.getTime() + min * 60_000);

describe('runReplay', () => {
  it('delivers each item at its virtual time, waiting gap / speed of real time', async () => {
    const clock = new VirtualClock(T0);
    const sleeps: number[] = [];
    const delivered: Array<[string, string]> = [];
    const n = await runReplay({
      items: [at(0), at(1), at(1), at(30)],
      at: (d) => d,
      to: at(60),
      speed: 60,
      clock,
      sleep: async (ms) => void sleeps.push(ms),
      deliver: async (d, now) => void delivered.push([d.toISOString(), now.toISOString()]),
    });
    expect(n).toBe(4);
    expect(sleeps).toEqual([1_000, 29_000, 30_000]); // 1, 29 and 30 virtual minutes at x60
    expect(delivered.every(([item, now]) => item === now)).toBe(true);
    expect(clock.now()).toEqual(at(60));
  });

  it('never waits at infinite speed and never moves the clock backwards', async () => {
    const clock = new VirtualClock(at(10));
    const sleeps: number[] = [];
    const seen: Date[] = [];
    await runReplay({
      items: [at(5), at(20)],
      at: (d) => d,
      to: at(30),
      speed: Infinity,
      clock,
      sleep: async (ms) => void sleeps.push(ms),
      deliver: async (_d, now) => void seen.push(now),
    });
    expect(sleeps).toEqual([]);
    expect(seen).toEqual([at(10), at(20)]);
    expect(clock.now()).toEqual(at(30));
  });
});
