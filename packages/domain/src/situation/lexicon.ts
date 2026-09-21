// The words of the Kremenchuk channels: Ukrainian, Russian and surzhyk, official and slang.
// Patterns are written in plain spelling and folded like the text, so «ракети/ракеты», «мінус/минус» and
// «ще/ещё» meet in one form. Edit freely, then bump SITUATION_RULES_VERSION (./index.ts).
import type { SituationThreatType } from '@aerial/contracts';

const FOLD: Record<string, string> = { і: 'и', ї: 'и', ы: 'и', є: 'е', э: 'е', ё: 'е', ґ: 'г', ъ: "'", '’': "'", ʼ: "'", '‘': "'", '`': "'" };

/** Lower case in one alphabet for uk/ru/surzhyk. Unit for unit (UTF-16), so match offsets are offsets into the original text. */
export const fold = (text: string) =>
  text.replace(/[\s\S]/g, (ch) => {
    const l = ch.toLowerCase();
    return l.length === 1 ? (FOLD[l] ?? l) : ch;
  });

/** A lexicon pattern on folded text; it starts at a word start. */
const re = (src: string) => new RegExp(`(?<![\\p{L}\\d])(?:${src.replace(/[іїыєэёґ]/g, (c) => FOLD[c]!)})`, 'u');
const L = '\\p{L}*';
const END = '(?!\\p{L})';

export type KnownThreat = Exclude<SituationThreatType, 'unknown' | 'none'>;

/** In priority order: «реактивний БпЛА» is jet_shahed, «балістичні ракети» ballistic, «керовані авіабомби» kab. */
export const THREATS: [KnownThreat, RegExp][] = [
  ['jet_shahed', re(`реактивн${L}`)],
  ['ballistic', re(`бал+істи${L}|бублик${L}|бублістик${L}|іскандер${L}`)],
  ['kab', re(`каб(?:и|ів|ами|ах)?${END}|керован${L}\\s+авіа${L}\\s+бомб${L}`)],
  ['missile', re(`ракет${L}|крилат${L}|калібр${L}|[хx]-?(?:101|555|22|59)${END}|кинд?жал${L}`)],
  // «міг» alone is the verb «could»: only with a number (МіГ-31); «дибіл-31» is the channels' nickname for it.
  ['aviation', re(`авіаці${L}|(?:міг|дибіл)[\\s-]*\\d+|су-?34|ту-?95|ту-?22|тактичн${L}|літак${L}|самол[еі]т${L}`)],
  // Assumption to calibrate: «бандероль» is counted as a strike drone, though Х Кременчук once called it a small cruise missile.
  ['shahed', re(`шахед${L}|шахід${L}|мопед${L}|геран${L}|гербер${L}|дрон${L}|бпла${END}|бе[зс]пілотн${L}|бандерол${L}`)],
];

/** Something is in the air and moving now: flight verbs, a course, circling, turning. */
export const MOVE = re(
  // No «при-»: «прилетіла» is an impact, not a flight.
  `(?:про|под|під|за|пере|до|від|от|ви|у|по|об|на)?л[еі]т(?:ить|ит|ять|ят|іти|еть|іть|ів|ел|іла|ела|іли|ели|ає|ает|ають|ают|аю)${END}` +
    `|курс(?:ом)?\\s+(?:(?:на|к|до|в|у|поки|пока)${END}|(?:захід|запад|півд|южн|півн|север|схід|восток)${L})|держ${L}\\s+курс` +
    `|крут(?:ит|ить|ят|ять)${L}|кружля${L}|(?:на|в|\\d+)\\s+круг${END}|круг${L}\\s+(?:дела|роби|нареза|мота|рису)${L}|(?:по|роз|раз|з|за|від|от|под|під)верн(?:ув|ул|ула|ули|улся|увся|улась|улася)${END}` +
    `|(?:по|под|під|раз|роз)ворач${L}|(?:іде|идет|йде|идут|йдуть)\\s+на${END}`,
);

