// GramJS (MTProto) implementation of TelegramSource. GramJS does not implement update gap recovery
// (its catchUp() is a TODO), so pts bookkeeping and getChannelDifference are driven by the worker loop.
import type { MediaFlag, NormalizedMessage } from '@aerial/contracts';
import { Api, Logger, TelegramClient, errors } from 'telegram';
import { LogLevel } from 'telegram/extensions/Logger.js';
import { UpdateConnectionState } from 'telegram/network/index.js';
import { StringSession } from 'telegram/sessions/index.js';
import {
  type ChannelDifference,
  type Change,
  type ChannelInfo,
  type LiveUpdate,
  TelegramAuthLost,
  TelegramChannelUnavailable,
  TelegramFloodWait,
  type TelegramSource,
  liveMessage,
  readSession,
} from './source';

/** Hard cap on one history read, whatever the time window. */
const RECENT_LIMIT = 2000;
const DIFF_LIMIT = 100;

export class GramJsSource implements TelegramSource {
  private client?: TelegramClient;
  private handler: (u: LiveUpdate) => void = () => {};
  private readonly channels = new Map<string, Api.InputChannel>();
  private wasDisconnected = false;

  constructor(private readonly cfg: { apiId: number; apiHash: string; sessionRef: string }) {}

  async connect(): Promise<void> {
    if (this.client?.connected) return;
    await guard(async () => {
      if (!this.client) {
        const secret = await readSession(this.cfg.sessionRef);
        let session: StringSession;
        try {
          session = new StringSession(secret);
        } catch {
          throw new TelegramAuthLost('Telegram session secret is malformed');
        }
        this.client = new TelegramClient(session, this.cfg.apiId, this.cfg.apiHash, {
          connectionRetries: 5,
          floodSleepThreshold: 0, // every FLOOD_WAIT reaches the loop, which waits it out with jitter
          baseLogger: new Logger(LogLevel.ERROR),
        });
        this.client.addEventHandler((u: unknown) => this.dispatch(u));
      }
      await this.client.connect();
      // checkAuthorization() swallows network errors as "unauthorized"; call directly so only 401s mean auth loss.
      await this.client.invoke(new Api.updates.GetState());
    });
  }

  resolveChannel(username: string): Promise<ChannelInfo> {
    return guard(async () => {
      const res = await this.api().invoke(new Api.contacts.ResolveUsername({ username }));
      const channel = res.chats.find((c): c is Api.Channel => c instanceof Api.Channel);
      if (!channel?.accessHash || channel.megagroup) throw new TelegramChannelUnavailable(`@${username} is not a channel`);
      const channelId = channel.id.toString();
      this.channels.set(channelId, new Api.InputChannel({ channelId: channel.id, accessHash: channel.accessHash }));
      return { channelId, username: channel.username ?? username, title: channel.title, pts: await this.channelPts(channelId) };
    });
  }

  recentMessages(channelId: string, since: Date): Promise<NormalizedMessage[]> {
    return guard(async () => {
      const { channelId: id, accessHash } = this.input(channelId);
      const out: NormalizedMessage[] = [];
      for await (const m of this.api().iterMessages(new Api.InputPeerChannel({ channelId: id, accessHash }), { limit: RECENT_LIMIT })) {
        if (m.date * 1000 < since.getTime()) break;
        const message = fromGramMessage(m);
        if (message) out.push(message);
      }
      return out;
    });
  }

  getChannelDifference(channelId: string, pts: number): Promise<ChannelDifference> {
    return guard(async () => {
      const res = await this.api().invoke(
        new Api.updates.GetChannelDifference({
          channel: this.input(channelId),
          filter: new Api.ChannelMessagesFilterEmpty(),
          pts,
          limit: DIFF_LIMIT,
        }),
      );
      if (res instanceof Api.updates.ChannelDifferenceEmpty) return { changes: [], pts: res.pts, final: true, tooLong: false };
      if (res instanceof Api.updates.ChannelDifferenceTooLong) {
        const dialogPts = res.dialog instanceof Api.Dialog ? res.dialog.pts : undefined;
        return { changes: [], pts: dialogPts ?? (await this.channelPts(channelId)), final: true, tooLong: true };
      }
      const changes: Change[] = [];
      for (const m of res.newMessages) {
        const message = fromGramMessage(m);
        if (message) changes.push({ kind: 'message', message });
      }
      for (const u of res.otherUpdates) {
        const update = toLiveUpdate(u);
        if (update && (update.kind === 'message' || update.kind === 'delete')) changes.push(update);
      }
      return { changes, pts: res.pts, final: res.final ?? false, tooLong: false };
    });
  }

  onUpdate(cb: (update: LiveUpdate) => void): void {
    this.handler = cb;
  }

  async disconnect(): Promise<void> {
    await this.client?.destroy();
    this.client = undefined;
  }

  private dispatch(u: unknown) {
    if (u instanceof UpdateConnectionState) {
      if (u.state !== UpdateConnectionState.connected) this.wasDisconnected = true;
      else if (this.wasDisconnected) {
        this.wasDisconnected = false;
        this.handler({ kind: 'reconnected' });
      }
      return;
    }
    const update = toLiveUpdate(u);
    if (update) this.handler(update);
  }

  private api(): TelegramClient {
    if (!this.client) throw new Error('telegram: not connected');
    return this.client;
  }

