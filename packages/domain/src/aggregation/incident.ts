import type { Claim, ClaimKind, EvidenceRelation, IncidentLifecycle, MessageMode, ThreatType } from '@aerial/contracts';
import { ancestors, byId } from '@aerial/geo';

const MIN = 60_000;

/** Versioned time/linking policy (doc 06). The numbers are starting hypotheses, calibrated on labelled data. */
export const AGGREGATION_POLICY = {
  version: 'aggregation-v1',
  /** Link window for current/future reports. */
  currentWindowMs: 15 * MIN,
  /** Link window for aftermath and past-scope reports (plus the mentioned event date). */
  historicalWindowMs: 24 * 60 * MIN,
  staleAfterMs: 15 * MIN,
  archiveAfterMs: 60 * MIN,
  /** Content copies (level-2 dedupe) must be published within this interval of each other. */
  copyWindowMs: 3 * 60 * MIN,
  /** Shorter texts («Відбій», «БпЛА на Кременчук») repeat independently, so an exact match is not a copy. */
  minCopyChars: 40,
};
export type AggregationPolicy = typeof AGGREGATION_POLICY;

/** A claim plus the message facts aggregation needs. */
export interface AggregationClaim extends Claim {
  /** Our sources.id. */
  sourceId: string;
  messageExternalId: string;
  /** Publication (event) time, never received time: a delayed delivery must not look fresh. */
  publishedAt: Date;
  mode: MessageMode;
  /** Revision cleanedText (channel footers removed); only used to detect copies. */
  text: string;
  /** Link targets of the message: visible URLs and hidden text-link hrefs. */
  links?: string[];
  /** Same-channel reply parent (Telegram replies stay inside a channel). */
  replyToMessageId?: string | null;
  /** Event date named in the text (YYYY-MM-DD, Europe/Kyiv); aftermath reports only link on the same date. */
  eventDate?: string | null;
}

export interface IncidentEvidence {
  claim: AggregationClaim;
  relation: EvidenceRelation;
  originGroup: string;
  /** Why the claim was linked; withdraw/merge/split append to it, so the original reason survives. */
  reason: string;
  active: boolean;
}

/** A group of reports about a similar situation, not the identity of a physical drone or missile. */
export interface Incident {
  id: string;
  kind: ClaimKind;
  mode: MessageMode;
  /** Optimistic concurrency: every change returns revision + 1. */
  revision: number;
  policyVersion: string;
  evidence: IncidentEvidence[];
  // Everything below is derived from active evidence and the injected clock by every operation.
  lifecycle: IncidentLifecycle;
  areaId: string | null;
  threatTypes: ThreatType[];
  firstSeenAt: Date;
  lastEvidenceAt: Date;
  hasConflict: boolean;
  closureClaimId: string | null;
  sourceCount: number;
  /** Reposts and copies of one post count once. */
  originGroupCount: number;
  /** Aggregation never establishes that channels are independent: several channels are always 'unknown'. */
  independence: 'single_source' | 'unknown';
}

export interface LinkDecision {
  /** Audit reason, e.g. `auto: same_place` or `relation_candidate`. */
  reason: string;
  originGroup: string;
  /** ID of the incident to create; required when `incident` is null. */
  newIncidentId?: string;
}

const AGGREGATED_KINDS = new Set<ClaimKind>(['threat_report', 'alert_claim', 'clear_claim', 'aftermath', 'unknown']);

/** Excluded and off-topic claims stay in the operator journal; uncertain (`review`) ones are aggregated as candidates. */
export const isAggregatable = (c: Claim): boolean =>
  c.active && c.publicationDecision !== 'exclude' && AGGREGATED_KINDS.has(c.kind);

export type PlaceRelation = 'same' | 'broader' | 'narrower' | 'disjoint';