export const TOWARDS = re(
  `(?:на|к|до)\\s+(?:нас|нам)${END}|в\\s+нашу\\s+сторону|в\\s+наш\\s+бік|на\\s+центр${END}|зустрічайте|встречайте` +
    `|(?:на|к|до|сторону|бік|напрямку|напрямок\\s+на|курс(?:ом)?(?:\\s+(?:на|к|до))?)\\s+кременчу${L}`,
);
export const PASSING = re(`на\\s+вод(?:у|і|е)${END}|по\\s+руслу|повз${END}|мимо${END}|через\\s+(?:нас|вас|наш\\s+район)${END}`);
export const AWAY = re(`відда?ля${L}|отдаля${L}|удаля${L}|(?:від|от)\\s+нас${END}|на\\s+виліт|на\\s+вилет|(?:від|от)верн(?:ув|ул)${L}`);
/** Into or inside a neighbouring oblast («і в Харківську обл»): away, unless the post also says towards or passing. */
export const OTHER_OBLAST = re(
  `(?:в|у)\\s+(?:харків|харьков|сумськ|сумск|черкаськ|черкасск|кіровоградськ|кировоградск|дніпропетровськ|днепропетровск|київськ|киевск|запорізьк|запорожск|донецьк|донецк)${L}\\s+(?:обл|област)`,
);
/** Turning towards a place («пішов на …», «развернулся в сторону …»): away when the place is outside the raion. */
export const TURN = re(`(?:пішов|пошел|пошла|пішла)${END}|(?:по|роз|раз|з|за|від|от|под|під)верн${L}|ворач${L}`);

/** Reported downed or fallen: «впав», «по ним мінус», «збито». A minus before a number is a temperature. */
export const DOWNED = re(
  `впав|упав|упал|впал|впали|упали|збили|збито|збив|сбили|сбит${L}|знищен${L}|знищили|уничтож${L}|падіння|падение|мінус${END}(?!\\s*\\d)|мінусн${L}|минусн${L}`,
);
/** An explicit all clear or «no threat for us»; «режиме ППО» is a ballistic launch aimed at the air, not the ground. */
export const CLEAR = re(
  `без\\s+(?:угроз|загроз)${L}|(?:немає|нема|нет)\\s+(?:угроз|загроз)${L}|(?:угроз|загроз)${L}\\s+(?:немає|нема|нет)${END}|чисто${END}|режим${L}\\s+(?:певео|пво|ппо)${END}`,
);
/** Official all-clear, as the alert bots and channels post it. */
export const CLEAR_OFFICIAL = re(`відб(?:ій|ою)\\s+(?:повітрян${L}\\s+)?тривог${L}|отбой\\s+(?:воздушн${L}\\s+)?тревог${L}|(?:дали|даю|дав)\\s+(?:відбій|отбой)`);
/** Official alert, not «відбій повітряної тривоги». */
export const ALERT_OFFICIAL = re(`(?<!(?:відб|отб)${L}\\s)(?:повітрян${L}\\s+тривог${L}|воздушн${L}\\s+тревог${L})|дали\\s+тр[еі]вогу|оголошен${L}\\s+тривог${L}`);

const FUTURE = `(?:буд(?:е|уть|ут|ет)|должн${L}|повин${L}|скоро)`;
const CLEAR_WORD = `(?:відб(?:ій|ою|ої|оєм|оям)|отбо(?:й|и|я|ем|ям))${END}`;
const ALERT_WORD = `тр[иеі]вога${END}`;
const GAP = `(?:[\\s,]+[\\p{L}'-]+){0,3}?[\\s,]+`;
/** «буде/будут відбій», «должны дать отбой», «відбій буде», and «відбою не буде» (negated: no forecast). */
export const CLEAR_EXPECTED = re(`${FUTURE}${GAP}${CLEAR_WORD}|${CLEAR_WORD}\\s+(?:не\\s+)?${FUTURE}`);
export const ALERT_EXPECTED = re(`${FUTURE}${GAP}${ALERT_WORD}|${ALERT_WORD}\\s+(?:не\\s+)?${FUTURE}`);
export const NEGATION = re(`(?:не|ні|нет|нету|нема|немає)${END}`);

/** Nouns only: «вибухові знижки» is an ad, «вибухових травм» a report of the past. */
export const EXPLOSIONS = re(`вибух(?:и|ів|ом|ами)?${END}|взрив(?:и|ов|ом|ами)?${END}|прил(?:ьот|іт|ет)(?:и|ів|ов|у|ом)?${END}|прилет[іе]ло|бахн${L}|бахка${L}|звуки${END}`);
export const AIR_DEFENSE = re(
  `ппо${END}|пво${END}|мобільн${L}\\s+груп${L}|не\\s+пуга${L}\\s+звук${L}|не\\s+лякайт${L}|по\\s+(?:ньому|нему|ним|них)(?:\\s+\\p{L}+){0,2}?\\s+(?:робот|работ)${L}`,
);
/** A report of consequences («внаслідок», «пошкоджено», «вночі»): news of the past, not the sky now. */
export const AFTERMATH = re(`внаслідок|наслідк${L}|пошкоджен${L}|постраждал${L}|травмован${L}|госпіталізован${L}|уламк${L}|влучан${L}|влучив|вночі|уночі|за\\s+ніч${END}`);
export const HEDGE = re(`(?:може|можливо|возможно|ймовірно|імовірно|вероятно|походу|мабуть|наверное|вроде|вроді|скоріше|скорее|схоже|хз|не\\s+знаю|по\\s+ідеї|по\\s+идее)${END}`);
/** A question or «+-» also hedges. */
export const QUESTION = /\?|\+-/;

