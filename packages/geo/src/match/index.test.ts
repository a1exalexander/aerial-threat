import { describe, expect, it } from 'vitest';
import { AMBIGUOUS_NAMES, PLACES, SUB_AREAS } from '../dictionary';
import { byId } from '../index';
import { extractPlaceCandidates, type PlaceCandidate } from './index';

// All sentences are synthetic.
function extract(text: string): PlaceCandidate[] {
  const found = extractPlaceCandidates(text);
  for (const c of found) expect(text.slice(c.span.start, c.span.end)).toBe(c.surface);
  return found;
}
const brief = (text: string) => extract(text).map((c) => [c.surface, c.placeId, c.relation]);
const one = (text: string) => {
  const found = extract(text);
  expect(found).toHaveLength(1);
  return found[0]!;
};

describe('extractPlaceCandidates', () => {
  it('matches case forms of city names', () => {
    for (const form of ['Полтава', 'Полтави', 'Полтаві', 'Полтаву', 'Полтавою']) {
      expect(one(`Тихо: ${form} сьогодні`).placeId).toBe('ua-pl-c-poltava');
    }
    for (const form of ['Кременчук', 'Кременчука', 'Кременчуку', 'Кременчуці', 'Кременчуком']) {
      expect(one(`Новини: ${form} сьогодні`).placeId).toBe('ua-pl-c-kremenchuk');
    }
    expect(one('Шахед у Горішніх Плавнях').placeId).toBe('ua-pl-c-horishni-plavni');
    expect(one('Тиша в Лохвиці').placeId).toBe('ua-pl-c-lokhvytsia');
    expect(one('Щось біля Зінькова').placeId).toBe('ua-pl-c-zinkiv');
    expect(one('Гул над Глобиним').placeId).toBe('ua-pl-c-hlobyne');
    expect(one('Дрон у Лубнах').placeId).toBe('ua-pl-c-lubny');
    expect(one('Дрон поблизу Лубен').placeId).toBe('ua-pl-c-lubny');
    expect(one('Обстріл у Карлівці').placeId).toBe('ua-pl-c-karlivka');
  });

  it('resolves every dictionary name in its base form', () => {
    for (const p of PLACES) for (const alias of p.aliases) expect(one(alias).placeId, alias).toBe(p.id);
  });

  it('is case-insensitive and folds apostrophes and Latin look-alikes', () => {
    expect(one('полтавський район').placeId).toBe('ua-pl-r-poltavskyi');
    expect(one('ПОЛТАВА').placeId).toBe('ua-pl-c-poltava');
    expect(one('Шум у Полтавi').placeId).toBe('ua-pl-c-poltava'); // Latin i
    for (const apostrophe of ["'", '’', 'ʼ', '`']) {
      expect(one(`Рух біля Кам${apostrophe}яних Потоків`).placeId).toBe('ua-pl-v-kamiani-potoky');
    }
  });

  it('keeps oblast, raion and city levels apart', () => {
    expect(one('Дронова активність на Полтавщині')).toMatchObject({ placeId: 'ua-pl', level: 'oblast', relation: 'in' });
    expect(one('Гроза по Полтавській обл.')).toMatchObject({ placeId: 'ua-pl', level: 'oblast' });
    expect(one('Загроза у Кременчуцькому районі')).toMatchObject({ placeId: 'ua-pl-r-kremenchutskyi', level: 'raion', relation: 'in' });
    expect(one('Кременчуцький р-н: тривога триває')).toMatchObject({ placeId: 'ua-pl-r-kremenchutskyi', level: 'raion' });
    expect(one('Уламки в Полтавському р-ні')).toMatchObject({ placeId: 'ua-pl-r-poltavskyi', relation: 'in' });
    expect(brief('Сумщина і Полтавщина')).toEqual([
      ['Сумщина', 'ua-sm', 'unknown'],
      ['Полтавщина', 'ua-pl', 'unknown'],
    ]);
  });

  it('does not take adjectival object names or unnamed places for places', () => {
    expect(extract('Полтавська ТЕЦ працює')).toEqual([]);
    expect(extract('Ремонт на Полтавській ТЕЦ')).toEqual([]);
    expect(extract('Курс на Кременчуцьке водосховище')).toEqual([]);
    expect(extract('Засідання Кременчуцького районного суду')).toEqual([]);
    expect(extract('Гул біля аеропорту')).toEqual([]);
    expect(extract('Ціль над містом')).toEqual([]);
    expect(extract('Затримали кременчуківця')).toEqual([]);
  });

  it('reads the relation from the preposition and the case', () => {
    expect(one('Два дрони летять у напрямку Кременчука').relation).toBe('towards');
    expect(one('Група курсом в бік Полтави').relation).toBe('towards');
    expect(one('Ціль іде курсом на Полтаву').relation).toBe('towards');
    expect(one('Ракета на Кременчук, заходить зі сходу').relation).toBe('towards');
    expect(one('Шахед на Полтаву').relation).toBe('towards');
    expect(one('Шахед у Полтаві').relation).toBe('in');
    expect(one('Вибухи в м. Кременчук').relation).toBe('in');
    expect(one('Вибухи у м. Кременчуці').relation).toBe('in');
    expect(one('Шахед на м. Кременчук').relation).toBe('towards');
    expect(one('📍 м. Кременчук, вул. Центральна').relation).toBe('unknown');
    expect(one('Світло вимкнули в селі Устимівка').relation).toBe('in');
    expect(one('Дрон над Полтавою').relation).toBe('over');
    expect(one('Ракета повз Лубни на північ').relation).toBe('past');
    expect(one('Ще кружляє поблизу Полтави').relation).toBe('near');
    expect(one('Ціль тримається північніше Кременчука').relation).toBe('near');
    expect(one('Щось у районі Кременчука').relation).toBe('region_of');
    expect(one('Шахеди в р-ні Полтави').relation).toBe('region_of');
    expect(one('→Гадяч').relation).toBe('towards');
    expect(one('Дрон з Полтавщини').relation).toBe('unknown');
    expect(one('Для Полтави поки тихо').relation).toBe('unknown');
    expect(one('Гул. Полтава не спить').relation).toBe('unknown');
  });

  it('leaves the relation open when the author gives alternatives', () => {
    expect(one('Ціль на/повз Полтаву, стежимо').relation).toBe('unknown');
  });

  it('does not carry a relation over a clause or a matched raion name', () => {
    expect(brief('у Полтаві, Кременчук під загрозою').map(([, , r]) => r)).toEqual(['in', 'unknown']);
    expect(brief('в напрямку Кременчука, Полтава чиста').map(([, , r]) => r)).toEqual(['towards', 'unknown']);
    expect(brief('У Полтавському районі Полтава').map(([, , r]) => r)).toEqual(['in', 'unknown']);
  });

  it('carries the relation across a list of places', () => {
    expect(brief('Потім поверне на Мачухи/Судіївку')).toEqual([
      ['Мачухи', 'ua-pl-v-machukhy', 'towards'],
      ['Судіївку', 'ua-pl-v-sudiivka', 'towards'],
    ]);
    expect(brief('Дві цілі →Гадяч/Миргород, заходять з Сумщини')).toEqual([
      ['Гадяч', 'ua-pl-c-hadiach', 'towards'],
      ['Миргород', 'ua-pl-c-myrhorod', 'towards'],
      ['Сумщини', 'ua-sm', 'unknown'],
    ]);
  });

  it('finds several mentions with exact spans', () => {
    const text = '✈️Полтавщина: одна ціль з Полтавщини на Черкащину, інша у напрямку Кременчука.';
    expect(brief(text)).toEqual([
      ['Полтавщина', 'ua-pl', 'unknown'],
      ['Полтавщини', 'ua-pl', 'unknown'],
      ['Черкащину', 'ua-ck', 'towards'],
      ['Кременчука', 'ua-pl-c-kremenchuk', 'towards'],
    ]);
  });

  it('resolves city districts to the city with a subArea note', () => {
    expect(one('Затор у Крюкові зранку')).toMatchObject({ placeId: 'ua-pl-c-kremenchuk', level: 'city', subArea: 'Крюків', relation: 'in' });
    expect(one('Немає води на Половках')).toMatchObject({ placeId: 'ua-pl-c-poltava', subArea: 'Половки', relation: 'in' });
    expect(one('Суд в Автозаводському районі')).toMatchObject({ placeId: 'ua-pl-c-kremenchuk', subArea: 'Автозаводський район' });
    expect(one('Вибух у Кременчуці')).toMatchObject({ subArea: null });
  });

  it('never resolves same-name villages', () => {
    expect(one('Дрон біля Михайлівки')).toMatchObject({ placeId: null, level: 'village', ambiguous: true, alternatives: [], relation: 'near' });
    expect(one('Уламки у Петрівці Кременчуцького').placeId).toBeNull();
  });

  it('requires a capital letter for settlement names that are also common words', () => {
    expect(extract('купили рибці й мачухи, нова гребінка')).toEqual([]);
    expect(extract('удар по заводському цеху')).toEqual([]);
    expect(one('Без води Рибці')).toMatchObject({ placeId: 'ua-pl-c-poltava', subArea: 'Рибці' });
  });

  it('splits hyphenated route names into both places', () => {
    expect(brief('Ремонт дороги Кременчук-Полтава').map(([, id]) => id)).toEqual(['ua-pl-c-kremenchuk', 'ua-pl-c-poltava']);
  });
});

describe('dictionary extras', () => {
  it('keys districts by existing cities and keeps extra names out of PLACES', () => {
    const names = new Set(PLACES.flatMap((p) => p.aliases));
    for (const [cityId, districts] of Object.entries(SUB_AREAS)) {
      expect(byId(cityId)?.level).toBe('city');
      for (const d of districts) expect(names.has(d), d).toBe(false);
    }
    for (const n of AMBIGUOUS_NAMES) expect(names.has(n), n).toBe(false);
  });
});
