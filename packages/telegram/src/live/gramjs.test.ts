import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeRevisionHash } from '@aerial/contracts/hash';
import { Api, errors, helpers } from 'telegram';
import { describe, expect, it } from 'vitest';
import { GramJsSource, fromGramMessage, toTelegramError } from './gramjs';
import { TelegramAuthLost, TelegramChannelUnavailable, TelegramFloodWait, readSession, writeSession } from './source';

const channelPost = (over: Partial<ConstructorParameters<typeof Api.Message>[0]> = {}) =>
  new Api.Message({
    id: 13766,
    peerId: new Api.PeerChannel({ channelId: 1234567890n as never }),
    date: 1_789_000_000,
    message: 'Шахед\r\nкурсом на Полтаву',
    ...over,
  });

describe('fromGramMessage', () => {
  it('maps a channel post to a live NormalizedMessage with decimal-string IDs', () => {
    const m = fromGramMessage(
      channelPost({ replyTo: new Api.MessageReplyHeader({ replyToMsgId: 13765 }), editDate: 1_789_000_060, views: 42 }),
    );
    expect(m).toMatchObject({
      sourceProvider: 'telegram',
      sourceExternalId: '1234567890',
      externalMessageId: '13766',
      publishedAt: new Date(1_789_000_000_000).toISOString(),
      editedAt: new Date(1_789_000_060_000).toISOString(),
      replyToExternalId: '13765',
      rawText: 'Шахед\r\nкурсом на Полтаву',
      normalizedText: 'Шахед\nкурсом на Полтаву',
      mediaFlags: [],
      mode: 'live',
    });
    expect(m?.rawPayload).toMatchObject({ id: 13766, views: 42, replyToMsgId: 13765 });
  });

  it('keeps views and reactions out of the revision hash', () => {
    const a = fromGramMessage(channelPost({ views: 1 }))!;
    const b = fromGramMessage(channelPost({ views: 900, forwards: 3 }))!;
    expect(computeRevisionHash(a)).toBe(computeRevisionHash(b));
  });

  it('maps media kinds and ignores link previews and cross-chat replies', () => {
    const doc = (attributes: Api.TypeDocumentAttribute[]) =>
      new Api.MessageMediaDocument({ document: new Api.Document({ attributes } as never) });
    const flags = (media: Api.TypeMessageMedia) => fromGramMessage(channelPost({ media }))?.mediaFlags;
    expect(flags(new Api.MessageMediaPhoto({}))).toEqual(['photo']);
    expect(flags(doc([new Api.DocumentAttributeVideo({ roundMessage: true } as never)]))).toEqual(['video_note']);
    expect(flags(doc([new Api.DocumentAttributeAudio({ voice: true } as never)]))).toEqual(['voice']);
    expect(flags(doc([new Api.DocumentAttributeAnimated(), new Api.DocumentAttributeVideo({} as never)]))).toEqual(['animation']);
    expect(flags(doc([]))).toEqual(['document']);
    expect(flags(new Api.MessageMediaWebPage({} as never))).toEqual([]);
    expect(flags(new Api.MessageMediaDice({} as never))).toEqual(['unsupported']);

    const crossChat = new Api.MessageReplyHeader({ replyToMsgId: 5, replyToPeerId: new Api.PeerChannel({ channelId: 1n as never }) });
    expect(fromGramMessage(channelPost({ replyTo: crossChat }))?.replyToExternalId).toBeNull();
  });

  it('skips service and non-channel messages', () => {
    expect(fromGramMessage(new Api.MessageService({ id: 1, peerId: new Api.PeerChannel({ channelId: 1n as never }), date: 1 } as never))).toBeUndefined();
    expect(fromGramMessage(channelPost({ peerId: new Api.PeerUser({ userId: 1n as never }) }))).toBeUndefined();
  });
});

describe('channel IDs', () => {
  // Same bare form as the Telegram Desktop export `id`, so live and archive rows share one `sources` row.
  const bare = '1706408894';
  const id = helpers.returnBigInt(bare);

  it('uses the bare channel ID, never the -100 marked peer ID', () => {
    const m = fromGramMessage(channelPost({ peerId: new Api.PeerChannel({ channelId: id }) }));
    expect(m?.sourceExternalId).toBe(bare);
  });

  it('resolves a username to the bare channel ID and its current pts', async () => {
    const src = new GramJsSource({ apiId: 1, apiHash: 'x', sessionRef: '/nonexistent' });
    const channel = new Api.Channel({ id, accessHash: helpers.returnBigInt(42), title: 'Energy', username: 'ppo_energy_poltava' } as never);
    Reflect.set(src, 'client', {
      invoke: async (req: unknown) =>
        req instanceof Api.contacts.ResolveUsername
          ? new Api.contacts.ResolvedPeer({ peer: new Api.PeerChannel({ channelId: id }), chats: [channel], users: [] })
          : new Api.messages.ChatFull({ fullChat: new Api.ChannelFull({ pts: 77 } as never), chats: [], users: [] }),
    });
    expect(await src.resolveChannel('ppo_energy_poltava')).toEqual({ channelId: bare, username: 'ppo_energy_poltava', title: 'Energy', pts: 77 });
  });
});

describe('toTelegramError', () => {
  const req = new Api.help.GetConfig();
  it('classifies flood, auth and channel errors; leaves the rest transient', () => {
    const flood = toTelegramError(new errors.FloodWaitError({ request: req, capture: 17 }));
    expect(flood).toBeInstanceOf(TelegramFloodWait);
    expect((flood as TelegramFloodWait).seconds).toBe(17);
    expect(toTelegramError(new errors.RPCError('SESSION_REVOKED', req, 401))).toBeInstanceOf(TelegramAuthLost);
    expect(toTelegramError(new errors.RPCError('AUTH_KEY_DUPLICATED', req, 406))).toBeInstanceOf(TelegramAuthLost);
    expect(toTelegramError(new errors.RPCError('USERNAME_NOT_OCCUPIED', req, 400))).toBeInstanceOf(TelegramChannelUnavailable);
    const network = new Error('socket hang up');
    expect(toTelegramError(network)).toBe(network);
  });
});

describe('session secret', () => {
  it('round-trips through a 0600 file and treats a missing one as lost authorization', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'aerial-session-')), 'collector.session');
    await expect(new GramJsSource({ apiId: 1, apiHash: 'x', sessionRef: path }).connect()).rejects.toBeInstanceOf(TelegramAuthLost);
    await writeSession(path, 'old');
    await writeSession(`file://${path}`, 'session-string');
    expect(await readSession(path)).toBe('session-string');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
});
