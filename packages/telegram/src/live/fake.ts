// In-memory Telegram "server" for tests: channels with a pts-ordered change log, pushes to the
// subscriber while connected, getChannelDifference/recentMessages over the same state, injectable errors.
import type { MediaFlag, NormalizedMessage } from '@aerial/contracts';
import {
  type ChannelDifference,
  type Change,
  type ChannelInfo,
  type LiveUpdate,
  TelegramChannelUnavailable,
  type TelegramSource,
  liveMessage,
} from './source';

/** An update as pushed by the server (with its pts). */
type Pushed = Extract<LiveUpdate, { pts: number }>;

type FakeChannel = {
  id: string;
  username: string;
  title: string;
  pts: number;
  nextId: number;
  messages: Map<string, NormalizedMessage>;
  log: { pts: number; change: Change }[];
};

export class FakeTelegramSource implements TelegramSource {
  connected = false;
  /** Page size of getChannelDifference. */
  diffLimit = 100;
  /** Oldest pts the server still has; asking for older changes answers tooLong. */
  minPts = 0;
  /** Runs inside recentMessages() before it answers, e.g. to push updates during a backfill. */
  onRecent?: () => void;
  readonly calls: string[] = [];
  private readonly channels = new Map<string, FakeChannel>();
  private handler: (u: LiveUpdate) => void = () => {};
  private readonly failures: { method: keyof TelegramSource; error: Error }[] = [];

  addChannel(username: string, id: string, title = username): void {
    this.channels.set(id, { id, username, title, pts: 0, nextId: 1, messages: new Map(), log: [] });
  }

  rename(channelId: string, username: string): void {
    this.channel(channelId).username = username;
  }

  post(
    channelId: string,
    text: string,
    opts: { date?: Date; replyToId?: string; mediaFlags?: MediaFlag[]; push?: boolean } = {},
  ): Pushed & { kind: 'message' } {
    const ch = this.channel(channelId);
    const id = String(ch.nextId++);
    const message = liveMessage({
      channelId,
      id,
      date: opts.date ?? new Date(),
      text,
      replyToId: opts.replyToId,
      mediaFlags: opts.mediaFlags,
      rawPayload: { id: Number(id), views: 1 },
    });
    ch.messages.set(id, message);
    return this.record(ch, { kind: 'message', message }, opts.push ?? true) as Pushed & { kind: 'message' };
  }

  /** New text and/or payload noise (views, reactions) for an existing post. */
  edit(channelId: string, id: string, patch: { text?: string; rawPayload?: Record<string, unknown> }, push = true): Pushed {
    const ch = this.channel(channelId);
    const old = ch.messages.get(id);
    if (!old) throw new Error(`fake: no message ${id}`);
    const message = liveMessage({
      channelId,
      id,
      date: new Date(old.publishedAt),
      editDate: new Date(),
      text: patch.text ?? old.rawText,
      replyToId: old.replyToExternalId,
      mediaFlags: old.mediaFlags,
      rawPayload: { ...old.rawPayload, ...patch.rawPayload },
    });
    ch.messages.set(id, message);
    return this.record(ch, { kind: 'message', message }, push);
  }

  delete(channelId: string, ids: string[], push = true): Pushed {
    const ch = this.channel(channelId);
    for (const id of ids) ch.messages.delete(id);
    return this.record(ch, { kind: 'delete', ids }, push);
  }

  /** Deletes a post without any update, as Telegram sometimes does. */
  forget(channelId: string, id: string): void {
    this.channel(channelId).messages.delete(id);
  }

  /** Delivers an update as-is, e.g. a duplicate of an earlier one. */
  emit(update: LiveUpdate): void {
    if (this.connected) this.handler(update);
  }

  /** The next call of `method` throws `error` (once). */
  failNext(method: keyof TelegramSource, error: Error): void {
    this.failures.push({ method, error });
  }

  async connect(): Promise<void> {
    this.enter('connect');
    this.connected = true;
  }

  async resolveChannel(username: string): Promise<ChannelInfo> {
    this.enter('resolveChannel');
    const ch = [...this.channels.values()].find((c) => c.username === username);
    if (!ch) throw new TelegramChannelUnavailable(`@${username} not found`);
    return { channelId: ch.id, username: ch.username, title: ch.title, pts: ch.pts };
  }

  async recentMessages(channelId: string, since: Date): Promise<NormalizedMessage[]> {
    this.enter('recentMessages');
    this.onRecent?.();
    return [...this.channel(channelId).messages.values()]
      .filter((m) => new Date(m.publishedAt) >= since)
      .sort((a, b) => Number(b.externalMessageId) - Number(a.externalMessageId));
  }

  async getChannelDifference(channelId: string, pts: number): Promise<ChannelDifference> {
    this.enter('getChannelDifference');
    const ch = this.channel(channelId);
    if (pts < this.minPts) return { changes: [], pts: ch.pts, final: true, tooLong: true };
    const page = ch.log.filter((e) => e.pts > pts).slice(0, this.diffLimit);
    const last = page.at(-1)?.pts ?? ch.pts;
    return { changes: page.map((e) => e.change), pts: last, final: last >= ch.pts, tooLong: false };
  }

  onUpdate(cb: (update: LiveUpdate) => void): void {
    this.handler = cb;
  }

  async disconnect(): Promise<void> {
    this.enter('disconnect');
    this.connected = false;
  }

  private record(ch: FakeChannel, change: Change, push: boolean): Pushed {
    ch.pts += 1;
    ch.log.push({ pts: ch.pts, change });
    const update: Pushed = { ...change, channelId: ch.id, pts: ch.pts, ptsCount: 1 };
    if (push) this.emit(update);
    return update;
  }

  private channel(id: string): FakeChannel {
    const ch = this.channels.get(id);
    if (!ch) throw new TelegramChannelUnavailable(`fake: no channel ${id}`);
    return ch;
  }

  private enter(method: keyof TelegramSource): void {
    this.calls.push(method);
    const i = this.failures.findIndex((f) => f.method === method);
    if (i >= 0) throw this.failures.splice(i, 1)[0]!.error;
  }
}
