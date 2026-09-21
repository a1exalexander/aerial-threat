// Synthetic Kremenchuk-screen dataset (no real channels, posts or people), used by situation.int.test.ts and for
// manual e2e on an empty, migrated database:
//   DATABASE_URL=postgres://… pnpm --filter @aerial/api exec tsx src/routes/public/__situation_seed__.ts <scenario>
//   KREMENCHUK_SOURCES=aerial_demo_krem,1000000102 DATABASE_URL=postgres://… pnpm --filter @aerial/api dev
import { pathToFileURL } from 'node:url';
import { KREMENCHUK, type SituationStatuses } from '@aerial/contracts';
import { type Db, alertStates, createDb, messageRevisions, messages, situationSnapshots, sourceHealth, sources } from '@aerial/db';
import { eq, inArray } from '@aerial/db/orm';

/** Put into every raw payload; the API must never return it. */
export const RAW_MARKER = 'RAW-PAYLOAD-MUST-NOT-LEAK';
/** KREMENCHUK_SOURCES for this dataset: one source by username (stored in another case), one by bare channel ID. */
export const SITUATION_SOURCES = 'aerial_demo_krem,1000000102';
export const SCENARIOS = ['active', 'threat', 'stale', 'unknown'] as const;
export type Scenario = (typeof SCENARIOS)[number];

const MIN = 60_000;
const ALERT_KEYS = ['кременчуцький', 'полтавська'];

export async function seedSituationPosts(db: Db, now = new Date()) {
  const ago = (ms: number) => new Date(now.getTime() - ms);
  let nextMessageId = 500;

  const source = async (externalId: string, username: string | null, displayName: string) => {
    const [row] = await db.insert(sources).values({ provider: 'telegram', externalId, username, displayName }).returning();
    await db.insert(sourceHealth).values({ sourceId: row!.id, lastSuccessAt: ago(10_000), lastMessageAt: ago(5 * MIN) });
    return row!.id;
  };
  const src = {
    byName: await source('1000000101', 'Aerial_Demo_Krem', 'Демо Кременчук А'),
    byId: await source('1000000102', null, 'Демо Кременчук Б'),
    other: await source('1000000103', 'aerial_demo_energy', 'Демо Енергетика'),
  };

  /** One post with its revisions (the last is current); returns the revision IDs in order. */
  const post = async (
    sourceId: string,
    at: Date,
    texts: string[],
    opts: { replyTo?: string; deleted?: boolean; scrubbed?: boolean } = {},
  ) => {
    const [message] = await db
      .insert(messages)
      .values({
        sourceId,
        externalMessageId: String(nextMessageId++),
        publishedAt: at,
        mode: 'live',
        replyToExternalId: opts.replyTo ?? null,
        deletedAt: opts.deleted ? at : null,
      })
      .returning();
    const revisions: string[] = [];
    for (const [i, text] of texts.entries()) {
      const stored = opts.scrubbed ? '' : text;
      const [revision] = await db
        .insert(messageRevisions)
        .values({
          messageId: message!.id,
          revisionHash: `h${message!.externalMessageId}-${i}`,
          editedAt: i > 0 ? new Date(at.getTime() + i * MIN) : null,
          rawPayload: opts.scrubbed ? null : { note: RAW_MARKER },
          rawText: stored,
          normalizedText: stored,
          cleanedText: stored,
        })
        .returning();
      revisions.push(revision!.id);
    }
    await db.update(messages).set({ latestRevisionId: revisions.at(-1)! }).where(eq(messages.id, message!.id));
    return { messageId: message!.externalMessageId, revisions };
  };

  const threat = await post(src.byName, ago(50 * MIN), [`Шахед курсом на Кременчук. ${'Уточнюємо деталі. '.repeat(10)}`]);
  const ad = await post(src.byName, ago(45 * MIN), ['Реклама: продаємо меблі зі знижкою']);
  const fundraiser = await post(src.byId, ago(40 * MIN), ['Збір на дрони: картка 0000 0000 0000 0000, тел. +380 00 000 00 00']);
  const edited = await post(src.byName, ago(35 * MIN), ['Ракета на півночі області', 'Ракета на півночі області, рухається на південь']);
  const deleted = await post(src.byName, ago(30 * MIN), ['Помилковий допис'], { deleted: true });
  const scrubbed = await post(src.byName, ago(20 * MIN), ['Текст, який прибрала ретенція'], { scrubbed: true });
  const otherChannel = await post(src.other, ago(10 * MIN), ['Графік відключень світла на завтра']);
  const reply = await post(src.byName, ago(5 * MIN), ['Над містом працює ППО'], { replyTo: threat.messageId });
  // Replies to the irrelevant ad: shown, but without the ad as its context.
  const replyToAd = await post(src.byName, ago(4 * MIN), ['Вибухів у місті не чути'], { replyTo: ad.messageId });
  const old = await post(src.byName, ago(7 * 60 * MIN), ['Відбій тривоги']);

  return {
    sources: src,
    posts: { threat, ad, fundraiser, edited, deleted, scrubbed, otherChannel, reply, replyToAd, old },
    /** The window the seeded snapshot evaluated: everything but the replies and the edit (it covered the first text). */
    window: [threat, ad, fundraiser, deleted, scrubbed].map((p) => p.revisions[0]!).concat(edited.revisions[0]!),
    relevant: [threat, fundraiser, scrubbed, edited].map((p) => p.revisions[0]!),
  };
}
export type SituationSeed = Awaited<ReturnType<typeof seedSituationPosts>>;

