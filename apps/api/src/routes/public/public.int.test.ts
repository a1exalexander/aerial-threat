import { loadApiEnv } from '@aerial/config';
import {
  AlertStateDto,
  ApiError,
  AreaDto,
  IncidentDetail,
  IncidentListItem,
  Overview,
  SourceDto,
  envelope,
} from '@aerial/contracts';
import { incidents } from '@aerial/db';
import { eq } from '@aerial/db/orm';
import { createTestDb } from '@aerial/db/testing';
import { createLogger } from '@aerial/observability';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../app';
import { RAW_MARKER, seedPublic } from './__seed__';

let t: Awaited<ReturnType<typeof createTestDb>>;
let app: ReturnType<typeof buildApp>;
let ids: Awaited<ReturnType<typeof seedPublic>>;

beforeAll(async () => {
  t = await createTestDb();
  ids = await seedPublic(t.db);
  const env = loadApiEnv({ DATABASE_URL: t.url });
  app = buildApp({ db: { db: t.db, sql: t.sql, close: async () => {} }, env, logger: createLogger({ name: 't', level: 'silent' }) });
});
afterAll(async () => {
  await app?.close();
  await t?.drop();
});

const get = async <T>(url: string, schema: { parse(v: unknown): T }, headers: Record<string, string> = {}) => {
  const res = await app.inject({ url, headers });
  expect(res.statusCode, res.body).toBe(200);
  expect(res.body).not.toContain(RAW_MARKER);
  return { res, body: schema.parse(res.json()) };
};
const expectError = async (url: string, status: number, code: string) => {
  const res = await app.inject(url);
  expect(res.statusCode).toBe(status);
  const err = ApiError.parse(res.json());
  expect(err).toMatchObject({ code, requestId: res.headers['x-request-id'] });
  expect(res.body).not.toMatch(/select|postgres|at .*\.ts/i);
};
const IncidentPage = envelope(IncidentListItem.array());
/** Re-anchor alert ages to now so slow runs cannot turn "fresh" rows stale mid-test. */
const touchAlerts = () =>
  t.sql`update alert_states set last_success_at = now() - case area_key
    when 'полтавський' then interval '60 seconds' when 'кременчуцький' then interval '10 minutes' else interval '1 second' end`;
const HOUR = 3600_000;

