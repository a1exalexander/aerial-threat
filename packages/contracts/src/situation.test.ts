import { describe, expect, it } from 'vitest';
import { type SituationStatuses, situationTile } from './index';

const status = <T>(value: T, confidence: 'high' | 'low' = 'high') => ({ value, confidence, evidenceMessageIds: [] });
const statuses = (threatNow: boolean, confidence: 'high' | 'low' = 'high'): SituationStatuses => ({
  threatNow: status(threatNow, confidence),
  threatType: status('shahed' as const),
  direction: status('towards' as const),
  quantity: status('1' as const),
  forecast: status('none' as const),
  explosions: status(false),
  airDefense: status(false),
});

describe('situationTile', () => {
  it.each([
    ['active', 'fresh', statuses(false), 'alert', false],
    ['active', 'fresh', statuses(true), 'alert', false], // a channel threat never overrides the alert
    ['active', 'stale', null, 'alert', true],
    ['unknown', 'fresh', statuses(true), 'unknown', false],
    ['inactive', 'unknown', statuses(false), 'unknown', false], // expired data never reads as clear
    ['inactive', 'fresh', statuses(true), 'threat', false],
    ['inactive', 'stale', statuses(true), 'threat', true],
    ['inactive', 'fresh', statuses(true, 'low'), 'clear', false],
    ['inactive', 'fresh', null, 'clear', false],
    ['inactive', 'stale', statuses(false), 'clear', true],
  ] as const)('%s/%s -> %s', (state, freshness, s, tile, stale) => {
    expect(situationTile({ state, freshness }, s)).toEqual({ tile, stale });
  });

  it('no alert row is unknown, never clear', () => {
    expect(situationTile(null, statuses(false))).toEqual({ tile: 'unknown', stale: false });
    expect(situationTile(undefined, null)).toEqual({ tile: 'unknown', stale: false });
  });
});