const NUMBER = `\\d{1,3}(?:\\s*[-–]\\s*\\d{1,3})?|один|одна|одне|одного|одну|два|дві|две|двоє|пара|пару|три|троє|чотири|четыре`;
const THREAT_ANY = THREATS.map(([, r]) => r.source).join('|');
const QTY_SOURCES = [
  `(${NUMBER})(?:\\s+[\\p{L}'-]+){0,2}?\\s+(?:${THREAT_ANY})`,
  `(${NUMBER})\\s*шт${END}`,
  `е?ще\\s+(${NUMBER})(?![\\d%])(?!\\s*(?:хв|мин|сек|год|час|грн|%)|\\s*к?м${END})`,
  `(груп${L}|кілька|декілька|несколько|багато|много|рій|рой)\\s+(?:\\p{L}+\\s+)?(?:${THREAT_ANY})`,
];
/** Counts before a threat term («2 бандероли»), «4 шт», «ще 2»; «групи шахедів» is a count we do not know. */
export const QUANTITY = new RegExp(QTY_SOURCES.map((s) => `(?<![\\p{L}\\d:.,])(?:${s.replace(/[іїыєэёґ]/g, (c) => FOLD[c]!)})`).join('|'), 'gu');
export const NUMBER_WORDS: Record<string, number> = { один: 1, одна: 1, одне: 1, одного: 1, одну: 1, два: 2, дви: 2, две: 2, двое: 2, пара: 2, пару: 2, три: 3, трое: 3, чотири: 4, четире: 4 };

// Noise. Payment details and ads are dropped unless the post also carries a report (movement, route, forecast…):
// a bare threat word does not save «кошти на дрони».
export const PAYMENT = re(`send\\.monobank|monobank|монобанк|посилання\\s+на\\s+банку|картк${L}\\s+банки|збір|збору|зборі|сбор|сбора|сбору|донат${L}|номер\\s+карт${L}|реквізит${L}|по\\s+\\d+(?:\\s*-\\s*\\d+)?\\s*грн|ціль:`);
export const CARD = /(?<!\d)\d{4}(?:[ -]?\d{4}){3}(?!\d)/;
export const IBAN = /(?<![\p{L}\d])UA\d{2}(?:\s?\d){25}(?!\d)/iu;
export const PHONE = /(?<!\d)(?:\+?38[\s-]?)?\(?0\d{2}\)?(?:[\s-]?\d){7}(?!\d)/;
export const COMMERCIAL = re(
  `пропонуємо|предлагаем|запрошуємо|приглашаем|шукаємо|шукаю|ищем|ваканс${L}|заробітн${L}|зарплат${L}|зп${END}|цін[аиі]?${END}|цен[аы]${END}` +
    `|замовляйте|замовлення|заказывайте|знижк${L}|скидк${L}|послуг${L}|услуг${L}|гаранті${L}|акці(?:я|ї|ю|йн${L})${END}|розпродаж${L}|распродаж${L}` +
    `|сейл${END}|інстаграм${L}|инстаграм${L}|instagram|працевлаштуван${L}|бронювання|запис${END}|оплачуйте|безкоштовн${L}|бесплатн${L}`,
);
/** Route lists: «Козельщина/Манжелія/Погреби», «Кобеляки → Козельщина», three names in a comma list. Case-sensitive, on the original text. */
export const ROUTE = /\p{Lu}\p{Ll}+(?:\s\p{Lu}?\p{Ll}+)?\s*(?:\/|→|->)\s*\p{Lu}\p{Ll}|\p{Lu}\p{Ll}+\s*,\s*\p{Lu}\p{Ll}+\s*,\s*\p{Lu}\p{Ll}/u;
export const EMOJI = /\p{Extended_Pictographic}/u;
/** Greetings and thanks; with an emoji and at most four words («Всім вечора 🤝») the post is chit-chat. */
export const CHATTER = re(`подяку${L}|дякую|спасибо|вечора|ранку|доброго|добрий|доброй|добраніч|спокійної|бажаю|привіт${L}`);
