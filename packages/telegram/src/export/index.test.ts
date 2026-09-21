import { NormalizedMessage } from '@aerial/contracts';
import { type TelegramFixture, loadTelegramExport, manifest } from '@aerial/test-fixtures';
import { describe, expect, it } from 'vitest';
import { ExportFormatError, parseRecord, parseTelegramExport } from './index';

const SOURCE = '1706408894';
const base = { id: 1, type: 'message', date: '2026-09-15T07:41:58', date_unixtime: '1789447318', text: 'x' };
const parse = (over: Record<string, unknown>) => parseRecord({ ...base, ...over }, 0, SOURCE);
const message = (over: Record<string, unknown>) => {
  const r = parse(over);
  if (r.status !== 'message') throw new Error(`expected message, got ${r.status}: ${r.reason}`);
  return r.message;
};
const signature = [{ type: 'text_link', text: 'ППО - Energy Полтава', href: 'https://t.me/+abc' }, { type: 'custom_emoji', text: '⚡', document_id: '' }];
const kremFooter = [
  { type: 'text_link', text: 'Підписатися', href: 'https://t.me/+xyz' },
  ' • ',
  { type: 'text_link', text: 'Надіслати новину', href: 'https://t.me/h_kremenchugbot' },
  ' • ',
  { type: 'text_link', text: 'IG', href: 'https://instagram.com/h.kremenchuk' },
];

describe('parseRecord', () => {
  it('joins entity arrays in order, keeping line breaks and link text, never markup', () => {
    const m = message({
      text: ['❗️', { type: 'bold', text: 'Ворожий БпЛА' }, '\n\nна ', { type: 'text_link', text: '<b>Полтаву</b>', href: 'https://ex.ua' }, ''],
    });
    expect(m.rawText).toBe('❗️Ворожий БпЛА\n\nна <b>Полтаву</b>');
    expect(m.normalizedText).toBe(m.rawText);
  });

  it('uses the unix timestamps, never the zone-less local `date`', () => {
    const m = message({ date: '2000-01-01T00:00:00', edited: '2000-01-01T00:01:00', edited_unixtime: '1789447400' });
    expect(m.publishedAt).toBe('2026-09-15T04:41:58.000Z');
    expect(m.editedAt).toBe('2026-09-15T04:43:20.000Z');
    expect(message({}).editedAt).toBeNull();
  });

  it('maps ids and replies to decimal strings and sets archive mode', () => {
    const m = message({ id: 13790, reply_to_message_id: 13789 });
    expect(m).toMatchObject({ sourceExternalId: SOURCE, externalMessageId: '13790', replyToExternalId: '13789', mode: 'archive' });
    expect(NormalizedMessage.parse(m)).toEqual(m);
    expect(message({ reply_to_message_id: 5, reply_to_peer_id: `channel${SOURCE}` }).replyToExternalId).toBe('5');
    // A reply into another chat never links to this channel's post with the same number.
    expect(message({ reply_to_message_id: 5, reply_to_peer_id: 'channel42' }).replyToExternalId).toBeNull();
  });

  it('flags media; a caption is the text; unknown media kinds stay visible as unsupported', () => {
    expect(message({ photo: '(File not included.)', text: 'Підпис' })).toMatchObject({ mediaFlags: ['photo'], rawText: 'Підпис' });
    expect(message({ file: 'f', media_type: 'video_file' }).mediaFlags).toEqual(['video']);
    expect(message({ file: 'f', media_type: 'hologram' }).mediaFlags).toEqual(['unsupported']);
    expect(message({ file: 'f' }).mediaFlags).toEqual(['document']);
    expect(message({ poll: {}, location_information: {}, contact_information: {} }).mediaFlags).toEqual(['poll', 'location', 'contact']);
    // Album parts without a caption are real posts: imported with empty text, never dropped.
    expect(message({ photo: 'p', text: '' })).toMatchObject({ rawText: '', cleanedText: '', mediaFlags: ['photo'] });
  });

  it('reports service records and unknown record kinds as unsupported', () => {
    expect(parse({ type: 'service', action: 'pin_message' })).toMatchObject({ status: 'unsupported', externalMessageId: '1', reason: 'service:pin_message' });
    expect(parse({ type: 'hologram' })).toMatchObject({ status: 'unsupported', reason: 'hologram' });
  });

  it.each([
    [{ date_unixtime: undefined }, /^date_unixtime:/],
    [{ date_unixtime: '17 Sep' }, /^date_unixtime:/],
    [{ edited: '2026-09-15T07:42:00' }, /^edited_unixtime: missing/],
    [{ edited_unixtime: '1789447000' }, /^edited_unixtime: before date_unixtime/],
    [{ text: [{ type: 'bold' }] }, /^text/],
    [{ id: 2 ** 53 }, /^id:/],
    [{ reply_to_message_id: '13789' }, /^reply_to_message_id:/],
  ])('quarantines %j', (over, reason) => {
    const r = parse(over);
    expect(r.status).toBe('invalid');
    expect(r.status !== 'message' && r.reason).toMatch(reason);
  });

  it('quarantines non-object records', () => {
    expect(parseRecord(null, 3, SOURCE)).toMatchObject({ index: 3, status: 'invalid', externalMessageId: null });
  });
});

