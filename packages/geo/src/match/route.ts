// Route lists from the channels («Козельщина/Манжелія/Погреби/Градизьк і на воду») as ordered stops.
import type { RouteStop } from '@aerial/contracts';
import { byId } from '../index';
import { extractPlaceCandidates } from './index';

const SPACE = '[^\\S\\n]';
const THEN = `(?:(?:і|и|й|та)\\s+)?(?:далі|дальше|потім|потом)`;
// Between two stops, on one line: «/», «→», «->», «,», a spaced dash, or «, далі (на) …».
const JOIN = new RegExp(`^${SPACE}*(?:(?:[/,→➡]\\uFE0F?|->)${SPACE}*|[-–—]${SPACE}+|,?${SPACE}*${THEN}${SPACE}+(?:(?:на|в|у|к|до)${SPACE}+)?)$`, 'iu');
const COMMA = /^\s*,\s*$/;
// «… і на воду», «…, дальше на воду», «… курс на воду»: over the Dnipro / Kremenchuk reservoir.
const TO_WATER = new RegExp(`^${SPACE}*,?${SPACE}*(?:(?:і|и|й|та)\\s+)?(?:(?:далі|дальше|потім|потом|курс(?:ом)?)\\s+)?на\\s+воду(?!\\p{L})`, 'iu');
// A capitalised name outside the dictionary; «Нова/Мала/Велика …» keep their first word. All-caps (ППО, ТЦ) is not a name.
const OTHER_NAME = /(?<!\p{L})(?:(?:Нов|Мал|Велик|Стар|Верхн|Нижн)\p{Ll}*\s+)?\p{Lu}\p{Ll}[\p{L}'’ʼ]*/gu;

// `known`: a dictionary match (resolved or ambiguous), not just a capitalised word.
type Item = { start: number; end: number; stop: RouteStop; known: boolean };

/** Settlements (resolved or not) in text order. Oblast and raion mentions are no stops and break a list. */
function items(text: string): Item[] {
  const found = extractPlaceCandidates(text);
  const out: Item[] = found
    .filter((c) => c.level !== 'oblast' && c.level !== 'raion')
    .map((c) => ({ ...c.span, known: true, stop: { name: c.subArea ?? (c.placeId && byId(c.placeId)?.name) ?? c.surface, placeId: c.placeId } }));
  for (const m of text.matchAll(OTHER_NAME)) {
    const [start, end] = [m.index, m.index + m[0].length];
    if (!found.some((c) => c.span.start < end && start < c.span.end)) out.push({ start, end, known: false, stop: { name: m[0], placeId: null } });
  }
  return out.sort((a, b) => a.start - b.start);
}

/**
 * Ordered stops of the post's longest route list: ≥2 names joined by «/», «→», «->», «,» or « - »
 * with at least one dictionary place, plus a final «на воду» stop (placeId null). Unknown names keep
 * their surface form but never join by a bare comma. A comma-only list needs 3 names, so prose
 * («у Полтаві, Кременчуці») is no route.
 * Null when the text has no list.
 */
export function extractRoute(text: string): RouteStop[] | null {
  const list = items(text);
  let best: RouteStop[] | null = null;
  for (let i = 0; i < list.length; ) {
    let j = i;
    const gaps: string[] = [];
    for (; j + 1 < list.length; j++) {
      const gap = text.slice(list[j]!.end, list[j + 1]!.start);
      // A bare comma joins dictionary names only: «Увага, Кременчук, Полтава» is prose.
      if (!JOIN.test(gap) || (COMMA.test(gap) && !(list[j]!.known && list[j + 1]!.known))) break;
      gaps.push(gap);
    }
    const run = list.slice(i, j + 1);
    i = j + 1;
    if (run.length < 2 || !run.some((s) => s.stop.placeId)) continue;
    if (run.length < 3 && gaps.every((g) => COMMA.test(g))) continue;
    const stops = run.map((s) => s.stop);
    if (TO_WATER.test(text.slice(run.at(-1)!.end))) stops.push({ name: 'на воду', placeId: null });
    if (!best || stops.length > best.length) best = stops;
  }
  return best;
}
