import { EvaluationError } from '@aerial/ai';
import { type SituationEvaluator, createFakeSituationEvaluator } from '@aerial/ai/situation';
import { PROCESS_REVISION, alertStates, enqueue, ingestMessage, jobs, sources } from '@aerial/db';
import { eq } from '@aerial/db/orm';
import { isKremenchukAlertActive } from '@aerial/db/repos/situation';
import { createTestDb } from '@aerial/db/testing';
import { type SituationMessage, rulesSituation } from '@aerial/domain/situation';
import { createLogger } from '@aerial/observability';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type SituationContext, drainRevisionJobs, newState, runSituationTick } from './index';

// The rules' noise filter is another unit's; pin a deterministic stand-in so the window test does not depend on it.
vi.mock('@aerial/domain/situation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@aerial/domain/situation')>()),
  isNoise: (text: string) => text.includes('#реклама'),
}));

const H = '1000000002'; // Х Кременчук (listed by username)
const M = '2432204405'; // Кременчуцький Миколай (listed by channel ID)
const ENERGY = '1000000001'; // collected, never part of the window
const SOURCES = ['h_kremenchug', M];
const T0 = new Date('2026-09-20T09:00:00Z');
const at = (s: number) => new Date(T0.getTime() + s * 1000);
const MIN = 60;

let t: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t?.drop());
beforeEach(async () => {
  await t.sql`truncate sources, messages, message_revisions, jobs, situation_snapshots, alert_states cascade`;
  await t.db.insert(sources).values([
    { provider: 'telegram', externalId: H, username: 'h_kremenchug', displayName: 'Х Кременчук' },
    { provider: 'telegram', externalId: M, displayName: 'Кременчуцький Миколай' },
    { provider: 'telegram', externalId: ENERGY, username: 'ppo_energy_poltava', displayName: 'Energy' },
  ]);
});

let seq = 0;
async function post(channel: string, text: string, publishedAt: Date, replyTo: string | null = null): Promise<string> {
  const id = String(++seq);
  await t.db.transaction((tx) =>
    ingestMessage(tx, {
      sourceProvider: 'telegram',
      sourceExternalId: channel,
      externalMessageId: id,
      publishedAt: publishedAt.toISOString(),
      editedAt: null,
      replyToExternalId: replyTo,
      rawText: text,
      normalizedText: text,
      cleanedText: text,
      mediaFlags: [],
      rawPayload: {},
      mode: 'live',
    }),
  );
  return id;
}

/** The fake evaluator (rules) that records every call. */
function counting(inner: SituationEvaluator = createFakeSituationEvaluator(rulesSituation)) {
  const calls: { now: Date; msgs: SituationMessage[] }[] = [];
  const evaluator: SituationEvaluator = {
    evaluate: async (msgs, now, signal) => {
      calls.push({ now, msgs });
      return inner.evaluate(msgs, now, signal);
    },
  };
  return { calls, evaluator, at: () => calls.map((c) => (c.now.getTime() - T0.getTime()) / 1000) };
}

const logger = createLogger({ name: 'test', level: 'silent' });
const context = (evaluator: SituationEvaluator | null): SituationContext => ({
  db: t.db,
  log: logger,
  sources: SOURCES,
  intervals: { rulesMs: 60_000, alertAiMs: 60_000, quietAiMs: 3_600_000 },
  evaluator,
  pollNewPosts: () => drainRevisionJobs(t.db, 'test', SOURCES),
  alertActive: (now) => isKremenchukAlertActive(t.db, now),
  state: newState(),
});

/** One tick at `now`; `alert` refreshes the NEPTUN raion row as if the connector had just polled. */
async function tick(ctx: SituationContext, now: Date, alert?: 'active' | 'inactive') {
  if (alert) {
    await t.db
      .insert(alertStates)
      .values({ areaKey: 'кременчуцький', areaKind: 'raion', state: alert, freshness: 'fresh', lastSuccessAt: now })
      .onConflictDoUpdate({ target: alertStates.areaKey, set: { state: alert, lastSuccessAt: now } });
  }
  return runSituationTick(ctx, now);
}

const snapshots = () => t.sql`select mode, status, evaluated_at, statuses, revision_ids, relevant_revision_ids from situation_snapshots order by evaluated_at, created_at`;

