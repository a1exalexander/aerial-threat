import {
  AGGREGATION_POLICY,
  activeReports,
  byTime,
  isClosure,
  isOblastLevel,
  placeRelation,
  type AggregationClaim,
  type AggregationPolicy,
  type Incident,
  type IncidentEvidence,
} from './incident';
import { matchOrigin, type OriginBasis } from './origin';

export type CandidateReason =
  | 'same_place'
  | 'broader_narrower'
  | 'oblast_level_only'
  | 'assumed_place'
  | 'shared_origin'
  | 'reply_to_evidence'
  | 'threat_type_unknown'
  | 'closure_of_own_report';

export interface IncidentCandidate {
  incidentId: string;
  score: number;
  reasons: CandidateReason[];
  /** Same specific place (or a copy of a report already in it): safe to link without asking. */
  strong: boolean;
}

export interface CandidateSearch {
  originGroup: string;
  originBasis: OriginBasis;
  /** Compatible incidents, best first. */
  candidates: IncidentCandidate[];
  /** Link to these without asking: the only candidate when it is strong, or every episode a closure claim ends. */
  link: string[];
  /** Ask Jev `relation_candidate` over `candidates`; none/unknown or no answer means a new incident. */
  needsRelationQuestion: boolean;
}

type Territory = { score: number; reasons: CandidateReason[]; strong: boolean };

/** Best territorial match of `placeId` against the reports' places; null when none is compatible. */
function territory(claim: AggregationClaim, reports: IncidentEvidence[], closure: boolean): Territory | null {
  const placeId = claim.placeId;
  if (!placeId) return null;
  let best: Territory | null = null;
  for (const e of reports) {
    const other = e.claim.placeId;
    if (!other) continue;
    const rel = placeRelation(placeId, other);
    // A closure covers the reports of its own place or a narrower one; a narrower «відбій» ends nothing broader.
    if (rel === 'disjoint' || (closure && rel === 'narrower')) continue;
    const broadest = rel === 'narrower' ? other : placeId;
    const oblast = isOblastLevel(broadest);
    const assumed = claim.geoBasis === 'channel_default' || e.claim.geoBasis === 'channel_default';
    const reasons: CandidateReason[] = [rel === 'same' ? 'same_place' : 'broader_narrower'];
    if (oblast) reasons.push('oblast_level_only');
    if (assumed) reasons.push('assumed_place');
    // An assumed place ranks below the same explicit one, so it never hides a strong match.
    const score = (oblast ? 1 : rel === 'same' ? 3 : 2) - (assumed ? 0.5 : 0);
    const t = { score, reasons, strong: rel === 'same' && !oblast && !assumed };
    if (!best || t.score > best.score) best = t;
  }
  return best;
}

