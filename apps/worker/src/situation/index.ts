// The Kremenchuk situation, one tick at a time (the loop runs it every few seconds; the replay on a virtual clock):
//   1. new-post signal (live: drains process_revision jobs), 2. NEPTUN alert state of the raion,
//   3. rules snapshot (free, no network), 4. AI snapshot when the cadence allows it.
// AI cadence: during an alert at most every SITUATION_ALERT_INTERVAL_S and at once when the alert starts; without
// one at most every SITUATION_QUIET_AI_INTERVAL_S; both only when new posts arrived. The AI call never runs inside
// a transaction, and snapshots never touch alert_states.
import { EvaluationError } from '@aerial/ai';
import { SITUATION_QUESTIONS_VERSION, type SituationEvaluation, type SituationEvaluator, createFakeSituationEvaluator } from '@aerial/ai/situation';
import { createGatewaySituationEvaluator } from '@aerial/ai/situation/gateway';
import type { WorkerEnv } from '@aerial/config';
import { KREMENCHUK, type RouteStop, type SituationStatuses } from '@aerial/contracts';
import { type Db, PROCESS_REVISION, claim, complete } from '@aerial/db';
import { type SituationSnapshot, insertSnapshot, latestSnapshot, touchSnapshot } from '@aerial/db/repos/situation';
import { SITUATION_RULES_VERSION, type SituationMessage, rulesSituation } from '@aerial/domain/situation';
import { extractRoute } from '@aerial/geo/match';
import type { Logger } from '@aerial/observability';
import { kremenchukRevisions, loadWindow } from './window';

export const AREA_ID = KREMENCHUK.placeId;
const MINUTE = 60_000;
/** Rules always, and AI during an alert, look at the posts of the last 30 min. */
export const RECENT_WINDOW_MS = 30 * MINUTE;
/** Quiet AI looks at the posts since its previous successful call, at most this far back… */
export const QUIET_WINDOW_MAX_MS = 6 * 60 * MINUTE;
/** …plus this overlap, so a post that arrived late (published before that call, ingested after) is still seen. */
const QUIET_WINDOW_OVERLAP_MS = 5 * MINUTE;
/** Jobs drained per tick; live jobs outrank archive ones, so an import backlog never delays a live post. */
const JOB_BATCH = 500;
const JOB_LEASE_MS = 60_000;

export type SituationState = {
  lastRulesAt: number | null;
  /** Last AI call, failed ones included: a failure waits for the next slot like a success. */
  lastAiAt: number | null;
  /** Last successful AI call: where the next quiet window starts. */
  lastAiOkAt: number | null;
  /** Whether the last AI call was made under an alert; the first call of an alert does not wait for the interval. */
  lastAiInAlert: boolean | null;
  newForRules: boolean;
  newForAi: boolean;
  /** Posts in the last rules window. While there are some, rules re-run on the interval so old posts age out. */
  rulesWindowSize: number;
};

export type SituationContext = {
  db: Db;
  log: Logger;
  /** KREMENCHUK_SOURCES: channel usernames or IDs. */
  sources: string[];
  intervals: { rulesMs: number; alertAiMs: number; quietAiMs: number };
  /** null: rules only (gateway not configured). */
  evaluator: SituationEvaluator | null;
  /** New Kremenchuk posts since the previous call. */
  pollNewPosts: (now: Date) => Promise<number>;
  alertActive: (now: Date) => Promise<boolean>;
  signal?: AbortSignal;
  state: SituationState;
};

export type TickResult = { alert: boolean; rules: SituationSnapshot | null; ai: SituationSnapshot | null };

export const newState = (): SituationState => ({
  lastRulesAt: null,
  lastAiAt: null,
  lastAiOkAt: null,
  lastAiInAlert: null,
  newForRules: false,
  newForAi: false,
  rulesWindowSize: 0,
});

/**
 * After a restart: cadence continues from the stored snapshots, so a restart never buys an extra AI call
 * (lastAiInAlert stays unknown: no immediate call for an alert already running).
 */