describe('AI cadence', () => {
  it('without an alert: AI at most hourly and only after new posts; rules every minute on new posts', async () => {
    const ai = counting();
    const ctx = context(ai.evaluator);
    let rules = 0;
    for (let m = 0; m <= 150; m++) {
      await post(H, `синтетичний пост ${m}`, at(m * MIN));
      if ((await tick(ctx, at(m * MIN), 'inactive')).rules) rules++;
    }
    for (const m of [180, 240, 300]) await tick(ctx, at(m * MIN), 'inactive');

    expect(ai.at()).toEqual([0, 60 * MIN, 120 * MIN, 180 * MIN]); // none at 240/300: nothing new after 150
    expect(rules).toBe(151);
    // Each quiet window starts at the previous AI call and holds at most 20 posts, newest kept.
    const [, second] = ai.calls;
    expect(second!.msgs).toHaveLength(20);
    expect(second!.msgs.at(-1)!.publishedAt).toEqual(at(60 * MIN));
    expect(second!.msgs[0]!.publishedAt).toEqual(at(41 * MIN));
  }, 60_000);

  it('the alert start triggers an immediate call; then at most once a minute', async () => {
    const ai = counting();
    const ctx = context(ai.evaluator);
    await post(H, 'пост 1', at(0));
    await tick(ctx, at(0), 'inactive'); // first call
    await post(M, 'пост 2', at(10));
    await tick(ctx, at(10), 'inactive'); // quiet: next slot in an hour
    await tick(ctx, at(20), 'active'); // alert starts: at once, although 20 s < 60 s
    await post(M, 'пост 3', at(30));
    await tick(ctx, at(30), 'active'); // debounced
    await tick(ctx, at(80), 'active'); // 60 s after the last call, with a new post
    expect(ai.at()).toEqual([0, 20, 80]);
    expect(ai.calls[1]!.msgs.map((m) => m.text)).toEqual(['пост 1', 'пост 2']); // alert window: the last 30 min
  });

  it('the first call of an alert does not wait for the interval, even when its posts come later', async () => {
    const ai = counting();
    const ctx = context(ai.evaluator);
    await post(H, 'пост 1', at(0));
    await tick(ctx, at(0), 'inactive');
    await tick(ctx, at(20), 'active'); // alert starts, nothing new: no call
    await post(H, 'пост 2', at(30));
    await tick(ctx, at(30), 'active'); // first post of the alert: at once
    expect(ai.at()).toEqual([0, 30]);
  });

  it('the quiet window starts before the last successful call: late posts and a failed call lose nothing', async () => {
    let fail = false;
    const ai = counting();
    const ctx = context({ evaluate: (msgs, now) => (fail ? Promise.reject(new EvaluationError('server', 'down')) : ai.evaluator.evaluate(msgs, now)) });
    await post(H, 'пост 1', at(0));
    await tick(ctx, at(0), 'inactive');
    await post(H, 'пізній пост', at(-10)); // published before that call, ingested after it
    await tick(ctx, at(60 * MIN), 'inactive');
    expect(ai.calls[1]!.msgs.map((m) => m.text)).toEqual(['пізній пост', 'пост 1']);
    fail = true;
    await post(H, 'пост 2', at(90 * MIN));
    await tick(ctx, at(120 * MIN), 'inactive'); // fails: the slot is used, the window is not
    fail = false;
    await post(H, 'пост 3', at(150 * MIN));
    await tick(ctx, at(180 * MIN), 'inactive');
    expect(ai.at()).toEqual([0, 60 * MIN, 180 * MIN]);
    expect(ai.calls[2]!.msgs.map((m) => m.text)).toEqual(['пост 2', 'пост 3']);
  });

  it('during an alert: at most once a minute and never without new posts', async () => {
    const ai = counting();
    const ctx = context(ai.evaluator);
    for (let s = 0; s <= 300; s += 5) {
      if (s < 180 && s % 10 === 0) await post(s % 20 ? H : M, `пост ${s}`, at(s));
      await tick(ctx, at(s), 'active');
    }
    expect(ai.at()).toEqual([0, 60, 120, 180]);
    for (const c of ai.calls) {
      expect(c.msgs.length).toBeLessThanOrEqual(20);
      expect(c.msgs.every((m) => c.now.getTime() - m.publishedAt.getTime() <= 30 * MIN * 1000)).toBe(true);
    }
  });
});

