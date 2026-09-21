// Live Telegram adapter contract: a small TelegramSource interface (GramJS in production, a fake in
// tests) that yields NormalizedMessage. Persistence, checkpoints and retries live in the worker's loop.
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { MediaFlag, NormalizedMessage } from '@aerial/contracts';

export type ChannelInfo = { channelId: string; username: string; title: string; pts: number };

/** One content change of a channel, in server order. Edits arrive as the message's new full content. */
export type Change = { kind: 'message'; message: NormalizedMessage } | { kind: 'delete'; ids: string[] };

/** A pushed update. pts/ptsCount follow https://core.telegram.org/api/updates (channel sequence). */
export type LiveUpdate =
  | (Change & { channelId: string; pts: number; ptsCount: number })
  | { kind: 'tooLong'; channelId: string }
  | { kind: 'reconnected' };

export type ChannelDifference = { changes: Change[]; pts: number; final: boolean; tooLong: boolean };

export interface TelegramSource {
  /** Idempotent. Throws TelegramAuthLost when the session is missing or no longer authorized. */
  connect(): Promise<void>;
  /** Username -> stable channel ID plus its current pts. Throws TelegramChannelUnavailable. */
  resolveChannel(username: string): Promise<ChannelInfo>;
  /** Current content of messages published at or after `since`, bounded, newest first. */
  recentMessages(channelId: string, since: Date): Promise<NormalizedMessage[]>;
  /** Changes after `pts` (one page); `tooLong` means the gap must be refilled from history instead. */
  getChannelDifference(channelId: string, pts: number): Promise<ChannelDifference>;
  onUpdate(cb: (update: LiveUpdate) => void): void;
  disconnect(): Promise<void>;
}

export class TelegramFloodWait extends Error {
  override name = 'TelegramFloodWait';
  constructor(readonly seconds: number) {
    super(`FLOOD_WAIT ${seconds}s`);
  }
}
/** Session revoked/expired/unregistered: needs an operator to run `cli telegram-login`. Never retried. */
export class TelegramAuthLost extends Error {
  override name = 'TelegramAuthLost';
}
/** Username not found, not a channel, or private. */
export class TelegramChannelUnavailable extends Error {
  override name = 'TelegramChannelUnavailable';
}

/**
 * Builds a live NormalizedMessage. The source ID is the bare channel ID (no -100 prefix), as in the
 * Telegram Desktop export. ponytail: text normalization is NFC + LF only; footer cleaning lives in the
 * export parser and moves to a shared helper when the pipeline needs identical cleanedText.
 */
export function liveMessage(m: {
  channelId: string;
  id: string;
  date: Date;
  editDate?: Date | null;
  text: string;
  replyToId?: string | null;
  mediaFlags?: MediaFlag[];
  rawPayload?: Record<string, unknown>;
}): NormalizedMessage {
  const normalizedText = m.text.normalize('NFC').replace(/\r\n?/g, '\n');
  return {
    sourceProvider: 'telegram',
    sourceExternalId: m.channelId,
    externalMessageId: m.id,
    publishedAt: m.date.toISOString(),
    editedAt: m.editDate ? m.editDate.toISOString() : null,
    replyToExternalId: m.replyToId ?? null,
    rawText: m.text,
    normalizedText,
    cleanedText: normalizedText.trim(),
    mediaFlags: m.mediaFlags ?? [],
    rawPayload: m.rawPayload ?? {},
    mode: 'live',
  };
}

/** TELEGRAM_SESSION_SECRET_REF is a file path (plain or file:// URL), e.g. a mounted secret. */
export const sessionPath = (ref: string) => (ref.startsWith('file:') ? fileURLToPath(ref) : ref);

export async function readSession(ref: string): Promise<string> {
  let session = '';
  try {
    session = (await readFile(sessionPath(ref), 'utf8')).trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; // e.g. a mount not ready yet: transient
  }
  if (!session) throw new TelegramAuthLost('Telegram session secret is missing or empty');
  return session;
}

/** Atomically replaces the session file; it is created 0600 so the secret is never world-readable. */
export async function writeSession(ref: string, session: string): Promise<string> {
  const path = sessionPath(ref);
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, session, { mode: 0o600, flag: 'wx' });
  await rename(tmp, path).catch(async (err: unknown) => {
    await rm(tmp, { force: true });
    throw err;
  });
  return path;
}
