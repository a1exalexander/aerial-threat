import { describe, expect, it } from 'vitest';
import rest from '../fixtures/alerts-rest.json';
import frames from '../fixtures/stream-frames.json';
import { StreamEnvelope, parseAlerts } from './contract';

describe('parseAlerts', () => {
  it('parses the recorded REST payload as a complete set of active areas', () => {
    const r = parseAlerts(rest);
    if (!r.ok) throw new Error(r.error);
    expect(r.snapshot.providerTime?.toISOString()).toBe('2026-09-21T08:34:33.227Z');
    expect(r.snapshot.diagnostics).toEqual([]);
    expect(r.snapshot.areas).toHaveLength(7);
    expect(r.snapshot.areas.find((a) => a.key === "куп'янський")).toMatchObject({ kind: 'raion', level: 'red' });
    expect(r.snapshot.areas.find((a) => a.key === 'луганська')).toMatchObject({
      kind: 'oblast',
      since: new Date('2022-04-04T16:45:00Z'),
    });
  });

  it('accepts a valid empty set (nothing under alert) as ok', () => {
    const r = parseAlerts({ version: 1, updatedAt: '2026-09-21T08:00:00Z', raions: [], oblasts: [] });
    expect(r).toEqual({ ok: true, snapshot: { providerTime: new Date('2026-09-21T08:00:00Z'), areas: [], diagnostics: [] } });
  });

  it.each([
    ['null', null],
    ['an error body', { error: 'upstream unavailable' }],
    ['a missing oblasts list', { raions: [] }],
    ['a list that is not an array', { raions: {}, oblasts: [] }],
    ['an entry without a key', { raions: [{ name: 'Район', level: 'red' }], oblasts: [] }],
    ['an empty key', { raions: [{ key: ' ', level: 'red' }], oblasts: [] }],
  ])('rejects %s (incomplete sets must never clear anything)', (_, json) => {
    expect(parseAlerts(json).ok).toBe(false);
  });

  it('tolerates schema drift: unknown enum -> unknown + diagnostic, the set stays usable', () => {
    const r = parseAlerts({
      updatedAt: 'not a time',
      partial: false,
      raions: [{ key: 'полтавський', level: 'orange', since: 'yesterday', color: '#f00' }],
      oblasts: [{ key: 'харківська' }],
    });
    if (!r.ok) throw new Error(r.error);
    expect(r.snapshot.providerTime).toBeNull();
    expect(r.snapshot.areas).toEqual([
      { key: 'полтавський', kind: 'raion', level: 'unknown', since: null },
      { key: 'харківська', kind: 'oblast', level: 'unknown', since: null },
    ]);
    expect(r.snapshot.diagnostics).toEqual([
      'unexpected field "partial" in payload',
      'invalid updatedAt',
      'unexpected field "color" in raion entry',
      'unknown level "orange" for "полтавський"',
      'invalid since for "полтавський"',
      'unknown level undefined for "харківська"',
    ]);
  });
});

describe('StreamEnvelope', () => {
  it('parses every recorded frame; the alerts frame carries the same payload as REST', () => {
    const envs = frames.map((f) => StreamEnvelope.parse(f));
    expect(envs.map((e) => e.type)).toEqual(['snapshot', 'alerts', 'upsert', 'remove', 'heartbeat']);
    expect(envs[1]!.data).toEqual(rest);
    expect(envs[4]!.data).toBeUndefined();
  });
});