describe('AI failure', () => {
  it('writes a failed row without statuses and keeps the rules snapshot current', async () => {
    const failing: SituationEvaluator = {
      evaluate: async () => {
        throw new EvaluationError('server', 'AI Gateway responded 503', 503);
      },
    };
    const ctx = context(failing);
    await post(H, 'пост 1', at(0));
    await tick(ctx, at(0), 'inactive'); // rules (first) + failed AI; rules not written twice
    await post(H, 'пост 2', at(30));
    await tick(ctx, at(30), 'active'); // alert start: AI fails again, rules forced though 30 s < interval
    await post(H, 'пост 3', at(50));
    await tick(ctx, at(50), 'active'); // a failure waits for the next slot too

    const rows = await snapshots();
    expect(rows.map((r) => [r.mode, r.status, (new Date(r.evaluated_at).getTime() - T0.getTime()) / 1000])).toEqual([
      ['rules', 'ok', 0],
      ['ai', 'failed', 0],
      ['ai', 'failed', 30],
      ['rules', 'ok', 30],
    ]);
    const failed = rows[2]!;
    expect(failed.revision_ids).toHaveLength(2);
    expect(failed.relevant_revision_ids).toEqual([]);
    expect(Object.values(failed.statuses).every((s) => (s as { confidence: string }).confidence === 'low')).toBe(true);
    expect(rows[3]!.revision_ids).toHaveLength(2);
  });

  it('an AI call aborted by shutdown records nothing', async () => {
    const controller = new AbortController();
    const ctx = {
      ...context({
        evaluate: async () => {
          controller.abort();
          throw new EvaluationError('aborted', 'AI evaluation aborted by caller');
        },
      }),
      signal: controller.signal,
    };
    await post(H, 'пост', at(0));
    const r = await tick(ctx, at(0), 'active');
    expect(r.ai).toBeNull();
    expect((await snapshots()).map((row) => row.mode)).toEqual(['rules']);
  });

  it('without an evaluator the loop runs rules only', async () => {
    const ctx = context(null);
    await post(H, 'пост', at(0));
    await tick(ctx, at(0), 'active');
    expect((await snapshots()).map((r) => r.mode)).toEqual(['rules']);
  });
});

it('never holds a transaction during the AI call', async () => {
  const seen: { idleInTx: number; wrote: boolean }[] = [];
  const inner = createFakeSituationEvaluator(rulesSituation);
  const ctx = context({
    evaluate: async (msgs, now) => {
      await new Promise((r) => setTimeout(r, 50)); // "network"
      const [row] = await t.sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and state like 'idle in transaction%'`;
      // Another connection writes the same tables the tick touches; a held lock would time out here.
      await t.sql.begin(async (tx) => {
        await tx`set local lock_timeout = '1s'`;
        await tx`update jobs set updated_at = now()`;
        await tx`update messages set version = version`;
      });
      seen.push({ idleInTx: row!.n, wrote: true });
      return inner.evaluate(msgs, now);
    },
  });
  await post(H, 'пост', at(0));
  const r = await tick(ctx, at(0), 'active');
  expect(r.ai?.status).toBe('ok');
  expect(seen).toEqual([{ idleInTx: 0, wrote: true }]);
});

describe('window', () => {
  it('only KREMENCHUK_SOURCES; noise dropped before the AI; PII redacted; revision IDs kept', async () => {
    const ai = counting();
    const ctx = context(ai.evaluator);
    await post(ENERGY, 'енергетичний пост', at(0));
    await tick(ctx, at(0), 'active');
    expect(ai.calls).toHaveLength(0); // Energy posts are no signal and no window

    const parent = await post(H, 'питання, телефон 050 000 00 00', at(10));
    await post(H, 'відповідь, збір на картку 1234 5678 9012 3456', at(20), parent);
    await post(M, 'купуйте у нас #реклама', at(30));
    await post(M, 'синтетичний пост @someone', at(40));
    await post(ENERGY, 'ще енергетичний', at(50));
    await tick(ctx, at(60), 'active');

    expect(ai.calls).toHaveLength(1);
    const msgs = ai.calls[0]!.msgs;
    expect(msgs.map((m) => [m.sourceName, m.text, m.replyToText])).toEqual([
      ['Х Кременчук', 'питання, телефон [PHONE]', null],
      ['Х Кременчук', 'відповідь, збір на картку [CARD]', 'питання, телефон [PHONE]'],
      ['Кременчуцький Миколай', 'синтетичний пост [HANDLE]', null],
    ]);
    expect(msgs.every((m) => /^\d+$/.test(m.messageId) && Array.isArray(m.placeCandidates))).toBe(true);
    const [row] = await t.sql`select revision_ids from situation_snapshots where mode = 'ai'`;
    expect(row!.revision_ids).toEqual(msgs.map((m) => m.revisionId));
  });

  it('completes every process_revision job and leaves other job kinds alone', async () => {
    const ctx = context(null);
    await post(H, 'пост', at(0));
    await post(ENERGY, 'енергетичний пост', at(0));
    await enqueue(t.db, { kind: 'other_kind', dedupeKey: 'other:1' });
    await tick(ctx, at(0));
    const rows = await t.db.select({ kind: jobs.kind, status: jobs.status }).from(jobs).orderBy(jobs.kind);
    expect(rows).toEqual([
      { kind: 'other_kind', status: 'queued' },
      { kind: PROCESS_REVISION, status: 'done' },
      { kind: PROCESS_REVISION, status: 'done' },
    ]);
    expect(await t.db.select().from(jobs).where(eq(jobs.status, 'running'))).toEqual([]);
  });
});
