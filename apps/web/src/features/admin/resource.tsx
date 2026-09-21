import type { Envelope } from '@aerial/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { adminFetch, hasStatus } from '../../auth/adminFetch';
import { signOut, useSession } from '../../auth/session';
import { formatKyiv } from './labels';

export type Resource<T> = { status: 'loading' | 'denied' | 'error' } | { status: 'ready'; value: T; refreshFailed?: boolean };

/**
 * Loads an admin GET and resolves with the fresh value (undefined on failure). 401 is handled by adminFetch (login
 * screen), 403 becomes the permission-denied state; a failed refresh keeps the last data so open drafts survive.
 */
export function useAdminResource<T>(path: string, schema: { parse(data: unknown): T }) {
  const [res, setRes] = useState<Resource<T>>({ status: 'loading' });
  const seq = useRef(0);
  const load = useCallback(async (): Promise<T | undefined> => {
    const n = ++seq.current; // only the latest request may set state
    try {
      const value = await adminFetch(path, schema);
      if (n === seq.current) setRes({ status: 'ready', value });
      return value;
    } catch (e) {
      if (n !== seq.current || hasStatus(e, 401)) return;
      if (hasStatus(e, 403)) setRes({ status: 'denied' });
      else setRes((prev) => (prev.status === 'ready' ? { ...prev, refreshFailed: true } : { status: 'error' }));
    }
  }, [path, schema]);
  const token = useSession().session?.token;
  useEffect(() => void load(), [load, token]); // a re-login after 401 re-reads what the hidden screen missed
  return [res, load] as const;
}

/** Loading, error and permission-denied are distinct states, not one spinner. */
export function ResourceState({ res, retry, need }: { res: Resource<unknown>; retry: () => void; need: string }) {
  if (res.status === 'loading') return <p role="status">Завантаження…</p>;
  if (res.status === 'denied')
    return (
      <div role="alert" className="banner error">
        <h2>Доступ заборонено</h2>
        <p>Сервер відхилив запит (403): потрібна роль {need}. Зверніться до адміністратора або увійдіть іншим обліковим записом.</p>
        <button type="button" onClick={() => signOut()}>
          Увійти іншим обліковим записом
        </button>
      </div>
    );
  if (res.status === 'ready' && res.refreshFailed)
    return (
      <div role="alert" className="banner warn">
        <p>Не вдалося оновити дані: показано попередню версію.</p>
        <button type="button" onClick={retry}>
          Оновити ще раз
        </button>
      </div>
    );
  if (res.status === 'error')
    return (
      <div role="alert" className="banner error">
        <p>Не вдалося завантажити дані: сервер недоступний або повернув помилку.</p>
        <button type="button" onClick={retry}>
          Спробувати ще раз
        </button>
      </div>
    );
  return null;
}

export const Time = ({ iso, empty = '—' }: { iso: string | null; empty?: string }) =>
  iso ? <time dateTime={iso}>{formatKyiv(iso)}</time> : <>{empty}</>;

export function AsOf({ env }: { env: Envelope<unknown> }) {
  return (
    <p className="hint" role="status">
      Дані станом на <Time iso={env.generatedAt} /> (Київ)
      {env.freshness !== 'fresh' && <strong> — можуть бути неактуальні ({env.freshness})</strong>}
    </p>
  );
}