/** How place `a` relates to `b`: «Полтавщина» is broader than Полтава, never the same place. */
export function placeRelation(a: string, b: string): PlaceRelation {
  if (a === b) return 'same';
  if (ancestors(b).some((p) => p.id === a)) return 'broader';
  if (ancestors(a).some((p) => p.id === b)) return 'narrower';
  return 'disjoint';
}

const disjoint = (a: string | null, b: string | null) => a !== null && b !== null && placeRelation(a, b) === 'disjoint';

/** Unknown IDs count as broad: they never make a link strong. */
export const isOblastLevel = (placeId: string): boolean => (byId(placeId)?.level ?? 'oblast') === 'oblast';

/** A channel's «відбій» linked to another kind of incident is closure evidence, not a report. */
export const isClosure = (incident: Pick<Incident, 'kind'>, e: IncidentEvidence): boolean =>
  e.claim.kind === 'clear_claim' && incident.kind !== 'clear_claim';

export const byTime = (a: IncidentEvidence, b: IncidentEvidence): number =>
  a.claim.publishedAt.getTime() - b.claim.publishedAt.getTime() || a.claim.id.localeCompare(b.claim.id);

/** Active non-closure evidence, oldest first. */
export const activeReports = (incident: Pick<Incident, 'kind' | 'evidence'>): IncidentEvidence[] =>
  incident.evidence.filter((e) => e.active && !isClosure(incident, e)).sort(byTime);

/** Active closures not followed by a newer report of the same channel (which reopens its episode). */
export function activeClosures(incident: Pick<Incident, 'kind' | 'evidence'>): IncidentEvidence[] {
  const reports = activeReports(incident);
  return incident.evidence
    .filter((c) => c.active && isClosure(incident, c))
    .filter((c) => !reports.some((r) => r.claim.sourceId === c.claim.sourceId && r.claim.publishedAt > c.claim.publishedAt))
    .sort(byTime);
}

/** The latest report of each source: a channel's update replaces its own earlier values. */
export const latestPerSource = (reports: IncidentEvidence[]): IncidentEvidence[] => [
  ...new Map([...reports].sort(byTime).map((e) => [e.claim.sourceId, e])).values(),
];

/**
 * Cross-channel disagreements, kept as variants (never averaged or summed): `counts` is each channel's
 * latest stated quantity, `quantity` those counts when they differ, `place` the reports naming a place
 * disjoint from another channel's.
 */
export function disagreements(reports: IncidentEvidence[]) {
  const counts = latestPerSource(reports.filter((e) => e.claim.quantity !== null));
  const quantity = new Set(counts.map((e) => e.claim.quantity)).size > 1 ? counts : [];
  const place = reports.filter((a) =>
    reports.some((b) => a.claim.sourceId !== b.claim.sourceId && disjoint(a.claim.placeId, b.claim.placeId)),
  );
  return { counts, quantity, place };
}

/** The most specific place when all named places nest; with disjoint places, the first one named. */
function areaOf(reports: IncidentEvidence[]): string | null {
  const places = [...new Set(reports.flatMap((e) => e.claim.placeId ?? []))];
  if (places.some((a) => places.some((b) => disjoint(a, b)))) return places[0] ?? null;
  return places.sort((a, b) => ancestors(b).length - ancestors(a).length)[0] ?? null;
}

const isHistorical = (incident: Incident, reports: IncidentEvidence[]) =>
  incident.kind === 'aftermath' || reports.every((e) => e.claim.temporalScope === 'past');

/**
 * TTL only moves an incident to stale/archived. A closure claim or silence never yields anything like
 * «загрози немає». Age counts from publication time, so a late delivery of an old post is not fresh.
 */
export function lifecycleAt(incident: Incident, now: Date, policy: AggregationPolicy = AGGREGATION_POLICY): IncidentLifecycle {
  const reports = activeReports(incident);
  if (reports.length === 0) return 'retracted';
  const age = now.getTime() - incident.lastEvidenceAt.getTime();
  if (age >= policy.archiveAfterMs) return 'archived';
  if (!reports.some((e) => e.claim.publicationDecision === 'publish')) return 'candidate';
  if (isHistorical(incident, reports)) return 'archived';
  return age >= policy.staleAfterMs ? 'stale' : 'reported';
}

