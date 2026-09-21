// `cli import --file <result.json> [--username <channel>]`: Telegram Desktop channel export -> archive messages.
// Idempotent through ingestMessage: a rerun of the same file adds no message, revision or job.
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadWorkerEnv } from '@aerial/config';
import type { NormalizedMessage } from '@aerial/contracts';
import { type Db, createDb, importRuns, ingestMessage, messageRevisions, messages, sources } from '@aerial/db';
import { TransactionRollbackError, and, eq, inArray, sql } from '@aerial/db/orm';
import { ExportFormatError, parseTelegramExport } from '@aerial/telegram/export';

export const MAX_EXPORT_BYTES = 256 * 1024 * 1024;

type Issue = { index: number; id: string | null; reason: string };

export type ImportResult = {
  runId: string;
  fileHash: string;
  source: { id: string; externalId: string; name: string };
  /** imported + unchanged + invalid + unsupported = total; the rest are informational sub-counts. */
  counters: {
    total: number;
    imported: number;
    unchanged: number;
    invalid: number;
    unsupported: number;
    revised: number;
    skippedLive: number;
    skippedOlder: number;
    mediaOnly: number;
    missingContext: number;
  };
  report: { quarantine: Issue[]; unsupported: Issue[]; missingContext: Array<{ id: string; replyTo: string }> };
};

export async function importTelegramExport(db: Db, input: { bytes: Buffer; username?: string }): Promise<ImportResult> {
  const fileHash = createHash('sha256').update(input.bytes).digest('hex');
  const [run] = await db.insert(importRuns).values({ fileHash }).returning({ id: importRuns.id });
  if (!run) throw new Error('import: could not start import_run');
  try {
    const result = await importParsed(db, run.id, fileHash, input);
    await db
      .update(importRuns)
      .set({ status: 'succeeded', counters: result.counters, report: result.report, finishedAt: new Date() })
      .where(eq(importRuns.id, run.id));
    return result;
  } catch (err) {
    const error = (err instanceof Error ? err.message : String(err)).slice(0, 2000);
    await db.update(importRuns).set({ status: 'failed', error, finishedAt: new Date() }).where(eq(importRuns.id, run.id));
    throw err;
  }
}

async function importParsed(db: Db, runId: string, fileHash: string, input: { bytes: Buffer; username?: string }): Promise<ImportResult> {
  let json: unknown;
  try {
    json = JSON.parse(input.bytes.toString('utf8'));
  } catch {
    throw new ExportFormatError('file is not valid JSON');
  }
  const parsed = parseTelegramExport(json);
  const [source] = await db
    .insert(sources)
    .values({ provider: 'telegram', externalId: parsed.source.externalId, displayName: parsed.source.name, username: input.username })
    .onConflictDoUpdate({
      target: [sources.provider, sources.externalId],
      // Fill blanks only: a live collector or operator may already own these fields.
      set: { displayName: sql`coalesce(${sources.displayName}, excluded.display_name)`, username: sql`coalesce(${sources.username}, excluded.username)` },
    })
    .returning({ id: sources.id });
  if (!source) throw new Error('import: could not upsert source');
  await db.update(importRuns).set({ sourceId: source.id }).where(eq(importRuns.id, runId));

  const counters = { total: parsed.records.length, imported: 0, unchanged: 0, invalid: 0, unsupported: 0, revised: 0, skippedLive: 0, skippedOlder: 0, mediaOnly: 0, missingContext: 0 };
  const report: ImportResult['report'] = { quarantine: [], unsupported: [], missingContext: [] };
  const posts: NormalizedMessage[] = [];
  for (const r of parsed.records) {
    if (r.status === 'message') posts.push(r.message);
    else {
      counters[r.status]++;
      report[r.status === 'invalid' ? 'quarantine' : 'unsupported'].push({ index: r.index, id: r.externalMessageId, reason: r.reason });
    }
  }

  // Published time, then stable ID: parents land before their replies.
  posts.sort((a, b) => a.publishedAt.localeCompare(b.publishedAt) || Number(a.externalMessageId) - Number(b.externalMessageId));
  for (const post of posts) {
    const status = await ingestArchivePost(db, source.id, post);
    if (status === 'live') counters.skippedLive++;
    if (status === 'older') counters.skippedOlder++;
    if (status === 'revised') counters.revised++;
    counters[status === 'imported' || status === 'revised' ? 'imported' : 'unchanged']++;
    if (!post.rawText.trim() && post.mediaFlags.length) counters.mediaOnly++;
  }

  // Second pass, after every post of the file is stored: a reply whose parent is in neither this file nor an
  // earlier import has missing context. It is reported, never invented and never fatal.
  const parents = [...new Set(posts.flatMap((p) => p.replyToExternalId ?? []))];
  const known = parents.length
    ? await db
        .select({ id: messages.externalMessageId })
        .from(messages)
        .where(and(eq(messages.sourceId, source.id), inArray(messages.externalMessageId, parents)))
    : [];
  const have = new Set(known.map((k) => k.id));
  for (const p of posts) {
    if (p.replyToExternalId && !have.has(p.replyToExternalId)) report.missingContext.push({ id: p.externalMessageId, replyTo: p.replyToExternalId });
  }
  counters.missingContext = report.missingContext.length;

  if (counters.imported + counters.unchanged + counters.invalid + counters.unsupported !== counters.total) {
    throw new Error(`import: accounted ${JSON.stringify(counters)} does not add up to the file total`);
  }
  return { runId, fileHash, source: { id: source.id, ...parsed.source }, counters, report };
}

