import type { AlertStateDto, AreaDto } from '@aerial/contracts';
import { describe, expect, it } from 'vitest';
import { alertDisplayState, areaAlertState, kyivLocalToIso, nearestArea, telegramUrl, toKyivLocal } from './present';

const alert = (placeId: string, state: AlertStateDto['state'], freshness: AlertStateDto['freshness'] = 'fresh'): AlertStateDto => ({
  areaKey: placeId,
  placeId,
  state,
  level: null,
  since: null,
  freshness,
  lastSuccessfulFetchAt: null,
  lastProviderChangeAt: null,
});

describe('Kyiv time', () => {
  it('converts Kyiv wall time to UTC in summer and winter', () => {
    expect(kyivLocalToIso('2026-09-20T14:30')).toBe('2026-09-20T11:30:00.000Z');
    expect(kyivLocalToIso('2026-01-10T10:00')).toBe('2026-01-10T08:00:00.000Z');
    expect(kyivLocalToIso('not a date')).toBeNull();
    expect(kyivLocalToIso('2026-02-31T10:00')).toBeNull(); // no silent roll-over into March
    expect(kyivLocalToIso('0099-09-20T14:30')).toBeNull(); // no silent 1999
    expect(kyivLocalToIso('2026-03-29T03:30')).toBeNull(); // skipped by the DST switch
  });

  it('round-trips through the datetime-local format', () => {
    const ms = Date.parse('2026-03-29T00:30:00Z'); // the night of the DST switch
    expect(kyivLocalToIso(toKyivLocal(ms))).toBe('2026-03-29T00:30:00.000Z');
  });
});

describe('telegramUrl', () => {
  it('builds links only from a valid public username and numeric ID', () => {
    expect(telegramUrl('demo_channel', '13745')).toBe('https://t.me/demo_channel/13745');
    expect(telegramUrl(null, '1')).toBeNull();
    expect(telegramUrl('javascript:alert(1)//', '1')).toBeNull();
    expect(telegramUrl('demo_channel', '1?x=<b>')).toBeNull();
  });
});

describe('alert display', () => {
  it('never shows an unknown-freshness reading as "no alert"', () => {
    expect(alertDisplayState(alert('a', 'inactive', 'unknown'))).toBe('unknown');
    expect(alertDisplayState(alert('a', 'inactive', 'stale'))).toBe('inactive');
    expect(alertDisplayState(alert('a', 'active', 'stale'))).toBe('active');
  });

  it('derives the map state of an area from itself and an oblast-wide alert', () => {
    expect(areaAlertState([alert('r', 'inactive'), alert('o', 'active')], 'r', 'o')).toBe('active');
    expect(areaAlertState([alert('r', 'inactive'), alert('o', 'inactive')], 'r', 'o')).toBe('inactive');
    expect(areaAlertState([alert('r', 'inactive'), alert('o', 'unknown')], 'r', 'o')).toBe('unknown');
    expect(areaAlertState([], 'r', 'o')).toBe('unknown');
    // A parent's "no alert" never stands in for a missing reading of the area itself.
    expect(areaAlertState([alert('o', 'inactive')], 'r', 'o')).toBe('unknown');
  });
});

it('nearestArea walks up to the first polygon we have', () => {
  const areas = new Map<string, AreaDto>([
    ['o', { id: 'o', name: 'O', level: 'oblast', parentId: null }],
    ['r', { id: 'r', name: 'R', level: 'raion', parentId: 'o' }],
    ['c', { id: 'c', name: 'C', level: 'city', parentId: 'r' }],
  ]);
  expect(nearestArea(areas, 'c', new Set(['o', 'r']))).toBe('r');
  expect(nearestArea(areas, 'c', new Set(['o']))).toBe('o');
  expect(nearestArea(areas, 'x', new Set(['o']))).toBeNull();
});
