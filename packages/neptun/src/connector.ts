// NEPTUN alerts connector: WebSocket stream + REST snapshots, delivered to one serial handler in provider order.
import { z } from 'zod';
import { type AlertsSnapshot, StreamEnvelope, parseAlerts } from './contract';

/** NEPTUN terms: REST no more often than once per 5 s. */
export const REST_MIN_INTERVAL_MS = 5_000;
/** Short enough that poll + timeout + poll stays under the 30 s stale threshold. */
export const REST_TIMEOUT_MS = 5_000;
/** Control REST snapshot every 10 s ± jitter unless something confirmed the alert set meanwhile (the stream is silent about unchanged state). */
export const POLL_INTERVAL_MS = 10_000;
export const POLL_JITTER_MS = 2_000;
/** Heartbeats arrive every 15 s; three missed ones mean a dead socket. */
export const WS_IDLE_MS = 45_000;
export const WS_BACKOFF_MAX_MS = 60_000;
const MAX_RAW_TEXT = 10_000;

export type Channel = 'rest' | 'ws';
export type FailureKind = 'timeout' | 'network' | 'http_429' | 'http_5xx' | 'http_error' | 'invalid_json' | 'schema';

export type NeptunEvent =
  /** A valid, complete alert set. `raw` is the payload as received (REST body / WS `alerts` data). */
  | { type: 'snapshot'; channel: Channel; observedAt: Date; raw: unknown; snapshot: AlertsSnapshot }
  /** Nothing usable arrived. `raw` is set only when an alerts payload arrived but failed validation. Never a clear. */
  | { type: 'failure'; channel: Channel; observedAt: Date; kind: FailureKind; error: string; raw?: unknown }
  /** Transport health only: proves the socket is alive, not that the alert set is fresh. */
  | { type: 'heartbeat'; observedAt: Date };

type Ordered = { observedAt: number; providerTime: number | null };

/**
 * Serial-apply guard: true when `next` must not overwrite the already applied `last`. Differing provider timestamps
 * decide (a slow REST response loses to a newer WS frame, a slow REST that saw a newer change wins); otherwise
 * observation order does (REST is observed at request start).
 * ponytail: no escape hatch for a provider clock that goes backwards: states go stale/unknown (never a false clear)
 * until a newer updatedAt arrives or the worker restarts.
 */
export function isOutOfOrder(next: Ordered, last: Ordered): boolean {
  if (next.providerTime !== null && last.providerTime !== null && next.providerTime !== last.providerTime)
    return next.providerTime < last.providerTime;
  return next.observedAt < last.observedAt;
}

type LogFn = (obj: object, msg: string) => void;
export type ConnectorLog = { debug: LogFn; info: LogFn; warn: LogFn; error: LogFn };

export type ConnectorOptions = {
  baseUrl: string;
  signal: AbortSignal;
  /** Called one event at a time. A rejection is logged and the snapshot does not count as applied. */
  onEvent: (e: NeptunEvent) => Promise<void>;
  log: ConnectorLog;
  fetch?: typeof fetch;
  WebSocket?: typeof WebSocket;
  now?: () => number;
  random?: () => number;
};

/** Resolves after ms, or early (without throwing) once the signal aborts. Global timers, so tests can fake them. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/**
 * Runs until `signal` aborts: a REST snapshot on start and on every stream (re)connect, the stream with backoff
 * reconnects, and a control REST poll every 10 s ± jitter whenever nothing confirmed the alert set meanwhile.
 */
