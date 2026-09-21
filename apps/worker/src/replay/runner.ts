/** Virtual time for replays: starts at the window start and only moves forward. */
export class VirtualClock {
  #ms: number;
  constructor(start: Date) {
    this.#ms = start.getTime();
  }
  now(): Date {
    return new Date(this.#ms);
  }
  advanceTo(t: Date): void {
    this.#ms = Math.max(this.#ms, t.getTime());
  }
}

/**
 * Delivers items (sorted by `at`) when the virtual clock reaches their time, then runs the clock on to `to`.
 * `speed` is virtual ms per real ms (60 = one virtual minute per second); Infinity never waits.
 * The real wait is injected so tests run on a fake clock.
 */
export async function runReplay<T>(o: {
  items: Iterable<T>;
  at: (item: T) => Date;
  to: Date;
  speed: number;
  clock: VirtualClock;
  sleep: (realMs: number) => Promise<void>;
  deliver: (item: T, now: Date) => Promise<void>;
}): Promise<number> {
  const waitUntil = async (t: Date) => {
    const gap = t.getTime() - o.clock.now().getTime();
    if (gap > 0 && Number.isFinite(o.speed)) await o.sleep(gap / o.speed);
    o.clock.advanceTo(t);
  };
  let delivered = 0;
  for (const item of o.items) {
    await waitUntil(o.at(item));
    await o.deliver(item, o.clock.now());
    delivered++;
  }
  await waitUntil(o.to);
  return delivered;
}
