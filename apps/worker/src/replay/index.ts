// `cli replay --from <iso> --to <iso> [--speed <x>] [--target <db url>]`: re-feeds the stored posts of a time
// window, in publish order on a virtual clock, into a freshly created `*_replay` database. The source database
// (DATABASE_URL) is only read, and replayed posts keep mode=archive, so no live state is ever touched.
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { loadWorkerEnv } from '@aerial/config';
import type { MediaFlag, NormalizedMessage } from '@aerial/contracts';
import { type Db, createDb, ingestMessage, messageRevisions, messages, sources } from '@aerial/db';
import { migrate } from '@aerial/db/migrate';
import { and, asc, eq, gte, inArray, isNull, lt } from '@aerial/db/orm';
import { VirtualClock, runReplay } from './runner';

export type ReplayOptions = { sourceUrl: string; targetUrl: string; from: Date; to: Date; speed: number; sleep: (ms: number) => Promise<void> };

const dbName = (url: string) => new URL(url).pathname.slice(1);

export async function replayWindow(o: ReplayOptions): Promise<{ delivered: number; target: string; clock: Date }> {
  const target = dbName(o.targetUrl);
  const sameDb = (a: string, b: string) => new URL(a).host === new URL(b).host && dbName(a) === dbName(b);
  // The target is dropped and recreated: only a dedicated *_replay database may be one.
  if (!/^[a-z\d_]+_replay$/.test(target) || sameDb(o.sourceUrl, o.targetUrl)) {
    throw new Error(`replay target must be a separate database named *_replay, got "${target}"`);
  }
  const adminUrl = new URL(o.targetUrl);
  adminUrl.pathname = '/postgres';
  const admin = createDb(adminUrl.toString(), { max: 1 });
  try {
    await admin.sql.unsafe(`drop database if exists ${target} with (force)`);
    await admin.sql.unsafe(`create database ${target}`);
  } finally {
    await admin.close();
  }
  await migrate(o.targetUrl);

  const source = createDb(o.sourceUrl, { max: 1 });
  const dest = createDb(o.targetUrl, { max: 1 });
  try {
    const posts = await readWindow(source.db, o.from, o.to);
    const channels = [...new Set(posts.map((p) => p.sourceExternalId))];
    if (channels.length) {
      const rows = await source.db
        .select({ provider: sources.provider, externalId: sources.externalId, username: sources.username, displayName: sources.displayName, defaultPlaceId: sources.defaultPlaceId })
        .from(sources)
        .where(and(eq(sources.provider, 'telegram'), inArray(sources.externalId, channels)));
      await dest.db.insert(sources).values(rows).onConflictDoNothing();
    }
    const clock = new VirtualClock(o.from);
    const delivered = await runReplay({
      items: posts,
      at: (p) => new Date(p.publishedAt),
      to: o.to,
      speed: o.speed,
      clock,
      sleep: o.sleep,
      deliver: (post, now) =>
        dest.db.transaction(async (tx) => {
          const r = await ingestMessage(tx, post);
          // Arrival is stamped with virtual time so the replayed dataset is consistent with its clock.
          await tx.update(messages).set({ receivedAt: now }).where(eq(messages.id, r.messageId));
          await tx.update(messageRevisions).set({ observedAt: now }).where(eq(messageRevisions.id, r.revisionId));
        }),
    });
    return { delivered, target, clock: clock.now() };
  } finally {
    await Promise.all([source.close(), dest.close()]);
  }
}

// ponytail: replays each post's latest revision at its publish time; replay edits at their observed_at once
// live revision history exists, and preload reply parents/context from before `from` if windows cut chains.
async function readWindow(db: Db, from: Date, to: Date): Promise<NormalizedMessage[]> {
  const rows = await db
    .select({ m: messages, r: messageRevisions, sourceExternalId: sources.externalId })
    .from(messages)
    .innerJoin(messageRevisions, eq(messageRevisions.id, messages.latestRevisionId))
    .innerJoin(sources, eq(sources.id, messages.sourceId))
    .where(and(eq(sources.provider, 'telegram'), gte(messages.publishedAt, from), lt(messages.publishedAt, to), isNull(messages.deletedAt)))
    .orderBy(asc(messages.publishedAt), asc(messages.externalMessageId));
  return rows.map(({ m, r, sourceExternalId }) => ({
    sourceProvider: 'telegram',
    sourceExternalId,
    externalMessageId: m.externalMessageId,
    publishedAt: m.publishedAt.toISOString(),
    editedAt: r.editedAt?.toISOString() ?? null,
    replyToExternalId: m.replyToExternalId,
    rawText: r.rawText,
    normalizedText: r.normalizedText,
    cleanedText: r.cleanedText,
    mediaFlags: r.mediaFlags as MediaFlag[],
    rawPayload: r.rawPayload ?? {},
    mode: 'archive',
  }));
}

const USAGE = 'usage: cli replay --from <iso> --to <iso> [--speed <virtual/real, default 1; Infinity = no wait>] [--target <postgres url of a *_replay db>]';

export async function run(argv: string[]): Promise<number> {
  let values: { from?: string; to?: string; speed?: string; target?: string };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: { from: { type: 'string' }, to: { type: 'string' }, speed: { type: 'string', default: '1' }, target: { type: 'string' } },
    }));
  } catch (err) {
    console.error(`${(err as Error).message}\n${USAGE}`);
    return 1;
  }
  const from = new Date(values.from ?? '');
  const to = new Date(values.to ?? '');
  const speed = Number(values.speed);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to || !(speed > 0)) {
    console.error(USAGE);
    return 1;
  }
  const sourceUrl = loadWorkerEnv().DATABASE_URL;
  const targetUrl = values.target ?? Object.assign(new URL(sourceUrl), { pathname: `/${dbName(sourceUrl)}_replay` }).toString();
  const started = performance.now();
  const r = await replayWindow({ sourceUrl, targetUrl, from, to, speed, sleep: (ms) => sleep(ms) });
  console.log(
    `replay ${from.toISOString()} -> ${to.toISOString()} at x${speed}: ${r.delivered} posts into ${r.target}; ` +
      `virtual clock ${r.clock.toISOString()}, ${Math.round(performance.now() - started)} ms real`,
  );
  return 0;
}
