import { ClaimReviewCommand, IncidentSplitCommand, type ReviewItemDto } from '@aerial/contracts';
import { http, HttpResponse, type JsonBodyType, type RequestHandler } from 'msw';
import { REVIEW_ITEMS, opsData } from './data';

/**
 * Scenarios: normal | empty (empty review queue and job queue) | forbidden (403 everywhere) | conflict (409 on the
 * next review submit, as if another operator changed the record). Switch with `?adminMock=<name>`; it sticks in
 * localStorage until changed. Any Bearer token is accepted; no token → 401.
 */
export const ADMIN_SCENARIOS = ['normal', 'empty', 'forbidden', 'conflict'] as const;
export type AdminScenario = (typeof ADMIN_SCENARIOS)[number];
export const ADMIN_MOCK_KEY = 'aerial.mock.admin';

export function adminScenario(): AdminScenario {
  const fromUrl = new URLSearchParams(location.search).get('adminMock');
  let value = fromUrl;
  try {
    if (fromUrl) localStorage.setItem(ADMIN_MOCK_KEY, fromUrl);
    else value = localStorage.getItem(ADMIN_MOCK_KEY);
  } catch {
    // storage blocked: URL only
  }
  return ADMIN_SCENARIOS.find((s) => s === value) ?? 'normal';
}

let items: ReviewItemDto[] = [];
let conflictArmed = true;
const replies = new Map<string, Reply>(); // idempotencyKey → first successful reply
export function resetAdminMocks() {
  items = structuredClone(REVIEW_ITEMS);
  conflictArmed = true;
  replies.clear();
}
resetAdminMocks();

type Reply = [status: number, body: JsonBodyType];
const fail = (status: number, code: string, message: string): Reply => [status, { code, requestId: crypto.randomUUID(), message }];
const send = ([status, body]: Reply) => HttpResponse.json(body, { status });
const envelope = (data: JsonBodyType) => ({
  data,
  generatedAt: new Date().toISOString(),
  projectionVersion: 'mock-1',
  freshness: 'fresh',
});

function denied(request: Request): Reply | null {
  if (!request.headers.get('authorization')?.startsWith('Bearer ')) return fail(401, 'unauthorized', 'Потрібна автентифікація');
  if (adminScenario() === 'forbidden') return fail(403, 'forbidden', 'Недостатньо прав');
  return null;
}

/** Validates, replays a known idempotency key, otherwise runs the command. Only successes are remembered. */
async function command<T extends { idempotencyKey: string }>(
  request: Request,
  schema: { safeParse(d: unknown): { success: true; data: T } | { success: false } },
  run: (cmd: T) => Reply,
) {
  const blocked = denied(request);
  if (blocked) return send(blocked);
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return send(fail(400, 'invalid_body', 'Некоректна команда'));
  const known = replies.get(parsed.data.idempotencyKey);
  if (known) return send(known);
  const reply = run(parsed.data);
  if (reply[0] < 300) replies.set(parsed.data.idempotencyKey, reply);
  return send(reply);
}

/** Conflict scenario: the first submit finds the record bumped by "another operator". */
function checkVersion(actual: number, expected: number, bump: () => void): Reply | null {
  if (adminScenario() === 'conflict' && conflictArmed) {
    conflictArmed = false;
    bump();
    return fail(409, 'version_conflict', 'Запис змінено, перечитайте його');
  }
  return actual === expected ? null : fail(409, 'version_conflict', 'Запис змінено, перечитайте його');
}

export const adminHandlers: RequestHandler[] = [
  http.get('*/v1/admin/review', ({ request }) => {
    const blocked = denied(request);
    return send(blocked ?? [200, envelope(adminScenario() === 'empty' ? [] : items)]);
  }),

  http.post('*/v1/admin/claims/:id/review', ({ request, params }) =>
    command(request, ClaimReviewCommand, (cmd) => {
      const item = items.find((i) => i.claim.id === params.id);
      if (!item) return fail(404, 'not_found', 'Твердження не знайдено');
      const conflict = checkVersion(item.claim.version, cmd.expectedVersion, () => item.claim.version++);
      if (conflict) return conflict;
      items = items.filter((i) => i !== item);
      return [200, { data: { claimId: item.claim.id, version: item.claim.version + 1 } }];
    }),
  ),

  http.post('*/v1/admin/incidents/:id/split', ({ request, params }) =>
    command(request, IncidentSplitCommand, (cmd) => {
      const item = items.find((i) => i.incident?.id === params.id && cmd.claimIds.includes(i.claim.id));
      if (!item?.incident) return fail(404, 'not_found', 'Подію не знайдено');
      const incident = item.incident;
      const conflict = checkVersion(incident.revision, cmd.expectedVersion, () => incident.revision++);
      if (conflict) return conflict;
      items = items.filter((i) => i !== item);
      return [200, { data: { incidentId: incident.id, revision: incident.revision + 1 } }];
    }),
  ),

  http.get('*/v1/admin/ops', ({ request }) => {
    const blocked = denied(request);
    return send(blocked ?? [200, envelope(opsData(Date.now(), adminScenario() === 'empty'))]);
  }),
];
