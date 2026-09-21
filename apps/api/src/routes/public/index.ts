import { createHash } from 'node:crypto';
import {
  AlertStateDto,
  AlertsQuery,
  AreaDto,
  AreasQuery,
  type Envelope,
  type Freshness,
  Id,
  IncidentDetail,
  IncidentListItem,
  IncidentsQuery,
  Overview,
  OverviewQuery,
  SourceDto,
  Timestamp,
  envelope,
} from '@aerial/contracts';
import {
  type IncidentKey,
  feedFreshness,
  getIncident,
  listAlerts,
  listIncidents,
  listSources,
  readOverview,
  readSnapshot,
  sourcesFreshness,
  worstFreshness,
} from '@aerial/db/repos/read';
import { PLACES, byId } from '@aerial/geo';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';

/** Longest from..to window of one /v1/incidents query. */
export const MAX_RANGE_MS = 31 * 24 * 3600_000;

const pages = {
  overview: envelope(Overview),
  incidents: envelope(IncidentListItem.array()),
  incident: envelope(IncidentDetail),
  alerts: envelope(AlertStateDto.array()),
  areas: envelope(AreaDto.array()),
  sources: envelope(SourceDto.array()),
};

const httpError = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });

type SafeParser<T> = {
  safeParse(v: unknown): { success: true; data: T } | { success: false; error: { issues: { path: PropertyKey[] }[] } };
};
function parseQuery<T>(schema: SafeParser<T>, query: unknown): T {
  const r = schema.safeParse(query);
  if (r.success) return r.data;
  throw httpError(400, `Invalid query parameter: ${[...new Set(r.error.issues.map((i) => String(i.path[0])))].join(', ')}`);
}

function knownArea(id: string | undefined): string | null {
  if (id === undefined) return null;
  if (!byId(id)) throw httpError(400, 'Unknown area');
  return id;
}

/** A contract-valid instant inside the range Postgres and JS agree on; anything else is a 400, not a DB error. */
function instant(value: string): Date {
  const d = new Date(value);
  const year = d.getUTCFullYear();
  if (!(year >= 1970 && year <= 9999)) throw httpError(400, 'Timestamp out of range');
  return d;
}

const encodeCursor = (k: IncidentKey) => Buffer.from(JSON.stringify([k.t, k.id])).toString('base64url');
function decodeCursor(cursor: string): IncidentKey {
  try {
    const [t, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown[];
    if (Timestamp.safeParse(t).success && Id.safeParse(id).success && instant(t as string)) return { t: t as string, id: id as string };
  } catch {
    // fall through: any undecodable cursor is the client's error
  }
  throw httpError(400, 'Invalid cursor');
}

/**
 * Validates the envelope against the contract, derives projectionVersion from its content (not from
 * generatedAt) and answers If-None-Match with 304 when the client already has this version.
 */
function send<T>(
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

/** Mounted at /v1. Public read API: every response is an envelope; an empty list is never "all clear". */
export const publicRoutes: FastifyPluginAsync = async (app) => {
  const snapshot = <T>(fn: Parameters<typeof readSnapshot<T>>[1]) => readSnapshot(app.db.db, fn);

  app.get('/overview', async (req, reply) => {
    const q = parseQuery(OverviewQuery, req.query);
    const areaId = knownArea(q.areaId);
    const now = new Date();
    const asOf = q.asOf ? instant(q.asOf) : null;
    if (asOf && asOf > now) throw httpError(400, 'asOf must not be in the future');
    const { overview, freshness } = await snapshot((tx) => readOverview(tx, areaId, asOf, now));
    return send(req, reply, pages.overview, { data: overview, freshness }, now);
  });

  app.get('/incidents', async (req, reply) => {
    const q = parseQuery(IncidentsQuery, req.query);
    const areaId = knownArea(q.areaId) ?? undefined;
    const now = new Date();
    let from = q.from ? instant(q.from) : undefined;
    let to = q.to ? instant(q.to) : undefined;
    if (from || to) {
      to ??= now;
      from ??= new Date(to.getTime() - MAX_RANGE_MS);
      if (from >= to) throw httpError(400, '`from` must be before `to`');
      if (to.getTime() - from.getTime() > MAX_RANGE_MS) throw httpError(400, 'Time range must not exceed 31 days');
    }
    const after = q.cursor ? decodeCursor(q.cursor) : undefined;
    const filter = { areaId, kind: q.kind, lifecycle: q.lifecycle, from, to, after, limit: q.limit };
    const { items, next, freshness } = await snapshot(async (tx) => {
      const page = await listIncidents(tx, filter);
      return { ...page, freshness: feedFreshness(await listSources(tx, now)) };
    });
    return send(req, reply, pages.incidents, { data: items, freshness, nextCursor: next && encodeCursor(next) }, now);
  });

  app.get<{ Params: { id: string } }>('/incidents/:id', async (req, reply) => {
    const now = new Date();
    const found = Id.safeParse(req.params.id).success
      ? await snapshot(async (tx) => {
          const incident = await getIncident(tx, req.params.id);
          return incident && { incident, freshness: feedFreshness(await listSources(tx, now)) };
        })
      : null;
    if (!found) throw httpError(404, 'Incident not found');
    return send(req, reply, pages.incident, { data: found.incident, freshness: found.freshness }, now);
  });

  app.get('/alerts', async (req, reply) => {
    const q = parseQuery(AlertsQuery, req.query);
    const areaId = knownArea(q.areaId);
    const now = new Date();
    const alerts = (await listAlerts(app.db.db, areaId, now)).filter((a) => !q.freshness || a.freshness === q.freshness);
    return send(req, reply, pages.alerts, { data: alerts, freshness: worstFreshness(alerts.map((a) => a.freshness)) }, now);
  });

  app.get('/areas', async (req, reply) => {
    const q = parseQuery(AreasQuery, req.query);
    const parentId = knownArea(q.parentId);
    const needle = q.query?.toLocaleLowerCase('uk');
    const data = PLACES.filter(
      (p) =>
        (parentId === null || p.parentId === parentId) &&
        (!needle || p.aliases.some((a) => a.toLocaleLowerCase('uk').includes(needle))),
    ).map(({ id, name, level, parentId }) => ({ id, name, level, parentId }));
    // The dictionary ships with the code, so it is always current.
    return send(req, reply, pages.areas, { data, freshness: 'fresh' }, new Date());
  });

  app.get('/sources', async (req, reply) => {
    const now = new Date();
    const data = await listSources(app.db.db, now);
    return send(req, reply, pages.sources, { data, freshness: sourcesFreshness(data) }, now);
  });
};
