import type { FastifyPluginAsync } from 'fastify';

/** Mounted at /v1/admin. Owned by the operator API unit; every route here must authenticate. */
export const adminRoutes: FastifyPluginAsync = async () => {};
