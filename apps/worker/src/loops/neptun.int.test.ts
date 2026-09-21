import { alertSnapshots, alertStates, sourceHealth } from '@aerial/db';
import { ensureNeptunSource, refreshAlertFreshness } from '@aerial/db/repos/alerts';
import { createTestDb } from '@aerial/db/testing';
import type { FailureKind, NeptunEvent } from '@aerial/neptun';
import { createLogger } from '@aerial/observability';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNeptunHandler } from './neptun';

let t: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t?.drop());

const T0 = Date.parse('2026-09-21T08:00:00Z');
const at = (s: number) => new Date(T0 + s * 1_000);
const snapshot = (s: number, keys: string[]): NeptunEvent => ({
  type: 'snapshot',
  channel: 'rest',
  observedAt: at(s),
  raw: { raions: keys, oblasts: [] },
  snapshot: {
    providerTime: at(s),
    areas: keys.map((key) => ({ key, kind: 'raion', level: 'red', since: at(0) })),
    diagnostics: [],
  },
});
const failure = (s: number, kind: FailureKind, raw?: unknown): NeptunEvent => ({
  type: 'failure',
  channel: 'rest',
  observedAt: at(s),
  kind,
  error: kind,
  raw,
});

describe('neptun handler', () => {
  it('429 / 5xx / timeout / invalid JSON / schema / network failures never create a clear', async () => {
    const sourceId = await ensureNeptunSource(t.db);
    const handle = createNeptunHandler(t.db, sourceId, createLogger({ name: 't', level: 'silent' }));
    const state = async () => (await t.db.select().from(alertStates)).find((r) => r.areaKey === 'кременчуцький')!;
    const health = async () => (await t.db.select().from(sourceHealth))[0]!;

    await handle(snapshot(0, ['кременчуцький']));
    expect(await state()).toMatchObject({ state: 'active', freshness: 'fresh' });

    const failures = [
      failure(10, 'http_429'),
      failure(20, 'http_5xx'),
      failure(30, 'timeout'),
      failure(40, 'invalid_json', '<html>'),
      failure(50, 'schema', { error: 'maintenance' }),
      failure(60, 'network'),
    ];
    for (const f of failures) {
      await handle(f);
      await refreshAlertFreshness(t.db, f.observedAt);
      expect((await state()).state).not.toBe('inactive');
    }
    await handle({ type: 'heartbeat', observedAt: at(61) }); // transport is alive, the alert set is still unconfirmed
    await refreshAlertFreshness(t.db, at(125));
    expect(await state()).toMatchObject({ state: 'unknown', freshness: 'unknown' });
    expect(await health()).toMatchObject({ lastSuccessAt: at(0), lastMessageAt: at(61), errorKind: 'network' });
    const invalid = (await t.db.select().from(alertSnapshots)).filter((s) => !s.valid);
    expect(invalid.map((s) => s.rawPayload)).toEqual(['<html>', { error: 'maintenance' }]);

    // Only a fresh, valid, complete set may clear.
    await handle(snapshot(130, []));
    expect(await state()).toMatchObject({ state: 'inactive', freshness: 'fresh' });
    expect(await health()).toMatchObject({ lastSuccessAt: at(130), errorKind: null });
  });
});
