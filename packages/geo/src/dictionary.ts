import type { PlaceLevel } from '@aerial/contracts';

/** Bump on any change to PLACES, SUB_AREAS or AMBIGUOUS_NAMES; stored alongside results that reference place IDs. */
export const DICTIONARY_VERSION = 'geo-v2';

export type Place = {
  /** Stable ID, never reused: ua-pl, ua-pl-r-<raion>, ua-pl-c-<city>, ua-pl-v-<village>. */
  readonly id: string;
  readonly name: string;
  readonly level: PlaceLevel;
  readonly parentId: string | null;
  /** Base (nominative) forms only; case forms and matching belong to @aerial/geo/match. */
  readonly aliases: readonly string[];
  /** NEPTUN area keys (alerts `key`, GeoJSON `properties.key`) that denote exactly this place. */
  readonly neptunKeys: readonly string[];
};

const oblast = (id: string, name: string, neptunKey: string, aliases: string[] = []): Place => ({
  id,
  name,
  level: 'oblast',
  parentId: null,
  aliases: [name, ...aliases],
  neptunKeys: [neptunKey],
});
const raion = (id: string, name: string, neptunKey: string): Place => ({
  id,
  name,
  level: 'raion',
  parentId: 'ua-pl',
  aliases: [name],
  neptunKeys: [neptunKey],
});
const settlement =
  (level: 'city' | 'village') =>
  (id: string, name: string, parentId: string, aliases: string[] = []): Place => ({
    id,
    name,
    level,
    parentId,
    aliases: [name, ...aliases],
    neptunKeys: [],
  });
const city = settlement('city');
const village = settlement('village');

const R_POLTAVA = 'ua-pl-r-poltavskyi';
const R_KREMENCHUK = 'ua-pl-r-kremenchutskyi';
const R_MYRHOROD = 'ua-pl-r-myrhorodskyi';
const R_LUBNY = 'ua-pl-r-lubenskyi';

export const PLACES: readonly Place[] = [
  oblast('ua-pl', 'Полтавська область', 'полтавська', ['Полтавщина']),
  raion(R_POLTAVA, 'Полтавський район', 'полтавський'),
  raion(R_KREMENCHUK, 'Кременчуцький район', 'кременчуцький'),
  raion(R_MYRHOROD, 'Миргородський район', 'миргородський'),
  raion(R_LUBNY, 'Лубенський район', 'лубенський'),

  // All cities of the oblast (raions per the 2020 reform).
  city('ua-pl-c-poltava', 'Полтава', R_POLTAVA),
  city('ua-pl-c-karlivka', 'Карлівка', R_POLTAVA),
  city('ua-pl-c-kobeliaky', 'Кобеляки', R_POLTAVA),
  city('ua-pl-c-reshetylivka', 'Решетилівка', R_POLTAVA),
  city('ua-pl-c-zinkiv', 'Зіньків', R_POLTAVA),
  city('ua-pl-c-kremenchuk', 'Кременчук', R_KREMENCHUK),
  city('ua-pl-c-horishni-plavni', 'Горішні Плавні', R_KREMENCHUK, ['Комсомольськ']),
  city('ua-pl-c-hlobyne', 'Глобине', R_KREMENCHUK),
  city('ua-pl-c-myrhorod', 'Миргород', R_MYRHOROD),
  city('ua-pl-c-hadiach', 'Гадяч', R_MYRHOROD),
  city('ua-pl-c-lokhvytsia', 'Лохвиця', R_MYRHOROD),
  city('ua-pl-c-zavodske', 'Заводське', R_MYRHOROD, ['Червонозаводське']),
  city('ua-pl-c-lubny', 'Лубни', R_LUBNY),
  city('ua-pl-c-pyriatyn', 'Пирятин', R_LUBNY),
  city('ua-pl-c-hrebinka', 'Гребінка', R_LUBNY),
  city('ua-pl-c-khorol', 'Хорол', R_LUBNY),

  // Villages named in the source channels.
  village('ua-pl-v-shcherbani', 'Щербані', R_POLTAVA),
  village('ua-pl-v-sudiivka', 'Судіївка', R_POLTAVA),
  village('ua-pl-v-machukhy', 'Мачухи', R_POLTAVA),
  village('ua-pl-v-rozsoshentsi', 'Розсошенці', R_POLTAVA),
  village('ua-pl-v-brailky', 'Браїлки', R_POLTAVA),
  village('ua-pl-v-ustymivka', 'Устимівка', R_KREMENCHUK),
  village('ua-pl-v-kamiani-potoky', "Кам'яні Потоки", R_KREMENCHUK),

  // Neighbouring oblasts: stored as context, outside the MVP area.
  oblast('ua-kh', 'Харківська область', 'харківська', ['Харківщина']),
  oblast('ua-sm', 'Сумська область', 'сумська', ['Сумщина']),
  oblast('ua-dp', 'Дніпропетровська область', 'дніпропетровська', ['Дніпропетровщина', 'Дніпровщина']),
  oblast('ua-kr', 'Кіровоградська область', 'кіровоградська', ['Кіровоградщина']),
  oblast('ua-ck', 'Черкаська область', 'черкаська', ['Черкащина']),
  oblast('ua-kv', 'Київська область', 'київська', ['Київщина']),
  oblast('ua-cn', 'Чернігівська область', 'чернігівська', ['Чернігівщина']),
];

/**
 * City districts and micro-districts. They are not places of their own: `match` resolves them
 * to the city and keeps the district name as `subArea`.
 */
export const SUB_AREAS: Readonly<Record<string, readonly string[]>> = {
  'ua-pl-c-poltava': ['Половки', 'Рибці', 'Авіамістечко'],
  'ua-pl-c-kremenchuk': ['Крюків', 'Крюківський район', 'Автозаводський район'],
};

/**
 * Names shared by several villages of the oblast that are not in PLACES. `match` marks them
 * ambiguous and never resolves them to a place.
 */
export const AMBIGUOUS_NAMES: readonly string[] = [
  'Петрівка',
  'Михайлівка',
  'Миколаївка',
  'Олександрівка',
  'Василівка',
  'Іванівка',
  'Новоселівка',
];
