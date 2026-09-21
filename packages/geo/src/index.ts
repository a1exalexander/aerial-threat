import { PLACES, type Place } from './dictionary';

export { DICTIONARY_VERSION, PLACES, type Place } from './dictionary';

const index = new Map(PLACES.map((p) => [p.id, p]));
const neptunIndex = new Map(PLACES.flatMap((p) => p.neptunKeys.map((k) => [k, p] as const)));

export const byId = (id: string): Place | undefined => index.get(id);

export const children = (id: string): Place[] => PLACES.filter((p) => p.parentId === id);

/** Exact NEPTUN area key (e.g. "кременчуцький", "полтавська"); unknown keys return undefined. */
export const byNeptunKey = (key: string): Place | undefined => neptunIndex.get(key);

/** Parent chain, nearest first: city -> raion -> oblast. */
export function ancestors(id: string): Place[] {
  const chain: Place[] = [];
  for (let p = index.get(id)?.parentId; p; p = index.get(p)?.parentId) {
    const parent = index.get(p);
    if (!parent) break;
    chain.push(parent);
  }
  return chain;
}

/** Кременчуцький район itself or any place inside it (Кременчук, Козельщина, Градизьк…): decides "passing near Kremenchuk". */
export const isInKremenchukRaion = (id: string): boolean => [id, ...ancestors(id).map((p) => p.id)].includes('ua-pl-r-kremenchutskyi');
