import { describe, expect, it } from 'vitest';
import { AREA_GEOMETRY } from './geometry';
import { PLACES, ancestors, byId, byNeptunKey, children } from './index';

const PARENT_LEVEL: Record<string, string[]> = { oblast: [], raion: ['oblast'], hromada: ['raion'], city: ['raion', 'hromada'], village: ['raion', 'hromada'] };

describe('geo dictionary', () => {
  it('has unique IDs and NEPTUN keys', () => {
    expect(new Set(PLACES.map((p) => p.id)).size).toBe(PLACES.length);
    const keys = PLACES.flatMap((p) => p.neptunKeys);
    expect(new Set(keys).size).toBe(keys.length);
  });

  // Parents are always a strictly higher level, so the hierarchy cannot cycle.
  it('links every place to an existing parent of a higher level', () => {
    for (const p of PLACES) {
      if (p.parentId) expect(PARENT_LEVEL[p.level], p.id).toContain(byId(p.parentId)?.level);
      else expect(p.level, p.id).toBe('oblast');
      expect(p.aliases, p.id).toContain(p.name);
    }
  });

  it('resolves the Poltava hierarchy and NEPTUN keys', () => {
    expect(ancestors('ua-pl-c-kremenchuk').map((p) => p.id)).toEqual(['ua-pl-r-kremenchutskyi', 'ua-pl']);
    expect(children('ua-pl').map((p) => p.id)).toHaveLength(4);
    expect(byNeptunKey('кременчуцький')?.id).toBe('ua-pl-r-kremenchutskyi');
    expect(byNeptunKey('полтавська')?.id).toBe('ua-pl');
    expect(byNeptunKey('невідомий')).toBeUndefined();
  });

  it('ships geometry for the oblast and every raion, keyed by place ID', () => {
    const ids = AREA_GEOMETRY.features.map((f) => f.properties.id).sort();
    expect(ids).toEqual(['ua-pl', ...children('ua-pl').map((p) => p.id)].sort());
    for (const f of AREA_GEOMETRY.features) {
      expect(byId(f.properties.id)).toMatchObject({ name: f.properties.name, level: f.properties.level });
    }
  });
});
