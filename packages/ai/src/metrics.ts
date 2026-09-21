// Offline evaluation metrics (doc 09): every rate is numerator/denominator with a Wilson 95% CI,
// because 100% on 5 examples is not evidence.
import { ClaimKind, PublicationDecision, TemporalScope, Timestamp } from '@aerial/contracts';
import { z } from 'zod';

export type Ratio = { numerator: number; denominator: number; rate: number | null; ci95: [number, number] | null };

export function wilson(numerator: number, denominator: number, z95 = 1.959964): Ratio {
  if (denominator === 0) return { numerator, denominator, rate: null, ci95: null };
  const n = denominator;
  const p = numerator / n;
  const z2 = z95 * z95;
  const center = (p + z2 / (2 * n)) / (1 + z2 / n);
  const half = (z95 / (1 + z2 / n)) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return { numerator, denominator, rate: p, ci95: [Math.max(0, center - half), Math.min(1, center + half)] };
}

export const RELEVANT_KINDS: ReadonlySet<ClaimKind> = new Set(['threat_report', 'alert_claim', 'clear_claim', 'aftermath']);

/** Human label of one item. `undefined` fields are unlabelled and stay out of that metric. */
export const Label = z.object({
  kind: ClaimKind,
  temporalScope: TemporalScope.optional(),
  /** Correct place ID, or null when no place applies. */
  placeId: z.string().nullable().optional(),
  /** True only for unambiguous explicit geography: the explicit-place accuracy population. */
  placeExplicit: z.boolean().optional(),
  /** Incident this post belongs to among the offered candidates, or null for a new incident. */
  relationId: z.string().nullable().optional(),
});
export type Label = z.infer<typeof Label>;

const Post = z.object({ text: z.string(), publishedAt: Timestamp });

/** `eval-live --dataset` file: redacted texts with pre-extracted candidates and labels. */
export const LabeledDataset = z.object({
  parserVersion: z.string().default('unknown'),
  items: z.array(
    z.object({
      id: z.string(),
      text: z.string(),
      publishedAt: Timestamp,
      channel: z.string().default(''),
      context: z
        .object({ replyParent: Post.nullable().optional(), recent: z.array(Post).optional(), truncated: z.boolean().optional() })
        .optional(),
      placeCandidates: z.array(z.object({ id: z.string(), name: z.string(), start: z.int(), end: z.int() })).default([]),
      relationCandidates: z.array(z.object({ id: z.string(), summary: z.string() })).default([]),
      expected: Label,
    }),
  ),
});
export type LabeledDataset = z.infer<typeof LabeledDataset>;

export type Prediction = {
  kind: ClaimKind | null;
  temporalScope: TemporalScope | null;
  placeId: string | null;
  relationId: string | null;
  decision: PublicationDecision;
};
export type EvalRecord = { expected: Label; predicted: Prediction };

export function computeMetrics(records: readonly EvalRecord[]) {
  const ratio = (population: (r: EvalRecord) => boolean, ok: (r: EvalRecord) => boolean) => {
    const pop = records.filter(population);
    return wilson(pop.filter(ok).length, pop.length);
  };
  const relevant = (r: EvalRecord) => RELEVANT_KINDS.has(r.expected.kind);
  // Published or sent to an operator; only an exclusion loses a relevant text.
  const caught = (r: EvalRecord) => r.predicted.decision !== 'exclude';
  return {
    /** Relevant texts not lost (published or sent to review). */
    relevantRecall: ratio(relevant, caught),
    relevantRecallCurrent: ratio((r) => relevant(r) && r.expected.kind !== 'aftermath', caught),
    relevantRecallAftermath: ratio((r) => r.expected.kind === 'aftermath', caught),
    /** Correct among auto-published: kind, and temporal scope when labelled. */
    publishedPrecision: ratio(
      (r) => r.predicted.decision === 'publish',
      ({ expected: e, predicted: p }) => p.kind === e.kind && (e.temporalScope === undefined || p.temporalScope === e.temporalScope),
    ),
    explicitPlaceAccuracy: ratio(
      (r) => r.expected.placeExplicit === true && r.expected.placeId != null,
      (r) => r.predicted.placeId === r.expected.placeId,
    ),
    /** Wrong links / all auto-links (labelled items only). */
    falseMergeRate: ratio(
      (r) => r.predicted.relationId !== null && r.expected.relationId !== undefined,
      (r) => r.predicted.relationId !== r.expected.relationId,
    ),
    /** Missed links / all labelled links. */
    falseSplitRate: ratio(
      (r) => r.expected.relationId != null,
      (r) => r.predicted.relationId === null,
    ),
    /** Relevant texts published without an operator: high precision with zero coverage is no success. */
    autoCoverage: ratio(relevant, (r) => r.predicted.decision === 'publish'),
    reviewShare: ratio(
      () => true,
      (r) => r.predicted.decision === 'review',
    ),
  };
}
export type EvalMetrics = ReturnType<typeof computeMetrics>;
