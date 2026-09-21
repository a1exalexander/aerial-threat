import { describe, expect, it } from 'vitest';
import { extractRoute } from './index';

// All sentences are synthetic.
const stops = (text: string) => extractRoute(text)?.map((s) => [s.name, s.placeId]) ?? null;
const WATER = ['на воду', null];

describe('extractRoute', () => {
  it('reads a Russian slash list ending «и на воду»', () => {
    expect(stops('Козелищина/Манежелия/Ламаное/Погребы/Градижск и на воду')).toEqual([
      ['Козельщина', 'ua-pl-v-kozelshchyna'],
      ['Манжелія', 'ua-pl-v-manzheliia'],
      ['Ламане', 'ua-pl-v-lamane'],
      ['Погреби', 'ua-pl-v-pohreby'],
      ['Градизьк', 'ua-pl-v-hradyzk'],
      WATER,
    ]);
  });

  it('reads comma lists, arrows and spaced dashes', () => {
    expect(stops('Кобеляки, Козельщина, Манжелія, Погреби, Градизьк')?.map(([, id]) => id)).toEqual([
      'ua-pl-c-kobeliaky',
      'ua-pl-v-kozelshchyna',
      'ua-pl-v-manzheliia',
      'ua-pl-v-pohreby',
      'ua-pl-v-hradyzk',
    ]);
    expect(stops('Група: Опошня/Диканька/Полтава')?.map(([name]) => name)).toEqual(['Опішня', 'Диканька', 'Полтава']);
    expect(stops('курс Глобине → Кременчук')?.map(([name]) => name)).toEqual(['Глобине', 'Кременчук']);
    expect(stops('Градизьк->Глобине')?.map(([name]) => name)).toEqual(['Градизьк', 'Глобине']);
    expect(stops('маршрут Кременчук - Полтава')?.map(([name]) => name)).toEqual(['Кременчук', 'Полтава']);
  });

  it('crosses the oblast border in dictionary names', () => {
    expect(stops('Летить біля Горішні Плавні/Онуфріївка/Павлиш/Чигирин.')).toEqual([
      ['Горішні Плавні', 'ua-pl-c-horishni-plavni'],
      ['Онуфріївка', 'ua-kr-v-onufriivka'],
      ['Павлиш', 'ua-kr-v-pavlysh'],
      ['Чигирин', 'ua-ck-c-chyhyryn'],
    ]);
  });

  it('keeps unknown names in their surface form', () => {
    expect(stops('Мопед: Кияшки/Нова Галещина/Козельщину')).toEqual([
      ['Кияшки', null],
      ['Нова Галещина', null],
      ['Козельщина', 'ua-pl-v-kozelshchyna'],
    ]);
    expect(stops('Садки/Крюків')).toEqual([
      ['Садки', null],
      ['Крюків', 'ua-pl-c-kremenchuk'],
    ]);
  });

  it('joins «далі (на)» and ends with the water', () => {
    expect(stops('Козельщина/Манжелія, далі Погреби/Градизьк, далі на воду')?.map(([name]) => name)).toEqual([
      'Козельщина',
      'Манжелія',
      'Погреби',
      'Градизьк',
      'на воду',
    ]);
    expect(stops('Погреби/Градизьк на воду і далі на Черкащину')).toEqual([
      ['Погреби', 'ua-pl-v-pohreby'],
      ['Градизьк', 'ua-pl-v-hradyzk'],
      WATER,
    ]);
  });

  it('takes the longest list of the post', () => {
    const text = 'Один: Козельщина/Омельник\n\nДругий: Царичанка/Кобеляки/Козельщина/Градизьк\n\nКурс західний';
    expect(stops(text)?.map(([name]) => name)).toEqual(['Царичанка', 'Кобеляки', 'Козельщина', 'Градизьк']);
  });

  it('returns null when there is no route list', () => {
    expect(stops('Тихо в Кременчуці')).toBeNull();
    expect(stops('Градизьк і на воду')).toBeNull();
    expect(stops('Вибухи у Полтаві, Кременчуці')).toBeNull();
    expect(stops('(Шахед/Гербера) над містом')).toBeNull();
    expect(stops('Київ/Бориспіль знову гучно')).toBeNull();
    expect(stops('Кіровоградська/Полтавська обл чисто')).toBeNull();
    expect(stops('Ремонт дороги Кременчук-Полтава')).toBeNull();
    expect(stops('Кременчук/\nПолтава')).toBeNull();
    expect(stops('ППО/Кременчук')).toBeNull();
    expect(stops('Увага, Кременчук, Полтава')).toBeNull();
    expect(stops('Увага, Кременчук, Полтава, Лубни')?.map(([name]) => name)).toEqual(['Кременчук', 'Полтава', 'Лубни']);
  });
});
