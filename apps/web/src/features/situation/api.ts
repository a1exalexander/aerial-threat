import { SituationResponse } from '@aerial/contracts';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { apiFetch } from '../../api/client';

const VISIBLE_POLL_MS = 10_000;
const HIDDEN_POLL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 8_000;
/** Same horizon as NEPTUN's "unknown": with no successful check for this long, the last tile is not shown as current. */
export const MAX_AGE_MS = 120_000;

export type Situation = {
  /** Last good response; kept after a failed refresh (the screen labels it as possibly stale). */
  data: SituationResponse | null;
  /** Error of the latest attempt; null once a later attempt succeeds. */
  error: unknown;
  /** No successful check (200 or 304) for MAX_AGE_MS: the alert state is unknown again. */
  expired: boolean;
};

/** Time of the last successful check (200 or 304). Its own store, so a 304 re-renders only the clock showing it. */
function clock() {
  let at: number | null = null;
  const subs = new Set<() => void>();
  return {
    get: () => at,
    set: (t: number) => {
      at = t;
      subs.forEach((cb) => cb());
    },
    subscribe: (cb: () => void) => {
      subs.add(cb);
      return () => void subs.delete(cb);
    },
  };
}
export type Clock = ReturnType<typeof clock>;
export const useClock = (c: Clock) => useSyncExternalStore(c.subscribe, c.get);

/**
 * Polls GET /v1/situation every 10 s while the tab is visible and every 60 s while hidden, sending the last ETag.
 * A 304 changes no state, so the screen does not re-render. Coming back online forces a full refresh.
 */
export function useSituation(): Situation & { checked: Clock } {
  const [state, setState] = useState<Situation>({ data: null, error: null, expired: false });
  const [checked] = useState(clock);

  useEffect(() => {
    let etag: string | null = null;
    let failed = false;
    let lastOk = Date.now(); // the first load counts from mount
    let timer: ReturnType<typeof setTimeout> | undefined;
    let ctrl: AbortController | undefined;

    const run = async (full = false) => {
      clearTimeout(timer);
      ctrl?.abort();
      const current = (ctrl = new AbortController());
      if (full) etag = null;
      try {
        // A hung request must fail (and keep the poll going) rather than freeze the last state on screen.
        const signal = AbortSignal.any([current.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
        const res = await apiFetch('/v1/situation', SituationResponse, { etag, signal });
        if (current.signal.aborted) return; // superseded or unmounted: a late response must not land
        lastOk = Date.now();
        checked.set(lastOk);
        if (res) {
          etag = res.etag;
          setState({ data: res.body, error: null, expired: false });
        } else if (failed) {
          setState((s) => ({ ...s, error: null, expired: false }));
        }
        failed = false;
      } catch (error) {
        if (current.signal.aborted) return;
        failed = true;
        setState((s) => ({ ...s, error, expired: Date.now() - lastOk > MAX_AGE_MS }));
      }
      timer = setTimeout(() => void run(), document.visibilityState === 'hidden' ? HIDDEN_POLL_MS : VISIBLE_POLL_MS);
    };
    const refresh = () => void run(true);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void run();
    };

    void run();
    window.addEventListener('online', refresh);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearTimeout(timer);
      ctrl?.abort();
      window.removeEventListener('online', refresh);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [checked]);

  return { ...state, checked };
}

const subscribeOnline = (cb: () => void) => {
  window.addEventListener('online', cb);
  window.addEventListener('offline', cb);
  return () => {
    window.removeEventListener('online', cb);
    window.removeEventListener('offline', cb);
  };
};
export const useOnline = () => useSyncExternalStore(subscribeOnline, () => navigator.onLine);
