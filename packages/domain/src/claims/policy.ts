import {
  ClaimKind,
  type Assessment,
  type GeoBasis,
  type PublicationDecision,
  type Uncertainty,
} from '@aerial/contracts';
import type { ClaimFragment } from './extract';

type Reason<K extends keyof Uncertainty> = Uncertainty[K][number];

/** Versioned policy parameters; the version is part of the processing key (`policy_version`). */
export interface ClaimsPolicy {
  version: string;
  /** Context: prior same-channel posts at most this old, and at most this many of them. */
  contextWindowMs: number;
  maxPriorPosts: number;
  /** Starting hypothesis, to be calibrated on labelled development/validation data per class. */
  defaultThreshold: number;
  thresholds: Partial<Record<ClaimKind, number>>;
  /** Required gap between the top class and the runner-up. */
  minMargin: number;
  /** A boolean question counts as «yes» above this probability. */
  booleanCutoff: number;
}

export const POLICY_VERSION = 'claims-policy-v1';
export const POLICY: Readonly<ClaimsPolicy> = Object.freeze({
  version: POLICY_VERSION,
  contextWindowMs: 15 * 60_000,
  maxPriorPosts: 5,
  defaultThreshold: 0.9,
  thresholds: {},
  minMargin: 0.2,
  booleanCutoff: 0.5,
});

/** What a decision rests on, for the operator's review queue and journal. */
export type DecisionReason =
  | 'no_kind_assessment'
  | 'unknown_kind'
  | 'below_threshold'
  | 'small_margin'
  | 'missing_evidence'
  | 'uncertain_threat_type'
  | 'unresolved_geo'
  | 'conflict'
  | 'multi_claim_unsplit'
  | 'missing_context'
  | 'future_time'
  | 'past_time'
  | 'suspected_prompt_injection'
  | 'excluded_kind';

export interface DecisionInput {
  /** Jev answers for this fragment (question names from doc 05). */
  assessments: Assessment[];
  /** The fragment and its rule candidates: the only admissible evidence. */
  evidence: ClaimFragment;
  geoBasis: GeoBasis;
  /** Extra reasons from the geo matcher (ambiguous_place, direction_only, …). */
  geoUncertainty?: Reason<'geo'>[];
  /** The split this fragment came from (a ClaimExtraction fits). */
  multiClaim: { needsReview: boolean };
  /** A conflict found outside this fragment (context, other sources). */
  conflict: boolean;
  context?: { missingContext: boolean; truncated: boolean };
}

/**
 * The decision about one claim. Deliberately carries no alert state: nothing here can change a
 * NEPTUN alert. A published clear_claim yields only the `closureClaim` hint for the incident.
 */
export interface PublicationOutcome {
  decision: PublicationDecision;
  kind: ClaimKind;
  reasons: DecisionReason[];
  uncertainty: Uncertainty;
  closureClaim: boolean;
  policyVersion: string;
}

/** Kinds about the present; aftermath is historical by definition. */
const CURRENT = new Set<ClaimKind>(['threat_report', 'alert_claim', 'clear_claim']);
const RELEVANT = new Set<ClaimKind>([...CURRENT, 'aftermath']);
const EXCLUDABLE = new Set<ClaimKind>(['advertisement', 'fundraising', 'background_news', 'other']);
/** Option names of the doc 05 question set that differ from the contract enum. */
const KIND_ALIASES: Record<string, ClaimKind> = { news: 'background_news', ad: 'advertisement' };

function ranked(assessments: Assessment[], question: string): { top: string; score: number; margin: number } | null {
  const a = assessments.find((x) => x.type === 'choice' && x.question === question);
  if (a?.type !== 'choice') return null;
  const [first, second] = Object.entries(a.probabilities).sort((x, y) => y[1] - x[1]);
  return { top: first?.[0] ?? a.selected, score: first?.[1] ?? 0, margin: (first?.[1] ?? 0) - (second?.[1] ?? 0) };
}

function yes(assessments: Assessment[], question: string, cutoff: number): boolean {
  const a = assessments.find((x) => x.type === 'boolean' && x.question === question);
  return a?.type === 'boolean' && a.probability > cutoff;
}

/**
 * publish: top class ≥ its threshold, margin ≥ minMargin, required evidence present, place resolved,
 * no conflict/unsplit multi-claim/injection. exclude: confident ad/fundraising/news/other.
 * Everything else goes to review; uncertainty keeps separate time/geo/classification reasons.
 */
