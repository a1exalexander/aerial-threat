// NEPTUN alert storage: raw alert_snapshots, the alert_states projection and the feed's source_health row.
// Provider data only: AI output never writes here.
import { createHash } from 'node:crypto';
import { PLACES, byId, byNeptunKey } from '@aerial/geo';
import { and, desc, eq, getTableColumns, isNull, lte, ne, or, sql } from 'drizzle-orm';
import type { Executor } from '../client';
import { alertSnapshots, alertStates, sourceHealth, sources } from '../schema';

export const NEPTUN_PROVIDER = 'neptun';
const NEPTUN_FEED = 'alerts';

/** Freshness policy (doc 04): stale 30 s after the last confirmed alert set, unknown after 120 s. */
export const ALERT_STALE_AFTER_MS = 30_000;
export const ALERT_UNKNOWN_AFTER_MS = 120_000;

/** One area of a valid, complete alert set (structurally the `@aerial/neptun` ActiveArea). */
export type ActiveAlertArea = { key: string; kind: 'raion' | 'oblast'; level: string; since: Date | null };

/** Areas projected even while no alert names them: every dictionary place with a NEPTUN key. */
const TRACKED = PLACES.flatMap((p) => p.neptunKeys.map((key) => [key, p.level] as const));

/** The alerts feed as a `sources` row so source_health can describe it. Returns its ID. */
export async function ensureNeptunSource(db: Executor): Promise<string> {
  const where = and(eq(sources.provider, NEPTUN_PROVIDER), eq(sources.externalId, NEPTUN_FEED));
  await db.insert(sources).values({ provider: NEPTUN_PROVIDER, externalId: NEPTUN_FEED, displayName: 'NEPTUN' }).onConflictDoNothing();
  const [row] = await db.select({ id: sources.id }).from(sources).where(where);
  if (!row) throw new Error('ensureNeptunSource: source row vanished');
  return row.id;
}

/** Stores a payload as received (valid or not). A payload identical to the previous one reuses that row. */
export async function recordAlertSnapshot(
  db: Executor,
  s: { fetchedAt: Date; providerTime: Date | null; raw: unknown; valid: boolean; error?: string },
): Promise<{ id: string; inserted: boolean }> {
  const payloadHash = createHash('sha256')
    .update(JSON.stringify(s.raw) ?? '')
    .digest('hex');
  const [prev] = await db
    .select({ id: alertSnapshots.id, payloadHash: alertSnapshots.payloadHash })
    .from(alertSnapshots)
    .where(eq(alertSnapshots.provider, NEPTUN_PROVIDER))
    .orderBy(desc(alertSnapshots.fetchedAt))
    .limit(1);
  if (prev?.payloadHash === payloadHash) return { id: prev.id, inserted: false };
  const [row] = await db
    .insert(alertSnapshots)
    .values({
      provider: NEPTUN_PROVIDER,
      fetchedAt: s.fetchedAt,
      providerTime: s.providerTime,
      payloadHash,
      rawPayload: s.raw,
      valid: s.valid,
      error: s.error ?? null,
    })
    .returning({ id: alertSnapshots.id });
  return { id: row!.id, inserted: true };
}

const { areaKey: _key, ...updatable } = getTableColumns(alertStates);
const fromExcluded = Object.fromEntries(Object.entries(updatable).map(([k, c]) => [k, sql.raw(`excluded.${c.name}`)]));

/**
 * Projects a valid, complete alert set: listed areas are active, every other known area is inactive, all fresh.
 * Only this path writes `inactive`, so failures can never clear an alert. Unknown keys are kept (place_id null).
 */
export async function applyAlertSnapshot(
  tx: Executor,
  s: { snapshotId: string; at: Date; providerTime: Date | null; areas: ActiveAlertArea[] },
): Promise<{ unknownKeys: string[]; changedKeys: string[] }> {
  const active = new Map(s.areas.map((a) => [a.key, a]));
  // An oblast-wide alert (occupied oblasts are listed whole) covers each raion of that oblast.
  for (const p of PLACES) {
    const parent = p.level === 'raion' && p.parentId ? active.get(byId(p.parentId)?.neptunKeys[0] ?? '') : undefined;
    if (parent) for (const key of p.neptunKeys) if (!active.has(key)) active.set(key, { ...parent, key, kind: 'raion' });
  }

  const existing = new Map((await tx.select().from(alertStates).for('update')).map((r) => [r.areaKey, r]));
  const kinds = new Map<string, string>([
    ...TRACKED,
    ...[...existing.values()].map((r) => [r.areaKey, r.areaKind] as const),
    ...[...active.values()].map((a) => [a.key, a.kind] as const),
  ]);

  const changedKeys: string[] = [];
  const rows = [...kinds].map(([areaKey, areaKind]) => {
    const a = active.get(areaKey);
    const old = existing.get(areaKey);
    const state = a ? 'active' : 'inactive';
    const since = a?.since ?? null;
    const changed = old?.state !== state || old?.since?.getTime() !== since?.getTime();
    if (changed && old) changedKeys.push(areaKey);
    const changeAt = a ? (since ?? s.providerTime ?? s.at) : old ? (s.providerTime ?? s.at) : null;
    return {
      areaKey,
      areaKind,
      placeId: byNeptunKey(areaKey)?.id ?? null,
      state,
      level: a?.level ?? null,
      since,
      freshness: 'fresh',
      lastSuccessAt: s.at,
      lastProviderChangeAt: changed ? changeAt : (old?.lastProviderChangeAt ?? null),
      snapshotId: s.snapshotId,
      updatedAt: s.at,
    };
  });
  await tx.insert(alertStates).values(rows).onConflictDoUpdate({ target: alertStates.areaKey, set: fromExcluded });

  return { unknownKeys: s.areas.filter((a) => !byNeptunKey(a.key)).map((a) => a.key), changedKeys };
}

/**
 * Ages the projection by last_success_at: fresh -> stale after 30 s; after 120 s freshness and state become
 * `unknown` (never `inactive`). The last known set stays reachable via snapshot_id. Returns the rows changed.
 */
export async function refreshAlertFreshness(db: Executor, now: Date): Promise<number> {
  const before = (ms: number) => new Date(now.getTime() - ms);
  const unknown = await db
    .update(alertStates)
    .set({ freshness: 'unknown', state: 'unknown', updatedAt: now })
    .where(
      and(
        ne(alertStates.freshness, 'unknown'),
        or(isNull(alertStates.lastSuccessAt), lte(alertStates.lastSuccessAt, before(ALERT_UNKNOWN_AFTER_MS))),
      ),
    )
    .returning({ key: alertStates.areaKey });
  const stale = await db
    .update(alertStates)
    .set({ freshness: 'stale', updatedAt: now })
    .where(and(eq(alertStates.freshness, 'fresh'), lte(alertStates.lastSuccessAt, before(ALERT_STALE_AFTER_MS))))
    .returning({ key: alertStates.areaKey });
  return unknown.length + stale.length;
}

/**
 * NEPTUN source_health: last_success_at = last accepted alert set (data freshness), last_message_at = last stream
 * frame (transport health only), error_kind = last failure, cleared by the next success.
 */
export async function recordNeptunHealth(
  db: Executor,
  sourceId: string,
  now: Date,
  patch: { lastSuccessAt?: Date; lastMessageAt?: Date; errorKind?: string | null },
): Promise<void> {
  await db
    .insert(sourceHealth)
    .values({ sourceId, ...patch, updatedAt: now })
    .onConflictDoUpdate({ target: sourceHealth.sourceId, set: { ...patch, updatedAt: now } });
}
