// Situation rules: free statuses over a window of Kremenchuk posts, plus the noise filter. Pure, no I/O.
// Placeholder bodies; implemented by unit 5.
import type { SituationStatuses } from '@aerial/contracts';

/** Bump whenever a rule changes; stored in situation_snapshots.rules_version. */
export const SITUATION_RULES_VERSION = 'situation-rules-v0';

/** One post of the evaluated window. IDs are strings: revision/source UUIDs, Telegram message ID as decimal. */
export type SituationMessage = {
  revisionId: string;
  sourceId: string;
  sourceName: string;
  messageId: string;
  publishedAt: Date;
  text: string;
  replyToText: string | null;
  /** Rule-extracted places (@aerial/geo/match PlaceCandidate) when the caller has them. */
  placeCandidates?: unknown[];
};

/** Ads, job posts, fundraising, chit-chat without threat terms. */
export function isNoise(_text: string): boolean {
  return false;
}

const low = <T>(value: T) => ({ value, confidence: 'low' as const, evidenceMessageIds: [] });

/** Statuses of the window at `now` and the revisions worth showing in the feed. */
export function rulesSituation(msgs: SituationMessage[], _now: Date): { statuses: SituationStatuses; relevantRevisionIds: string[] } {
  return {
    statuses: {
      threatNow: low(false),
      threatType: low('unknown'),
      direction: low('unknown'),
      quantity: low('unknown'),
      forecast: low('none'),
      explosions: low(false),
      airDefense: low(false),
    },
    relevantRevisionIds: msgs.map((m) => m.revisionId),
  };
}
