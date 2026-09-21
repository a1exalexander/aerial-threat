import type { Db } from '@aerial/db';
import {
  applyAlertSnapshot,
  ensureNeptunSource,
  recordAlertSnapshot,
  recordNeptunHealth,
  refreshAlertFreshness,
} from '@aerial/db/repos/alerts';
import { type NeptunEvent, runNeptunConnector } from '@aerial/neptun';
import type { Logger } from '@aerial/observability';
import type { Loop } from './index';

const FRESHNESS_TICK_MS = 5_000;

/**
 * Applies connector events to the DB, one at a time. Valid snapshots are stored raw and projected; failures are
 * stored (when a payload arrived) and recorded in source_health, and never touch alert_states.
 */
export function createNeptunHandler(db: Db, sourceId: string, log: Logger) {
  const reported = new Set<string>(); // each diagnostic / unknown key is logged once per process
  const reportOnce = (items: string[], msg: string) => {
    const fresh = items.filter((i) => !reported.has(i));
    fresh.forEach((i) => reported.add(i));
    if (fresh.length) log.warn({ items: fresh }, msg);
  };

  return async (e: NeptunEvent): Promise<void> => {
    const at = e.observedAt;
    if (e.type === 'heartbeat') return recordNeptunHealth(db, sourceId, at, { lastMessageAt: at });

    const transport = e.channel === 'ws' ? { lastMessageAt: at } : {};
    if (e.type === 'failure') {
      log.warn({ channel: e.channel, kind: e.kind, error: e.error }, 'neptun: no usable alert set');
      return db.transaction(async (tx) => {
        if (e.raw !== undefined)
          await recordAlertSnapshot(tx, { fetchedAt: at, providerTime: null, raw: e.raw, valid: false, error: `${e.kind}: ${e.error}` });
        await recordNeptunHealth(tx, sourceId, at, { ...transport, errorKind: e.kind });
      });
    }

    const { snapshot } = e;
    reportOnce(snapshot.diagnostics, 'neptun: schema drift tolerated');
    const { unknownKeys, changedKeys } = await db.transaction(async (tx) => {
      const { id } = await recordAlertSnapshot(tx, { fetchedAt: at, providerTime: snapshot.providerTime, raw: e.raw, valid: true });
      const applied = await applyAlertSnapshot(tx, { snapshotId: id, at, providerTime: snapshot.providerTime, areas: snapshot.areas });
      await recordNeptunHealth(tx, sourceId, at, { ...transport, lastSuccessAt: at, errorKind: null });
      return applied;
    });
    reportOnce(unknownKeys, 'neptun: area keys outside the geo dictionary (kept with place_id null)');
    if (changedKeys.length) log.info({ channel: e.channel, changedKeys }, 'neptun: alert states changed');
  };
}

export const neptunLoop: Loop = {
  name: 'neptun',
  async start({ db, env, logger, signal }) {
    const log = logger.child({ loop: 'neptun' });
    const sourceId = await ensureNeptunSource(db.db);
    const tick = setInterval(() => {
      refreshAlertFreshness(db.db, new Date()).catch((err) => log.error({ err }, 'neptun: freshness refresh failed'));
    }, FRESHNESS_TICK_MS);
    try {
      await runNeptunConnector({ baseUrl: env.NEPTUN_BASE_URL, signal, log, onEvent: createNeptunHandler(db.db, sourceId, log) });
    } finally {
      clearInterval(tick);
    }
  },
  // start() follows ctx.signal: it closes the stream, drains queued events and resolves.
  stop: async () => {},
};
