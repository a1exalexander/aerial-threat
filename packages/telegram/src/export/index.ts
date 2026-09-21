// Telegram Desktop "Export chat history" (result.json of a channel) -> NormalizedMessage, mode=archive.
// Pure: no I/O. Text is data, never HTML: entity objects only contribute their `text`, in order.
import type { MediaFlag, NormalizedMessage } from '@aerial/contracts';
import { z } from 'zod';

export const EXPORT_PARSER_VERSION = 'tg-export-v1';

const SafeId = z.number().int().positive().refine(Number.isSafeInteger, 'unsafe integer');
const UnixTime = z.string().regex(/^\d{1,12}$/, 'expected unix seconds');
const Entity = z.object({ type: z.string(), text: z.string(), href: z.string().optional() }).loose();
const Text = z.union([z.string(), z.array(z.union([z.string(), Entity]))]);

export const TelegramExport = z.object({
  name: z.string(),
  type: z.enum(['public_channel', 'private_channel']),
  id: SafeId,
  messages: z.array(z.unknown()),
});

const MessageRecord = z
  .object({
    id: SafeId,
    type: z.literal('message'),
    // `date`/`edited` are zone-less local time: never read; the unixtime twins are authoritative.
    date_unixtime: UnixTime,
    edited: z.string().optional(),
    edited_unixtime: UnixTime.optional(),
    reply_to_message_id: SafeId.optional(),
    reply_to_peer_id: z.string().optional(),
    text: Text,
    photo: z.string().optional(),
    file: z.string().optional(),
    media_type: z.string().optional(),
    poll: z.unknown().optional(),
    location_information: z.unknown().optional(),
    contact_information: z.unknown().optional(),
  })
  .loose()
  .refine((m) => m.edited === undefined || m.edited_unixtime !== undefined, {
    path: ['edited_unixtime'],
    message: 'missing',
  })
  .refine((m) => m.edited_unixtime === undefined || Number(m.edited_unixtime) >= Number(m.date_unixtime), {
    path: ['edited_unixtime'],
    message: 'before date_unixtime',
  });
type MessageRecord = z.infer<typeof MessageRecord>;

export type ExportRecordResult =
  | { index: number; status: 'message'; message: NormalizedMessage }
  | { index: number; status: 'invalid' | 'unsupported'; externalMessageId: string | null; reason: string };

export type ParsedExport = {
  source: { externalId: string; name: string };
  records: ExportRecordResult[];
};

export class ExportFormatError extends Error {
  override name = 'ExportFormatError';
}

/** Parses a whole export. Throws ExportFormatError only for a file that is not a channel export at all. */
export function parseTelegramExport(json: unknown): ParsedExport {
  const file = TelegramExport.safeParse(json);
  if (!file.success) throw new ExportFormatError(`not a Telegram channel export: ${describe(file.error.issues[0])}`);
  const sourceExternalId = String(file.data.id);
  const seen = new Set<number>();
  const records = file.data.messages.map((raw, index): ExportRecordResult => {
    const result = parseRecord(raw, index, sourceExternalId);
    if (result.status !== 'message') return result;
    const id = Number(result.message.externalMessageId);
    if (seen.has(id)) return { index, status: 'invalid', externalMessageId: String(id), reason: 'duplicate id' };
    seen.add(id);
    return result;
  });
  return { source: { externalId: sourceExternalId, name: file.data.name }, records };
}

export function parseRecord(raw: unknown, index: number, sourceExternalId: string): ExportRecordResult {
  const rec: Record<string, unknown> = typeof raw === 'object' && raw !== null ? { ...raw } : {};
  const id = Number.isSafeInteger(rec.id) ? String(rec.id) : null;
  // Service records (pins, joins, title changes) and unknown kinds carry no post to evaluate.
  if (typeof rec.type === 'string' && rec.type !== 'message') {
    const reason = typeof rec.action === 'string' ? `${rec.type}:${rec.action}` : rec.type;
    return { index, status: 'unsupported', externalMessageId: id, reason };
  }
  const parsed = MessageRecord.safeParse(raw);
  if (!parsed.success) return { index, status: 'invalid', externalMessageId: id, reason: describe(parsed.error.issues[0]) };

  const m = parsed.data;
  const segments = toSegments(m.text);
  const rawText = segments.map((s) => s.text).join('');
  // A reply into another chat must not point at this channel's post with the same number; the peer stays in rawPayload.
  const ownReply = m.reply_to_peer_id === undefined || m.reply_to_peer_id === `channel${sourceExternalId}`;
  return {
    index,
    status: 'message',
    message: {
      sourceProvider: 'telegram',
      sourceExternalId,
      externalMessageId: String(m.id),
      publishedAt: fromUnix(m.date_unixtime),
      editedAt: m.edited_unixtime ? fromUnix(m.edited_unixtime) : null,
      replyToExternalId: m.reply_to_message_id && ownReply ? String(m.reply_to_message_id) : null,
      rawText,
      normalizedText: normalize(rawText),
      cleanedText: normalize(rawText.slice(0, footerStart(segments, rawText))).trimEnd(),
      mediaFlags: mediaFlags(m),
      rawPayload: rec,
      mode: 'archive',
    },
  };
}

