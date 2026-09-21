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
const raion = (key: string, over: Partial<ActiveAlertArea> = {}): ActiveAlertArea => ({
  key,
  kind: 'raion',
  level: 'red',
  since,
  oblast: null,
  ...over,
});
const kremenchuk = raion('кременчуцький', { oblast: 'Полтавська область' });

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
    const res = await apply([kremenchuk, raion('бахмутський', { oblast: 'Донецька область' })]);
    expect(res.unknownKeys).toEqual(['бахмутський']);
    expect(res.changedKeys.sort()).toEqual(['бахмутський', 'кременчуцький', 'полтавська']); // new alerts, not new inactive rows

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
    expect(r.get('полтавський')).toMatchObject({ state: 'inactive', level: null, freshness: 'fresh', lastProviderChangeAt: null });
    expect(r.get('сумська')).toMatchObject({ areaKind: 'oblast', placeId: 'ua-sm', state: 'inactive' });
    expect(r.get('бахмутський')).toMatchObject({ placeId: null, state: 'active' });
  });

  it('an oblast row is active while any of its raions is (partial alert), by dictionary or provider oblast name', async () => {
    await apply([kremenchuk, raion('красноградський', { oblast: 'Харківська область', level: 'yellow' })]);
    const r = await rows();
    expect(r.get('полтавська')).toMatchObject({ areaKind: 'oblast', placeId: 'ua-pl', state: 'active', level: 'red' });
    expect(r.get('харківська')).toMatchObject({ placeId: 'ua-kh', state: 'active', level: 'yellow' });
    expect(r.get('миргородський')).toMatchObject({ state: 'inactive' }); // partial never spills down
  });

  it('an oblast-wide alert covers its raions at the higher level and the earliest start', async () => {
    const early = new Date('2026-09-21T07:00:00Z');
    await apply([
      { key: 'полтавська', kind: 'oblast', level: 'red', since: early, oblast: null },
      raion('кременчуцький', { level: 'yellow' }),
    ]);
    const r = await rows();
    for (const key of ['полтавський', 'миргородський', 'лубенський']) expect(r.get(key)).toMatchObject({ state: 'active', level: 'red', since: early });
    expect(r.get('кременчуцький')).toMatchObject({ state: 'active', level: 'red', since: early });
    expect(r.get('харківська')).toMatchObject({ state: 'inactive' });
  });

  it('a valid empty set clears every active area (the only path to inactive)', async () => {
    await apply([kremenchuk, raion('бахмутський')]);
    const res = await apply([], plus(10_000), plus(9_000));
    expect(res.changedKeys.sort()).toEqual(['бахмутський', 'кременчуцький', 'полтавська']);
    const r = await rows();
    expect(r.get('кременчуцький')).toMatchObject({ state: 'inactive', since: null, level: null, lastProviderChangeAt: plus(9_000) });
    expect(r.get('бахмутський')).toMatchObject({ state: 'inactive' });
  });

  it('detects a level change on an area that stays active', async () => {
    await apply([raion('кременчуцький', { level: 'yellow' })]);
    const res = await apply([kremenchuk], plus(10_000), plus(9_000));
    expect(res.changedKeys.sort()).toEqual(['кременчуцький', 'полтавська']);
    expect((await rows()).get('кременчуцький')).toMatchObject({ level: 'red', lastProviderChangeAt: plus(9_000) });
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

    // Recovery with the same provider state: fresh again, and nothing counts as a provider change.
    const res = await apply([kremenchuk], plus(130_000), T0);
    expect(res.changedKeys).toEqual([]);
    const r = await rows();
    expect(r.get('кременчуцький')).toMatchObject({ state: 'active', freshness: 'fresh', lastSuccessAt: plus(130_000), lastProviderChangeAt: since });
    expect(r.get('полтавський')).toMatchObject({ state: 'inactive', freshness: 'fresh', lastProviderChangeAt: null });
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

  it('stores payloads jsonb would reject (NUL, lone surrogates) with U+FFFD instead of failing', async () => {
    const raw = { 'k\u0000': 'a\u0000b', cut: 'x\uD83D', literal: '\\u0000 stays text', emoji: '🙂' };
    const { id } = await recordAlertSnapshot(t.db, { fetchedAt: T0, providerTime: null, raw, valid: false, error: 'schema' });
    const [row] = await t.db.select().from(alertSnapshots).where(eq(alertSnapshots.id, id));
    expect(row!.rawPayload).toEqual({ 'k�': 'a�b', cut: 'x�', literal: '\\u0000 stays text', emoji: '🙂' });
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
