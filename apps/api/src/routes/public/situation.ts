// GET /v1/situation: the Kremenchuk screen. NEPTUN decides the alert; the latest snapshot adds statuses; the feed
// shows the Kremenchuk channels' posts, minus what the snapshot (or, for newer posts, the noise rule) left out.
import { KREMENCHUK, type SituationDto, SituationResponse, situationTile } from '@aerial/contracts';
import { listSources, readSnapshot, worstFreshness } from '@aerial/db/repos/read';
import { evaluationFreshness, kremenchukAlert, latestSnapshot, situationFeed, situationSourceIds } from '@aerial/db/repos/situation';
import { isNoise } from '@aerial/domain/situation';
import { isInKremenchukRaion } from '@aerial/geo';
import type { FastifyPluginAsync } from 'fastify';
import { send } from './respond';

export const FEED_WINDOW_MS = 6 * 3600_000;
export const FEED_SIZE = 50;

export const situationRoutes: FastifyPluginAsync = async (app) => {
  app.get('/situation', async (req, reply) => {
    const now = new Date();
    const data = await readSnapshot(app.db.db, async (tx): Promise<SituationDto> => {
      const { state, level, since, freshness, lastSuccessfulFetchAt } = await kremenchukAlert(tx, now);
      const alert = { state, level, since, freshness, lastSuccessfulFetchAt };
      const snap = await latestSnapshot(tx, KREMENCHUK.placeId, { status: 'ok' });
      const evaluation = snap && { mode: snap.mode, evaluatedAt: snap.evaluatedAt.toISOString(), freshness: evaluationFreshness(snap.evaluatedAt, now) };
      // An expired evaluation cannot raise the tile to threat; a stale one marks the threat tile stale.
      const { tile, stale } = situationTile(alert, evaluation?.freshness === 'unknown' ? null : (snap?.statuses ?? null));
      const tileStale = stale || (tile === 'threat' && evaluation?.freshness === 'stale');

      const covered = new Set(snap?.revisionIds);
      const relevant = new Set(snap?.relevantRevisionIds);
      const sourceIds = await situationSourceIds(tx, app.env.KREMENCHUK_SOURCES);
      const feed = await situationFeed(tx, {
        sourceIds,
        since: new Date(now.getTime() - FEED_WINDOW_MS),
        limit: FEED_SIZE,
        keep: (p) => (covered.has(p.id) ? relevant.has(p.id) : !isNoise(p.text)),
      });
      return {
        area: { id: KREMENCHUK.placeId, name: KREMENCHUK.name },
        alert,
        tile,
        tileStale,
        statuses: snap?.statuses ?? null,
        route: snap?.route?.map((s) => ({ ...s, inRaion: s.placeId !== null && isInKremenchukRaion(s.placeId) })) ?? null,
        evaluation,
        feed,
        sources: (await listSources(tx, now)).filter((s) => sourceIds.includes(s.id)),
      };
    });
    const freshness = worstFreshness([data.alert.freshness, data.evaluation?.freshness ?? 'unknown']);
    return send(req, reply, SituationResponse, { data, freshness }, now);
  });
};
