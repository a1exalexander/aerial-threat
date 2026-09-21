import { NormalizedMessage } from '@aerial/contracts';
import { computeRevisionHash } from '@aerial/contracts/hash';
import { and, eq, sql } from 'drizzle-orm';
import type { Executor } from './client';
import { JOB_PRIORITY, enqueue } from './queue';
import { messageRevisions, messages, sources } from './schema';

export const PROCESS_REVISION = 'process_revision';

export type IngestResult = { status: 'imported' | 'unchanged' | 'revised'; messageId: string; revisionId: string };

/**
 * Stores one normalized message inside the caller's transaction: upserts the source-scoped message,
 * adds a revision only when the content hash is new, points messages.latest_revision_id at it and
 * enqueues its process_revision job. Revision and job commit together or not at all.
 */
export async function ingestMessage(tx: Executor, input: NormalizedMessage): Promise<IngestResult> {
  const msg = NormalizedMessage.parse(input);
  const sourceId = await sourceIdFor(tx, msg);

  const [created] = await tx
    .insert(messages)
    .values({
      sourceId,
      externalMessageId: msg.externalMessageId,
      publishedAt: new Date(msg.publishedAt),
      replyToExternalId: msg.replyToExternalId,
      mode: msg.mode,
    })
    .onConflictDoNothing({ target: [messages.sourceId, messages.externalMessageId] })
    .returning({ id: messages.id });
  // Existing message: lock it so concurrent ingests of the same post (live edit vs import) serialize.
  const [message] = created
    ? [{ id: created.id, latestRevisionId: null }]
    : await tx
        .select({ id: messages.id, latestRevisionId: messages.latestRevisionId })
        .from(messages)
        .where(and(eq(messages.sourceId, sourceId), eq(messages.externalMessageId, msg.externalMessageId)))
        .for('update');
  if (!message) throw new Error('ingestMessage: message row vanished');

  const revisionHash = computeRevisionHash(msg);
  const [inserted] = await tx
    .insert(messageRevisions)
    .values({
      messageId: message.id,
      revisionHash,
      editedAt: msg.editedAt ? new Date(msg.editedAt) : null,
      rawPayload: msg.rawPayload,
      rawText: msg.rawText,
      normalizedText: msg.normalizedText,
      cleanedText: msg.cleanedText,
      mediaFlags: msg.mediaFlags,
    })
    .onConflictDoNothing({ target: [messageRevisions.messageId, messageRevisions.revisionHash] })
    .returning({ id: messageRevisions.id });

  let revisionId = inserted?.id;
  if (!revisionId) {
    const [existing] = await tx
      .select({ id: messageRevisions.id })
      .from(messageRevisions)
      .where(and(eq(messageRevisions.messageId, message.id), eq(messageRevisions.revisionHash, revisionHash)));
    if (!existing) throw new Error('ingestMessage: revision row vanished');
    revisionId = existing.id;
    if (revisionId === message.latestRevisionId) return { status: 'unchanged', messageId: message.id, revisionId };
    // Otherwise the text was edited back to an earlier revision, which becomes current again.
  }

  await tx
    .update(messages)
    .set({
      latestRevisionId: revisionId,
      replyToExternalId: msg.replyToExternalId,
      version: created ? undefined : sql`${messages.version} + 1`,
    })
    .where(eq(messages.id, message.id));

  const priority = msg.mode === 'archive' ? JOB_PRIORITY.archive : created ? JOB_PRIORITY.live : JOB_PRIORITY.live_update;
  await enqueue(tx, {
    kind: PROCESS_REVISION,
    dedupeKey: `${PROCESS_REVISION}:${revisionId}`,
    payload: { revisionId, messageId: message.id },
    priority,
  });
  return { status: created ? 'imported' : 'revised', messageId: message.id, revisionId };
}

async function sourceIdFor(tx: Executor, msg: NormalizedMessage): Promise<string> {
  const where = and(eq(sources.provider, msg.sourceProvider), eq(sources.externalId, msg.sourceExternalId));
  const [found] = await tx.select({ id: sources.id }).from(sources).where(where);
  if (found) return found.id;
  // Unknown channel: create a bare source row; adapters fill username/display name.
  await tx.insert(sources).values({ provider: msg.sourceProvider, externalId: msg.sourceExternalId }).onConflictDoNothing();
  const [row] = await tx.select({ id: sources.id }).from(sources).where(where);
  if (!row) throw new Error('ingestMessage: source row vanished');
  return row.id;
}