export function decidePublication(input: DecisionInput, policy: ClaimsPolicy = POLICY): PublicationOutcome {
  const { assessments, evidence, geoBasis, multiClaim, conflict, context } = input;
  const c = evidence.candidates;
  const reasons = new Set<DecisionReason>();
  const time = new Set<Reason<'time'>>();
  const geo = new Set<Reason<'geo'>>(input.geoUncertainty);
  const cls = new Set<Reason<'classification'>>();

  const kindRank = ranked(assessments, 'message_kind');
  const kind = ClaimKind.safeParse(KIND_ALIASES[kindRank?.top ?? ''] ?? kindRank?.top).data ?? 'unknown';
  if (!kindRank) reasons.add('no_kind_assessment');
  const score = kindRank?.score ?? 0;
  const margin = kindRank?.margin ?? 0;
  if (score < (policy.thresholds[kind] ?? policy.defaultThreshold)) cls.add('low_score');
  if (margin < policy.minMargin) cls.add('small_margin');
  const confident = kindRank !== null && !cls.has('low_score') && !cls.has('small_margin');
  if (cls.has('low_score')) reasons.add('below_threshold');
  if (cls.has('small_margin')) reasons.add('small_margin');

  // Assessments are per fragment: «several claims» from Jev means this fragment is still unsplit.
  const jevMulti = yes(assessments, 'contains_multiple_claims', policy.booleanCutoff);
  if (multiClaim.needsReview || jevMulti) {
    cls.add('multiple_claims');
    reasons.add('multi_claim_unsplit');
  }
  if (c.tentative.length > 0 || yes(assessments, 'is_tentative', policy.booleanCutoff)) cls.add('tentative_language');
  const needsContext = yes(assessments, 'needs_context', policy.booleanCutoff);
  if (context?.missingContext) cls.add('missing_context');
  else if (needsContext) cls.add('needs_context');
  if (context?.missingContext && needsContext) reasons.add('missing_context');
  if (context?.truncated) cls.add('context_truncated');
  if (conflict || evidence.conflict) {
    cls.add('conflicting_context');
    reasons.add('conflict');
  }
  if (c.injections.length > 0) {
    cls.add('suspected_prompt_injection');
    reasons.add('suspected_prompt_injection');
  }

  // publishedAt is not the event time: a current kind about another time is inconsistent.
  const scope = ranked(assessments, 'temporal_scope')?.top;
  if (c.times.length === 0) time.add('no_explicit_time');
  if (c.times.some((t) => t.kind === 'relative')) time.add('relative_time');
  if (c.times.some((t) => t.future || t.past)) time.add('event_time_differs_from_published');
  if (RELEVANT.has(kind) && (scope === 'future' || c.times.some((t) => t.future))) reasons.add('future_time');
  if (CURRENT.has(kind) && (scope === 'past' || (c.times.length > 0 && c.times.every((t) => t.past)))) reasons.add('past_time');

  if (geoBasis === 'reply_context') geo.add('from_reply_context');
  if (geoBasis === 'channel_default') geo.add('from_channel_default');
  if (geoBasis === 'unresolved' && geo.size === 0) geo.add('no_place_mention');

  let decision: PublicationDecision = 'review';
  if (!kindRank || reasons.has('suspected_prompt_injection')) {
    // No classification, or an instruction aimed at the model: never an automatic outcome.
  } else if (EXCLUDABLE.has(kind)) {
    // Only Jev's multi-claim signal blocks exclusion; two weapon words in a fundraising post do not.
    if (confident && !jevMulti) {
      decision = 'exclude';
      reasons.clear();
      reasons.add('excluded_kind');
    }
  } else if (!RELEVANT.has(kind)) {
    reasons.add('unknown_kind');
  } else {
    // Every public factual field needs a literal span: a type only from its own non-negated term,
    // a closure only from non-negated closure wording. A named type must also be a confident answer.
    const type = ranked(assessments, 'threat_type');
    const typed = !type || type.top === 'unknown' || c.threats.some((t) => t.threatType === type.top && !t.negated);
    if (evidence.spans.length === 0 || !typed || (kind === 'clear_claim' && c.closures.length === 0)) reasons.add('missing_evidence');
    if (type && type.top !== 'unknown' && (type.score < policy.defaultThreshold || type.margin < policy.minMargin)) {
      reasons.add('uncertain_threat_type');
    }
    if (geoBasis === 'unresolved') reasons.add('unresolved_geo');
    if (reasons.size === 0) decision = 'publish';
  }

  return {
    decision,
    kind,
    reasons: [...reasons],
    uncertainty: { time: [...time], geo: [...geo], classification: [...cls] },
    closureClaim: kind === 'clear_claim' && decision === 'publish',
    policyVersion: policy.version,
  };
}

/** A place mention from the geo matcher: `placeId` null when the matcher could not pick exactly one place. */
export interface PlaceMention {
  placeId: string | null;
  /** «у напрямку Кременчука»: a heading, not a location. */
  direction: boolean;
}

/**
 * Place priority (doc 06): an unambiguous explicit place in the text, then the reply parent's place,
 * then the channel default as an assumption (no pin), else unresolved. Ambiguous or several explicit
 * places are never resolved silently.
 */
export function resolvePlace(input: {
  explicit: PlaceMention[];
  replyParent: PlaceMention[] | null;
  channelDefault: string | null;
}): { placeId: string | null; geoBasis: GeoBasis; geoUncertainty: Reason<'geo'>[] } {
  const reasons: Reason<'geo'>[] = [];
  const locate = (mentions: PlaceMention[]) => {
    const places = mentions.filter((m) => !m.direction);
    const ids = new Set(places.map((m) => m.placeId));
    return { places, only: ids.size === 1 ? ([...ids][0] ?? null) : null };
  };

  const own = locate(input.explicit);
  if (own.only) return { placeId: own.only, geoBasis: 'explicit', geoUncertainty: reasons };
  if (own.places.length > 0) return { placeId: null, geoBasis: 'unresolved', geoUncertainty: ['ambiguous_place'] };
  if (input.explicit.length > 0) reasons.push('direction_only');

  const parent = input.replyParent ? locate(input.replyParent) : null;
  if (parent?.only) return { placeId: parent.only, geoBasis: 'reply_context', geoUncertainty: [...reasons, 'from_reply_context'] };
  if (input.channelDefault) {
    return { placeId: input.channelDefault, geoBasis: 'channel_default', geoUncertainty: [...reasons, 'from_channel_default'] };
  }
  return { placeId: null, geoBasis: 'unresolved', geoUncertainty: reasons.length > 0 ? reasons : ['no_place_mention'] };
}
