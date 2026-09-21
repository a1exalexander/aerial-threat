import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { alertSnapshots, alertStates, sourceHealth } from '../schema';
import { createTestDb } from '../testing';
import {
  type ActiveAlertArea,
  applyAlertSnapshot,
  ensureNeptunSource,
  recordAlertSnapshot,
  recordNeptunHealth,
  refreshAlertFreshness,
} from './alerts';

let t: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t?.drop());
beforeEach(async () => {
  await t.sql`truncate alert_states, alert_snapshots`;
});

const T0 = new Date('2026-09-21T08:00:00Z');
const plus = (ms: number) => new Date(T0.getTime() + ms);
const since = new Date('2026-09-21T07:55:00Z');
const kremenchuk: ActiveAlertArea = { key: 'кременчуцький', kind: 'raion', level: 'red', since };

/** What the worker does with one valid snapshot. */
async function apply(areas: ActiveAlertArea[], at = T0, providerTime: Date | null = at) {
  return t.db.transaction(async (tx) => {
    const { id } = await recordAlertSnapshot(tx, { fetchedAt: at, providerTime, raw: { raions: areas.map((a) => a.key) }, valid: true });
    return { snapshotId: id, ...(await applyAlertSnapshot(tx, { snapshotId: id, at, providerTime, areas })) };
  });
}
const rows = async () => new Map((await t.db.select().from(alertStates)).map((r) => [r.areaKey, r]));

describe('alert_states projection', () => {
  it('marks listed areas active and every other tracked area inactive; unknown keys are kept, not dropped', async () => {
    const res = await apply([kremenchuk, { key: 'бахмутський', kind: 'raion', level: 'red', since }]);
    expect(res.unknownKeys).toEqual(['бахмутський']);

    const r = await rows();
    expect(r.get('кременчуцький')).toMatchObject({
      areaKind: 'raion',
      placeId: 'ua-pl-r-kremenchutskyi',
      state: 'active',
      level: 'red',
      since,
      freshness: 'fresh',
      lastSuccessAt: T0,
      lastProviderChangeAt: since,
      snapshotId: res.snapshotId,
    });
    expect(r.get('полтавська')).toMatchObject({ areaKind: 'oblast', placeId: 'ua-pl', state: 'inactive', level: null, freshness: 'fresh' });
    expect(r.get('полтавський')).toMatchObject({ state: 'inactive', freshness: 'fresh', lastProviderChangeAt: null });
    expect(r.get('бахмутський')).toMatchObject({ placeId: null, state: 'active' });
  });

  it('a valid empty set clears every active area (the only path to inactive)', async () => {
    await apply([kremenchuk, { key: 'бахмутський', kind: 'raion', level: 'red', since }]);
    const res = await apply([], plus(10_000), plus(9_000));
    expect(res.changedKeys.sort()).toEqual(['бахмутський', 'кременчуцький']);
    const r = await rows();
    expect(r.get('кременчуцький')).toMatchObject({ state: 'inactive', since: null, level: null, lastProviderChangeAt: plus(9_000) });
    expect(r.get('бахмутський')).toMatchObject({ state: 'inactive' });
  });

  it('an oblast-wide alert covers the raions of that oblast', async () => {
    await apply([{ key: 'полтавська', kind: 'oblast', level: 'red', since }]);
    const r = await rows();
    for (const key of ['полтавський', 'кременчуцький', 'миргородський', 'лубенський'])
      expect(r.get(key)).toMatchObject({ state: 'active', level: 'red', since });
    expect(r.get('харківська')).toMatchObject({ state: 'inactive' });
  });

  it('outage: stale after 30 s, unknown after 120 s, never inactive; the last known set stays in history', async () => {
    const { snapshotId } = await apply([kremenchuk]);
    const at = async (ms: number) => {
      await refreshAlertFreshness(t.db, plus(ms));
      return (await rows()).get('кременчуцький')!;
    };

    expect(await at(29_000)).toMatchObject({ state: 'active', freshness: 'fresh' });
    expect(await at(31_000)).toMatchObject({ state: 'active', freshness: 'stale' });
    expect(await at(121_000)).toMatchObject({ state: 'unknown', freshness: 'unknown', snapshotId, lastSuccessAt: T0 });
    expect((await rows()).get('полтавський')).toMatchObject({ state: 'unknown', freshness: 'unknown' });
    const [last] = await t.db.select().from(alertSnapshots).where(eq(alertSnapshots.id, snapshotId));
    expect(last!.rawPayload).toEqual({ raions: ['кременчуцький'] });

    // Recovery: the next full set makes the projection fresh again.
    await apply([kremenchuk], plus(130_000), T0);
    expect((await rows()).get('кременчуцький')).toMatchObject({ state: 'active', freshness: 'fresh', lastSuccessAt: plus(130_000) });
  });
});

describe('alert_snapshots and source_health', () => {
  it('stores payloads raw (valid or not) and reuses the row for an identical consecutive payload', async () => {
    const a = await recordAlertSnapshot(t.db, { fetchedAt: T0, providerTime: T0, raw: { raions: [], oblasts: [] }, valid: true });
    const same = await recordAlertSnapshot(t.db, { fetchedAt: plus(10_000), providerTime: T0, raw: { raions: [], oblasts: [] }, valid: true });
    const bad = await recordAlertSnapshot(t.db, { fetchedAt: plus(20_000), providerTime: null, raw: '{"raions": [', valid: false, error: 'invalid_json' });
    expect(same).toEqual({ id: a.id, inserted: false });
    expect(bad.inserted).toBe(true);
    const [row] = await t.db.select().from(alertSnapshots).where(eq(alertSnapshots.id, bad.id));
    expect(row).toMatchObject({ provider: 'neptun', valid: false, rawPayload: '{"raions": [', error: 'invalid_json' });
  });

  it('keeps one health row for the feed', async () => {
    const sourceId = await ensureNeptunSource(t.db);
    expect(await ensureNeptunSource(t.db)).toBe(sourceId);
    await recordNeptunHealth(t.db, sourceId, T0, { lastSuccessAt: T0, errorKind: null });
    await recordNeptunHealth(t.db, sourceId, plus(5_000), { errorKind: 'http_429' });
    const [h] = await t.db.select().from(sourceHealth).where(eq(sourceHealth.sourceId, sourceId));
    expect(h).toMatchObject({ lastSuccessAt: T0, errorKind: 'http_429', updatedAt: plus(5_000) });
  });
});
