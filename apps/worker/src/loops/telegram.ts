// Live Telegram collector (doc 04 B). One collector per database/environment (advisory-lock lease), which
// matches doc 08's one Telegram session per environment.
// Flow: buffer pushed updates -> bounded backfill (first start) or catch-up from the stored pts
// (restart/reconnect) plus a recheck of the recent window -> apply buffered and live updates in pts order.
// Every write goes through ingestMessage in the same transaction as the channel's pts checkpoint, so the
// cursor never passes unsaved data; duplicates and backfill/buffer overlap collapse on its idempotency key.
import { setTimeout as delay } from 'node:timers/promises';
import type { WorkerEnv } from '@aerial/config';
import {
  type Db,
  type Executor,
  JOB_PRIORITY,
  LeaseLostError,
  PROCESS_REVISION,
  backoffMs,
  enqueue,
  ingestMessage,
  messages,
  sourceHealth,
  sources,
  telegramCheckpoints,
} from '@aerial/db';
import { type SQL, and, between, eq, inArray, isNull, notInArray, sql } from '@aerial/db/orm';
import type { Logger } from '@aerial/observability';
import {
  type Change,
  GramJsSource,
  type LiveUpdate,
  TelegramAuthLost,
  TelegramChannelUnavailable,
  TelegramFloodWait,
  type TelegramSource,
} from '@aerial/telegram/live';
import type { Loop, LoopContext } from './index';

const LEASE_KEY = 'aerial:telegram-collector';
/** Buffered updates beyond this are dropped in favour of a resync from the checkpoint. */
const MAX_QUEUE = 10_000;
const INT4_MAX = 2_147_483_647;

export type TelegramLoopOptions = {
  /** Returns undefined when Telegram is not configured. */
  createSource: (env: WorkerEnv) => TelegramSource | undefined;
  /** Source allowlist; defaults to TELEGRAM_CHANNELS (@aerial/config). Identity is the resolved channel ID. */
  channels: string[];
  /** First-start history window. */
  backfillMs: number;
  /** Window re-read after a restart or reconnect to catch edits/deletes the update stream missed. */
  recheckMs: number;
  /** Catch-up period for every channel; also the connection-health heartbeat and lease check. */
  syncIntervalMs: number;
  leaseRetryMs: number;
  sleep: (ms: number, signal: AbortSignal) => Promise<unknown>;
  random: () => number;
};

const defaults: Omit<TelegramLoopOptions, 'channels'> = {
  createSource: (env) => {
    const apiId = Number(env.TELEGRAM_API_ID);
    return Number.isSafeInteger(apiId) && apiId > 0 && env.TELEGRAM_API_HASH && env.TELEGRAM_SESSION_SECRET_REF
      ? new GramJsSource({ apiId, apiHash: env.TELEGRAM_API_HASH, sessionRef: env.TELEGRAM_SESSION_SECRET_REF })
      : undefined;
  },
  backfillMs: 24 * 3_600_000,
  recheckMs: 3_600_000,
  syncIntervalMs: 30_000,
  leaseRetryMs: 15_000,
  sleep: (ms, signal) => delay(ms, undefined, { signal }),
  random: Math.random,
};

export function createTelegramLoop(overrides: Partial<TelegramLoopOptions> = {}): Loop {
  return {
    name: 'telegram',
    async start(ctx) {
      const opts: TelegramLoopOptions = { ...defaults, channels: ctx.env.TELEGRAM_CHANNELS, ...overrides };
      const log = ctx.logger.child({ loop: 'telegram' });
      const source = opts.createSource(ctx.env);
      if (!source) {
        log.warn('telegram not configured (TELEGRAM_API_ID, TELEGRAM_API_HASH, TELEGRAM_SESSION_SECRET_REF); live collector disabled');
        await markError(ctx.db.db, log, 'not_configured', 'all');
        return;
      }
      const lease = await acquireLease(ctx, opts, log);
      if (!lease) return;
      try {
        await new Collector(ctx, source, opts, log, lease).run();
      } finally {
        await source.disconnect().catch((err: unknown) => log.warn({ err }, 'telegram disconnect failed'));
        await lease.release();
      }
    },
    // Shutdown is driven by ctx.signal: start() applies the updates it already accepted, then resolves.
    stop: async () => {},
  };
}

