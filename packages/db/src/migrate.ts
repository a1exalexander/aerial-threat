// Plain-SQL migration runner: applies migrations/NNNN_<slug>.sql in filename order, each in its own
// transaction, tracked in schema_migrations. No journal, so parallel branches only add files.
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));
const FILE_RE = /^\d{4}_[a-z0-9_]+\.sql$/;
const LOCK_ID = 7_431_001; // pg_advisory_lock key: one runner at a time per database

/** Applies pending migrations; returns the filenames applied now. Refuses if an applied file was edited. */
export async function migrate(url: string, dir = MIGRATIONS_DIR): Promise<string[]> {
  const files = (await readdir(dir)).filter((f) => FILE_RE.test(f)).sort();
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await sql`select pg_advisory_lock(${LOCK_ID})`;
    await sql`create table if not exists schema_migrations (
      filename text primary key,
      checksum text not null,
      applied_at timestamptz not null default now()
    )`;
    const applied = new Map(
      (await sql<{ filename: string; checksum: string }[]>`select filename, checksum from schema_migrations`).map((r) => [
        r.filename,
        r.checksum,
      ]),
    );
    const done: string[] = [];
    for (const file of files) {
      const content = await readFile(`${dir}/${file}`, 'utf8');
      const checksum = createHash('sha256').update(content).digest('hex');
      const known = applied.get(file);
      if (known === checksum) continue;
      if (known) throw new Error(`Migration ${file} was edited after it was applied; add a new migration instead.`);
      await sql.begin(async (tx) => {
        await tx.unsafe(content);
        await tx`insert into schema_migrations (filename, checksum) values (${file}, ${checksum})`;
      });
      done.push(file);
    }
    return done;
  } finally {
    await sql`select pg_advisory_unlock(${LOCK_ID})`.catch(() => {});
    await sql.end({ timeout: 5 });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  const applied = await migrate(url);
  console.log(applied.length ? `applied: ${applied.join(', ')}` : 'up to date');
}
