import { AGGREGATION_POLICY, type AggregationClaim, type AggregationPolicy, type Incident } from './incident';

/**
 * Comparison form for copy detection: case, emoji, punctuation and apostrophe variants go; words
 * (negations such as «не»), numbers and place names stay, so «вибухів не чути» never equals «вибухи чути».
 */
export const comparisonForm = (text: string): string =>
  text
    .replace(/[’‘ʼ`´]/g, "'") // before NFKC, which decomposes ´ into space + accent
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Key of a Telegram post link (t.me/<channel>/<post>, t.me/c/<id>/<post>, topic links), or null.
 * Other links (sites, donation jars, profiles, invites) are not evidence of one original post:
 * channel footers share them across unrelated posts.
 */
export function normalizeLink(link: string): string | null {
  try {
    const url = new URL(/^[a-z]+:\/\//i.test(link) ? link : `https://${link}`);
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    if (host !== 't.me' && host !== 'telegram.me') return null;
    const path = url.pathname.split('/').filter(Boolean);
    const rest = path[0] === 's' ? path.slice(1) : path;
    const [channel, post] = rest[0] === 'c' ? [`c/${rest[1]}`, rest.at(-1)] : [rest[0]?.toLowerCase(), rest.at(-1)];
    const valid = rest.length >= 2 && /^(c\/\d+|[a-z][a-z0-9_]{3,})$/.test(channel ?? '') && /^\d+$/.test(post ?? '');
    return valid ? `t.me/${channel}/${post}` : null;
  } catch {
    return null;
  }
}

export type OriginBasis = 'same_message' | 'text_copy' | 'shared_link' | 'new';

/**
 * Level-2 dedupe: a claim joins the origin group of an earlier report of the same message, an exact copy
 * of its text, or a post linking the same original Telegram post, within the copy window. A repost
 * therefore counts as one origin; this says nothing about the channels being independent.
 */
export function matchOrigin(
  claim: AggregationClaim,
  incidents: readonly Incident[],
  policy: AggregationPolicy = AGGREGATION_POLICY,
): { originGroup: string; originBasis: OriginBasis } {
  const form = comparisonForm(claim.text);
  const links = new Set((claim.links ?? []).flatMap((l) => normalizeLink(l) ?? []));
  const basisOf = (other: AggregationClaim): OriginBasis | null => {
    if (other.sourceId === claim.sourceId && other.messageExternalId === claim.messageExternalId) return 'same_message';
    if (Math.abs(other.publishedAt.getTime() - claim.publishedAt.getTime()) > policy.copyWindowMs) return null;
    if (form.length >= policy.minCopyChars && comparisonForm(other.text) === form) return 'text_copy';
    return (other.links ?? []).some((l) => links.has(normalizeLink(l) ?? '')) ? 'shared_link' : null;
  };
  let best: { originGroup: string; originBasis: OriginBasis; at: number } | undefined;
  for (const incident of incidents) {
    if (incident.mode !== claim.mode) continue;
    for (const e of incident.evidence) {
      const basis = e.active ? basisOf(e.claim) : null;
      const at = e.claim.publishedAt.getTime();
      if (basis && (!best || at < best.at)) best = { originGroup: e.originGroup, originBasis: basis, at };
    }
  }
  return best
    ? { originGroup: best.originGroup, originBasis: best.originBasis }
    : { originGroup: `${claim.sourceId}:${claim.messageExternalId}`, originBasis: 'new' };
}