/**
 * One transaction per post: revision + job commit together, and a crash mid-file resumes idempotently on rerun.
 * Never rewrites a post the live collector owns (that would feed the live projection), and never lets an
 * older export roll a post back to an earlier text.
 */
async function ingestArchivePost(db: Db, sourceId: string, post: NormalizedMessage) {
  const byId = and(eq(messages.sourceId, sourceId), eq(messages.externalMessageId, post.externalMessageId));
  return db
    .transaction(async (tx) => {
      const [current] = await tx
        .select({ mode: messages.mode, editedAt: messageRevisions.editedAt })
        .from(messages)
        .leftJoin(messageRevisions, eq(messageRevisions.id, messages.latestRevisionId))
        .where(byId)
        .for('update', { of: messages });
      if (current?.mode === 'live') return 'live';
      if (current?.editedAt && new Date(post.editedAt ?? post.publishedAt) < current.editedAt) return 'older';
      const { status } = await ingestMessage(tx, post);
      // No row to lock above: the live collector may have inserted the post since. Undo if it did.
      if (!current && status !== 'imported') {
        const [row] = await tx.select({ mode: messages.mode }).from(messages).where(byId);
        if (row?.mode === 'live') tx.rollback();
      }
      return status;
    })
    .catch((err: unknown) => {
      if (err instanceof TransactionRollbackError) return 'live' as const;
      throw err;
    });
}

const USAGE = 'usage: cli import --file <result.json> [--username <channel username>]';

export async function run(argv: string[]): Promise<number> {
  let values: { file?: string; username?: string };
  try {
    ({ values } = parseArgs({ args: argv, options: { file: { type: 'string' }, username: { type: 'string' } } }));
  } catch (err) {
    console.error(`${(err as Error).message}\n${USAGE}`);
    return 1;
  }
  if (!values.file || (values.username !== undefined && !/^[A-Za-z\d_]{4,32}$/.test(values.username))) {
    console.error(USAGE);
    return 1;
  }
  // `pnpm --filter … cli` runs in apps/worker; resolve paths against where the user typed the command.
  const path = resolve(process.env.INIT_CWD ?? process.cwd(), values.file);
  const size = await stat(path).then((s) => s.size, () => -1);
  if (size < 0 || size > MAX_EXPORT_BYTES) {
    console.error(size < 0 ? `import: cannot read ${path}` : `import: ${path} is ${size} bytes, over the ${MAX_EXPORT_BYTES} byte limit`);
    return 1;
  }

  const database = createDb(loadWorkerEnv().DATABASE_URL, { max: 2 });
  try {
    const r = await importTelegramExport(database.db, { bytes: await readFile(path), username: values.username });
    const { total, imported, unchanged, invalid, unsupported, ...extra } = r.counters;
    console.log(`import run ${r.runId}: telegram ${r.source.externalId} "${r.source.name}", file sha256 ${r.fileHash}`);
    console.log(`total=${total} imported=${imported} unchanged=${unchanged} invalid=${invalid} unsupported=${unsupported}`);
    console.log(Object.entries(extra).map(([k, v]) => `${k}=${v}`).join(' '));
    for (const q of r.report.quarantine) console.log(`quarantined #${q.index} id=${q.id ?? '?'}: ${q.reason}`);
    for (const u of r.report.unsupported) console.log(`unsupported #${u.index} id=${u.id ?? '?'}: ${u.reason}`);
    for (const m of r.report.missingContext) console.log(`missing_context ${m.id} -> ${m.replyTo}`);
    return 0;
  } catch (err) {
    if (!(err instanceof ExportFormatError)) throw err;
    console.error(`import: ${err.message}`);
    return 1;
  } finally {
    await database.close();
  }
}
