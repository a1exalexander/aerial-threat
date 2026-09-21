import { ApiError } from '@aerial/contracts';

const BASE_URL = import.meta.env.VITE_API_URL ?? '';

export class ApiRequestError extends Error {
  readonly status: number;
  /** Parsed { code, requestId, message } when the server sent one. */
  readonly error: ApiError | null;

  constructor(status: number, error: ApiError | null) {
    super(error?.message ?? `HTTP ${status}`);
    this.status = status;
    this.error = error;
  }
}

/** Any @aerial/contracts schema (or anything with a zod-like parse). */
type Schema<T> = { parse(data: unknown): T };

export type Fetched<T> = { body: T; etag: string | null };

/**
 * GETs JSON from the Aerial Threat API and validates it against a contract; never trusts the shape.
 * With `etag` it sends If-None-Match and resolves null on 304 (the body the caller holds is still current).
 */
export async function apiFetch<T>(
  path: string,
  schema: Schema<T>,
  { etag = null, signal }: { etag?: string | null; signal?: AbortSignal } = {},
): Promise<Fetched<T> | null> {
  const headers = new Headers({ accept: 'application/json' });
  if (etag) headers.set('if-none-match', etag);
  // no-store: the browser cache must not answer the conditional request for us.
  const res = await fetch(`${BASE_URL}${path}`, { headers, signal, cache: 'no-store' });
  if (res.status === 304) return null;
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) throw new ApiRequestError(res.status, ApiError.safeParse(body).data ?? null);
  return { body: schema.parse(body), etag: res.headers.get('etag') };
}