function rate(claim: AggregationClaim, originGroup: string, incident: Incident, policy: AggregationPolicy): IncidentCandidate | null {
  if (incident.mode !== claim.mode || incident.lifecycle === 'retracted') return null;
  const reports = activeReports(incident);
  const t = claim.publishedAt.getTime();
  const first = incident.firstSeenAt.getTime();
  const last = incident.lastEvidenceAt.getTime();
  const proximity = (window: number) => 1 - Math.min(Math.abs(t - last), window) / window;

  if (claim.kind === 'clear_claim') {
    // Ends only this channel's own open episode; other channels' reports stay as they are.
    if (incident.kind !== 'threat_report' && incident.kind !== 'alert_claim') return null;
    if (t < first || t > last + policy.archiveAfterMs) return null;
    const own = reports.filter((e) => e.claim.sourceId === claim.sourceId && e.claim.publishedAt <= claim.publishedAt);
    const geo = territory(claim, own, true);
    if (!geo) return null;
    return {
      incidentId: incident.id,
      score: geo.score + proximity(policy.archiveAfterMs),
      reasons: ['closure_of_own_report', ...geo.reasons],
      strong: true,
    };
  }

  if (claim.kind !== incident.kind || claim.kind === 'unknown' || claim.temporalScope === 'unknown') return null;
  if (!reports.some((e) => e.claim.temporalScope === claim.temporalScope)) return null;
  // The channel's own «відбій» ended its episode unless the channel reported again after it.
  const lastOwn = incident.evidence
    .filter((e) => e.active && e.claim.sourceId === claim.sourceId && e.claim.publishedAt <= claim.publishedAt)
    .sort(byTime)
    .at(-1);
  if (lastOwn && isClosure(incident, lastOwn)) return null;

  const historical = claim.kind === 'aftermath' || claim.temporalScope === 'past';
  const window = historical ? policy.historicalWindowMs : policy.currentWindowMs;
  if (t < first - window || t > last + window) return null;
  if (historical && claim.eventDate && reports.some((e) => e.claim.eventDate && e.claim.eventDate !== claim.eventDate)) return null;

  const types = reports.map((e) => e.claim.threatType);
  const exactType = claim.threatType !== 'unknown' && types.includes(claim.threatType);
  if (!exactType && claim.threatType !== 'unknown' && !types.includes('unknown')) return null;

  // Territory is required even for copies: a sibling claim of a multi-place post shares its origin, not its place.
  const geo = territory(claim, reports, false);
  if (!geo) return null;
  const reasons = [...geo.reasons];
  const sharedOrigin = reports.some((e) => e.originGroup === originGroup);
  if (sharedOrigin) reasons.push('shared_origin');
  // A reply is a strong hint, not an automatic merge: it may continue a fundraiser or an ad.
  const reply =
    claim.replyToMessageId != null &&
    reports.some((e) => e.claim.sourceId === claim.sourceId && e.claim.messageExternalId === claim.replyToMessageId);
  if (reply) reasons.push('reply_to_evidence');
  if (!exactType) reasons.push('threat_type_unknown');
  return {
    incidentId: incident.id,
    score: geo.score + (sharedOrigin ? 3 : 0) + (reply ? 2 : 0) + (exactType ? 0.5 : 0) + proximity(window),
    reasons,
    strong: geo.strong || sharedOrigin,
  };
}

/**
 * Bounded candidate search (level-3 dedupe): compatible territory, kind, temporal scope, threat type and
 * time window. Never links on an oblast plus «БпЛА» alone. Pass the not-retracted incidents of the claim's
 * mode whose evidence is within the longest window (24 h) of the claim. A claim already active in an
 * incident routes back to it (redelivery); withdraw a corrected claim first to route it afresh.
 */
export function findIncidentCandidates(
  claim: AggregationClaim,
  openIncidents: readonly Incident[],
  policy: AggregationPolicy = AGGREGATION_POLICY,
): CandidateSearch {
  const origin = matchOrigin(claim, openIncidents, policy);
  const holding = openIncidents.filter((i) => i.evidence.some((e) => e.active && e.claim.id === claim.id));
  if (holding.length) return { ...origin, candidates: [], link: holding.map((i) => i.id), needsRelationQuestion: false };
  const candidates = openIncidents
    .flatMap((i) => rate(claim, origin.originGroup, i, policy) ?? [])
    .sort((a, b) => b.score - a.score);
  if (claim.kind === 'clear_claim') {
    return { ...origin, candidates, link: candidates.map((c) => c.incidentId), needsRelationQuestion: false };
  }
  const only = candidates.length === 1 ? candidates[0] : undefined;
  const link = only?.strong ? [only.incidentId] : [];
  return { ...origin, candidates, link, needsRelationQuestion: candidates.length > 0 && link.length === 0 };
}

export interface Rate {
  numerator: number;
  denominator: number;
}

/**
 * Pairwise grouping errors against labelled groups (doc 09): false merges over predicted same-incident
 * pairs, false splits over labelled same-group pairs. Maps are claimId → incident/group ID; a labelled
 * claim missing from `predicted` was dropped and counts as a group of its own.
 */
export function groupingErrors(
  predicted: ReadonlyMap<string, string>,
  expected: ReadonlyMap<string, string>,
): { falseMerge: Rate; falseSplit: Rate } {
  const ids = [...expected.keys()];
  const group = (id: string) => predicted.get(id) ?? `dropped:${id}`;
  const falseMerge = { numerator: 0, denominator: 0 };
  const falseSplit = { numerator: 0, denominator: 0 };
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const [a, b] = [ids[i]!, ids[j]!];
      const together = group(a) === group(b);
      const labelled = expected.get(a) === expected.get(b);
      if (together) falseMerge.denominator++;
      if (together && !labelled) falseMerge.numerator++;
      if (labelled) falseSplit.denominator++;
      if (labelled && !together) falseSplit.numerator++;
    }
  }
  return { falseMerge, falseSplit };
}
