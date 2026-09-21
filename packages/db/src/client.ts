import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

export function createDb(url: string, opts: { max?: number } = {}) {
  const sql = postgres(url, { max: opts.max ?? 10, connect_timeout: 10, onnotice: () => {} });
  const db = drizzle(sql, { schema });
  return { db, sql, close: () => sql.end({ timeout: 5 }) };
}

export type Database = ReturnType<typeof createDb>;
export type Db = Database['db'];
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
/** A plain handle or an open transaction; functions taking it join the caller's transaction. */
export type Executor = Db | Tx;
