import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { is } from 'drizzle-orm';
import { PgTable, getTableConfig } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, migrate } from './migrate';
import * as schema from './schema';
import { createTestDb } from './testing';

let t: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t?.drop());

describe('migrations', () => {
  it('drizzle schema.ts matches the applied SQL (tables, columns, types, nullability, indexes)', async () => {
    const tables = Object.values(schema).filter((v) => is(v, PgTable)).map((tbl) => getTableConfig(tbl));
    const expectedColumns = tables.flatMap((c) =>
      c.columns.map((col) => `${c.name}.${col.name} ${col.getSQLType()}${col.notNull ? ' not null' : ''}`),
    );
    const actualColumns = await t.sql<{ col: string }[]>`
      select c.relname || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod)
        || case when a.attnotnull then ' not null' else '' end as col
      from pg_attribute a
      join pg_class c on c.oid = a.attrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
        and c.relname <> 'schema_migrations'`;
    expect(actualColumns.map((r) => r.col).sort()).toEqual(expectedColumns.sort());

    const expectedIndexes = tables.flatMap((c) => c.indexes.map((i) => i.config.name));
    const actualIndexes = await t.sql<{ indexname: string }[]>`
      select indexname from pg_indexes
      where schemaname = 'public' and indexname not like '%_pkey'`;
    expect(actualIndexes.map((r) => r.indexname).sort()).toEqual(expectedIndexes.sort());
  });

  it('is a no-op on rerun and refuses edited applied files', async () => {
    expect(await migrate(t.url)).toEqual([]);
    const dir = await mkdtemp(join(tmpdir(), 'aerial-migrations-'));
    const original = await readFile(join(MIGRATIONS_DIR, '0001_init.sql'), 'utf8');
    await writeFile(join(dir, '0001_init.sql'), `${original}\n-- edited\n`);
    await expect(migrate(t.url, dir)).rejects.toThrow(/0001_init\.sql was edited/);
  });
});
