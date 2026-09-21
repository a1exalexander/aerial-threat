// Kremenchuk screen storage: situation_snapshots (evaluations of the channel window) and the NEPTUN state of the
// raion as the screen and the AI gating see it. Snapshots never write alert_states.
import { type AlertStateDto, KREMENCHUK, type SituationMode } from '@aerial/contracts';
import { byId } from '@aerial/geo';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Executor } from '../client';
import { alertStates, situationSnapshots } from '../schema';
import { alertDto } from './read/policy';

export type SituationSnapshot = typeof situationSnapshots.$inferSelect;
export type NewSituationSnapshot = typeof situationSnapshots.$inferInsert;
export type SituationSnapshotStatus = SituationSnapshot['status'];

export async function insertSnapshot(db: Executor, row: NewSituationSnapshot): Promise<SituationSnapshot> {
  const [out] = await db.insert(situationSnapshots).values(row).returning();
  return out!;
}

/** The newest snapshot of the area by evaluated_at, optionally of one mode and/or status; null when none. */
export async function latestSnapshot(
  db: Executor,
  areaId: string,
  opts: { mode?: SituationMode; status?: SituationSnapshotStatus } = {},
): Promise<SituationSnapshot | null> {
  const [row] = await db
    .select()
    .from(situationSnapshots)
    .where(
      and(
        eq(situationSnapshots.areaId, areaId),
        opts.mode ? eq(situationSnapshots.mode, opts.mode) : undefined,
        opts.status ? eq(situationSnapshots.status, opts.status) : undefined,
      ),
    )
    .orderBy(desc(situationSnapshots.evaluatedAt), desc(situationSnapshots.createdAt))
    .limit(1);
  return row ?? null;
}

const RAION = byId(KREMENCHUK.raionId)!;
const OBLAST = byId(KREMENCHUK.oblastId)!;
const RAION_KEY = RAION.neptunKeys[0]!;
const OBLAST_KEY = OBLAST.neptunKeys[0]!;

/**
 * NEPTUN state of Кременчуцький район with freshness recomputed from last_success_at (the read API policy:
 * stale after 30 s, unknown after 120 s). Without a raion row the state is unknown; the oblast row then only
 * tells how fresh the feed is and never stands in for the raion's state (it may be a partial alert elsewhere).
 */
export async function kremenchukAlert(db: Executor, now = new Date()): Promise<AlertStateDto> {
  const rows = await db.select().from(alertStates).where(inArray(alertStates.areaKey, [RAION_KEY, OBLAST_KEY]));
  const raion = rows.find((r) => r.areaKey === RAION_KEY);
  if (raion) return alertDto(RAION_KEY, RAION, raion, now);
  const oblast = rows.find((r) => r.areaKey === OBLAST_KEY);
  const feed = oblast && alertDto(OBLAST_KEY, OBLAST, oblast, now);
  return {
    ...alertDto(RAION_KEY, RAION, undefined, now),
    ...(feed && { freshness: feed.freshness, lastSuccessfulFetchAt: feed.lastSuccessfulFetchAt }),
  };
}

/** True while NEPTUN reports the raion under alert (fresh or stale); unknown is not active. */
export const isKremenchukAlertActive = async (db: Executor, now = new Date()): Promise<boolean> =>
  (await kremenchukAlert(db, now)).state === 'active';