export async function restoreState(db: Db): Promise<SituationState> {
  const [rules, ai, aiOk] = await Promise.all([
    latestSnapshot(db, AREA_ID, { mode: 'rules' }),
    latestSnapshot(db, AREA_ID, { mode: 'ai' }),
    latestSnapshot(db, AREA_ID, { mode: 'ai', status: 'ok' }),
  ]);
  return {
    ...newState(),
    lastRulesAt: rules?.evaluatedAt.getTime() ?? null,
    lastAiAt: ai?.evaluatedAt.getTime() ?? null,
    lastAiOkAt: aiOk?.evaluatedAt.getTime() ?? null,
    rulesWindowSize: rules?.revisionIds.length ?? 0,
  };
}

/** fake: the rules, free. gateway: the Jev evaluator; if it cannot be created the loop runs rules only. */
export function createSituationEvaluator(env: WorkerEnv, log: Logger): SituationEvaluator | null {
  if (env.AI_EVALUATOR === 'fake') return createFakeSituationEvaluator(rulesSituation);
  try {
    return createGatewaySituationEvaluator({
      apiKey: env.AI_GATEWAY_API_KEY,
      model: env.AI_MODEL_ID,
      dailyRequestLimit: env.AI_DAILY_REQUEST_LIMIT,
      concurrency: env.AI_CONCURRENCY,
      onEvent: (event) => log.warn({ event }, 'situation: AI event'),
    });
  } catch (err) {
    log.warn({ err }, 'situation: gateway evaluator unavailable; rules only');
    return null;
  }
}

export function situationContext(
  db: Db,
  env: WorkerEnv,
  log: Logger,
  parts: Pick<SituationContext, 'pollNewPosts' | 'alertActive' | 'state' | 'signal'>,
): SituationContext {
  return {
    db,
    log,
    sources: env.KREMENCHUK_SOURCES,
    intervals: {
      rulesMs: env.SITUATION_RULES_INTERVAL_S * 1000,
      alertAiMs: env.SITUATION_ALERT_INTERVAL_S * 1000,
      quietAiMs: env.SITUATION_QUIET_AI_INTERVAL_S * 1000,
    },
    evaluator: createSituationEvaluator(env, log),
    ...parts,
  };
}

/**
 * The live new-post signal: claims one batch of process_revision jobs and completes them in the transaction that
 * sorts out which revisions are Kremenchuk posts, so the queue never grows. Returns how many are. One batch per
 * call: a failure can only lose the signal of a batch that was rolled back, whose jobs come back after the lease.
 */
export async function drainRevisionJobs(db: Db, owner: string, sources: string[]): Promise<number> {
  const batch = await claim(db, { kinds: [PROCESS_REVISION], owner, leaseMs: JOB_LEASE_MS, limit: JOB_BATCH });
  if (!batch.length) return 0;
  const ids = batch.map((j) => j.payload.revisionId).filter((id): id is string => typeof id === 'string');
  return db.transaction(async (tx) => {
    const ours = await kremenchukRevisions(tx, sources, ids);
    for (const job of batch) await complete(tx, job);
    return ours.length;
  });
}

const low = <T>(value: T) => ({ value, confidence: 'low' as const, evidenceMessageIds: [] });
/** Statuses of a failed AI row: the column is required, the row is never shown. */
const NO_STATUSES: SituationStatuses = {
  threatNow: low(false),
  threatType: low('unknown'),
  direction: low('unknown'),
  quantity: low('unknown'),
  forecast: low('none'),
  explosions: low(false),
  airDefense: low(false),
};

/** Route list of the newest relevant post that has one. */
function routeOf(window: SituationMessage[], relevant: string[]): RouteStop[] | null {
  const keep = new Set(relevant);
  for (const m of [...window].reverse()) {
    const route = keep.has(m.revisionId) ? extractRoute(m.text) : null;
    if (route?.length) return route;
  }
  return null;
}

const windowRow = (window: SituationMessage[], from: Date, now: Date) => ({
  areaId: AREA_ID,
  evaluatedAt: now,
  windowFrom: from,
  windowTo: now,
  revisionIds: window.map((m) => m.revisionId),
});

