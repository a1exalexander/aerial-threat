import { AreaDto, envelope, type ApiError } from '@aerial/contracts';
import { http, HttpResponse, type JsonBodyType, type RequestHandler } from 'msw';
import { AREAS, buildAlerts, buildIncident, buildOverview, SCENARIOS, type Scenario } from './data';

export const SCENARIO_KEY = 'aerial.mockScenario';

/** `?scenario=<name>` on the page URL (remembered in localStorage) switches the mocked state; default `fresh`. */
export function currentScenario(): Scenario {
  const isScenario = (s: string | null): s is Scenario => SCENARIOS.includes(s as Scenario);
  const fromUrl = new URLSearchParams(globalThis.location?.search).get('scenario');
  try {
    if (isScenario(fromUrl)) localStorage.setItem(SCENARIO_KEY, fromUrl);
    const stored = localStorage.getItem(SCENARIO_KEY);
    return isScenario(stored) ? stored : 'fresh';
  } catch {
    return isScenario(fromUrl) ? fromUrl : 'fresh';
  }
}

const error = (status: number, code: string, message: string) =>
  HttpResponse.json({ code, requestId: 'mock-request', message } satisfies ApiError, { status });

/** Stable ETag per scenario and query, so polling sees 304 until the scenario changes. */
function withEtag(request: Request, body: JsonBodyType) {
  const etag = `"${currentScenario()}:${new URL(request.url).search}"`;
  if (request.headers.get('if-none-match') === etag) return new HttpResponse(null, { status: 304, headers: { etag } });
  return HttpResponse.json(body, { headers: { etag } });
}

const unavailable = () => error(503, 'unavailable', 'Service temporarily unavailable');

/** Owned by the web public screens unit: /v1/* mocks built from @aerial/contracts. */
export const publicHandlers: RequestHandler[] = [
  http.get('*/v1/overview', ({ request }) => {
    const scenario = currentScenario();
    if (scenario === 'error') return unavailable();
    const q = new URL(request.url).searchParams;
    return withEtag(request, buildOverview(scenario, q.get('areaId'), q.get('asOf')));
  }),
  http.get('*/v1/incidents/:id', ({ request, params }) => {
    const scenario = currentScenario();
    if (scenario === 'error') return unavailable();
    const body = buildIncident(scenario, String(params.id));
    return body ? withEtag(request, body) : error(404, 'not_found', 'Not found');
  }),
  http.get('*/v1/alerts', ({ request }) => {
    const scenario = currentScenario();
    if (scenario === 'error') return unavailable();
    return withEtag(request, buildAlerts(scenario, new URL(request.url).searchParams.get('areaId')));
  }),
  http.get('*/v1/areas', ({ request }) =>
    withEtag(
      request,
      envelope(AreaDto.array()).parse({
        data: AREAS,
        generatedAt: new Date().toISOString(),
        projectionVersion: 'geo-v1',
        freshness: 'fresh',
      }),
    ),
  ),
];
