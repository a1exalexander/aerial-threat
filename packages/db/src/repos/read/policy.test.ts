import { describe, expect, it } from 'vitest';
import {
  type AlertRow,
  ageFreshness,
  alertDto,
  alertPlaces,
  incidentGeoBasis,
  publicUsername,
  sourceAvailability,
  subtree,
  telegramUrl,
  worstFreshness,
} from './policy';

const now = new Date('2026-09-21T12:00:00Z');
const ago = (s: number) => new Date(now.getTime() - s * 1000);
const row = (over: Partial<AlertRow>): AlertRow => ({
  areaKey: 'полтавська',
  placeId: 'ua-pl',
  state: 'inactive',
  level: null,
  since: null,
  freshness: 'fresh',
  lastSuccessAt: ago(5),
  lastProviderChangeAt: null,
  ...over,
});

describe('read policy', () => {
  it('takes the worst freshness and treats nothing as unknown', () => {
    expect(worstFreshness(['fresh', 'stale', 'fresh'])).toBe('stale');
    expect(worstFreshness(['fresh', 'unknown'])).toBe('unknown');
    expect(worstFreshness(['fresh'])).toBe('fresh');
    expect(worstFreshness([])).toBe('unknown');
  });

  it('ages alert data: stale after 30 s, unknown after 120 s or with no success at all', () => {
    expect(ageFreshness(ago(30), now)).toBe('fresh');
    expect(ageFreshness(ago(31), now)).toBe('stale');
    expect(ageFreshness(ago(121), now)).toBe('unknown');
    expect(ageFreshness(null, now)).toBe('unknown');
  });

  it('never reports a missing or untrusted alert as inactive', () => {
    expect(alertDto('полтавська', undefined, undefined, now)).toMatchObject({ state: 'unknown', freshness: 'unknown' });
    expect(alertDto('k', undefined, row({ lastSuccessAt: ago(600) }), now)).toMatchObject({ state: 'unknown', freshness: 'unknown' });
    expect(alertDto('k', undefined, row({ freshness: 'unknown' }), now)).toMatchObject({ state: 'unknown' });
    expect(alertDto('k', undefined, row({ state: 'weird' }), now)).toMatchObject({ state: 'unknown', freshness: 'fresh' });
    expect(alertDto('k', undefined, row({ state: 'active', lastSuccessAt: ago(60) }), now)).toMatchObject({
      state: 'active',
      freshness: 'stale',
    });
    expect(alertDto('k', undefined, row({}), now)).toMatchObject({ state: 'inactive', freshness: 'fresh' });
  });

  it('scopes areas downwards for incidents and both ways for alerts', () => {
    expect(subtree('ua-pl-c-kremenchuk')).toEqual(['ua-pl-c-kremenchuk']);
    expect(subtree('ua-pl-r-kremenchutskyi')).toEqual(
      expect.arrayContaining(['ua-pl-r-kremenchutskyi', 'ua-pl-c-kremenchuk', 'ua-pl-c-horishni-plavni']),
    );
    expect(subtree('ua-pl-r-kremenchutskyi')).not.toContain('ua-pl');
    expect(alertPlaces('ua-pl-c-kremenchuk').map((p) => p.id)).toEqual(['ua-pl', 'ua-pl-r-kremenchutskyi']);
    expect(alertPlaces('ua-kh').map((p) => p.id)).toEqual(['ua-kh']);
  });

  it('derives source availability from connector health, not channel silence', () => {
    const s = { enabled: true, lastSuccessAt: ago(10), errorKind: null };
    expect(sourceAvailability(s, now)).toBe('ok');
    expect(sourceAvailability({ ...s, errorKind: 'flood_wait' }, now)).toBe('degraded');
    expect(sourceAvailability({ ...s, lastSuccessAt: ago(6 * 60) }, now)).toBe('degraded');
    expect(sourceAvailability({ ...s, lastSuccessAt: ago(16 * 60) }, now)).toBe('unavailable');
    expect(sourceAvailability({ ...s, lastSuccessAt: null }, now)).toBe('unknown');
    expect(sourceAvailability({ ...s, enabled: false }, now)).toBe('paused');
  });

  it('links only verified public usernames', () => {
    expect(publicUsername('telegram', 'aerial_demo_a')).toBe('aerial_demo_a');
    for (const bad of ['bad name!', 'abc', 'ends_', '1digit', 'x'.repeat(33), 'a/../b', null])
      expect(publicUsername('telegram', bad)).toBeNull();
    expect(publicUsername('neptun', 'aerial_demo_a')).toBeNull();
    expect(telegramUrl('aerial_demo_a', '13810')).toBe('https://t.me/aerial_demo_a/13810');
    expect(telegramUrl('aerial_demo_a', '-5')).toBeNull();
    expect(telegramUrl(null, '13810')).toBeNull();
  });

  it('reports the strongest geo basis, and unresolved without an area', () => {
    expect(incidentGeoBasis('ua-pl', ['channel_default', 'explicit'])).toBe('explicit');
    expect(incidentGeoBasis(null, ['explicit'])).toBe('unresolved');
  });
});
