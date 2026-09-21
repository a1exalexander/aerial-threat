// `cli situation-replay --from <iso> --to <iso> [--step <s>] [--alert-schedule <file>]`: runs situation ticks on a
// virtual clock over the posts already stored in DATABASE_URL (e.g. imported exports) and writes their snapshots
// there. A post is new once the clock passes its publish time; jobs are not touched. Alert state comes from the
// schedule file — JSON [["<from iso>", "<to iso>"], ...] of alert periods, inactive otherwise — or else from
// alert_states. Prints the AI calls during alert vs quiet and the snapshots written (status values, never text).
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { loadWorkerEnv } from '@aerial/config';
import { createDb } from '@aerial/db';
import { type SituationSnapshot, isKremenchukAlertActive } from '@aerial/db/repos/situation';
import { createLogger } from '@aerial/observability';
import { newState, runSituationTick, situationContext } from './index';
import { countPosts } from './window';

const USAGE = 'usage: cli situation-replay --from <iso> --to <iso> [--step <seconds, default 60>] [--alert-schedule <json file>]';

export function parseSchedule(json: unknown): [Date, Date][] {
  if (!Array.isArray(json)) throw new Error('alert schedule: expected [["<from iso>", "<to iso>"], ...]');
  return json.map((p, i) => {
    const [a, b] = Array.isArray(p) ? p.map((v) => new Date(String(v))) : [];
    if (!a || !b || Number.isNaN(a.getTime()) || Number.isNaN(b.getTime()) || a >= b) throw new Error(`alert schedule: bad period #${i + 1}`);
    return [a, b];
  });
}

const kyiv = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Kyiv', dateStyle: 'short', timeStyle: 'short' });

function describe(s: SituationSnapshot, alert: boolean): string {
  const v = s.statuses;
  const f = (k: keyof typeof v) => `${k}=${String(v[k].value)}/${v[k].confidence}`;
  const route = s.route?.map((r) => r.placeId ?? '?').join('>') ?? '-';
  return `${kyiv.format(s.evaluatedAt)} ${alert ? 'ALERT' : 'quiet'} ${s.mode} posts=${s.revisionIds.length} relevant=${s.relevantRevisionIds.length} ${Object.keys(v)
    .map((k) => f(k as keyof typeof v))
    .join(' ')} route=${route}`;
}

export async function run(argv: string[]): Promise<number> {
  let values: { from?: string; to?: string; step?: string; 'alert-schedule'?: string };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: { from: { type: 'string' }, to: { type: 'string' }, step: { type: 'string', default: '60' }, 'alert-schedule': { type: 'string' } },
    }));
  } catch (err) {
    console.error(`${(err as Error).message}\n${USAGE}`);
    return 1;
  }
  const from = new Date(values.from ?? '');
  const to = new Date(values.to ?? '');
  const stepMs = Number(values.step) * 1000;
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to || !(stepMs > 0)) {
    console.error(USAGE);
    return 1;
  }
  const env = loadWorkerEnv();
  // Replay snapshots carry virtual evaluated_at times; never mix them into a real screen's history.
  if (env.APP_ENV === 'production' || env.APP_ENV === 'staging') {
    console.error(`situation-replay: refused on APP_ENV=${env.APP_ENV}`);
    return 1;
  }
  const schedule = values['alert-schedule'] ? parseSchedule(JSON.parse(await readFile(values['alert-schedule'], 'utf8'))) : null;

  const { db, close } = createDb(env.DATABASE_URL, { max: 2 });
  try {
    let prev = from;
    const ctx = situationContext(db, env, createLogger({ name: 'situation-replay', level: env.LOG_LEVEL }), {
      state: newState(),
      pollNewPosts: async (now) => {
        const n = await countPosts(db, { sources: env.KREMENCHUK_SOURCES, from: prev, to: now });
        prev = now;
        return n;
      },
      alertActive: schedule
        ? async (now) => schedule.some(([a, b]) => a <= now && now < b)
        : (now) => isKremenchukAlertActive(db, now),
    });
    const calls = { alert: 0, quiet: 0, failed: 0 };
    const written = { rules: 0, ai: 0, failed: 0 };
    let alertTicks = 0;
    let lastQuiet: number | null = null;
    let minQuietGapMs = Infinity;
    const samples: string[] = [];
    let ticks = 0;
    for (let t = from.getTime(); t <= to.getTime(); t += stepMs, ticks++) {
      const r = await runSituationTick(ctx, new Date(t));
      if (r.alert) alertTicks++;
      if (r.rules) written.rules++;
      if (!r.ai) continue;
      calls[r.alert ? 'alert' : 'quiet']++;
      if (!r.alert) {
        if (lastQuiet !== null) minQuietGapMs = Math.min(minQuietGapMs, t - lastQuiet);
        lastQuiet = t;
      }
      if (r.ai.status === 'failed') {
        calls.failed++;
        written.failed++;
      } else {
        written.ai++;
        samples.push(describe(r.ai, r.alert));
      }
    }
    console.log(`situation-replay ${from.toISOString()} -> ${to.toISOString()}, step ${stepMs / 1000} s: ${ticks} ticks, ${alertTicks} under alert`);
    console.log(`evaluator: ${ctx.evaluator ? env.AI_EVALUATOR : 'none (rules only)'}; sources: ${ctx.sources.join(', ')}`);
    console.log(
      `AI calls: ${calls.alert} during alert, ${calls.quiet} quiet (min gap between quiet calls: ${
        Number.isFinite(minQuietGapMs) ? `${Math.round(minQuietGapMs / 60_000)} min` : 'n/a'
      }), ${calls.failed} failed`,
    );
    console.log(`snapshots written: ${written.rules} rules, ${written.ai} ai, ${written.failed} failed`);
    console.log('AI snapshots (Kyiv time; status values only):');
    for (const line of samples) console.log(`  ${line}`);
    return 0;
  } finally {
    await close();
  }
}
