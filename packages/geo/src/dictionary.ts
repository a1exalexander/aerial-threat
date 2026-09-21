import type { PlaceLevel } from '@aerial/contracts';

/** Bump on any change to PLACES, SUB_AREAS or AMBIGUOUS_NAMES; stored alongside results that reference place IDs. */
export const DICTIONARY_VERSION = 'geo-v3';

export type Place = {
  /** Stable ID, never reused: <oblast> (ua-pl, ua-dp…), <oblast>-r-<raion>, <oblast>-c-<city>, <oblast>-v-<village or селище>. */
  readonly id: string;
  readonly name: string;
  readonly level: PlaceLevel;
  readonly parentId: string | null;
  /** Base (nominative) forms only, Ukrainian first, then Russian/surzhyk spellings; case forms belong to @aerial/geo/match. */
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
const raion = (id: string, name: string, neptunKey: string | null, parentId = 'ua-pl', aliases: string[] = []): Place => ({
  id,
  name,
  level: 'raion',
  parentId,
  aliases: [name, ...aliases],
  neptunKeys: neptunKey ? [neptunKey] : [],
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
  oblast('ua-pl', 'Полтавська область', 'полтавська', ['Полтавщина', 'Полтавская область']),
  raion(R_POLTAVA, 'Полтавський район', 'полтавський', 'ua-pl', ['Полтавский район']),
  raion(R_KREMENCHUK, 'Кременчуцький район', 'кременчуцький', 'ua-pl', ['Кременчугский район']),
  raion(R_MYRHOROD, 'Миргородський район', 'миргородський', 'ua-pl', ['Миргородский район']),
  raion(R_LUBNY, 'Лубенський район', 'лубенський', 'ua-pl', ['Лубенский район']),

  // All cities of the oblast (raions per the 2020 reform).
  city('ua-pl-c-poltava', 'Полтава', R_POLTAVA),
  city('ua-pl-c-karlivka', 'Карлівка', R_POLTAVA, ['Карловка']),
  city('ua-pl-c-kobeliaky', 'Кобеляки', R_POLTAVA),
  city('ua-pl-c-reshetylivka', 'Решетилівка', R_POLTAVA, ['Решетиловка']),
  city('ua-pl-c-zinkiv', 'Зіньків', R_POLTAVA, ['Зеньков']),
  city('ua-pl-c-kremenchuk', 'Кременчук', R_KREMENCHUK, ['Кременчуг']),
  city('ua-pl-c-horishni-plavni', 'Горішні Плавні', R_KREMENCHUK, ['Комсомольськ', 'Горишние Плавни', 'Горишни Плавни', 'Комсомольск']),
  city('ua-pl-c-hlobyne', 'Глобине', R_KREMENCHUK, ['Глобино']),
  city('ua-pl-c-myrhorod', 'Миргород', R_MYRHOROD),
  city('ua-pl-c-hadiach', 'Гадяч', R_MYRHOROD),
  city('ua-pl-c-lokhvytsia', 'Лохвиця', R_MYRHOROD, ['Лохвица']),
  city('ua-pl-c-zavodske', 'Заводське', R_MYRHOROD, ['Червонозаводське', 'Заводское']),
  city('ua-pl-c-lubny', 'Лубни', R_LUBNY),
  city('ua-pl-c-pyriatyn', 'Пирятин', R_LUBNY),
  city('ua-pl-c-hrebinka', 'Гребінка', R_LUBNY, ['Гребенка']),
  city('ua-pl-c-khorol', 'Хорол', R_LUBNY),

  // Villages named in the source channels. `village` also covers селища (former смт): every settlement below city status.
  village('ua-pl-v-shcherbani', 'Щербані', R_POLTAVA, ['Щербаны']),
  village('ua-pl-v-sudiivka', 'Судіївка', R_POLTAVA, ['Судиевка']),
  village('ua-pl-v-machukhy', 'Мачухи', R_POLTAVA),
  village('ua-pl-v-rozsoshentsi', 'Розсошенці', R_POLTAVA, ['Россошенцы']),
  village('ua-pl-v-brailky', 'Браїлки', R_POLTAVA, ['Браилки']),
  village('ua-pl-v-ustymivka', 'Устимівка', R_KREMENCHUK, ['Устимовка']),
  village('ua-pl-v-kamiani-potoky', "Кам'яні Потоки", R_KREMENCHUK, ['Каменные Потоки']),
  // v3: stops of the drone routes across the raion («Козельщина/Манжелія/Погреби/Градизьк і на воду»).
  village('ua-pl-v-kozelshchyna', 'Козельщина', R_KREMENCHUK, ['Козелищина']),
  village('ua-pl-v-manzheliia', 'Манжелія', R_KREMENCHUK, ['Манжелия', 'Манежелия']),
  village('ua-pl-v-lamane', 'Ламане', R_KREMENCHUK, ['Ламаное']),
  village('ua-pl-v-pohreby', 'Погреби', R_KREMENCHUK),
  village('ua-pl-v-hradyzk', 'Градизьк', R_KREMENCHUK, ['Градижск', 'Градисжк', 'Градизьск']),
  village('ua-pl-v-omelnyk', 'Омельник', R_KREMENCHUK),
  village('ua-pl-v-semenivka', 'Семенівка', R_KREMENCHUK, ['Семеновка']),
  village('ua-pl-v-opishnia', 'Опішня', R_POLTAVA, ['Опошня']),
  village('ua-pl-v-dykanka', 'Диканька', R_POLTAVA),
  village('ua-pl-v-mashivka', 'Машівка', R_POLTAVA, ['Машевка']),
  village('ua-pl-v-chutove', 'Чутове', R_POLTAVA, ['Чутово']),

  // Neighbouring oblasts: stored as context, outside the MVP area.
  oblast('ua-kh', 'Харківська область', 'харківська', ['Харківщина', 'Харьковская область', 'Харьковщина']),
  oblast('ua-sm', 'Сумська область', 'сумська', ['Сумщина', 'Сумская область']),
  oblast('ua-dp', 'Дніпропетровська область', 'дніпропетровська', ['Дніпропетровщина', 'Дніпровщина', 'Днепропетровская область', 'Днепропетровщина']),
  oblast('ua-kr', 'Кіровоградська область', 'кіровоградська', ['Кіровоградщина', 'Кировоградская область', 'Кировоградщина']),
  oblast('ua-ck', 'Черкаська область', 'черкаська', ['Черкащина', 'Черкасская область', 'Черкасщина']),
  oblast('ua-kv', 'Київська область', 'київська', ['Київщина', 'Киевская область', 'Киевщина']),
  oblast('ua-cn', 'Чернігівська область', 'чернігівська', ['Чернігівщина', 'Черниговская область', 'Черниговщина']),

  // v3: neighbour raions and the route stops across the oblast border. No NEPTUN keys: context only.
  raion('ua-dp-r-dniprovskyi', 'Дніпровський район', null, 'ua-dp'),
  city('ua-dp-c-dnipro', 'Дніпро', 'ua-dp-r-dniprovskyi', ['Днепр']),
  village('ua-dp-v-tsarychanka', 'Царичанка', 'ua-dp-r-dniprovskyi'),
  raion('ua-kr-r-kropyvnytskyi', 'Кропивницький район', null, 'ua-kr'),
  city('ua-kr-c-kropyvnytskyi', 'Кропивницький', 'ua-kr-r-kropyvnytskyi', ['Кропивницкий', 'Кроп', 'Кроп-р']),
  village('ua-kr-v-kanatove', 'Канатове', 'ua-kr-r-kropyvnytskyi', ['Канатово']),
  raion('ua-kr-r-oleksandriiskyi', 'Олександрійський район', null, 'ua-kr'),
  city('ua-kr-c-oleksandriia', 'Олександрія', 'ua-kr-r-oleksandriiskyi', ['Александрия']),
  city('ua-kr-c-svitlovodsk', 'Світловодськ', 'ua-kr-r-oleksandriiskyi', ['Светловодск']),
  village('ua-kr-v-onufriivka', 'Онуфріївка', 'ua-kr-r-oleksandriiskyi', ['Онуфриевка']),
  village('ua-kr-v-pavlysh', 'Павлиш', 'ua-kr-r-oleksandriiskyi'),
  raion('ua-ck-r-cherkaskyi', 'Черкаський район', null, 'ua-ck'),
  city('ua-ck-c-cherkasy', 'Черкаси', 'ua-ck-r-cherkaskyi', ['Черкассы']),
  city('ua-ck-c-chyhyryn', 'Чигирин', 'ua-ck-r-cherkaskyi'),
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