describe('GET /v1/incidents', () => {
  const all = async (query: string, limit: number) => {
    const seen: IncidentListItem[] = [];
    let cursor: string | null | undefined;
    do {
      const { body } = await get(`/v1/incidents?limit=${limit}&${query}${cursor ? `&cursor=${cursor}` : ''}`, IncidentPage);
      expect(body.data.length).toBeLessThanOrEqual(limit);
      seen.push(...body.data);
      cursor = body.nextCursor;
    } while (cursor);
    return seen;
  };

  it('pages the live feed by (lastEvidenceAt desc, id desc) without gaps or repeats', async () => {
    const items = await all('', 7);
    const bulkAndNamed = ids.bulk.length + 5; // kremenchukCity, kremenchukRaion, oblast, poltavaCity, unresolved
    expect(items).toHaveLength(bulkAndNamed);
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
    const sorted = [...items].sort((a, b) => b.lastEvidenceAt.localeCompare(a.lastEvidenceAt) || b.id.localeCompare(a.id));
    expect(items.map((i) => i.id)).toEqual(sorted.map((i) => i.id));
    // Not public: review-only incident; archive imports stay out of the current feed.
    expect(items.map((i) => i.id)).not.toContain(ids.reviewOnly);
    expect(items.map((i) => i.id)).not.toContain(ids.archived);
  });

  it('keeps the cursor stable when newer incidents arrive between pages', async () => {
    const before = await get('/v1/incidents?limit=6', IncidentPage);
    const first = await get('/v1/incidents?limit=3', IncidentPage);
    // A newer public incident (sharing a claim of an existing one) lands in front of the cursor.
    const [row] = await t.db.select().from(incidents).where(eq(incidents.id, ids.bulk[0]!));
    const [newer] = await t.db
      .insert(incidents)
      .values({ ...row!, id: undefined, lastEvidenceAt: new Date() })
      .returning();
    await t.sql`insert into incident_evidence (incident_id, claim_id, relation)
      select ${newer!.id}, claim_id, relation from incident_evidence where incident_id = ${ids.bulk[0]!}`;
    try {
      const second = await get(`/v1/incidents?limit=3&cursor=${first.body.nextCursor}`, IncidentPage);
      expect([...first.body.data, ...second.body.data].map((i) => i.id)).toEqual(before.body.data.map((i) => i.id));
      expect((await get('/v1/incidents?limit=1', IncidentPage)).body.data[0]!.id).toBe(newer!.id);
    } finally {
      await t.sql`delete from incident_evidence where incident_id = ${newer!.id}`;
      await t.sql`delete from incidents where id = ${newer!.id}`;
    }
  });

  it('defaults the limit to 20 and rejects more than 100', async () => {
    const { body } = await get('/v1/incidents', IncidentPage);
    expect(body.data).toHaveLength(20);
    expect(body.nextCursor).toBeTruthy();
    await expectError('/v1/incidents?limit=101', 400, 'bad_request');
    await expectError('/v1/incidents?limit=0', 400, 'bad_request');
  });

  it('rejects bad cursors, inverted and over-long ranges', async () => {
    await expectError('/v1/incidents?cursor=not-a-cursor', 400, 'bad_request');
    const to = new Date();
    const from = new Date(to.getTime() - 32 * 24 * HOUR);
    await expectError(`/v1/incidents?from=${from.toISOString()}&to=${to.toISOString()}`, 400, 'bad_request');
    await expectError(`/v1/incidents?from=${to.toISOString()}&to=${from.toISOString()}`, 400, 'bad_request');
    await expectError(`/v1/incidents?from=${from.toISOString()}`, 400, 'bad_request');
    await expectError('/v1/incidents?areaId=ua-nowhere', 400, 'bad_request');
    await expectError('/v1/incidents?kind=rumour', 400, 'bad_request');
    await expectError('/v1/incidents?to=0000-01-01T00:00:00Z', 400, 'bad_request');
    const yearZero = Buffer.from(JSON.stringify(['0000-01-01T00:00:00Z', ids.oblast])).toString('base64url');
    await expectError(`/v1/incidents?cursor=${yearZero}`, 400, 'bad_request');
  });

  it('includes archive imports only in a history range', async () => {
    const to = new Date();
    const from = new Date(to.getTime() - 7 * 24 * HOUR);
    const items = await all(`from=${from.toISOString()}&to=${to.toISOString()}&areaId=ua-pl-c-poltava`, 100);
    expect(items.map((i) => [i.id, i.mode])).toEqual([
      [ids.poltavaCity, 'live'],
      [ids.archived, 'archive'],
    ]);
  });

  it('filters an area with the places inside it, never the areas containing it', async () => {
    const ofArea = async (areaId: string) => (await all(`areaId=${areaId}`, 100)).map((i) => i.id);
    const raion = await ofArea('ua-pl-r-kremenchutskyi');
    expect(raion.sort()).toEqual([ids.kremenchukCity, ids.kremenchukRaion].sort());
    expect(await ofArea('ua-pl-c-kremenchuk')).toEqual([ids.kremenchukCity]);
    const oblast = await ofArea('ua-pl');
    expect(oblast).toContain(ids.oblast);
    expect(oblast).toContain(ids.kremenchukCity);
    expect(oblast).not.toContain(ids.unresolved);
    expect(await ofArea('ua-kh')).toEqual([]);
  });

  it('filters by lifecycle and kind', async () => {
    const stale = await all('lifecycle=stale', 100);
    expect(stale.length).toBeGreaterThan(0);
    expect(stale.every((i) => i.lifecycle === 'stale')).toBe(true);
    expect(await all('kind=aftermath', 100)).toEqual([]);
  });

  it('answers an empty result as an empty list with freshness, not "all clear"', async () => {
    const { body } = await get('/v1/incidents?areaId=ua-kh', IncidentPage);
    expect(body.data).toEqual([]);
    expect(body.nextCursor).toBeNull();
    // Collector A is healthy, B reports errors: the feed is stale, not fresh.
    expect(body.freshness).toBe('stale');
  });

  it('summarises public evidence only', async () => {
    const { body } = await get('/v1/incidents?areaId=ua-pl-c-kremenchuk', IncidentPage);
    expect(body.data[0]).toMatchObject({ sourceCount: 3, hasConflict: true, geoBasis: 'explicit', threatTypes: ['uav'] });
    const poltava = await get('/v1/incidents?areaId=ua-pl-c-poltava', IncidentPage);
    expect(poltava.body.data[0]).toMatchObject({ id: ids.poltavaCity, closureClaimed: true });
    const unresolved = (await all('', 100)).find((i) => i.id === ids.unresolved);
    expect(unresolved).toMatchObject({ areaId: null, geoBasis: 'unresolved' });
  });

  it('answers If-None-Match with 304 until the projection changes', async () => {
    const { res } = await get('/v1/incidents?areaId=ua-pl-r-kremenchutskyi', IncidentPage);
    const etag = res.headers.etag as string;
    expect(etag).toMatch(/^W\/".+"$/);
    expect(etag).toBe(`W/"${IncidentPage.parse(res.json()).projectionVersion}"`);

    const cached = await app.inject({ url: '/v1/incidents?areaId=ua-pl-r-kremenchutskyi', headers: { 'if-none-match': etag } });
    expect(cached.statusCode).toBe(304);
    expect(cached.body).toBe('');

    await t.db.update(incidents).set({ summary: 'Оновлене зведення.' }).where(eq(incidents.id, ids.kremenchukRaion));
    const changed = await app.inject({ url: '/v1/incidents?areaId=ua-pl-r-kremenchutskyi', headers: { 'if-none-match': etag } });
    expect(changed.statusCode).toBe(200);
    expect(changed.headers.etag).not.toBe(etag);
  });
});

