// Synthetic read-API dataset (no real channels, posts or people), used by public.int.test.ts and for manual e2e:
//   DATABASE_URL=postgres://… pnpm --filter @aerial/api exec tsx src/routes/public/__seed__.ts
import { pathToFileURL } from 'node:url';
import type { ClaimKind, EvidenceRelation, GeoBasis, IncidentLifecycle, PublicationDecision } from '@aerial/contracts';
import {
  type Db,
  alertStates,
  claims,
  createDb,
  incidentEvidence,
  incidents,
  messageRevisions,
  messages,
  processingRuns,
  sourceHealth,
  sources,
} from '@aerial/db';
import { eq } from '@aerial/db/orm';

/** Put into every raw payload; the API must never return it. */
export const RAW_MARKER = 'RAW-PAYLOAD-MUST-NOT-LEAK';
const MIN = 60_000;

type ClaimSpec = {
  source: string;
  text: string;
  placeId?: string | null;
  geoBasis?: GeoBasis;
  kind?: ClaimKind;
  quantity?: number | null;
  decision?: PublicationDecision;
  relation?: EvidenceRelation;
  linkActive?: boolean;
  deleted?: boolean;
};

export async function seedPublic(db: Db, now = new Date()) {
  const ago = (ms: number) => new Date(now.getTime() - ms);
  let nextMessageId = 1000;

  const source = async (externalId: string, username: string | null, displayName: string, enabled = true) => {
    const [row] = await db.insert(sources).values({ provider: 'telegram', externalId, username, displayName, enabled }).returning();
    return row!.id;
  };
  const src = {
    a: await source('1000000001', 'aerial_demo_a', 'Демо-канал А'),
    b: await source('1000000002', 'aerial_demo_b', 'Демо-канал Б'),
    // An unverifiable username: shown without a link. Paused sources keep their old evidence public.
    c: await source('1000000003', 'bad name!', 'Демо-канал В', false),
  };
  await db.insert(sourceHealth).values([
    { sourceId: src.a, lastSuccessAt: ago(20_000), lastMessageAt: ago(5 * MIN) },
    { sourceId: src.b, lastSuccessAt: ago(MIN), lastMessageAt: ago(6 * MIN), errorKind: 'flood_wait' },
  ]);

  /** One post -> revision -> processing run -> claim. */
  const claim = async (c: ClaimSpec, mode: 'live' | 'archive', at: Date) => {
    const [message] = await db
      .insert(messages)
      .values({
        sourceId: c.source,
        externalMessageId: String(nextMessageId++),
        publishedAt: at,
        receivedAt: new Date(at.getTime() + 2000),
        mode,
        deletedAt: c.deleted ? at : null,
      })
      .returning();
    const [revision] = await db
      .insert(messageRevisions)
      .values({
        messageId: message!.id,
        revisionHash: `h${message!.externalMessageId}`,
        rawPayload: { note: RAW_MARKER },
        rawText: c.text,
        normalizedText: c.text,
        cleanedText: c.text,
      })
      .returning();
    await db.update(messages).set({ latestRevisionId: revision!.id }).where(eq(messages.id, message!.id));
    const [run] = await db
      .insert(processingRuns)
      .values({
        revisionId: revision!.id,
        contextHash: 'ctx',
        model: 'fake',
        questionsVersion: 'q1',
        parserVersion: 'p1',
        policyVersion: 'pol1',
        status: 'succeeded',
        usage: { note: RAW_MARKER },
        providerRequestId: RAW_MARKER,
      })
      .returning();
    const [row] = await db
      .insert(claims)
      .values({
        runId: run!.id,
        revisionId: revision!.id,
        kind: c.kind ?? 'threat_report',
        threatType: 'uav',
        temporalScope: 'current',
        quantity: c.quantity ?? null,
        placeId: c.placeId ?? null,
        geoBasis: c.geoBasis ?? (c.placeId ? 'explicit' : 'unresolved'),
        evidence: [{ revisionId: revision!.id, start: 0, end: c.text.length, rawStart: 0, rawEnd: c.text.length }],
        assessments: [{ type: 'boolean', question: RAW_MARKER, probability: 0.97 }],
        publicationDecision: c.decision ?? 'publish',
        uncertainty: { time: [], geo: c.placeId ? [] : ['no_place_mention'], classification: [] },
      })
      .returning();
    return row!.id;
  };

  const incident = async (
    spec: { areaId: string | null; at: Date; mode?: 'live' | 'archive'; lifecycle?: IncidentLifecycle; hasConflict?: boolean },
    evidence: ClaimSpec[],
  ) => {
    const mode = spec.mode ?? 'live';
    const [row] = await db
      .insert(incidents)
      .values({
        kind: 'threat_report',
        threatType: 'uav',
        areaId: spec.areaId,
        mode,
        lifecycle: spec.lifecycle ?? 'reported',
        firstSeenAt: new Date(spec.at.getTime() - 10 * MIN),
        lastEvidenceAt: spec.at,
        summary: 'Канал повідомляє про БпЛА. Місце визначено з тексту.',
        hasConflict: spec.hasConflict ?? false,
        policyVersion: 'pol1',
      })
      .returning();
    for (const [i, e] of evidence.entries()) {
      // One second apart, the last post at `at`, so evidence order is deterministic.
      const claimId = await claim(e, mode, new Date(spec.at.getTime() - (evidence.length - 1 - i) * 1000));
      await db.insert(incidentEvidence).values({
        incidentId: row!.id,
        claimId,
        relation: e.relation ?? 'primary',
        reason: RAW_MARKER,
        active: e.linkActive ?? true,
      });
      if (e.relation === 'closure') await db.update(incidents).set({ closureClaimId: claimId }).where(eq(incidents.id, row!.id));
    }
    return row!.id;
  };

  const ids = {
    sources: src,
    // City-level report seen by two channels that disagree on the count; plus hidden and moved evidence.
    kremenchukCity: await incident({ areaId: 'ua-pl-c-kremenchuk', at: ago(5 * MIN), hasConflict: true }, [
      { source: src.a, text: 'Кременчук: 2 БпЛА', placeId: 'ua-pl-c-kremenchuk', quantity: 2 },
      { source: src.b, text: 'Кременчук — 3 БпЛА', placeId: 'ua-pl-c-kremenchuk', quantity: 3, relation: 'conflicting' },
      { source: src.c, text: 'БпЛА над Кременчуком', placeId: 'ua-pl-c-kremenchuk', relation: 'supporting' },
      { source: src.a, text: 'Excluded ad text', kind: 'advertisement', decision: 'exclude', relation: 'supporting' },
      { source: src.b, text: 'Review-only text', decision: 'review', relation: 'supporting' },
      { source: src.b, text: 'Deleted post text', placeId: 'ua-pl-c-kremenchuk', deleted: true, relation: 'supporting' },
      { source: src.a, text: 'Moved by a split', placeId: 'ua-pl-c-kremenchuk', linkActive: false, relation: 'supporting' },
    ]),
    kremenchukRaion: await incident({ areaId: 'ua-pl-r-kremenchutskyi', at: ago(10 * MIN) }, [
      { source: src.a, text: 'Кременчуцький район: БпЛА', placeId: 'ua-pl-r-kremenchutskyi' },
    ]),
    oblast: await incident({ areaId: 'ua-pl', at: ago(15 * MIN) }, [
      { source: src.b, text: 'На Полтавщині БпЛА', placeId: 'ua-pl' },
    ]),
    poltavaCity: await incident({ areaId: 'ua-pl-c-poltava', at: ago(20 * MIN) }, [
      { source: src.a, text: 'Полтава: БпЛА', placeId: 'ua-pl-c-poltava' },
      { source: src.a, text: 'Полтава: відбій загрози', placeId: 'ua-pl-c-poltava', kind: 'clear_claim', relation: 'closure' },
    ]),
    unresolved: await incident({ areaId: null, at: ago(25 * MIN) }, [{ source: src.b, text: 'БпЛА, місце не вказано' }]),
    reviewOnly: await incident({ areaId: 'ua-pl-c-poltava', at: ago(2 * MIN), lifecycle: 'candidate' }, [
      { source: src.a, text: 'Незрозумілий допис', placeId: 'ua-pl-c-poltava', decision: 'review' },
    ]),
    archived: await incident({ areaId: 'ua-pl-c-poltava', at: ago(3 * 24 * 60 * MIN), mode: 'archive', lifecycle: 'archived' }, [
      { source: src.a, text: 'Архів: Полтава, БпЛА', placeId: 'ua-pl-c-poltava' },
    ]),
    bulk: [] as string[],
  };
  // A page-able run in one raion; two rows share a timestamp to exercise the id tie-break.
  for (let i = 0; i < 24; i++) {
    const at = ago((30 + (i === 1 ? 0 : i)) * MIN);
    ids.bulk.push(
      await incident({ areaId: 'ua-pl-c-myrhorod', at, lifecycle: i % 3 ? 'stale' : 'reported' }, [
        { source: i % 2 ? src.a : src.b, text: `Миргород: БпЛА #${i}`, placeId: 'ua-pl-c-myrhorod' },
      ]),
    );
  }

  await db.insert(alertStates).values([
    { areaKey: 'полтавська', areaKind: 'oblast', placeId: 'ua-pl', state: 'active', freshness: 'fresh', since: ago(40 * MIN), lastSuccessAt: ago(5000), lastProviderChangeAt: ago(40 * MIN) },
    { areaKey: 'полтавський', areaKind: 'raion', placeId: 'ua-pl-r-poltavskyi', state: 'active', freshness: 'fresh', lastSuccessAt: ago(MIN), lastProviderChangeAt: ago(40 * MIN) },
    // Stored as fresh by a connector that then died: too old to trust, so it must read unknown, not inactive.
    { areaKey: 'кременчуцький', areaKind: 'raion', placeId: 'ua-pl-r-kremenchutskyi', state: 'inactive', freshness: 'fresh', lastSuccessAt: ago(10 * MIN), lastProviderChangeAt: ago(3 * 60 * MIN) },
    { areaKey: 'лубенський', areaKind: 'raion', placeId: 'ua-pl-r-lubenskyi', state: 'inactive', freshness: 'fresh', lastSuccessAt: ago(5000), lastProviderChangeAt: ago(3 * 60 * MIN) },
    { areaKey: 'херсонська', areaKind: 'oblast', placeId: null, state: 'active', freshness: 'fresh', lastSuccessAt: ago(5000), lastProviderChangeAt: ago(60 * MIN) },
  ]);
  return ids;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const database = createDb(url, { max: 1 });
  const ids = await seedPublic(database.db);
  console.log(JSON.stringify(ids, null, 2));
  await database.close();
}
