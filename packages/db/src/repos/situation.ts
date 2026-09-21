// Kremenchuk screen storage: situation_snapshots (evaluations of the channel window) and the NEPTUN state of the
// raion as the screen and the AI gating see it. Snapshots never write alert_states.
import { type AlertStateDto, type FeedItem, type Freshness, KREMENCHUK, type SituationMode } from '@aerial/contracts';
import { byId } from '@aerial/geo';
import { and, desc, eq, gte, inArray, isNull, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Executor } from '../client';
import { alertStates, messageRevisions, messages, situationSnapshots, sources } from '../schema';
import { redact } from './admin';
import { alertDto, publicUsername, telegramUrl } from './read/policy';

export type SituationSnapshot = typeof situationSnapshots.$inferSelect;
export type NewSituationSnapshot = typeof situationSnapshots.$inferInsert;
export type SituationSnapshotStatus = SituationSnapshot['status'];

export async function insertSnapshot(db: Executor, row: NewSituationSnapshot): Promise<SituationSnapshot> {
  const [out] = await db.insert(situationSnapshots).values(row).returning();
  return out!;
}

/** The newest snapshot of the area by evaluated_at, optionally of one mode and/or status; null when none. */
export async function latestSnapshot(
  db: Executor,
  areaId: string,
  opts: { mode?: SituationMode; status?: SituationSnapshotStatus } = {},
): Promise<SituationSnapshot | null> {
  const [row] = await db
    .select()
    .from(situationSnapshots)
    .where(
      and(
        eq(situationSnapshots.areaId, areaId),
        opts.mode ? eq(situationSnapshots.mode, opts.mode) : undefined,
        opts.status ? eq(situationSnapshots.status, opts.status) : undefined,
      ),
    )
    .orderBy(desc(situationSnapshots.evaluatedAt), desc(situationSnapshots.createdAt))
    .limit(1);
  return row ?? null;
}

const RAION = byId(KREMENCHUK.raionId)!;
const OBLAST = byId(KREMENCHUK.oblastId)!;
const RAION_KEY = RAION.neptunKeys[0]!;
const OBLAST_KEY = OBLAST.neptunKeys[0]!;

/**
 * NEPTUN state of Кременчуцький район with freshness recomputed from last_success_at (the read API policy:
 * stale after 30 s, unknown after 120 s). Without a raion row the state is unknown; the oblast row then only
 * tells how fresh the feed is and never stands in for the raion's state (it may be a partial alert elsewhere).
 */
export async function kremenchukAlert(db: Executor, now = new Date()): Promise<AlertStateDto> {
  const rows = await db.select().from(alertStates).where(inArray(alertStates.areaKey, [RAION_KEY, OBLAST_KEY]));
  const raion = rows.find((r) => r.areaKey === RAION_KEY);
  if (raion) return alertDto(RAION_KEY, RAION, raion, now);
  const oblast = rows.find((r) => r.areaKey === OBLAST_KEY);
  const feed = oblast && alertDto(OBLAST_KEY, OBLAST, oblast, now);
  return {
    ...alertDto(RAION_KEY, RAION, undefined, now),
    ...(feed && { freshness: feed.freshness, lastSuccessfulFetchAt: feed.lastSuccessfulFetchAt }),
  };
}

/** True while NEPTUN reports the raion under alert (fresh or stale); unknown is not active. */
export const isKremenchukAlertActive = async (db: Executor, now = new Date()): Promise<boolean> =>
  (await kremenchukAlert(db, now)).state === 'active';

/**
 * How old a snapshot may be for the screen to trust its statuses (by evaluated_at): fresh up to 3 min (the worker
 * evaluates every minute, so this allows two missed runs), stale up to 15 min, unknown after that. An unknown
 * evaluation no longer feeds the tile, so an old threat never keeps the screen amber.
 */
export const EVALUATION_FRESHNESS = { staleAfterMs: 3 * 60_000, unknownAfterMs: 15 * 60_000 } as const;

