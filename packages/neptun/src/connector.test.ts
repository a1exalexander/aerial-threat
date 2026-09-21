import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import frames from '../fixtures/stream-frames.json';
import { type NeptunEvent, POLL_INTERVAL_MS, POLL_JITTER_MS, REST_MIN_INTERVAL_MS, isOutOfOrder, runNeptunConnector } from './connector';

class FakeWs {
  static all: FakeWs[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: URL) {
    FakeWs.all.push(this);
  }
  open() {
    this.onopen?.();
  }
  frame(f: unknown) {
    this.onmessage?.({ data: typeof f === 'string' ? f : JSON.stringify(f) });
  }
  close() {
    queueMicrotask(() => this.onclose?.());
  }
}
const lastWs = () => FakeWs.all.at(-1)!;

/** A fetch that never answers on its own; it honours abort like the real one. */
const hangingFetch = (_: unknown, init?: RequestInit) =>
  new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)));

const payload = (updatedAt: string | undefined, raionKeys: string[]) => ({
  updatedAt,
  raions: raionKeys.map((key) => ({ key, level: 'red', since: '2026-09-21T07:00:00Z' })),
  oblasts: [],
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function harness(fetchImpl: (url: URL, init?: RequestInit) => Promise<Response>, random = () => 0.5 /* no jitter */) {
  const events: NeptunEvent[] = [];
  const logs: string[] = [];
  const push = (_: object, msg: string) => void logs.push(msg);
  const ctl = new AbortController();
  const fetchMock = vi.fn(fetchImpl);
  const done = runNeptunConnector({
    baseUrl: 'https://neptun.test',
    signal: ctl.signal,
    onEvent: async (e) => void events.push(e),
    log: { debug: push, info: push, warn: push, error: push },
    fetch: fetchMock as unknown as typeof fetch,
    WebSocket: FakeWs as unknown as typeof WebSocket,
    random,
  });
  const snapshots = () =>
    events.flatMap((e) => (e.type === 'snapshot' ? [{ channel: e.channel, keys: e.snapshot.areas.map((a) => a.key) }] : []));
  return { events, logs, fetchMock, snapshots, stop: () => (ctl.abort(), done) };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-21T08:00:00Z'));
  FakeWs.all = [];
});
afterEach(() => void vi.useRealTimers());

describe('isOutOfOrder', () => {
  const at = (observedAt: number, providerTime: number | null = null) => ({ observedAt, providerTime });
  it('lets provider time decide when both snapshots carry one', () => {
    expect(isOutOfOrder(at(1_000, 100), at(2_000, 200))).toBe(true); // slow REST, older state
    expect(isOutOfOrder(at(1_000, 300), at(2_000, 200))).toBe(false); // slow REST, newer state
    expect(isOutOfOrder(at(3_000, 100), at(2_000, 200))).toBe(true); // lagging frame
    expect(isOutOfOrder(at(3_000, 200), at(2_000, 200))).toBe(false); // same state again: a confirmation
    expect(isOutOfOrder(at(1_000, 200), at(2_000, 200))).toBe(true); // same state, observed earlier: nothing new
    expect(isOutOfOrder(at(600_000, 100), at(2_000, 200))).toBe(true); // however late: never roll back
  });
  it('falls back to observation order without provider time', () => {
    expect(isOutOfOrder(at(1_000), at(2_000, 200))).toBe(true);
    expect(isOutOfOrder(at(3_000, 100), at(2_000))).toBe(false);
  });
});

describe('runNeptunConnector', () => {
  it('reports 429 / 5xx / timeout / invalid JSON / network / schema errors as failures, never as a snapshot', async () => {
    const replies: Array<() => Promise<Response>> = [
      async () => new Response('slow down', { status: 429 }),
      async () => new Response('<html>bad gateway</html>', { status: 502 }),
      async () => Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError')),
      async () => new Response('{"raions": [', { status: 200 }),
      async () => Promise.reject(new TypeError('fetch failed')),
      async () => json({ error: 'maintenance' }),
    ];
    const h = harness(() => replies.shift()!());
    await vi.advanceTimersByTimeAsync(55_000); // start + a poll every 10 s while nothing is confirmed
    await h.stop();

    expect(h.fetchMock).toHaveBeenCalledTimes(6);
    expect(h.events.map((e) => (e.type === 'failure' ? `${e.channel}:${e.kind}` : e.type))).toEqual([
      'rest:http_429',
      'rest:http_5xx',
      'rest:timeout',
      'rest:invalid_json',
      'rest:network',
      'rest:schema',
    ]);
    // Only payloads that arrived are kept raw (for alert_snapshots); transport errors carry none.
    expect(h.events.map((e) => e.type === 'failure' && e.raw)).toEqual([undefined, undefined, undefined, '{"raions": [', undefined, { error: 'maintenance' }]);
  });

  it('never starts REST requests less than 5 s apart, whatever triggers them', async () => {
    const starts: number[] = [];
    const h = harness(async () => (starts.push(Date.now()), json(payload('2026-09-21T08:00:00Z', []))));
    // A flapping stream: every socket opens (-> REST refresh) and dies half a second later.
    const flap = setInterval(() => {
      const ws = lastWs();
      if (ws.onopen) ws.open();
      setTimeout(() => ws.close(), 500);
    }, 100);
    await vi.advanceTimersByTimeAsync(90_000);
    clearInterval(flap);
    await h.stop();

    expect(starts.length).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < starts.length; i++) expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(REST_MIN_INTERVAL_MS);
  });

  it.each([
    { name: 'older REST loses to a newer WS frame', rest: '2026-09-21T08:00:00Z', ws: '2026-09-21T08:00:30Z', want: ['ws'] },
    { name: 'without provider time the earlier-observed REST loses', rest: undefined, ws: undefined, want: ['ws'] },
    { name: 'a slow REST that saw a newer change still applies', rest: '2026-09-21T08:01:00Z', ws: '2026-09-21T08:00:30Z', want: ['ws', 'rest'] },
  ])('WS/REST race: $name', async ({ rest, ws, want }) => {
    let answer!: (r: Response) => void;
    const h = harness(() => new Promise((resolve) => (answer = resolve)));
    await vi.advanceTimersByTimeAsync(0); // start REST is in flight
    lastWs().open(); // its refresh joins the in-flight request
    await vi.advanceTimersByTimeAsync(1_000);
    lastWs().frame({ type: 'alerts', ts: '2026-09-21T08:00:01Z', data: payload(ws, []) }); // all clear
    await vi.advanceTimersByTimeAsync(1_000);
    answer(json(payload(rest, ['полтавський']))); // the earlier request lands last
    await vi.advanceTimersByTimeAsync(0);
    await h.stop();

    expect(h.fetchMock).toHaveBeenCalledTimes(1);
    expect(h.snapshots().map((s) => s.channel)).toEqual(want);
    if (want.length === 1) expect(h.logs).toContain('neptun: dropped out-of-order snapshot');
  });

  it('maps stream frames to events and keeps going after unknown or broken frames', async () => {
    const h = harness(hangingFetch);
    await vi.advanceTimersByTimeAsync(0);
    const ws = lastWs();
    expect(ws.url.toString()).toBe('wss://neptun.test/api/v1/stream');
    ws.open();
    for (const f of frames) ws.frame(f); // snapshot, alerts, upsert, remove, heartbeat
    ws.frame({ type: 'mystery', ts: '2026-09-21T08:00:00Z' });
    ws.frame({ type: 'mystery' });
    ws.frame('{not json'); // unclassifiable frames are logged only: they may be threat tracks
    ws.frame([1, 2]);
    ws.frame({ type: 'alerts', ts: '2026-09-21T08:00:00Z', data: { raions: [] } }); // an alerts payload that fails the contract
    ws.frame({ type: 'alerts', ts: '2026-09-21T08:00:00Z', data: payload('2026-09-21T08:40:00Z', ['Полтавський']) });
    await vi.advanceTimersByTimeAsync(0);
    await h.stop();

    expect(h.events.map((e) => (e.type === 'failure' ? `failure:${e.kind}` : e.type))).toEqual([
      'snapshot',
      'heartbeat',
      'failure:schema',
      'snapshot',
    ]);
    expect(h.snapshots()[1]).toEqual({ channel: 'ws', keys: ['полтавський'] });
    expect(h.logs).toEqual(
      expect.arrayContaining([
        'neptun: unknown stream event type ignored',
        'neptun: stream frame is not JSON (ignored)',
        'neptun: stream frame without an envelope (ignored)',
      ]),
    );
    expect(h.logs.filter((m) => m === 'neptun: unknown stream event type ignored')).toHaveLength(1);
  });

  it('drops a REST failure whose request started before the applied set', async () => {
    let fail!: (e: Error) => void;
    const h = harness(() => new Promise((_, reject) => (fail = reject)));
    await vi.advanceTimersByTimeAsync(0);
    lastWs().open();
    await vi.advanceTimersByTimeAsync(1_000);
    lastWs().frame({ type: 'alerts', ts: '2026-09-21T08:00:01Z', data: payload('2026-09-21T08:00:00Z', []) });
    await vi.advanceTimersByTimeAsync(1_000);
    fail(new DOMException('timeout', 'TimeoutError'));
    await vi.advanceTimersByTimeAsync(0);
    await h.stop();
    expect(h.events.map((e) => e.type)).toEqual(['snapshot']);
  });

  it('polls REST every 10 s ± jitter even at the shortest jitter (its own confirmation never skips a cycle)', async () => {
    const starts: number[] = [];
    const h = harness(async () => (starts.push(Date.now()), json(payload('2026-09-21T08:00:00Z', []))), () => 0);
    await vi.advanceTimersByTimeAsync(39_000);
    await h.stop();
    const t0 = Date.parse('2026-09-21T08:00:00Z');
    const step = POLL_INTERVAL_MS - POLL_JITTER_MS;
    expect(starts.map((s) => s - t0)).toEqual([0, step, 2 * step, 3 * step, 4 * step]);
  });

  it('retries promptly when the stream errors without a close event (refused connection)', async () => {
    const h = harness(hangingFetch);
    await vi.advanceTimersByTimeAsync(0);
    lastWs().onerror?.();
    await vi.advanceTimersByTimeAsync(3_000); // first backoff is 1-3 s
    await h.stop();
    expect(FakeWs.all.length).toBe(2);
  });

  it('reconnects a silent stream and takes a fresh REST snapshot on reconnect', async () => {
    const h = harness(async () => json(payload('2026-09-21T08:00:00Z', [])));
    await vi.advanceTimersByTimeAsync(0);
    lastWs().open();
    await vi.advanceTimersByTimeAsync(60_000); // no frames at all: idle timeout closes the socket
    expect(FakeWs.all.length).toBeGreaterThanOrEqual(2);
    const before = h.fetchMock.mock.calls.length;
    lastWs().open();
    await vi.advanceTimersByTimeAsync(REST_MIN_INTERVAL_MS);
    expect(h.fetchMock.mock.calls.length).toBeGreaterThan(before);
    await h.stop();
  });
});
