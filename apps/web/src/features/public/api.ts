import { ApiError } from '@aerial/contracts';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ApiRequestError } from '../../api/client';

const BASE_URL = import.meta.env.VITE_API_URL ?? '';
export const VISIBLE_POLL_MS = 10_000;
export const HIDDEN_POLL_MS = 60_000;

type Schema<T> = { parse(data: unknown): T };

/** GET with If-None-Match; null means 304 (the cached body is still current). */
async function fetchWithEtag<T>(path: string, schema: Schema<T>, etag: string | null, signal: AbortSignal) {
  const headers = new Headers({ accept: 'application/json' });
  if (etag) headers.set('if-none-match', etag);
  // no-store: the browser cache must not answer the conditional request for us.
  const res = await fetch(`${BASE_URL}${path}`, { headers, signal, cache: 'no-store' });
  if (res.status === 304) return null;
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) throw new ApiRequestError(res.status, ApiError.safeParse(body).data ?? null);
  return { body: schema.parse(body), etag: res.headers.get('etag') };
}

export type Resource<T> = {
  /** Last good response for this path; kept after a failed refresh (partial failure = stale label). */
  data: T | null;
  /** Error of the latest attempt; null once a later attempt succeeds. */
  error: unknown;
  reload: () => void;
};

type State<T> = { path: string | null; data: T | null; error: unknown };

/**
 * Fetches `path` and, with `poll`, refreshes every 10 s while the tab is visible and every 60 s while hidden.
 * Sends the last ETag; a 304 changes no state, so nothing re-renders. Coming back online forces a full refresh.
 */
export function useApi<T>(path: string | null, schema: Schema<T>, { poll = true } = {}): Resource<T> {
  const [state, setState] = useState<State<T>>({ path: null, data: null, error: null });
  const reloadRef = useRef(() => {});
  const reload = useCallback(() => reloadRef.current(), []);

  useEffect(() => {
    if (!path) return;
    let etag: string | null = null;
    let failed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let ctrl: AbortController | undefined;
    let stopped = false;
    let gone = false; // 404 will not fix itself: stop polling until an explicit reload

    const run = async (full = false) => {
      if (stopped) return;
      clearTimeout(timer);
      ctrl?.abort();
      const current = (ctrl = new AbortController());
      if (full) etag = null;
      try {
        const res = await fetchWithEtag(path, schema, etag, current.signal);
        if (current.signal.aborted) return; // superseded or unmounted: a late response must not land
        if (res) {
          etag = res.etag;
          setState({ path, data: res.body, error: null });
        } else if (failed) {
          setState((s) => ({ ...s, error: null }));
        }
        failed = false;
        gone = false;
      } catch (error) {
        if (current.signal.aborted) return;
        failed = true;
        gone = error instanceof ApiRequestError && error.status === 404;
        setState((s) => (s.path === path ? { ...s, error } : { path, data: null, error }));
      }
      if (poll && !gone && !current.signal.aborted) {
        timer = setTimeout(() => void run(), document.visibilityState === 'hidden' ? HIDDEN_POLL_MS : VISIBLE_POLL_MS);
      }
    };
    const refresh = () => void run(true);
    reloadRef.current = refresh;
    const onVisible = () => {
      if (document.visibilityState === 'visible') void run();
    };

    void run();
    window.addEventListener('online', refresh);
    if (poll) document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      reloadRef.current = () => {};
      clearTimeout(timer);
      ctrl?.abort();
      window.removeEventListener('online', refresh);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [path, schema, poll]);

  // Data of a previous path is never shown under a new one.
  return state.path === path ? { data: state.data, error: state.error, reload } : { data: null, error: null, reload };
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