describe('GET /v1/incidents/:id', () => {
  const Page = envelope(IncidentDetail);

  it('returns public evidence with provenance, conflicts and verified links only', async () => {
    const { body } = await get(`/v1/incidents/${ids.kremenchukCity}`, Page);
    const ev = body.data.evidence;
    expect(ev.map((e) => e.text)).toEqual(['Кременчук: 2 БпЛА', 'Кременчук — 3 БпЛА', 'БпЛА над Кременчуком', 'Moved by a split']);
    expect(ev.map((e) => e.quantity)).toEqual([2, 3, null, null]);
    expect(ev[1]).toMatchObject({ relation: 'conflicting', active: true });
    expect(ev[3]).toMatchObject({ active: false });
    expect(ev[0]!.messageUrl).toBe(`https://t.me/aerial_demo_a/${ev[0]!.messageExternalId}`);
    expect(ev[2]).toMatchObject({ sourceUsername: null, messageUrl: null });
    for (const e of ev) {
      expect(e.spans[0]!.revisionId).toBe(e.revisionId);
      expect(e).toMatchObject({ geoBasis: 'explicit', editedAt: null, uncertainty: { time: [], geo: [], classification: [] } });
      expect(Date.parse(e.receivedAt!)).toBeGreaterThan(Date.parse(e.publishedAt));
    }
    expect(body.data.hasConflict).toBe(true);
    const raw = JSON.stringify(body);
    for (const hidden of ['Excluded ad text', 'Review-only text', 'Deleted post text', 'assessments', 'rawPayload', 'usage'])
      expect(raw).not.toContain(hidden);
  });

  it('is 404 in the error envelope for missing, malformed and non-public incidents', async () => {
    await expectError('/v1/incidents/00000000-0000-4000-8000-000000000000', 404, 'not_found');
    await expectError('/v1/incidents/not-a-uuid', 404, 'not_found');
    await expectError(`/v1/incidents/${ids.reviewOnly}`, 404, 'not_found');
  });

  it('serves archive incidents by id', async () => {
    const { body } = await get(`/v1/incidents/${ids.archived}`, Page);
    expect(body.data).toMatchObject({ mode: 'archive', lifecycle: 'archived' });
  });
});

describe('GET /v1/alerts', () => {
  const Page = envelope(AlertStateDto.array());
  beforeEach(touchAlerts);

  it('reports the area, its ancestors and children; missing or dead data is unknown, never inactive', async () => {
    const { body } = await get('/v1/alerts?areaId=ua-pl', Page);
    const byKey = Object.fromEntries(body.data.map((a) => [a.areaKey, a]));
    expect(body.data.map((a) => a.areaKey)).toEqual(['полтавська', 'полтавський', 'кременчуцький', 'миргородський', 'лубенський']);
    expect(byKey['полтавська']).toMatchObject({ placeId: 'ua-pl', state: 'active', freshness: 'fresh' });
    expect(byKey['полтавська']!.lastSuccessfulFetchAt).toBeTruthy();
    expect(byKey['полтавська']!.lastProviderChangeAt).toBeTruthy();
    expect(byKey['полтавський']).toMatchObject({ state: 'active', freshness: 'stale' });
    expect(byKey['кременчуцький']).toMatchObject({ state: 'unknown', freshness: 'unknown' });
    expect(byKey['миргородський']).toMatchObject({ state: 'unknown', freshness: 'unknown', lastSuccessfulFetchAt: null });
    expect(byKey['лубенський']).toMatchObject({ state: 'inactive', freshness: 'fresh' });
    expect(body.freshness).toBe('unknown');

    const city = await get('/v1/alerts?areaId=ua-pl-c-poltava', Page);
    expect(city.body.data.map((a) => a.areaKey)).toEqual(['полтавська', 'полтавський']);
  });

  it('is unknown for areas without any alert rows', async () => {
    const { body } = await get('/v1/alerts?areaId=ua-ck', Page);
    expect(body.data).toEqual([expect.objectContaining({ areaKey: 'черкаська', state: 'unknown', freshness: 'unknown' })]);
    expect(body.freshness).toBe('unknown');
  });

  it('filters by freshness and lists provider areas outside the dictionary', async () => {
    const { body } = await get('/v1/alerts?freshness=fresh', Page);
    expect(body.data.map((a) => a.areaKey).sort()).toEqual(['лубенський', 'полтавська', 'херсонська'].sort());
    expect(body.freshness).toBe('fresh');
    await expectError('/v1/alerts?freshness=green', 400, 'bad_request');
  });
});