export const telegramLoop = createTelegramLoop();

type Channel = { sourceId: string; channelId: string; username: string; pts: number | null; resolvedPts: number };

class Collector {
  private readonly channels = new Map<string, Channel>();
  /** Allowlisted usernames not resolved yet (or dropped as unavailable); retried on every resync. */
  private readonly pending: Set<string>;
  private readonly queue: LiveUpdate[] = [];
  private accepting = true;
  private resync = true;
  private wake = () => {};
  private readonly db: Db;

  constructor(
    private readonly ctx: LoopContext,
    private readonly source: TelegramSource,
    private readonly o: TelegramLoopOptions,
    private readonly log: Logger,
    private readonly lease: Lease,
  ) {
    this.db = ctx.db.db;
    this.pending = new Set(o.channels);
  }

  async run(): Promise<void> {
    const { signal } = this.ctx;
    // Subscribe before connecting: updates that arrive during the backfill wait in the queue.
    this.source.onUpdate((u) => {
      if (!this.accepting) return;
      if (this.queue.length >= MAX_QUEUE) {
        this.queue.length = 0;
        this.resync = true; // everything dropped is still behind the checkpoint and gets refetched
      }
      this.queue.push(u);
      this.wake();
    });
    const onAbort = () => this.wake();
    signal.addEventListener('abort', onAbort);
    let attempt = 0;
    let nextTick = 0;
    try {
      while (!signal.aborted) {
        try {
          if (this.resync) {
            this.queue.length = 0; // the resync refetches all of it from the checkpoint
            await this.call(() => this.source.connect());
            if (this.pending.size) await this.resolveChannels();
            this.resync = false;
            for (const ch of [...this.channels.values()]) await this.perChannel(ch, () => this.syncChannel(ch));
            attempt = 0;
            nextTick = Date.now() + this.o.syncIntervalMs;
          }
          while (this.queue.length && !this.resync) await this.apply(this.queue.shift()!);
          if (!this.resync && (await this.idle(nextTick - Date.now()))) {
            await this.tick();
            nextTick = Date.now() + this.o.syncIntervalMs;
          }
        } catch (err) {
          if (err instanceof TelegramAuthLost) return await this.authLost(err);
          if (err instanceof LeaseLostError) throw err;
          if (signal.aborted) break;
          // Anything else (network, DB, a failed commit): back off, then resync from the checkpoint.
          this.resync = true;
          const retryInMs = backoffMs(++attempt, this.o.random);
          this.log.warn({ err, attempt, retryInMs }, 'telegram sync failed; resyncing after backoff');
          await markError(this.db, this.log, 'transient', this.sourceIds());
          await this.o.sleep(retryInMs, signal).catch(() => {});
        }
      }
      await this.drain();
    } finally {
      this.accepting = false;
      signal.removeEventListener('abort', onAbort);
    }
  }

  /** Shutdown: stop accepting updates and store the ones already accepted (each commits with its checkpoint). */
  private async drain() {
    this.accepting = false;
    if (this.resync) return; // the checkpoint is behind them anyway; the next start refetches them
    try {
      for (const u of this.queue.splice(0)) await this.apply(u);
    } catch (err) {
      this.log.warn({ err }, 'telegram drain stopped; the next start catches up from the checkpoint');
    }
  }