type Segment = { type: string; text: string; href?: string };

function toSegments(text: MessageRecord['text']): Segment[] {
  if (typeof text === 'string') return [{ type: 'plain', text }];
  return text.map((e) => (typeof e === 'string' ? { type: 'plain', text: e } : e));
}

/** Same normalisation as the revision hash: NFC and LF line breaks. Keeps every character otherwise. */
const normalize = (s: string) => s.normalize('NFC').replace(/\r\n?/g, '\n');

const fromUnix = (seconds: string) => new Date(Number(seconds) * 1000).toISOString();

const MEDIA_TYPES: Record<string, MediaFlag> = {
  video_file: 'video',
  animation: 'animation',
  audio_file: 'audio',
  voice_message: 'voice',
  video_message: 'video_note',
  sticker: 'sticker',
};

function mediaFlags(m: MessageRecord): MediaFlag[] {
  const flags = new Set<MediaFlag>();
  if (m.photo !== undefined) flags.add('photo');
  // A media_type we do not know is kept as `unsupported` instead of being dropped.
  if (m.media_type !== undefined) flags.add(MEDIA_TYPES[m.media_type] ?? 'unsupported');
  else if (m.file !== undefined) flags.add('document');
  if (m.poll !== undefined) flags.add('poll');
  if (m.location_information !== undefined) flags.add('location');
  if (m.contact_information !== undefined) flags.add('contact');
  return [...flags];
}

// Channel promotion lives on these hosts (signature, subscribe/bot/social links). News-source links elsewhere stay.
const PROMO_HOSTS = ['t.me', 'telegram.me', 'instagram.com', 'facebook.com', 'tiktok.com', 'x.com', 'twitter.com', 'youtube.com', 'youtu.be', 'viber.com'];

function isPromo(s: Segment): boolean {
  if (s.type === 'mention') return true;
  const url = s.type === 'text_link' ? s.href : s.type === 'link' ? s.text : undefined;
  if (!url) return false;
  try {
    const host = new URL(/^[a-z][a-z\d+.-]*:/i.test(url) ? url : `https://${url}`).hostname.replace(/^www\./, '');
    return PROMO_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

/**
 * Offset where the channel signature / promo footer starts. Conservative: only trailing lines made of
 * promo links plus emoji/separators (no letter or digit outside the links) are cut, so a closing line
 * with any own words ("ПОВА", "Джерело фото: …") ends the footer. The cleaned text is therefore always
 * a prefix of the normalized text and evidence offsets are shared.
 */
function footerStart(segments: Segment[], raw: string): number {
  const promo = new Uint8Array(raw.length);
  let pos = 0;
  for (const s of segments) {
    if (isPromo(s)) promo.fill(1, pos, pos + s.text.length);
    pos += s.text.length;
  }
  const lines: Array<[number, number]> = [];
  for (let start = 0, i = 0; i <= raw.length; i++) {
    if (i === raw.length || raw[i] === '\n') {
      lines.push([start, i]);
      start = i + 1;
    }
  }
  let cut = raw.length;
  for (const [start, end] of lines.reverse()) {
    if (!raw.slice(start, end).trim()) continue;
    let own = '';
    let hasPromo = false;
    for (let i = start; i < end; i++) {
      if (promo[i]) hasPromo = true;
      else own += raw[i];
    }
    if (!hasPromo || /[\p{L}\p{N}]/u.test(own)) break;
    cut = start;
  }
  return cut;
}

function describe(issue: z.core.$ZodIssue | undefined): string {
  if (!issue) return 'invalid';
  return `${issue.path.join('.') || 'record'}: ${issue.message}`;
}