function derive(base: Incident, now: Date, policy: AggregationPolicy): Incident {
  const reports = activeReports(base);
  const primary = reports[0];
  const { quantity, place } = disagreements(reports);
  const conflicting = new Set([...quantity, ...place]);
  const relationOf = (e: IncidentEvidence): EvidenceRelation => {
    if (isClosure(base, e)) return 'closure';
    if (e === primary) return 'primary';
    return conflicting.has(e) ? 'conflicting' : 'supporting';
  };
  const types = [...new Set(reports.map((e) => e.claim.threatType))];
  const times = reports.map((e) => e.claim.publishedAt.getTime());
  const sources = new Set(reports.map((e) => e.claim.sourceId)).size;
  const next: Incident = {
    ...base,
    policyVersion: policy.version,
    evidence: base.evidence.map((e) => (e.active ? { ...e, relation: relationOf(e) } : e)),
    areaId: areaOf(reports),
    threatTypes: types.length > 1 ? types.filter((t) => t !== 'unknown') : types,
    firstSeenAt: times.length ? new Date(Math.min(...times)) : base.firstSeenAt,
    lastEvidenceAt: times.length ? new Date(Math.max(...times)) : base.lastEvidenceAt,
    hasConflict: conflicting.size > 0,
    closureClaimId: (base.kind === 'clear_claim' ? reports : activeClosures(base)).at(-1)?.claim.id ?? null,
    sourceCount: sources,
    originGroupCount: new Set(reports.map((e) => e.originGroup)).size,
    independence: sources > 1 ? 'unknown' : 'single_source',
  };
  return { ...next, lifecycle: lifecycleAt(next, now, policy) };
}

function create(id: string, kind: ClaimKind, mode: MessageMode, evidence: IncidentEvidence[], now: Date, policy: AggregationPolicy) {
  const t = evidence[0]?.claim.publishedAt ?? now;
  return derive(
    {
      id,
      kind,
      mode,
      revision: 1,
      policyVersion: policy.version,
      evidence,
      lifecycle: 'candidate',
      areaId: null,
      threatTypes: [],
      firstSeenAt: t,
      lastEvidenceAt: t,
      hasConflict: false,
      closureClaimId: null,
      sourceCount: 0,
      originGroupCount: 0,
      independence: 'single_source',
    },
    now,
    policy,
  );
}

const note = (e: IncidentEvidence, reason: string): IncidentEvidence => ({ ...e, reason: `${e.reason}; ${reason}` });

/**
 * Links a claim to `incident`, or creates a new incident when it is null (a claim without a confident
 * link is never dropped). Level-1 dedupe: re-applying a claim ID at the same or an older version is a
 * no-op, also after it was withdrawn; a newer version replaces it. Withdraw claims superseded by an
 * edit or a reprocess run (withdrawClaims) before applying their successors.
 */
export function applyClaim(
  incident: Incident | null,
  claim: AggregationClaim,
  decision: LinkDecision,
  now: Date,
  policy: AggregationPolicy = AGGREGATION_POLICY,
): Incident {
  const link = (reason: string): IncidentEvidence => ({
    claim,
    relation: 'supporting',
    originGroup: decision.originGroup,
    reason,
    active: claim.active,
  });
  if (!incident) {
    if (!decision.newIncidentId) throw new Error('newIncidentId is required to create an incident');
    return create(decision.newIncidentId, claim.kind, claim.mode, [link(decision.reason)], now, policy);
  }
  if (incident.mode !== claim.mode) throw new Error('archive and live evidence never share an incident');
  const existing = incident.evidence.find((e) => e.claim.id === claim.id);
  if (existing && existing.claim.version >= claim.version) return incident;
  const evidence = [...incident.evidence.filter((e) => e !== existing), link(existing ? `${existing.reason}; ${decision.reason}` : decision.reason)];
  return derive({ ...incident, revision: incident.revision + 1, evidence }, now, policy);
}