describe('cleanedText', () => {
  const cleaned = (text: unknown) => message({ text }).cleanedText;

  it('drops the channel signature and promo footers', () => {
    expect(cleaned([{ type: 'bold', text: 'Ворожий БпЛА над містом' }, '\n\n', ...signature, ''])).toBe('Ворожий БпЛА над містом');
    expect(cleaned(['Загроза БпЛА для Кременчука\n\n', ...kremFooter])).toBe('Загроза БпЛА для Кременчука');
    // Hidden promo link on its own line above the signature; forwarded channel signature with emoji around it.
    expect(cleaned(['Текст\n', { type: 'text_link', text: 'ㅤ', href: 'https://t.me/+hidden' }, '\n', ...signature])).toBe('Текст');
    expect(cleaned(['Зліт МіГ-31К.\n\n', { type: 'custom_emoji', text: '❤' }, ' ', { type: 'text_link', text: 'ППО - NEWS', href: 'https://t.me/+n' }, ' 🇺🇦'])).toBe(
      'Зліт МіГ-31К.',
    );
  });

  it('keeps lines with own words, news-source links and links inside sentences', () => {
    expect(cleaned('Вибухи!')).toBe('Вибухи!');
    expect(cleaned(['Уламки.\n\nПОВА\n\n', ...kremFooter])).toBe('Уламки.\n\nПОВА');
    expect(cleaned(['Новина\n\n', { type: 'text_link', text: 'suspilne.media', href: 'https://suspilne.media/x' }, '\n\n', ...kremFooter])).toBe(
      'Новина\n\nsuspilne.media',
    );
    expect(cleaned(['Джерело фото: ', { type: 'text_link', text: 'Автор', href: 'https://t.me/author/1' }])).toBe('Джерело фото: Автор');
    expect(cleaned(['Update: ', { type: 'link', text: 'https://t.me/h_kremenchug/101798' }])).toBe('Update: https://t.me/h_kremenchug/101798');
    expect(cleaned(['Текст\n😉\n\n', { type: 'link', text: 'https://www.instagram.com/shop' }])).toBe('Текст\n😉');
  });
});

describe('parseTelegramExport', () => {
  it('rejects files that are not channel exports', () => {
    expect(() => parseTelegramExport({ name: 'x', type: 'personal_chat', id: 1, messages: [] })).toThrow(ExportFormatError);
    expect(() => parseTelegramExport([])).toThrow(ExportFormatError);
  });

  it('quarantines a repeated message id', () => {
    const parsed = parseTelegramExport({ name: 'c', type: 'public_channel', id: 5, messages: [base, base] });
    expect(parsed.source).toEqual({ externalId: '5', name: 'c' });
    expect(parsed.records.map((r) => r.status)).toEqual(['message', 'invalid']);
  });

  it.each(['energy', 'kremenchuk', 'kremenchuk-mykolai'] as TelegramFixture[])('parses every %s fixture record into one message', (name) => {
    const json = loadTelegramExport(name) as { messages: Array<{ id: number; text: unknown; text_entities: Array<{ text: string }> }> };
    const { source, records } = parseTelegramExport(json);
    expect(source.externalId).toBe(manifest.files[name].sourceExternalId);
    // One record -> one message (the export holds only the last text; no invented earlier revisions).
    expect(records.map((r) => r.status === 'message' && r.message.externalMessageId)).toEqual(manifest.files[name].records.map((r) => r.id));
    for (const [i, r] of records.entries()) {
      if (r.status !== 'message') continue;
      const m = NormalizedMessage.parse(r.message);
      // `text` (string or entity array) and Telegram's own flat `text_entities` agree on content and order.
      expect(m.rawText).toBe(json.messages[i]!.text_entities.map((e) => e.text).join(''));
      expect(m.normalizedText.startsWith(m.cleanedText)).toBe(true);
      expect(m.cleanedText).not.toMatch(/ППО - Energy Полтава|Підписатися/);
    }
  });

  it('keeps regression texts intact after cleaning', () => {
    const text = (name: TelegramFixture, id: string) => {
      const r = parseTelegramExport(loadTelegramExport(name)).records.find((x) => x.status === 'message' && x.message.externalMessageId === id);
      return r?.status === 'message' ? r.message.cleanedText : undefined;
    };
    expect(text('energy', '13766')).toBe('⚠️ 7х курсом в бік Полтави');
    expect(text('energy', '13773')).toBe('✈️Полтавщина:\n→Черкаси/Сміла з Полтавщини (2х).\n\n✈️Полтавщина:\n→Гадяч/Миргород з Сумщини.');
    expect(text('kremenchuk', '101889')).toBe(
      'Зафіксовано падіння ворожого БпЛА на відкритій території у Кременчуцькому районі. Виникло загоряння сухої рослинності. Люди не постраждали.\n\nПовідомляє Полтавська ОВА',
    );
    expect(text('kremenchuk', '101902')).toBe('🟡 Кременчуцький р-н\nРівень знижено до жовтого\nДронова загроза');
  });

  it('parses the reply-heavy kremenchuk-mykolai export: bare channel id, media-only posts, forwards', () => {
    const { source, records } = parseTelegramExport(loadTelegramExport('kremenchuk-mykolai'));
    expect(source).toEqual({ externalId: '2432204405', name: 'Кременчуцький Миколай' });
    const byId = new Map(records.flatMap((r) => (r.status === 'message' ? [[r.message.externalMessageId, r.message] as const] : [])));
    expect(byId.get('23998')).toMatchObject({ rawText: '', mediaFlags: ['sticker'], replyToExternalId: '23997' });
    expect(byId.get('24068')).toMatchObject({ mediaFlags: ['voice'], replyToExternalId: '24067' });
    expect(byId.get('24087')?.cleanedText).toBe('Кобеляки, Козельщина, Манжелія, Погреби, Градизьк)'); // forwarded post
    expect(byId.get('24099')?.cleanedText).toMatch(/^Хочеш можеш подякувати-хочеш не дякуй ,або коХве чи ще щось🚬\n/); // custom emoji in place
    expect(byId.get('24135')).toMatchObject({ cleanedText: 'По ним минус ➖', replyToExternalId: '24134' });
  });
});
