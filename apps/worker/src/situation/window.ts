// Reads of the Kremenchuk window: latest revisions of KREMENCHUK_SOURCES posts, noise dropped, PII redacted.
import { redact } from '@aerial/ai';
import { type Executor, messageRevisions, messages, sources } from '@aerial/db';
import { and, count, desc, eq, gt, inArray, isNull, lte, ne, or, sql } from '@aerial/db/orm';
import { type SituationMessage, isNoise } from '@aerial/domain/situation';
import { extractPlaceCandidates } from '@aerial/geo/match';

export const MAX_WINDOW_POSTS = 20;
// ponytail: noise is dropped after the SQL limit; a window with >180 noise posts in a row gets fewer than 20.
const SCAN_LIMIT = 200;

/** Telegram sources listed in KREMENCHUK_SOURCES, by username (any case) or channel ID. */
const listed = (list: string[]) =>
  and(
    eq(sources.provider, 'telegram'),
    or(
      inArray(
        sql`lower(${sources.username})`,
        list.map((s) => s.toLowerCase()),
      ),
      inArray(sources.externalId, list),
    ),
  );

/** Current, non-empty Kremenchuk posts published in (from, to]. */
const posts = (list: string[], from: Date, to: Date) =>
  and(listed(list), isNull(messages.deletedAt), ne(messageRevisions.cleanedText, ''), gt(messages.publishedAt, from), lte(messages.publishedAt, to));

/**
 * The window in publish order (oldest first): at most 20 newest non-noise posts published in (from, to].
 * isNoise sees the original text (it looks for card numbers); everything returned is redacted, so no evaluator
 * ever gets a phone or card number. Revision IDs are kept as-is.
 */
export async function loadWindow(db: Executor, o: { sources: string[]; from: Date; to: Date }): Promise<SituationMessage[]> {
  const replyToText = sql<string | null>`(
    select pr.cleaned_text from messages pm join message_revisions pr on pr.id = pm.latest_revision_id
    where pm.source_id = ${messages.sourceId} and pm.external_message_id = ${messages.replyToExternalId} and pm.deleted_at is null)`;
  const rows = await db
    .select({
      revisionId: messageRevisions.id,
      sourceId: sources.id,
      sourceName: sql<string>`coalesce(${sources.displayName}, ${sources.username}, ${sources.externalId})`,
      messageId: messages.externalMessageId,
      publishedAt: messages.publishedAt,
      text: messageRevisions.cleanedText,
      replyToText,
    })
    .from(messages)
    .innerJoin(sources, eq(sources.id, messages.sourceId))
    .innerJoin(messageRevisions, eq(messageRevisions.id, messages.latestRevisionId))
    .where(posts(o.sources, o.from, o.to))
    .orderBy(desc(messages.publishedAt), desc(messages.externalMessageId))
    .limit(SCAN_LIMIT);

  // Public channel handles stay readable; any other @handle may be a private person.
  const clean = (text: string) => redact(text, { keepHandles: o.sources }).text;
  return rows
    .filter((r) => !isNoise(r.text))
    .slice(0, MAX_WINDOW_POSTS)
    .reverse()
    .map((r) => {
      const text = clean(r.text);
      return { ...r, text, replyToText: r.replyToText ? clean(r.replyToText) : null, placeCandidates: extractPlaceCandidates(text) };
    });
}

/** How many Kremenchuk posts were published in (from, to]. The replay's new-post signal. */
export async function countPosts(db: Executor, o: { sources: string[]; from: Date; to: Date }): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(messages)
    .innerJoin(sources, eq(sources.id, messages.sourceId))
    .innerJoin(messageRevisions, eq(messageRevisions.id, messages.latestRevisionId))
    .where(posts(o.sources, o.from, o.to));
  return row?.n ?? 0;
}

/** Which of these revisions belong to Kremenchuk sources. */
export async function kremenchukRevisions(db: Executor, list: string[], revisionIds: string[]): Promise<string[]> {
  if (!revisionIds.length) return [];
  const rows = await db
    .select({ id: messageRevisions.id })
    .from(messageRevisions)
    .innerJoin(messages, eq(messages.id, messageRevisions.messageId))
    .innerJoin(sources, eq(sources.id, messages.sourceId))
    .where(and(inArray(messageRevisions.id, revisionIds), listed(list)));
  return rows.map((r) => r.id);
}
