import { createHash } from 'node:crypto';
import { POLICY, type ClaimsPolicy } from './policy';

/** The fields context selection needs; callers pass their own post objects and get them back. */
export interface ContextPost {
  sourceExternalId: string;
  externalMessageId: string;
  /** UTC ISO instant. */
  publishedAt: string;
  replyToExternalId: string | null;
  /** The revision used as context; immutable, so it pins the content in the context hash. */
  revisionId: string;
}

export interface ContextSelection<T extends ContextPost> {
  replyParent: T | null;
  /** Prior same-channel posts inside the window, oldest first. */
  prior: T[];
  /** The message replies to a post that is not available. */
  missingContext: boolean;
  /** More prior posts were eligible than the policy allows. */
  truncated: boolean;
  truncatedReason: 'max_prior_posts' | null;
  /** sha256 over the policy version and the selected revisions; part of the processing key. */
  contextHash: string;
  policyVersion: string;
}

/**
 * Bounded context for one message: its reply parent and at most `maxPriorPosts` posts of the same
 * channel published within `contextWindowMs` before it. Posts published after the message (or after
 * `now`, the virtual clock in replay) are never used. To detect truncation, pass every post of the
 * window, one entry per message.
 */
export function selectContext<T extends ContextPost>({
  message,
  candidates,
  now,
  policy = POLICY,
}: {
  message: ContextPost;
  candidates: readonly T[];
  now: Date;
  policy?: ClaimsPolicy;
}): ContextSelection<T> {
  const at = (p: ContextPost) => Date.parse(p.publishedAt);
  // Telegram IDs grow within a channel, so they order posts that share a timestamp.
  const order = (a: ContextPost, b: ContextPost) => at(a) - at(b) || Number(BigInt(a.externalMessageId) - BigInt(b.externalMessageId));
  const earlier = candidates.filter(
    (p) => p.sourceExternalId === message.sourceExternalId && order(p, message) < 0 && at(p) <= now.getTime(),
  );

  const replyParent = earlier.find((p) => message.replyToExternalId !== null && p.externalMessageId === message.replyToExternalId) ?? null;
  const eligible = earlier
    .filter((p) => p !== replyParent && at(p) >= at(message) - policy.contextWindowMs)
    .sort((a, b) => order(b, a));
  const prior = eligible.slice(0, policy.maxPriorPosts).reverse();
  const missingContext = message.replyToExternalId !== null && replyParent === null;
  const truncated = eligible.length > prior.length;

  const contextHash = createHash('sha256')
    .update(JSON.stringify([policy.version, message.revisionId, replyParent?.revisionId ?? null, missingContext, prior.map((p) => p.revisionId), truncated]))
    .digest('hex');
  return { replyParent, prior, missingContext, truncated, truncatedReason: truncated ? 'max_prior_posts' : null, contextHash, policyVersion: policy.version };
}