export function evaluationFreshness(evaluatedAt: Date, now: Date): Freshness {
  const age = now.getTime() - evaluatedAt.getTime();
  return age > EVALUATION_FRESHNESS.unknownAfterMs ? 'unknown' : age > EVALUATION_FRESHNESS.staleAfterMs ? 'stale' : 'fresh';
}

/** IDs of the Telegram sources named in KREMENCHUK_SOURCES, by username (any case) or bare channel ID. */
export async function situationSourceIds(db: Executor, refs: readonly string[]): Promise<string[]> {
  if (refs.length === 0) return [];
  const rows = await db
    .select({ id: sources.id })
    .from(sources)
    .where(
      and(
        eq(sources.provider, 'telegram'),
        or(inArray(sql`lower(${sources.username})`, refs.map((r) => r.toLowerCase())), inArray(sources.externalId, [...refs])),
      ),
    );
  return rows.map((r) => r.id);
}

export const REPLY_TEXT_MAX = 140;

const shorten = (text: string, max: number) => {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : text;
};

/**
 * Posts of the sources published since `since`, newest first: the latest revision of each message that is not
 * deleted, with `keep` applied to the unredacted text (also of the replied-to post), cut to `limit`. Revisions
 * without text (media only, or scrubbed by retention) are skipped. Texts are redacted (phones, card numbers,
 * e-mails); raw payloads are never read.
 */
export async function situationFeed(
  db: Executor,
  opts: { sourceIds: string[]; since: Date; limit: number; keep: (post: { id: string; text: string }) => boolean },
): Promise<FeedItem[]> {
  if (opts.sourceIds.length === 0) return [];
  const parent = alias(messages, 'parent');
  const parentRevision = alias(messageRevisions, 'parent_revision');
  // ponytail: loads the whole window before `keep` and the limit (a few hundred posts of two channels in 6 h);
  // push the relevance filter into SQL if a busy source is ever added.
  const rows = await db
    .select({
      id: messageRevisions.id,
      provider: sources.provider,
      username: sources.username,
      displayName: sources.displayName,
      messageId: messages.externalMessageId,
      publishedAt: messages.publishedAt,
      editedAt: messageRevisions.editedAt,
      text: sql<string>`coalesce(nullif(${messageRevisions.cleanedText}, ''), ${messageRevisions.normalizedText})`,
      replyToId: parentRevision.id,
      replyToText: sql<string | null>`coalesce(nullif(${parentRevision.cleanedText}, ''), ${parentRevision.normalizedText})`,
    })
    .from(messages)
    .innerJoin(sources, eq(sources.id, messages.sourceId))
    .innerJoin(messageRevisions, eq(messageRevisions.id, messages.latestRevisionId))
    .leftJoin(
      parent,
      and(eq(parent.sourceId, messages.sourceId), eq(parent.externalMessageId, messages.replyToExternalId), isNull(parent.deletedAt)),
    )
    .leftJoin(parentRevision, eq(parentRevision.id, parent.latestRevisionId))
    .where(and(inArray(messages.sourceId, opts.sourceIds), isNull(messages.deletedAt), gte(messages.publishedAt, opts.since)))
    .orderBy(desc(messages.publishedAt), desc(messages.id));

  return rows
    .filter((r) => r.text.trim() !== '' && opts.keep(r))
    .slice(0, opts.limit)
    .map((r) => {
      const username = publicUsername(r.provider, r.username);
      return {
        id: r.id,
        sourceName: r.displayName ?? username ?? r.provider,
        sourceUsername: username,
        messageId: r.messageId,
        publishedAt: r.publishedAt.toISOString(),
        editedAt: r.editedAt?.toISOString() ?? null,
        text: redact(r.text),
        replyToText:
          r.replyToId && r.replyToText?.trim() && opts.keep({ id: r.replyToId, text: r.replyToText })
            ? shorten(redact(r.replyToText), REPLY_TEXT_MAX)
            : null,
        link: telegramUrl(username, r.messageId),
      };
    });
}