async function writeRules(ctx: SituationContext, now: Date): Promise<SituationSnapshot> {
  const from = new Date(now.getTime() - RECENT_WINDOW_MS);
  const window = await loadWindow(ctx.db, { sources: ctx.sources, from, to: now });
  const r = rulesSituation(window, now);
  const route = routeOf(window, r.relevantRevisionIds);
  // Unchanged picture: confirm the last rules row as current instead of writing a duplicate every minute.
  const prev = await latestSnapshot(ctx.db, AREA_ID, { mode: 'rules', status: 'ok' });
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  if (
    prev &&
    prev.rulesVersion === SITUATION_RULES_VERSION &&
    same(prev.revisionIds, window.map((m) => m.revisionId)) &&
    same(prev.relevantRevisionIds, r.relevantRevisionIds) &&
    same(prev.statuses, r.statuses) &&
    same(prev.route, route)
  ) {
    const row = await touchSnapshot(ctx.db, prev.id, now);
    Object.assign(ctx.state, { lastRulesAt: now.getTime(), newForRules: false, rulesWindowSize: window.length });
    return row;
  }
  const row = await insertSnapshot(ctx.db, {
    ...windowRow(window, from, now),
    relevantRevisionIds: r.relevantRevisionIds,
    statuses: r.statuses,
    route,
    mode: 'rules',
    rulesVersion: SITUATION_RULES_VERSION,
    status: 'ok',
  });
  Object.assign(ctx.state, { lastRulesAt: now.getTime(), newForRules: false, rulesWindowSize: window.length });
  return row;
}

export async function runSituationTick(ctx: SituationContext, now: Date): Promise<TickResult> {
  const s = ctx.state;
  const t = now.getTime();
  const since = (at: number | null) => (at === null ? Infinity : t - at);

  if ((await ctx.pollNewPosts(now)) > 0) s.newForRules = s.newForAi = true;
  const alert = await ctx.alertActive(now);
  const out: TickResult = { alert, rules: null, ai: null };

  // Every interval: a changed picture writes a row, an unchanged one only re-confirms the last (cheap, no network).
  if (since(s.lastRulesAt) >= ctx.intervals.rulesMs) {
    out.rules = await writeRules(ctx, now);
  }

  const { evaluator } = ctx;
  const due = alert
    ? s.lastAiInAlert === false || since(s.lastAiAt) >= ctx.intervals.alertAiMs
    : since(s.lastAiAt) >= ctx.intervals.quietAiMs;
  if (!evaluator || !s.newForAi || !due) return out;

  const from = new Date(alert ? t - RECENT_WINDOW_MS : Math.max((s.lastAiOkAt ?? 0) - QUIET_WINDOW_OVERLAP_MS, t - QUIET_WINDOW_MAX_MS));
  const window = await loadWindow(ctx.db, { sources: ctx.sources, from, to: now });
  if (!window.length) {
    s.newForAi = false; // the new posts were noise or too old for this window
    return out;
  }
  s.lastAiAt = t;
  s.lastAiInAlert = alert;
  const provenance = { ...windowRow(window, from, now), questionsVersion: SITUATION_QUESTIONS_VERSION, rulesVersion: SITUATION_RULES_VERSION };

  let result: SituationEvaluation;
  try {
    result = await evaluator.evaluate(window, now, ctx.signal); // network, outside any transaction
  } catch (err) {
    if (ctx.signal?.aborted) return out; // shutdown, not a failure: nothing recorded, the next start retries
    // EvaluationError carries no provider payload or post text; anything else is logged by name only.
    const kind = err instanceof EvaluationError ? err.kind : 'unexpected';
    ctx.log.warn({ kind, error: err instanceof EvaluationError ? err.message : (err as Error)?.name }, 'situation: AI evaluation failed; rules only');
    out.ai = await insertSnapshot(ctx.db, { ...provenance, statuses: NO_STATUSES, mode: 'ai', status: 'failed' });
    out.rules ??= await writeRules(ctx, now);
    return out;
  }
  out.ai = await insertSnapshot(ctx.db, {
    ...provenance,
    relevantRevisionIds: result.relevantRevisionIds,
    statuses: result.statuses,
    route: routeOf(window, result.relevantRevisionIds),
    mode: 'ai',
    model: result.model,
    usage: result.usage,
    providerRequestId: result.providerRequestId,
    latencyMs: result.latencyMs,
    status: 'ok',
  });
  s.newForAi = false;
  s.lastAiOkAt = t;
  return out;
}
