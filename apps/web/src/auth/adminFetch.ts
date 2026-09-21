import { ApiRequestError, apiFetch } from '../api/client';
import { currentToken, signOut } from './session';

/**
 * apiFetch for /v1/admin/*: adds the bearer token and maps 401 to a logged-out session («увійдіть знову»).
 * 403 and 409 surface as ApiRequestError for the screen: permission-denied state and the conflict flow.
 */
export async function adminFetch<T>(path: string, schema: { parse(data: unknown): T }, init: RequestInit = {}): Promise<T> {
  const token = currentToken();
  if (!token) throw new ApiRequestError(401, null);
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${token}`);
  if (init.body) headers.set('content-type', 'application/json');
  try {
    return await apiFetch(path, schema, { ...init, headers });
  } catch (e) {
    // Only drop the session this request used; a fresh login may have replaced it meanwhile.
    if (e instanceof ApiRequestError && e.status === 401 && currentToken() === token) signOut(true);
    throw e;
  }
}

export const hasStatus = (e: unknown, status: number) => e instanceof ApiRequestError && e.status === status;
