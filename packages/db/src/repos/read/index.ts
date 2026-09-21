// Read-side projection queries behind the public /v1/* API. Run them inside readSnapshot() so one response
// sees one consistent database state. Only public columns are selected: raw payloads, model assessments,
// processing runs and operator reasons never leave this module.
import {
  type AlertStateDto,
  type ClaimKind,
  type Freshness,
  IncidentDetail,
  type IncidentLifecycle,
  IncidentListItem,
  type Overview,
  SourceDto,
} from '@aerial/contracts';
import { byNeptunKey } from '@aerial/geo';
import { and, asc, desc, eq, exists, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import type { Db, Executor, Tx } from '../../client';
import { alertStates, claims, incidentEvidence, incidents, messageRevisions, messages, sourceHealth, sources } from '../../schema';
import {
  type AlertRow,
  alertDto,
  alertPlaces,
  feedFreshness,
  incidentGeoBasis,
  publicUsername,
  sourceAvailability,
  subtree,
  telegramUrl,
  worstFreshness,
} from './policy';

export * from './policy';

/** One consistent, read-only view of the database for a whole response. */
export const readSnapshot = <T>(db: Db, fn: (tx: Tx) => Promise<T>) =>
  db.transaction(fn, { isolationLevel: 'repeatable read', accessMode: 'read only' });

/** Excluded and review-only claims, inactive claims and deleted posts are never public. */
const publicClaim = and(eq(claims.active, true), eq(claims.publicationDecision, 'publish'), isNull(messages.deletedAt));

export type IncidentKey = { t: string; id: string };
export type IncidentFilter = {
  areaId?: string;
  kind?: ClaimKind;
  lifecycle?: IncidentLifecycle;
  from?: Date;
  to?: Date;
  after?: IncidentKey;
  limit: number;
};

/**
 * One feed page ordered by (last_evidence_at desc, id desc); `next` is the keyset of the last row when more follow.
 * - areaId: the area and places inside it (see `subtree`).
 * - Without from/to only live incidents are listed (the current feed); a time range is history and also lists
 *   archive imports. from/to select incidents overlapping [from, to].
 * - An incident is public only while it has active evidence from a public claim.
 */
export async function listIncidents(tx: Executor, f: IncidentFilter): Promise<{ items: IncidentListItem[]; next: IncidentKey | null }> {
  const hasPublicEvidence = tx
    .select({ one: sql`1` })
    .from(incidentEvidence)
    .innerJoin(claims, eq(claims.id, incidentEvidence.claimId))
    .innerJoin(messageRevisions, eq(messageRevisions.id, claims.revisionId))
    .innerJoin(messages, eq(messages.id, messageRevisions.messageId))
    .where(and(eq(incidentEvidence.incidentId, incidents.id), eq(incidentEvidence.active, true), publicClaim));
  const rows = await tx
    .select({
      incident: incidents,
      // Microsecond-exact UTC text, so the cursor never skips or repeats rows that share a millisecond.
      key: sql<string>`to_char(${incidents.lastEvidenceAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    })
    .from(incidents)
    .where(
      and(
        f.areaId === undefined ? undefined : inArray(incidents.areaId, subtree(f.areaId)),
        f.kind === undefined ? undefined : eq(incidents.kind, f.kind),
        f.lifecycle === undefined ? undefined : eq(incidents.lifecycle, f.lifecycle),
        f.from || f.to ? undefined : eq(incidents.mode, 'live'),
        f.from ? gte(incidents.lastEvidenceAt, f.from) : undefined,
        f.to ? lte(incidents.firstSeenAt, f.to) : undefined,
        f.after
          ? sql`(${incidents.lastEvidenceAt}, ${incidents.id}) < (${f.after.t}::timestamptz, ${f.after.id}::uuid)`
          : undefined,
        exists(hasPublicEvidence),
      ),
    )
    .orderBy(desc(incidents.lastEvidenceAt), desc(incidents.id))
    .limit(f.limit + 1);

  const page = rows.slice(0, f.limit);
  const last = page.at(-1);
  return {
    items: await withEvidenceStats(tx, page.map((r) => r.incident)),
    next: rows.length > f.limit && last ? { t: last.key, id: last.incident.id } : null,
  };
}

type IncidentRow = typeof incidents.$inferSelect;

/** List items for the rows that still have public evidence, in the given order. */
async function withEvidenceStats(tx: Executor, rows: IncidentRow[]): Promise<IncidentListItem[]> {
  if (rows.length === 0) return [];
  const stats = await tx
    .select({
      incidentId: incidentEvidence.incidentId,
      threatTypes: sql<string[]>`array_agg(distinct ${claims.threatType} order by ${claims.threatType})`,
      geoBases: sql<string[]>`array_agg(distinct ${claims.geoBasis})`,
      sourceCount: sql<number>`count(distinct ${messages.sourceId})::int`,
      conflicting: sql<boolean>`bool_or(${incidentEvidence.relation} = 'conflicting')`,
      closure: sql<boolean>`coalesce(bool_or(${incidentEvidence.claimId} = ${incidents.closureClaimId}), false)`,
    })
    .from(incidentEvidence)
    .innerJoin(incidents, eq(incidents.id, incidentEvidence.incidentId))
    .innerJoin(claims, eq(claims.id, incidentEvidence.claimId))
    .innerJoin(messageRevisions, eq(messageRevisions.id, claims.revisionId))
    .innerJoin(messages, eq(messages.id, messageRevisions.messageId))
    .where(
      and(
        inArray(
          incidentEvidence.incidentId,
          rows.map((r) => r.id),
        ),
        eq(incidentEvidence.active, true),
        publicClaim,
      ),
    )
    .groupBy(incidentEvidence.incidentId);
  const byIncident = new Map(stats.map((s) => [s.incidentId, s]));

  return rows.flatMap((i) => {
    const s = byIncident.get(i.id);
    if (!s) return [];
    return IncidentListItem.parse({
      id: i.id,
      kind: i.kind,
      threatTypes: s.threatTypes,
      areaId: i.areaId,
      geoBasis: incidentGeoBasis(i.areaId, s.geoBases),
      lifecycle: i.lifecycle,
      mode: i.mode,
      firstSeenAt: i.firstSeenAt.toISOString(),
      lastEvidenceAt: i.lastEvidenceAt.toISOString(),
      summary: i.summary ?? '',
      sourceCount: s.sourceCount,
      hasConflict: i.hasConflict || s.conflicting,
      closureClaimed: s.closure,
      revision: i.revision,
    });
  });
}

/**
 * A public incident with every public claim ever linked to it, oldest post first. Links deactivated by a
 * merge/split stay listed with `active: false`. Null when the incident does not exist or is not public.
 */
export async function getIncident(tx: Executor, id: string): Promise<IncidentDetail | null> {
  const [row] = await tx.select().from(incidents).where(eq(incidents.id, id));
  const [item] = row ? await withEvidenceStats(tx, [row]) : [];
  if (!item) return null;

  const evidence = await tx
    .select({
      claim: claims,
      relation: incidentEvidence.relation,
      originGroup: incidentEvidence.originGroup,
      active: incidentEvidence.active,
      revisionId: messageRevisions.id,
      text: messageRevisions.normalizedText,
      editedAt: messageRevisions.editedAt,
      externalMessageId: messages.externalMessageId,
      publishedAt: messages.publishedAt,
      receivedAt: messages.receivedAt,
      sourceId: sources.id,
      provider: sources.provider,
      username: sources.username,
    })
    .from(incidentEvidence)
    .innerJoin(claims, eq(claims.id, incidentEvidence.claimId))
    .innerJoin(messageRevisions, eq(messageRevisions.id, claims.revisionId))
    .innerJoin(messages, eq(messages.id, messageRevisions.messageId))
    .innerJoin(sources, eq(sources.id, messages.sourceId))
    .where(and(eq(incidentEvidence.incidentId, id), publicClaim))
    .orderBy(asc(messages.publishedAt), asc(claims.ordinal), asc(claims.id));

  return IncidentDetail.parse({
    ...item,
    evidence: evidence.map(({ claim: c, ...e }) => {
      const username = publicUsername(e.provider, e.username);
      return {
        claimId: c.id,
        sourceId: e.sourceId,
        sourceUsername: username,
        messageExternalId: e.externalMessageId,
        messageUrl: telegramUrl(username, e.externalMessageId),
        publishedAt: e.publishedAt.toISOString(),
        // Spans index the revision's normalizedText, so that is the text published next to them.
        text: e.text,
        spans: c.evidence,
        geoBasis: c.geoBasis,
        relation: e.relation,
        originGroup: e.originGroup,
        active: e.active,
        revisionId: e.revisionId,
        receivedAt: e.receivedAt.toISOString(),
        editedAt: e.editedAt?.toISOString() ?? null,
        kind: c.kind,
        threatType: c.threatType,
        temporalScope: c.temporalScope,
        quantity: c.quantity,
        quantityText: c.quantityText,
        placeId: c.placeId,
        movementMention: c.movementMention,
        uncertainty: c.uncertainty,
      };
    }),
  });
}

/**
 * NEPTUN states for the area's alert places (see `alertPlaces`), in dictionary order. A place without a row is
 * reported as unknown. Unfiltered, provider areas missing from the dictionary are appended by key.
 */
export async function listAlerts(tx: Executor, areaId: string | null, now: Date): Promise<AlertStateDto[]> {
  const places = alertPlaces(areaId);
  const keys = places.flatMap((p) => p.neptunKeys);
  const rows: AlertRow[] = await tx
    .select()
    .from(alertStates)
    .where(areaId === null ? undefined : inArray(alertStates.areaKey, keys))
    .orderBy(asc(alertStates.areaKey));
  const byKey = new Map(rows.map((r) => [r.areaKey, r]));
  const known = places.flatMap((p) => p.neptunKeys.map((k) => alertDto(k, p, byKey.get(k), now)));
  const extra = rows.filter((r) => !keys.includes(r.areaKey)).map((r) => alertDto(r.areaKey, byNeptunKey(r.areaKey), r, now));
  return [...known, ...extra];
}

export async function listSources(tx: Executor, now: Date): Promise<SourceDto[]> {
  const rows = await tx
    .select({ s: sources, h: sourceHealth })
    .from(sources)
    .leftJoin(sourceHealth, eq(sourceHealth.sourceId, sources.id))
    .orderBy(asc(sources.provider), asc(sources.displayName), asc(sources.id));
  return rows.map(({ s, h }) => {
    const username = publicUsername(s.provider, s.username);
    return SourceDto.parse({
      id: s.id,
      provider: s.provider,
      username,
      // Never fall back to a withheld username or the raw channel ID.
      displayName: s.displayName ?? username ?? s.provider,
      enabled: s.enabled,
      lastSuccessfulSync: h?.lastSuccessAt?.toISOString() ?? null,
      lastMessageAt: h?.lastMessageAt?.toISOString() ?? null,
      availability: sourceAvailability({ enabled: s.enabled, lastSuccessAt: h?.lastSuccessAt ?? null, errorKind: h?.errorKind ?? null }, now),
    });
  });
}

export const OVERVIEW_FEED_SIZE = 20;

/**
 * The dashboard snapshot. Live: current alert states, the live feed head and source health. Archive (`asOf`):
 * incidents first seen by then (live and imported), each in its latest recorded state; alerts are unknown
 * because only the current alert projection is kept. Freshness is the worst of the alerts and the collectors.
 */
export async function readOverview(
  tx: Executor,
  areaId: string | null,
  asOf: Date | null,
  now: Date,
): Promise<{ overview: Overview; freshness: Freshness }> {
  // ponytail: no alert or incident history is kept, so archive alerts are unknown and archive incidents show their
  // latest state (lastEvidenceAt may be after asOf); add versioned projections if point-in-time state is needed.
  const alerts = asOf
    ? alertPlaces(areaId).flatMap((p) => p.neptunKeys.map((k) => alertDto(k, p, undefined, now)))
    : await listAlerts(tx, areaId, now);
  const feed = await listIncidents(tx, { areaId: areaId ?? undefined, to: asOf ?? undefined, limit: OVERVIEW_FEED_SIZE });
  const sourceList = await listSources(tx, now);
  return {
    overview: {
      asOf: (asOf ?? now).toISOString(),
      mode: asOf ? 'archive' : 'live',
      areaId,
      alerts,
      incidents: feed.items,
      sources: sourceList,
    },
    freshness: worstFreshness([...alerts.map((a) => a.freshness), feedFreshness(sourceList)]),
  };
}