const status = <T>(value: T, evidence: string[] = []) => ({ value, confidence: 'high' as const, evidenceMessageIds: evidence });

/**
 * Replaces the NEPTUN rows of the raion/oblast and the area's snapshots with a scenario:
 * - active: raion under alert, fresh AI snapshot reporting a threat;
 * - threat: raion clear, fresh AI snapshot reporting a threat (amber);
 * - stale: raion clear, the threat snapshot is 20 min old (expired: no amber);
 * - unknown: no NEPTUN rows and no snapshot.
 * Each has a newer failed snapshot that the screen must ignore.
 */
export async function setSituationScenario(db: Db, scenario: Scenario, seed: SituationSeed, now = new Date()) {
  const ago = (ms: number) => new Date(now.getTime() - ms);
  await db.delete(alertStates).where(inArray(alertStates.areaKey, ALERT_KEYS));
  await db.delete(situationSnapshots).where(eq(situationSnapshots.areaId, KREMENCHUK.placeId));
  if (scenario === 'unknown') return;

  const active = scenario === 'active';
  await db.insert(alertStates).values([
    { areaKey: 'кременчуцький', areaKind: 'raion', placeId: KREMENCHUK.raionId, state: active ? 'active' : 'inactive', level: active ? 'red' : null, since: active ? ago(20 * MIN) : ago(3 * 60 * MIN), freshness: 'fresh', lastSuccessAt: ago(5000), lastProviderChangeAt: ago(20 * MIN) },
    { areaKey: 'полтавська', areaKind: 'oblast', placeId: KREMENCHUK.oblastId, state: 'active', level: 'yellow', since: ago(20 * MIN), freshness: 'fresh', lastSuccessAt: ago(5000), lastProviderChangeAt: ago(20 * MIN) },
  ]);
  const evidence = [seed.posts.threat.revisions[0]!];
  const statuses: SituationStatuses = {
    threatNow: status(true, evidence),
    threatType: status('shahed', evidence),
    direction: status('towards', evidence),
    quantity: status('1', evidence),
    forecast: status('none'),
    explosions: status(false),
    airDefense: status(false),
  };
  const evaluatedAt = ago(scenario === 'stale' ? 20 * MIN : MIN);
  const base = { areaId: KREMENCHUK.placeId, mode: 'ai' as const, model: 'fake/situation', usage: { note: RAW_MARKER }, providerRequestId: RAW_MARKER };
  await db.insert(situationSnapshots).values([
    { ...base, evaluatedAt, windowFrom: ago(60 * MIN), windowTo: evaluatedAt, revisionIds: seed.window, relevantRevisionIds: seed.relevant, statuses, route: [{ name: 'Кременчук', placeId: KREMENCHUK.placeId }], status: 'ok' },
    { ...base, evaluatedAt: new Date(evaluatedAt.getTime() + 30_000), statuses: { ...statuses, threatNow: status(false) }, status: 'failed' },
  ]);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const url = process.env.DATABASE_URL;
  const scenario = process.argv[2] as Scenario;
  if (!url) throw new Error('DATABASE_URL is required');
  if (!SCENARIOS.includes(scenario)) throw new Error(`scenario must be one of: ${SCENARIOS.join(', ')}`);
  const database = createDb(url, { max: 1 });
  const seed = await seedSituationPosts(database.db);
  await setSituationScenario(database.db, scenario, seed);
  console.log(JSON.stringify({ scenario, ...seed }, null, 2));
  await database.close();
}
