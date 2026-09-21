// Response helpers shared by the public /v1 routes.
import { createHash } from 'node:crypto';
import type { Envelope, Freshness } from '@aerial/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';

export const httpError = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });

/**
 * Validates the envelope against the contract, derives projectionVersion from its content (not from
 * generatedAt) and answers If-None-Match with 304 when the client already has this version.
 */
export function send<T>(
  req: FastifyRequest,
  reply: FastifyReply,
  schema: { parse(v: unknown): Envelope<T> },
  body: { data: T; freshness: Freshness; nextCursor?: string | null },
  now: Date,
) {
  const out = schema.parse({ ...body, generatedAt: now.toISOString(), projectionVersion: '-' });
  out.projectionVersion = createHash('sha256')
    .update(JSON.stringify([out.data, out.freshness, out.nextCursor ?? null]))
    .digest('base64url')
    .slice(0, 22);
  reply.header('etag', `W/"${out.projectionVersion}"`).header('cache-control', 'no-cache');
  const known = req.headers['if-none-match']?.split(',').map((t) => t.trim().replace(/^W\//, ''));
  if (known?.some((t) => t === '*' || t === `"${out.projectionVersion}"`)) return reply.code(304).send();
  return out;
}
