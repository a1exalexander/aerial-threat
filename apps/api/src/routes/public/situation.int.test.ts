import { loadApiEnv } from '@aerial/config';
import { SituationResponse } from '@aerial/contracts';
import { createTestDb } from '@aerial/db/testing';
import { createLogger } from '@aerial/observability';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app';
import { RAW_MARKER, SITUATION_SOURCES, type Scenario, type SituationSeed, seedSituationPosts, setSituationScenario } from './__situation_seed__';

let t: Awaited<ReturnType<typeof createTestDb>>;
let app: ReturnType<typeof buildApp>;
let seed: SituationSeed;

beforeAll(async () => {
  t = await createTestDb();
  seed = await seedSituationPosts(t.db);
  const env = loadApiEnv({ DATABASE_URL: t.url, KREMENCHUK_SOURCES: SITUATION_SOURCES });
  app = buildApp({ db: { db: t.db, sql: t.sql, close: async () => {} }, env, logger: createLogger({ name: 't', level: 'silent' }) });
});
afterAll(async () => {
  await app?.close();
  await t?.drop();
});

const situation = async (scenario: Scenario) => {
  await setSituationScenario(t.db, scenario, seed);
  const res = await app.inject('/v1/situation');
  expect(res.statusCode, res.body).toBe(200);
  expect(res.body).not.toContain(RAW_MARKER);
  expect(res.body).not.toMatch(/0000 0000|\+380 00/);
  return { res, body: SituationResponse.parse(res.json()) };
};

describe('GET /v1/situation', () => {
  it('active alert: red tile regardless of the channels', async () => {
    const { body } = await situation('active');
    expect(body.data).toMatchObject({ area: { id: 'ua-pl-c-kremenchuk', name: 'Кременчук' }, tile: 'alert', tileStale: false });
    expect(body.data.alert).toMatchObject({ state: 'active', level: 'red', freshness: 'fresh' });
    expect(body.data.evaluation).toMatchObject({ mode: 'ai', freshness: 'fresh' });
    expect(body.freshness).toBe('fresh');
  });

  it('inactive alert + fresh high-confidence threat: amber tile, statuses and route of the latest ok snapshot', async () => {
    const { body } = await situation('threat');
    expect(body.data).toMatchObject({ tile: 'threat', tileStale: false });
    expect(body.data.statuses?.threatType).toEqual({ value: 'shahed', confidence: 'high', evidenceMessageIds: [seed.posts.threat.revisions[0]] });
    expect(body.data.route).toEqual([{ name: 'Кременчук', placeId: 'ua-pl-c-kremenchuk' }]);
  });

  it('an expired evaluation never keeps the tile amber; a stale one still does', async () => {
    const { body } = await situation('stale');
    expect(body.data).toMatchObject({ tile: 'clear', evaluation: { freshness: 'unknown' } });
    expect(body.data.statuses?.threatNow.value).toBe(true);
    expect(body.freshness).toBe('unknown');

    await t.sql`update situation_snapshots set evaluated_at = now() - interval '10 minutes' where status = 'ok'`;
    const again = SituationResponse.parse((await app.inject('/v1/situation')).json());
    expect(again.data).toMatchObject({ tile: 'threat', tileStale: true, evaluation: { freshness: 'stale' } });
    expect(again.freshness).toBe('stale');
  });

  it('no NEPTUN row and no snapshot: unknown, never clear', async () => {
    const { body } = await situation('unknown');
    expect(body.data).toMatchObject({ tile: 'unknown', statuses: null, route: null, evaluation: null });
    expect(body.data.alert).toMatchObject({ state: 'unknown', freshness: 'unknown' });
    expect(body.freshness).toBe('unknown');
  });

  it('feed: snapshot-irrelevant posts hidden, newer revisions shown, deleted/scrubbed/old/other channels left out', async () => {
    const { posts } = seed;
    const { body } = await situation('threat');
    const feed = body.data.feed;
    expect(feed.map((f) => f.id)).toEqual([
      posts.replyToAd.revisions[0],
      posts.reply.revisions[0],
      posts.edited.revisions[1], // the edit came after the snapshot, so it is shown as the current text
      posts.fundraiser.revisions[0],
      posts.threat.revisions[0],
    ]);

    const [replyToAd, reply, edited, fundraiser, threat] = feed;
    expect(replyToAd!.replyToText).toBeNull(); // its parent is the snapshot-irrelevant ad
    expect(reply).toMatchObject({
      sourceName: 'Демо Кременчук А',
      sourceUsername: 'Aerial_Demo_Krem',
      messageId: posts.reply.messageId,
      text: 'Над містом працює ППО',
      link: `https://t.me/Aerial_Demo_Krem/${posts.reply.messageId}`,
      editedAt: null,
    });
    expect([...reply!.replyToText!]).toHaveLength(140);
    expect(reply!.replyToText).toMatch(/^Шахед курсом на Кременчук\. .*…$/);
    expect(edited).toMatchObject({ text: 'Ракета на півночі області, рухається на південь', editedAt: expect.any(String) });
    // Matched by the bare channel ID: no public username, so no link.
    expect(fundraiser).toMatchObject({ sourceName: 'Демо Кременчук Б', sourceUsername: null, link: null, replyToText: null });
    expect(fundraiser!.text).toMatch(/^Збір на дрони: картка •+, тел\. •+$/);
    expect(threat!.replyToText).toBeNull();

    // Without a snapshot nothing is marked irrelevant; the noise rule alone decides — and it hides the ad.
    const none = await situation('unknown');
    const noneIds = none.body.data.feed.map((f) => f.id);
    expect(noneIds).not.toContain(posts.ad.revisions[0]);
    expect(noneIds).toContain(posts.threat.revisions[0]);
  });

  it('sources: only the Kremenchuk channels', async () => {
    const { body } = await situation('threat');
    expect(body.data.sources.map((s) => s.id).sort()).toEqual([seed.sources.byName, seed.sources.byId].sort());
    expect(body.data.sources.every((s) => s.availability === 'ok')).toBe(true);
    expect(JSON.stringify(body.data)).not.toContain('Демо Енергетика');
  });

  it('answers If-None-Match with 304', async () => {
    const { res } = await situation('threat');
    const etag = res.headers.etag as string;
    expect(etag).toMatch(/^W\/"[\w-]{22}"$/);
    const cached = await app.inject({ url: '/v1/situation', headers: { 'if-none-match': etag } });
    expect(cached.statusCode).toBe(304);
    expect(cached.body).toBe('');
  });
});