  private async resolveChannels() {
    for (const username of [...this.pending]) {
      let info;
      try {
        info = await this.call(() => this.source.resolveChannel(username));
      } catch (err) {
        if (!(err instanceof TelegramChannelUnavailable)) throw err;
        this.log.error({ err, username }, 'telegram channel unavailable; retried on the next resync');
        continue;
      }
      // Keyed by the stable channel ID: a renamed username updates the existing source, never adds one.
      const [row] = await this.db
        .insert(sources)
        .values({ provider: 'telegram', externalId: info.channelId, username: info.username, displayName: info.title })
        .onConflictDoUpdate({
          target: [sources.provider, sources.externalId],
          set: { username: info.username, displayName: info.title, updatedAt: sql`now()` },
        })
        .returning({ id: sources.id, enabled: sources.enabled });
      if (!row) throw new Error('telegram: source upsert returned nothing');
      this.pending.delete(username);
      // ponytail: pause/unpause takes effect on the next collector start; re-read `enabled` per tick if it must be live.
      if (!row.enabled) {
        this.log.info({ username: info.username }, 'telegram source paused; skipped');
        continue;
      }
      const [cp] = await this.db.select({ pts: telegramCheckpoints.pts }).from(telegramCheckpoints).where(eq(telegramCheckpoints.sourceId, row.id));
      this.channels.set(info.channelId, { sourceId: row.id, channelId: info.channelId, username, pts: cp?.pts ?? null, resolvedPts: info.pts });
    }
    if (!this.channels.size) this.log.warn('telegram: no allowlisted channel is available; idle');
  }

  private async syncChannel(ch: Channel) {
    // First start: bounded backfill; pts was read before the history, so later changes replay idempotently.
    if (ch.pts === null) return this.syncWindow(ch, this.o.backfillMs, ch.resolvedPts);
    await this.catchUp(ch);
    await this.syncWindow(ch, this.o.recheckMs, cursor(ch));
  }

  private async apply(u: LiveUpdate) {
    if (u.kind === 'reconnected') {
      this.resync = true; // gap recovery: difference from the checkpoint plus a recent-window recheck
      return;
    }
    const ch = this.channels.get(u.channelId);
    if (!ch || ch.pts === null) return; // not allowlisted, or not backfilled yet (the pending resync covers it)
    const pts = ch.pts;
    await this.perChannel(ch, async () => {
      if (u.kind === 'tooLong') return this.catchUp(ch);
      if (u.pts <= pts) return; // already stored: duplicate delivery or backfill overlap
      if (u.pts - u.ptsCount !== pts) return this.catchUp(ch); // gap: fetch the missing range
      await this.commit(ch, [u], u.pts, { live: true });
    });
  }

  private async tick() {
    await this.lease.check();
    for (const ch of [...this.channels.values()]) await this.perChannel(ch, () => this.catchUp(ch));
  }

  private async catchUp(ch: Channel) {
    for (;;) {
      const diff = await this.call(() => this.source.getChannelDifference(ch.channelId, cursor(ch)));
      if (diff.tooLong) return this.syncWindow(ch, this.o.backfillMs, diff.pts);
      await this.commit(ch, diff.changes, diff.pts, { live: true });
      if (diff.final) return;
    }
  }

  /** Stores the window's current content, marks stored posts missing inside it as deleted, sets pts. */
  private async syncWindow(ch: Channel, windowMs: number, pts: number) {
    const recent = await this.call(() => this.source.recentMessages(ch.channelId, new Date(Date.now() - windowMs)));
    const changes = recent
      .map((message) => ({ kind: 'message' as const, message }))
      .sort((a, b) => compareIds(a.message.externalMessageId, b.message.externalMessageId));
    await this.commit(ch, changes, pts, { live: false, window: changes.map((c) => c.message.externalMessageId) });
  }

