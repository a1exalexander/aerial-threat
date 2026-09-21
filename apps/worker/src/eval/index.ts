/**
 * `cli eval-live --dataset <labels.json> --budget <n> [--out report.json] [--transport sdk|http]`
 *
 * Opt-in offline evaluation of Jev on a labelled dataset (doc 09). Makes real, billed Gateway calls,
 * so it needs AI_GATEWAY_API_KEY and an explicit request budget; CI never runs it. The dataset
 * format is `LabeledDataset` in @aerial/ai (redacted texts, pre-extracted candidates, labels).
 * The report holds versions, latency, usage and metrics with numerator/denominator and Wilson CI;
 * it never contains message text.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import {
  computeMetrics,
  createGatewayEvaluator,
  EvaluationError,
  INSTRUCTIONS_VERSION,
  LabeledDataset,
  NO_CANDIDATE,
  QUESTIONS_VERSION,
  RELEVANT_KINDS,
  type EvalRecord,
  type Evaluator,
  type Prediction,
} from '@aerial/ai';
import { parseEnv, WorkerEnv } from '@aerial/config';
import type { Assessment, ClaimKind, TemporalScope } from '@aerial/contracts';

const USAGE = 'usage: cli eval-live --dataset <labels.json> --budget <max requests> [--out <report.json>] [--transport sdk|http]';

// ponytail: stand-in publication policy (doc 05 start values) so the runner works before the domain
// policy lands; swap for @aerial/domain/claims publicationDecision once it exists.
const EVAL_POLICY = { version: 'eval-stand-in-v1', minScore: 0.9, minMargin: 0.2, maxFlag: 0.5 };

export function predict(assessments: readonly Assessment[]): Prediction {
  const choice = (q: string) => assessments.find((a) => a.question === q && a.type === 'choice') as Extract<Assessment, { type: 'choice' }> | undefined;
  const flag = (q: string) => assessments.find((a) => a.question === q && a.type === 'boolean') as Extract<Assessment, { type: 'boolean' }> | undefined;
  const candidate = (q: string) => {
    const selected = choice(q)?.selected;
    return selected && !(NO_CANDIDATE as readonly string[]).includes(selected) ? selected : null;
  };
  const kind = choice('message_kind');
  const [first = 0, second = 0] = Object.values(kind?.probabilities ?? {}).sort((a, b) => b - a);
  const confident = kind !== undefined && first >= EVAL_POLICY.minScore && first - second >= EVAL_POLICY.minMargin;
  const flagged = ['contains_multiple_claims', 'needs_context', 'is_tentative'].some((q) => (flag(q)?.probability ?? 0) >= EVAL_POLICY.maxFlag);
  const relevant = kind !== undefined && RELEVANT_KINDS.has(kind.selected as ClaimKind);
  return {
    kind: (kind?.selected as ClaimKind | undefined) ?? null,
    temporalScope: (choice('temporal_scope')?.selected as TemporalScope | undefined) ?? null,
    placeId: candidate('place_candidate'),
    relationId: candidate('relation_candidate'),
    decision: !confident ? 'review' : !relevant ? 'exclude' : flagged ? 'review' : 'publish',
  };
}

/** Nearest-rank percentile of an ascending list. */
const percentile = (sorted: number[], q: number) => (sorted.length ? sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)]! : null);

/** The run is sequential, so an open circuit is waited out instead of failing every remaining item. */
async function evaluateWaitingOutCircuit(evaluator: Evaluator, input: Parameters<Evaluator['evaluate']>[0]) {
  for (;;) {
    try {
      return await evaluator.evaluate(input);
    } catch (e) {
      if (!(e instanceof EvaluationError && e.kind === 'circuit_open')) throw e;
      await sleep(e.retryAfterMs ?? 1000);
    }
  }
}

