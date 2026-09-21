// Server-only (node:crypto): import via `@aerial/contracts/hash`, never from the web app.
import { createHash } from 'node:crypto';
import type { NormalizedMessage } from './domain';

export type RevisionHashInput = Pick<NormalizedMessage, 'rawText' | 'replyToExternalId' | 'mediaFlags'>;

/**
 * Stable sha256 over the meaningful content of a message revision: text (for media posts the
 * caption is the text), reply target and media kinds. Reactions, views and any other payload
 * field are deliberately not part of the input, so they never create a new revision.
 */
export function computeRevisionHash({ rawText, replyToExternalId, mediaFlags }: RevisionHashInput): string {
  const text = rawText.normalize('NFC').replace(/\r\n?/g, '\n');
  const content = JSON.stringify(['v1', text, replyToExternalId, [...new Set(mediaFlags)].sort()]);
  return createHash('sha256').update(content).digest('hex');
}