  private input(channelId: string): Api.InputChannel {
    const input = this.channels.get(channelId);
    if (!input) throw new Error(`telegram: channel ${channelId} was not resolved`);
    return input;
  }

  private async channelPts(channelId: string): Promise<number> {
    const full = await this.api().invoke(new Api.channels.GetFullChannel({ channel: this.input(channelId) }));
    if (!(full.fullChat instanceof Api.ChannelFull)) throw new TelegramChannelUnavailable(`${channelId} is not a channel`);
    return full.fullChat.pts;
  }
}

// ponytail: a service message (pin, title change) yields no update, so the next one looks like a gap and
// costs one getChannelDifference; channels post few of them.
function toLiveUpdate(u: unknown): LiveUpdate | undefined {
  if (u instanceof Api.UpdateNewChannelMessage || u instanceof Api.UpdateEditChannelMessage) {
    const message = fromGramMessage(u.message);
    return message && { kind: 'message', message, channelId: message.sourceExternalId, pts: u.pts, ptsCount: u.ptsCount };
  }
  if (u instanceof Api.UpdateDeleteChannelMessages) {
    return { kind: 'delete', ids: u.messages.map(String), channelId: u.channelId.toString(), pts: u.pts, ptsCount: u.ptsCount };
  }
  if (u instanceof Api.UpdateChannelTooLong) return { kind: 'tooLong', channelId: u.channelId.toString() };
  return undefined;
}

/** Api.Message of a channel -> NormalizedMessage; service/empty messages -> undefined. */
export function fromGramMessage(m: Api.TypeMessage): NormalizedMessage | undefined {
  if (!(m instanceof Api.Message) || !(m.peerId instanceof Api.PeerChannel)) return undefined;
  // Replies into another chat are not context of this channel.
  const replyTo = m.replyTo instanceof Api.MessageReplyHeader && !m.replyTo.replyToPeerId ? m.replyTo.replyToMsgId : undefined;
  return liveMessage({
    channelId: m.peerId.channelId.toString(),
    id: String(m.id),
    date: new Date(m.date * 1000),
    editDate: m.editDate ? new Date(m.editDate * 1000) : null,
    text: m.message ?? '',
    replyToId: replyTo === undefined ? null : String(replyTo),
    mediaFlags: mediaFlags(m.media),
    // A plain-JSON subset of the TL object (no file references or client internals). Views and
    // forwards are kept for provenance; they never reach the revision hash.
    rawPayload: {
      id: m.id,
      date: m.date,
      editDate: m.editDate,
      message: m.message,
      entities: m.entities?.map((e) => ({ type: e.className, offset: e.offset, length: e.length, url: 'url' in e ? e.url : undefined })),
      replyToMsgId: replyTo,
      media: m.media?.className,
      groupedId: m.groupedId?.toString(),
      postAuthor: m.postAuthor,
      forwarded: m.fwdFrom ? true : undefined,
      views: m.views,
      forwards: m.forwards,
    },
  });
}

function mediaFlags(media: Api.TypeMessageMedia | undefined): MediaFlag[] {
  // Link previews are attached asynchronously by Telegram and are not a content change.
  if (!media || media instanceof Api.MessageMediaEmpty || media instanceof Api.MessageMediaWebPage) return [];
  if (media instanceof Api.MessageMediaPhoto) return ['photo'];
  if (media instanceof Api.MessageMediaDocument) {
    const attrs = media.document instanceof Api.Document ? media.document.attributes : [];
    const video = attrs.find((a) => a instanceof Api.DocumentAttributeVideo);
    const audio = attrs.find((a) => a instanceof Api.DocumentAttributeAudio);
    if (attrs.some((a) => a instanceof Api.DocumentAttributeSticker)) return ['sticker'];
    if (attrs.some((a) => a instanceof Api.DocumentAttributeAnimated)) return ['animation'];
    if (video) return [video.roundMessage ? 'video_note' : 'video'];
    if (audio) return [audio.voice ? 'voice' : 'audio'];
    return ['document'];
  }
  if (media instanceof Api.MessageMediaPoll) return ['poll'];
  if (media instanceof Api.MessageMediaGeo || media instanceof Api.MessageMediaGeoLive || media instanceof Api.MessageMediaVenue) {
    return ['location'];
  }
  if (media instanceof Api.MessageMediaContact) return ['contact'];
  return ['unsupported'];
}

const AUTH_ERRORS = new Set(['AUTH_KEY_DUPLICATED', 'AUTH_KEY_UNREGISTERED', 'SESSION_REVOKED', 'SESSION_EXPIRED', 'USER_DEACTIVATED', 'USER_DEACTIVATED_BAN']);
const CHANNEL_ERRORS = new Set(['USERNAME_NOT_OCCUPIED', 'USERNAME_INVALID', 'CHANNEL_PRIVATE', 'CHANNEL_INVALID']);

/** Maps GramJS errors onto the adapter's error classes; anything else is transient for the caller. */
export function toTelegramError(err: unknown): unknown {
  if (err instanceof errors.FloodError && 'seconds' in err && typeof err.seconds === 'number') return new TelegramFloodWait(err.seconds);
  if (err instanceof errors.RPCError) {
    if (err.code === 401 || AUTH_ERRORS.has(err.errorMessage)) return new TelegramAuthLost(err.errorMessage);
    if (CHANNEL_ERRORS.has(err.errorMessage)) return new TelegramChannelUnavailable(err.errorMessage);
  }
  return err;
}

async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toTelegramError(err);
  }
}