export async function runEval(dataset: LabeledDataset, evaluator: Evaluator) {
  const records: EvalRecord[] = [];
  const items: Record<string, unknown>[] = [];
  const latencies: number[] = [];
  const usage = { requests: 0, inputTokens: 0, outputTokens: 0 };
  let errors = 0;
  let skipped = 0;
  let stoppedBy: 'budget' | 'credentials' | null = null;
  for (const [i, item] of dataset.items.entries()) {
    try {
      const result = await evaluateWaitingOutCircuit(evaluator, {
        state: { text: item.text, publishedAt: item.publishedAt, channel: item.channel },
        context: item.context,
        questions: { placeCandidates: item.placeCandidates, relationCandidates: item.relationCandidates },
      });
      usage.requests += result.attempts;
      usage.inputTokens += result.usage.inputTokens ?? 0;
      usage.outputTokens += result.usage.outputTokens ?? 0;
      latencies.push(result.latencyMs);
      const predicted = predict(result.assessments);
      records.push({ expected: item.expected, predicted });
      items.push({ id: item.id, ...predicted, expectedKind: item.expected.kind, attempts: result.attempts, providerRequestId: result.providerRequestId });
    } catch (e) {
      const kind = e instanceof EvaluationError ? e.kind : 'input'; // e.g. a reserved candidate ID in the dataset
      if (e instanceof EvaluationError) usage.requests += e.attempts;
      // Out of budget, or every further call would fail the same way: stop, but keep the report.
      if (kind === 'budget_exhausted' || kind === 'credentials') {
        stoppedBy = kind === 'credentials' ? kind : 'budget';
        skipped = dataset.items.length - i;
        break;
      }
      // Failed calls say nothing about answer quality: counted, kept out of the metrics.
      errors++;
      items.push({ id: item.id, error: kind, attempts: e instanceof EvaluationError ? e.attempts : 0 });
    }
  }
  latencies.sort((a, b) => a - b);
  return {
    generatedAt: new Date().toISOString(),
    model: evaluator.model,
    questionsVersion: QUESTIONS_VERSION,
    instructionsVersion: INSTRUCTIONS_VERSION,
    parserVersion: dataset.parserVersion,
    policy: EVAL_POLICY,
    counts: { items: dataset.items.length, evaluated: records.length, errors, skipped, stoppedBy },
    latencyMs: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), max: latencies.at(-1) ?? null },
    usage,
    metrics: computeMetrics(records),
    items,
  };
}

export async function run(argv: string[]): Promise<number> {
  const env = parseEnv(WorkerEnv.pick({ AI_GATEWAY_API_KEY: true, AI_MODEL_ID: true }));
  if (!env.AI_GATEWAY_API_KEY) {
    console.error('eval-live: AI_GATEWAY_API_KEY required — live Jev evaluation is opt-in and billed (CI uses the fake evaluator).');
    return 2;
  }
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: { dataset: { type: 'string' }, budget: { type: 'string' }, out: { type: 'string' }, transport: { type: 'string' } },
    }));
  } catch (e) {
    console.error(`eval-live: ${(e as Error).message}\n${USAGE}`);
    return 2;
  }
  const budget = Number(values.budget);
  const transport = values.transport ?? 'sdk';
  if (!values.dataset || !Number.isInteger(budget) || budget < 1 || (transport !== 'sdk' && transport !== 'http')) {
    console.error(USAGE);
    return 2;
  }

  let report;
  const out = values.out ?? `eval-report-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  try {
    const dataset = LabeledDataset.parse(JSON.parse(await readFile(values.dataset, 'utf8')));
    const evaluator = createGatewayEvaluator({
      apiKey: env.AI_GATEWAY_API_KEY,
      model: env.AI_MODEL_ID,
      transport,
      maxRequests: budget, // hard cap for the run, retries included
      dailyRequestLimit: budget, // for the 50/80/100 % warnings
      concurrency: 1,
      onEvent: (event) => console.error('eval-live:', JSON.stringify(event)),
    });
    report = { ...(await runEval(dataset, evaluator)), transport };
    await writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
  } catch (e) {
    console.error(`eval-live: ${(e as Error).message}`);
    return 1;
  }

  const { counts, metrics } = report;
  console.log(
    `eval-live: ${counts.evaluated}/${counts.items} evaluated, ${counts.errors} errors, ${counts.skipped} skipped` +
      `${counts.stoppedBy ? ` (stopped: ${counts.stoppedBy})` : ''}; report ${out}`,
  );
  for (const [name, r] of Object.entries(metrics)) {
    const ci = r.ci95 ? ` [${r.ci95.map((v) => v.toFixed(3)).join(', ')}]` : '';
    console.log(`  ${name}: ${r.numerator}/${r.denominator}${r.rate === null ? '' : ` = ${r.rate.toFixed(3)}`}${ci}`);
  }
  if (counts.stoppedBy === 'credentials') console.error('eval-live: Gateway rejected the credentials; partial report written');
  return counts.stoppedBy === 'credentials' ? 1 : 0;
}
