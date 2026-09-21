import { KREMENCHUK, type SituationStatuses } from '@aerial/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { alertStates } from '../schema';
import { createTestDb } from '../testing';
import { insertSnapshot, isKremenchukAlertActive, kremenchukAlert, latestSnapshot } from './situation';

let t: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t?.drop());
beforeEach(async () => {
  await t.sql`truncate alert_states, situation_snapshots`;
});

const T0 = new Date('2026-09-21T08:00:00Z');
const plus = (ms: number) => new Date(T0.getTime() + ms);
const low = <T>(value: T) => ({ value, confidence: 'low' as const, evidenceMessageIds: [] });
const statuses: SituationStatuses = {
  threatNow: low(false),
  threatType: low('unknown'),
  direction: low('unknown'),
  quantity: low('unknown'),
  forecast: low('none'),
  explosions: low(false),
  airDefense: low(false),
};
const REV = '0b3c1f9e-8a3b-4a51-9d2e-2a4f3f7c1b10';

describe('situation_snapshots', () => {
  it('returns the newest snapshot of the area, filtered by mode and status', async () => {
    expect(await latestSnapshot(t.db, KREMENCHUK.placeId)).toBeNull();
    const base = { areaId: KREMENCHUK.placeId, statuses, status: 'ok' as const };
    const ai = await insertSnapshot(t.db, { ...base, evaluatedAt: T0, mode: 'ai', model: 'fake/jev', revisionIds: [REV], relevantRevisionIds: [REV] });
    await insertSnapshot(t.db, { ...base, evaluatedAt: plus(60_000), mode: 'rules', rulesVersion: 'situation-rules-v0' });
    await insertSnapshot(t.db, { ...base, evaluatedAt: plus(120_000), mode: 'ai', status: 'failed' });
    await insertSnapshot(t.db, { ...base, areaId: 'ua-pl', evaluatedAt: plus(180_000), mode: 'rules' });

    expect(ai).toMatchObject({ revisionIds: [REV], relevantRevisionIds: [REV], statuses, route: null });
    expect(await latestSnapshot(t.db, KREMENCHUK.placeId)).toMatchObject({ mode: 'ai', status: 'failed' });
    expect(await latestSnapshot(t.db, KREMENCHUK.placeId, { mode: 'rules' })).toMatchObject({ evaluatedAt: plus(60_000) });
    expect((await latestSnapshot(t.db, KREMENCHUK.placeId, { mode: 'ai', status: 'ok' }))?.id).toBe(ai.id);
  });
});

describe('kremenchukAlert', () => {
  const row = (areaKey: string, state: string, lastSuccessAt: Date) => ({
    areaKey,
    areaKind: areaKey === 'полтавська' ? 'oblast' : 'raion',
    state,
    level: state === 'active' ? 'red' : null,
    freshness: 'fresh',
    lastSuccessAt,
  });

  it('no data is unknown and not active', async () => {
    expect(await kremenchukAlert(t.db, T0)).toMatchObject({ placeId: KREMENCHUK.raionId, state: 'unknown', freshness: 'unknown' });
    expect(await isKremenchukAlertActive(t.db, T0)).toBe(false);
  });

  it('reads the raion row and ages it: stale after 30 s, unknown after 120 s', async () => {
    await t.db.insert(alertStates).values([row('кременчуцький', 'active', T0), row('полтавська', 'active', T0)]);
    expect(await kremenchukAlert(t.db, plus(10_000))).toMatchObject({ state: 'active', level: 'red', freshness: 'fresh' });
    expect(await kremenchukAlert(t.db, plus(60_000))).toMatchObject({ state: 'active', freshness: 'stale' });
    expect(await isKremenchukAlertActive(t.db, plus(60_000))).toBe(true);
    expect(await kremenchukAlert(t.db, plus(121_000))).toMatchObject({ state: 'unknown', freshness: 'unknown' });
    expect(await isKremenchukAlertActive(t.db, plus(121_000))).toBe(false);
  });

  it('an active oblast never makes the raion active; without a raion row it only gives freshness', async () => {
    await t.db.insert(alertStates).values(row('полтавська', 'active', T0));
    expect(await kremenchukAlert(t.db, plus(10_000))).toMatchObject({
      state: 'unknown',
      freshness: 'fresh',
      lastSuccessfulFetchAt: T0.toISOString(),
    });
    expect(await isKremenchukAlertActive(t.db, plus(10_000))).toBe(false);
  });
});
