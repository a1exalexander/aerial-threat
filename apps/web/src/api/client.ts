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

/** Fetches JSON from the Aerial Threat API and validates it against a contract; never trusts the shape. */
export async function apiFetch<T>(path: string, schema: Schema<T>, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('accept', 'application/json');
  const res = await fetch(`${BASE_URL}${path}`, { ...init, headers });
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) throw new ApiRequestError(res.status, ApiError.safeParse(body).data ?? null);
  return schema.parse(body);
}
