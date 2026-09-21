// GET /v1/situation: the Kremenchuk screen (SituationResponse). Placeholder; implemented by unit 2.
import type { ApiError } from '@aerial/contracts';
import type { FastifyPluginAsync } from 'fastify';

export const situationRoutes: FastifyPluginAsync = async (app) => {
  app.get('/situation', async (req, reply) =>
    reply.status(501).send({ code: 'not_implemented', requestId: req.id, message: 'Not implemented yet' } satisfies ApiError),
  );
};