  /**
   * One transaction: messages/deletes, then the checkpoint and health. The in-memory cursor moves after
   * the commit. `window` is the ascending list of IDs the history returned.
   */
  private async commit(ch: Channel, changes: Change[], pts: number, opts: { live: boolean; window?: string[] }) {
    let lastMessageAt: Date | undefined;
    let lagMs: number | undefined;
    await this.db.transaction(async (tx) => {
      for (const c of changes) {
        if (c.kind === 'delete') {
          await markDeleted(tx, ch.sourceId, inArray(messages.externalMessageId, c.ids));
          continue;
        }
        const { status } = await ingestMessage(tx, c.message);
        const published = new Date(c.message.publishedAt);
        if (!lastMessageAt || published > lastMessageAt) lastMessageAt = published;
        // Ingestion lag counts fresh posts only, not edits of old ones.
        if (opts.live && status === 'imported' && !c.message.editedAt) {
          lagMs = Math.min(INT4_MAX, Math.max(lagMs ?? 0, Date.now() - published.getTime()));
        }
      }
      const ids = opts.window;
      // History inside [oldest, newest] of the window is complete, so a stored post missing there was deleted.
      if (ids?.length) {
        await markDeleted(tx, ch.sourceId, between(messages.externalMessageId, ids[0]!, ids.at(-1)!), notInArray(messages.externalMessageId, ids));
      }
      await tx
        .insert(telegramCheckpoints)
        .values({ sourceId: ch.sourceId, pts })
        .onConflictDoUpdate({
          target: telegramCheckpoints.sourceId,
          set: { pts: sql`greatest(${telegramCheckpoints.pts}, excluded.pts)`, updatedAt: sql`now()` },
        });
      await markHealthy(tx, ch.sourceId, lastMessageAt, lagMs);
    });
    ch.pts = pts;
  }

  /** Waits up to `ms` for an update or shutdown; true when the wait ran out (time to tick). */
  private idle(ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      if (this.ctx.signal.aborted) return resolve(false);
      if (ms <= 0) return resolve(true); // a steady update stream must not starve the tick
      if (this.queue.length) return resolve(false);
      const timer = setTimeout(() => resolve(true), ms);
      this.wake = () => {
        clearTimeout(timer);
        resolve(false);
      };
    });
  }

  /** A channel that turned private/invalid is dropped until the next resync instead of stalling the others. */
  private async perChannel(ch: Channel, fn: () => Promise<void>) {
    try {
      await fn();
    } catch (err) {
      if (!(err instanceof TelegramChannelUnavailable)) throw err;
      this.channels.delete(ch.channelId);
      this.pending.add(ch.username);
      this.log.error({ err, username: ch.username }, 'telegram channel became unavailable; dropped until the next resync');
      await markError(this.db, this.log, 'unavailable', [ch.sourceId]);
    }
  }

  /** Honours FLOOD_WAIT in place: the server-given wait plus jitter, then the same call again. Never rotates accounts. */
  private async call<T>(fn: () => Promise<T>): Promise<T> {
    for (;;) {
      try {
        return await fn();
      } catch (err) {
        if (!(err instanceof TelegramFloodWait)) throw err;
        const base = err.seconds * 1000;
        const waitMs = base + Math.round(this.o.random() * Math.max(1000, base / 10));
        this.log.warn({ waitMs }, 'telegram FLOOD_WAIT; pausing');
        await markError(this.db, this.log, 'flood_wait', this.sourceIds());
        await this.o.sleep(waitMs, this.ctx.signal);
      }
    }
  }

  /** Stops only this connector and raises an operational alert; login is never retried automatically. */
  private async authLost(err: TelegramAuthLost) {
    this.log.error(
      { alert: 'telegram_auth_lost', reason: err.message },
      'Telegram authorization lost; collector stopped. Restore the session with `cli telegram-login`, then restart the worker',
    );
    await markError(this.db, this.log, 'auth_lost', 'all');
  }

  /** Resolved channels, or every enabled Telegram source before resolution. */
  private sourceIds(): string[] | 'all' {
    return this.channels.size ? [...this.channels.values()].map((c) => c.sourceId) : 'all';
  }
}

function cursor(ch: Channel): number {
  if (ch.pts === null) throw new Error(`telegram: channel ${ch.channelId} has no checkpoint yet`);
  return ch.pts;
}

const compareIds = (a: string, b: string) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);

/**
 * Marks posts deleted and re-queues their current revision so the pipeline drops their contribution.
 * Telegram does not report every deletion; the recent-window recheck narrows but does not close that gap.
 */