describe('GET /v1/overview', () => {
  const Page = envelope(Overview);
  beforeEach(touchAlerts);

  it('returns one live snapshot for the area', async () => {
    const { body } = await get('/v1/overview?areaId=ua-pl-c-kremenchuk', Page);
    expect(body.data).toMatchObject({ mode: 'live', areaId: 'ua-pl-c-kremenchuk', asOf: body.generatedAt });
    expect(body.data.alerts.map((a) => a.areaKey)).toEqual(['полтавська', 'кременчуцький']);
    expect(body.data.incidents.map((i) => i.id)).toEqual([ids.kremenchukCity]);
    expect(body.data.sources.map((s) => s.displayName)).toEqual(['Демо-канал А', 'Демо-канал Б', 'Демо-канал В']);
    expect(body.freshness).toBe('unknown'); // the Kremenchuk raion alert is too old to trust
  });

  it('flags an archive snapshot and never reuses the current alert state for it', async () => {
    const asOf = new Date(Date.now() - 3 * 24 * HOUR + HOUR).toISOString();
    const { body } = await get(`/v1/overview?areaId=ua-pl-c-poltava&asOf=${asOf}`, Page);
    expect(body.data).toMatchObject({ mode: 'archive', asOf: new Date(asOf).toISOString() });
    expect(body.data.incidents.map((i) => i.id)).toEqual([ids.archived]);
    expect(body.data.alerts.every((a) => a.state === 'unknown' && a.freshness === 'unknown')).toBe(true);
    expect(body.freshness).toBe('unknown');
    await expectError(`/v1/overview?asOf=${new Date(Date.now() + HOUR).toISOString()}`, 400, 'bad_request');
  });
});

describe('GET /v1/areas and /v1/sources', () => {
  it('serves the dictionary by parent and query', async () => {
    const Page = envelope(AreaDto.array());
    const raions = await get('/v1/areas?parentId=ua-pl', Page);
    expect(raions.body.data.every((a) => a.level === 'raion' && a.parentId === 'ua-pl')).toBe(true);
    expect(raions.body.data).toHaveLength(4);
    const found = await get(`/v1/areas?query=${encodeURIComponent('кременч')}`, Page);
    expect(found.body.data.map((a) => a.id)).toEqual(['ua-pl-r-kremenchutskyi', 'ua-pl-c-kremenchuk']);
    await expectError('/v1/areas?parentId=ua-nowhere', 400, 'bad_request');
  });

  it('reports public source info with availability', async () => {
    const { body } = await get('/v1/sources', envelope(SourceDto.array()));
    expect(body.data.map((s) => [s.username, s.availability, s.enabled])).toEqual([
      ['aerial_demo_a', 'ok', true],
      ['aerial_demo_b', 'degraded', true],
      [null, 'paused', false],
    ]);
    expect(body.freshness).toBe('stale');
  });

  it('never falls back to a withheld username or the raw channel id', async () => {
    await t.sql`insert into sources (provider, external_id, username) values ('telegram', '1000000099', 'not public!')`;
    try {
      const { res, body } = await get('/v1/sources', envelope(SourceDto.array()));
      expect(body.data.at(-1)).toMatchObject({ username: null, displayName: 'telegram', availability: 'unknown' });
      expect(res.body).not.toMatch(/not public!|1000000099/);
    } finally {
      await t.sql`delete from sources where external_id = '1000000099'`;
    }
  });
});