/** Edits, deletions and operator exclusions: the evidence stays for audit, only its contribution goes. */
export function withdrawClaims(
  incident: Incident,
  claimIds: Iterable<string>,
  reason: string,
  now: Date,
  policy: AggregationPolicy = AGGREGATION_POLICY,
): Incident {
  const ids = new Set(claimIds);
  const hit = (e: IncidentEvidence) => e.active && ids.has(e.claim.id);
  if (!incident.evidence.some(hit)) return incident;
  const evidence = incident.evidence.map((e) => (hit(e) ? { ...note(e, `withdrawn: ${reason}`), active: false } : e));
  return derive({ ...incident, revision: incident.revision + 1, evidence }, now, policy);
}

/**
 * Operator merge: `source`'s active evidence moves to `target` with its reasons kept; `source` keeps it
 * inactive. Kinds must match, except that a «відбій» incident may join as closure evidence.
 */
export function mergeIncidents(
  target: Incident,
  source: Incident,
  reason: string,
  now: Date,
  policy: AggregationPolicy = AGGREGATION_POLICY,
): { target: Incident; source: Incident } {
  if (target.id === source.id) throw new Error('cannot merge an incident into itself');
  if (target.mode !== source.mode) throw new Error('archive and live incidents never merge');
  if (target.kind !== source.kind && source.kind !== 'clear_claim') throw new Error(`cannot merge ${source.kind} into ${target.kind}`);
  const moved = source.evidence
    .filter((e) => e.active)
    .map((e) => {
      // One evidence row per claim and incident: an earlier (inactive) row in the target keeps its history.
      const earlier = target.evidence.find((t) => t.claim.id === e.claim.id);
      return { ...e, reason: `${earlier ? `${earlier.reason}; ` : ''}${e.reason}; merged from ${source.id}: ${reason}` };
    });
  const ids = new Set(moved.map((e) => e.claim.id));
  const evidence = [...target.evidence.filter((e) => !ids.has(e.claim.id)), ...moved];
  return {
    target: derive({ ...target, revision: target.revision + 1, evidence }, now, policy),
    source: withdrawClaims(source, ids, `merged into ${target.id}: ${reason}`, now, policy),
  };
}

/** Operator split: the chosen claims move to a new incident; the original keeps them inactive for audit. */
export function splitIncident(
  incident: Incident,
  claimIds: Iterable<string>,
  newIncidentId: string,
  reason: string,
  now: Date,
  policy: AggregationPolicy = AGGREGATION_POLICY,
): { original: Incident; split: Incident } {
  const ids = new Set(claimIds);
  const moved = incident.evidence
    .filter((e) => e.active && ids.has(e.claim.id))
    .sort(byTime)
    .map((e) => note(e, `split from ${incident.id}: ${reason}`));
  if (moved.length === 0) throw new Error('none of the claims is active evidence of this incident');
  const kind = moved.find((e) => e.claim.kind !== 'clear_claim')?.claim.kind ?? 'clear_claim';
  return {
    original: withdrawClaims(incident, ids, `split into ${newIncidentId}: ${reason}`, now, policy),
    split: create(newIncidentId, kind, incident.mode, moved, now, policy),
  };
}

/** TTL sweep with an injected (possibly virtual) clock; returns the same object when nothing changed. */
export function refreshLifecycle(incident: Incident, now: Date, policy: AggregationPolicy = AGGREGATION_POLICY): Incident {
  const lifecycle = lifecycleAt(incident, now, policy);
  return lifecycle === incident.lifecycle ? incident : { ...incident, lifecycle, revision: incident.revision + 1 };
}