async function markDeleted(tx: Executor, sourceId: string, ...which: [SQL, ...SQL[]]) {
  const rows = await tx
    .update(messages)
    .set({ deletedAt: sql`now()`, version: sql`${messages.version} + 1` })
    .where(and(eq(messages.sourceId, sourceId), isNull(messages.deletedAt), ...which))
    .returning({ messageId: messages.id, revisionId: messages.latestRevisionId });
  for (const { messageId, revisionId } of rows) {
    if (!revisionId) continue;
    await enqueue(tx, {
      kind: PROCESS_REVISION,
      dedupeKey: `${PROCESS_REVISION}:${revisionId}`,
      payload: { revisionId, messageId },
      priority: JOB_PRIORITY.live_update,
    });
  }
}

/** Connection health (last_success_at) and last post time are separate: a silent channel is not a failure. */
async function markHealthy(tx: Executor, sourceId: string, lastMessageAt: Date | undefined, lagMs: number | undefined) {
  await tx
    .insert(sourceHealth)
    .values({ sourceId, lastSuccessAt: sql`now()`, lastMessageAt, lagMs: lagMs === undefined ? undefined : Math.round(lagMs), errorKind: null })
    .onConflictDoUpdate({
      target: sourceHealth.sourceId,
      set: {
        lastSuccessAt: sql`now()`,
        lastMessageAt: sql`greatest(${sourceHealth.lastMessageAt}, excluded.last_message_at)`,
        lagMs: sql`coalesce(excluded.lag_ms, ${sourceHealth.lagMs})`,
        errorKind: null,
        updatedAt: sql`now()`,
      },
    });
}

/** Sets error_kind on the given sources ('all' = every enabled Telegram source). Best effort. */
async function markError(db: Executor, log: Logger, errorKind: string, which: string[] | 'all') {
  try {
    const ids =
      which === 'all'
        ? (await db.select({ id: sources.id }).from(sources).where(and(eq(sources.provider, 'telegram'), eq(sources.enabled, true)))).map(
            (r) => r.id,
          )
        : which;
    if (!ids.length) return;
    await db
      .insert(sourceHealth)
      .values(ids.map((sourceId) => ({ sourceId, errorKind })))
      .onConflictDoUpdate({ target: sourceHealth.sourceId, set: { errorKind, updatedAt: sql`now()` } });
  } catch (err) {
    log.warn({ err, errorKind }, 'telegram: could not record source health');
  }
}

type Lease = { check(): Promise<void>; release(): Promise<void> };

/**
 * One active collector per database: a session-level Postgres advisory lock on a reserved pool connection
 * (reserved connections are not recycled by max_lifetime). If that connection dies Postgres frees the lock;
 * check() then fails (error or a different backend pid) and the loop restarts to re-acquire it.
 */
async function acquireLease(ctx: LoopContext, o: TelegramLoopOptions, log: Logger): Promise<Lease | undefined> {
  const conn = await ctx.db.sql.reserve();
  try {
    while (!ctx.signal.aborted) {
      const [row] = await conn<{ ok: boolean; pid: number }[]>`
        select pg_try_advisory_lock(hashtextextended(${LEASE_KEY}, 0)) as ok, pg_backend_pid() as pid`;
      if (row?.ok) {
        const { pid } = row;
        return {
          check: async () => {
            const [same] = await conn<{ ok: boolean }[]>`select pg_backend_pid() = ${pid} as ok`.catch(() => []);
            if (!same?.ok) throw new LeaseLostError('telegram collector lease lost');
          },
          release: async () => {
            await conn`select pg_advisory_unlock(hashtextextended(${LEASE_KEY}, 0))`.catch(() => {});
            conn.release();
          },
        };
      }
      log.info('another collector holds the Telegram lease; waiting');
      await o.sleep(o.leaseRetryMs, ctx.signal).catch(() => {});
    }
  } catch (err) {
    conn.release();
    throw err;
  }
  conn.release();
  return undefined;
}
