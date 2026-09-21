import {
  type AdminReviewResponse,
  type ApiError,
  ClaimReviewCommand,
  type Envelope,
  Id,
  IncidentMergeCommand,
  IncidentSplitCommand,
  MessageReprocessCommand,
  ReviewQuery,
  SourcePauseCommand,
} from '@aerial/contracts';
import {
  CommandError,
  type CommandErrorCode,
  mergeIncident,
  opsSnapshot,
  pauseSource,
  reprocessMessage,
  reviewClaim,
  reviewQueue,
  splitIncident,
} from '@aerial/db/repos/admin';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { authenticate, requireRole } from '../../auth/index';

const STATUS: Record<CommandErrorCode, number> = {
  not_found: 404,
  version_conflict: 409,
  idempotency_key_reused: 422,
  invalid_command: 422,
};

/** Parses with a contract schema; a failure is a 400 with the zod issues as the message. */
function parse<T>(schema: { parse(data: unknown): T }, data: unknown): T {
  try {
    return schema.parse(data);
  } catch (err) {
    const issues = (err as { issues?: { path: PropertyKey[]; message: string }[] }).issues ?? [];
    const message = issues.map((i) => `${i.path.map(String).join('.') || 'body'}: ${i.message}`).join('; ');
    throw Object.assign(new Error(message || 'Invalid request'), { statusCode: 400 });
  }
}

// Admin reads are computed live from the database on every request.
const envelope = <T>(data: T): Envelope<T> => ({
  data,
  generatedAt: new Date().toISOString(),
  projectionVersion: 'admin-v1',
  freshness: 'fresh',
});

/** Mounted at /v1/admin. Every route authenticates (bearer JWT) and checks its role server-side. */
export const adminRoutes: FastifyPluginAsync = async (app) => {
  app.decorateRequest('operator', null);
  app.addHook('onRequest', authenticate(app.env, app.log));
  app.setErrorHandler((err, req, reply) => {
    if (!(err instanceof CommandError)) throw err; // the app-level handler shapes everything else
    const body: ApiError = { code: err.code, requestId: req.id, message: err.message };
    return reply.status(STATUS[err.code]).send(body);
  });

  const viewer = { onRequest: requireRole('viewer') };
  const reviewer = { onRequest: requireRole('reviewer') };
  const admin = { onRequest: requireRole('admin') };
  const ctx = (req: FastifyRequest) => ({ actor: req.operator!.sub, requestId: req.id });
  const id = (req: FastifyRequest) => parse(Id, (req.params as { id?: unknown }).id).toLowerCase();

  app.get('/review', viewer, async (req): Promise<AdminReviewResponse> => {
    const { items, failedRuns } = await reviewQueue(app.db.db, parse(ReviewQuery, req.query));
    return { ...envelope(items), failedRuns };
  });
  app.get('/ops', viewer, async () => envelope(await opsSnapshot(app.db.db)));

  app.post('/claims/:id/review', reviewer, async (req) => reviewClaim(app.db.db, ctx(req), id(req), parse(ClaimReviewCommand, req.body)));
  app.post('/incidents/:id/merge', reviewer, async (req) =>
    mergeIncident(app.db.db, ctx(req), id(req), parse(IncidentMergeCommand, req.body)),
  );
  app.post('/incidents/:id/split', reviewer, async (req) =>
    splitIncident(app.db.db, ctx(req), id(req), parse(IncidentSplitCommand, req.body)),
  );
  app.post('/messages/:id/reprocess', reviewer, async (req) =>
    reprocessMessage(app.db.db, ctx(req), id(req), parse(MessageReprocessCommand, req.body)),
  );
  app.post('/sources/:id/pause', admin, async (req) => pauseSource(app.db.db, ctx(req), id(req), parse(SourcePauseCommand, req.body)));
};