export async function runNeptunConnector(o: ConnectorOptions): Promise<void> {
  const { signal, onEvent, log } = o;
  const fetchImpl = o.fetch ?? fetch;
  const WS = o.WebSocket ?? WebSocket;
  const now = o.now ?? Date.now;
  const random = o.random ?? Math.random;
  const alertsUrl = new URL('/api/v1/alerts', o.baseUrl);
  const streamUrl = new URL('/api/v1/stream', o.baseUrl);
  streamUrl.protocol = streamUrl.protocol === 'http:' ? 'ws:' : 'wss:';

  // Serial apply: every event goes through one chain, so an older snapshot can never land after a newer one.
  let chain = Promise.resolve();
  let last: Ordered | null = null;
  let lastConfirmedAt = -Infinity;
  const emit = (e: NeptunEvent): Promise<void> =>
    (chain = chain.then(async () => {
      let order: Ordered | null = null;
      if (e.type === 'snapshot') {
        order = { observedAt: +e.observedAt, providerTime: e.snapshot.providerTime?.getTime() ?? null };
        if (last && isOutOfOrder(order, last)) return log.info({ channel: e.channel }, 'neptun: dropped out-of-order snapshot');
      }
      // A failure of a request that started before the applied set says nothing about it; don't let it mark health.
      if (e.type === 'failure' && last && +e.observedAt < last.observedAt)
        return log.info({ channel: e.channel, kind: e.kind }, 'neptun: dropped failure older than the applied set');
      try {
        await onEvent(e);
      } catch (err) {
        log.error({ err }, 'neptun: event handler failed');
        return;
      }
      if (order) {
        last = order;
        lastConfirmedAt = order.observedAt;
      }
    }));

  const alertsEvent = (json: unknown, channel: Channel, observedAt: Date): NeptunEvent => {
    const r = parseAlerts(json);
    return r.ok
      ? { type: 'snapshot', channel, observedAt, raw: json, snapshot: r.snapshot }
      : { type: 'failure', channel, observedAt, kind: 'schema', error: r.error, raw: json };
  };

  async function fetchAlerts(): Promise<NeptunEvent> {
    const observedAt = new Date(now());
    const fail = (kind: FailureKind, error: string, raw?: unknown): NeptunEvent => ({ type: 'failure', channel: 'rest', observedAt, kind, error, raw });
    try {
      const res = await fetchImpl(alertsUrl, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.any([signal, AbortSignal.timeout(REST_TIMEOUT_MS)]),
      });
      if (!res.ok) {
        await res.body?.cancel();
        return fail(res.status === 429 ? 'http_429' : res.status >= 500 ? 'http_5xx' : 'http_error', `HTTP ${res.status}`);
      }
      const text = await res.text();
      const json = parseJson(text);
      return json.ok ? alertsEvent(json.value, 'rest', observedAt) : fail('invalid_json', 'body is not JSON', text.slice(0, MAX_RAW_TEXT));
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      return fail(e.name === 'TimeoutError' ? 'timeout' : 'network', e.message);
    }
  }

  // One REST request at a time: concurrent triggers share it, and starts are at least REST_MIN_INTERVAL_MS apart.
  let lastRestAt = -Infinity;
  let inflight: Promise<void> | null = null;
  const refresh = (reason: string): Promise<void> =>
    (inflight ??= (async () => {
      const wait = lastRestAt + REST_MIN_INTERVAL_MS - now();
      if (wait > 0) await sleep(wait, signal);
      if (signal.aborted) return;
      lastRestAt = now();
      log.debug({ reason }, 'neptun: REST snapshot');
      const event = await fetchAlerts();
      if (!signal.aborted) await emit(event); // a request cut by shutdown is not a provider failure
    })().finally(() => (inflight = null)));

  const warned = new Set<string>();
  const warnOnce = (key: string, obj: object, msg: string) => {
    if (!warned.has(key)) log.warn(obj, msg);
    warned.add(key);
  };
  // A frame we cannot even classify may be a threat track, so it is logged, not counted as an alerts failure.
  function onFrame(text: string) {
    const observedAt = new Date(now());
    const json = parseJson(text);
    if (!json.ok) return warnOnce('invalid_json', {}, 'neptun: stream frame is not JSON (ignored)');
    const env = StreamEnvelope.safeParse(json.value);
    if (!env.success) return warnOnce('envelope', { error: z.prettifyError(env.error) }, 'neptun: stream frame without an envelope (ignored)');
    switch (env.data.type) {
      case 'alerts':
        return void emit(alertsEvent(env.data.data, 'ws', observedAt));
      case 'heartbeat':
        return void emit({ type: 'heartbeat', observedAt });
      case 'snapshot':
      case 'upsert':
      case 'remove':
        return; // threat tracks: not part of the alert projection (post-MVP layer)
      default:
        warnOnce(`type:${env.data.type}`, { type: env.data.type }, 'neptun: unknown stream event type ignored');
    }
  }

  /** One socket lifetime; resolves with how long it stayed open (0 if it never opened). */
  function connectOnce(): Promise<number> {
    return new Promise((resolve) => {
      let ws: WebSocket;
      try {
        ws = new WS(streamUrl);
      } catch (err) {
        log.error({ err }, 'neptun: cannot open stream');
        return resolve(0);
      }
      let openedAt: number | null = null;
      let idle: ReturnType<typeof setTimeout> | undefined;
      let grace: ReturnType<typeof setTimeout> | undefined;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(idle);
        clearTimeout(grace);
        ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
        signal.removeEventListener('abort', shut);
        resolve(openedAt === null ? 0 : now() - openedAt);
      };
      // A close handshake on a dead network can hang: give it 5 s, then drop the socket regardless.
      const shut = () => {
        try {
          ws.close();
        } catch {
          // already closing
        }
        grace ??= setTimeout(finish, 5_000);
      };
      const bump = () => {
        clearTimeout(idle);
        idle = setTimeout(() => {
          log.warn({ idleMs: WS_IDLE_MS }, 'neptun: stream silent; reconnecting');
          shut();
        }, WS_IDLE_MS);
      };
      signal.addEventListener('abort', shut, { once: true });
      bump();
      ws.onopen = () => {
        openedAt = now();
        bump();
        log.info({}, 'neptun: stream open');
        void refresh('ws_open');
      };
      ws.onmessage = (e) => {
        bump();
        onFrame(String(e.data));
      };
      ws.onerror = () => {}; // a close event follows
      ws.onclose = finish;
    });
  }

  async function runStream() {
    let failures = 0;
    while (!signal.aborted) {
      const openMs = await connectOnce();
      if (signal.aborted) break;
      failures = openMs >= 60_000 ? 0 : failures + 1;
      const delayMs = Math.round(Math.min(WS_BACKOFF_MAX_MS, 1_000 * 2 ** failures * (0.5 + random())));
      log.warn({ failures, delayMs }, 'neptun: stream closed; reconnecting');
      await sleep(delayMs, signal);
    }
  }

  async function runPoll() {
    while (!signal.aborted) {
      await sleep(POLL_INTERVAL_MS + (random() * 2 - 1) * POLL_JITTER_MS, signal);
      // The threshold is the shortest sleep, so the poll's own previous confirmation never skips a cycle.
      if (!signal.aborted && now() - lastConfirmedAt >= POLL_INTERVAL_MS - POLL_JITTER_MS) await refresh('poll');
    }
  }

  await Promise.all([refresh('start'), runStream(), runPoll()]);
  await chain;
}
