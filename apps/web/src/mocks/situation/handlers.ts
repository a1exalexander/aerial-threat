import {
  SituationResponse,
  type Confidence,
  type FeedItem,
  type SituationDto,
  type SituationStatus,
  type SituationStatuses,
  type SourceDto,
} from '@aerial/contracts';
import { http, HttpResponse, type RequestHandler } from 'msw';

// Synthetic demo data only: invented short texts and channel names, no real posts.

export const SCENARIOS = [
  'alert-shahed',
  'alert-ballistic',
  'threat-no-alert',
  'clear',
  'unknown',
  'stale',
  'ai-off',
  'empty-feed',
  'eval-stale',
  'eval-unknown',
] as const;
export type Scenario = (typeof SCENARIOS)[number];
export const SCENARIO_KEY = 'aerial.mockScenario';

/** `?scenario=<name>` on the page URL (remembered in localStorage) switches the mocked state; default `alert-shahed`. */
export function currentScenario(): Scenario {
  const isScenario = (s: string | null): s is Scenario => SCENARIOS.includes(s as Scenario);
  const fromUrl = new URLSearchParams(globalThis.location?.search).get('scenario');
  try {
    if (isScenario(fromUrl)) localStorage.setItem(SCENARIO_KEY, fromUrl);
    const stored = localStorage.getItem(SCENARIO_KEY);
    return isScenario(stored) ? stored : 'alert-shahed';
  } catch {
    return isScenario(fromUrl) ? fromUrl : 'alert-shahed';
  }
}

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const MIN = 60_000;
const CHANNEL_A = { name: 'Канал «Кременчук» (демо)', username: 'demo_kremenchuk_channel' };
const CHANNEL_B = { name: 'Канал «Крюків» (демо)', username: 'demo_kryukiv_channel' };

const st = <T,>(value: T, confidence: Confidence = 'high', evidenceMessageIds: string[] = []): SituationStatus<T> => ({
  value,
  confidence,
  evidenceMessageIds,
});
const QUIET: SituationStatuses = {
  threatNow: st(false),
  threatType: st('none'),
  direction: st('none'),
  quantity: st('unknown'),
  forecast: st('none'),
  explosions: st(false),
  airDefense: st(false),
};

/** Every response is parsed through the contracts, so a mock that drifts from the API shape fails loudly. */
export function buildSituation(scenario: Scenario, now = Date.now()): SituationResponse {
  const at = (minAgo: number) => new Date(now - minAgo * MIN).toISOString();
  let n = 0;
  const post = (channel: typeof CHANNEL_A, minAgo: number, text: string, extra: Partial<FeedItem> = {}): FeedItem => {
    const messageId = String(9000 + ++n);
    return {
      id: uuid(n),
      sourceName: channel.name,
      sourceUsername: channel.username,
      messageId,
      publishedAt: at(minAgo),
      editedAt: null,
      text,
      replyToText: null,
      link: `https://t.me/${channel.username}/${messageId}`,
      ...extra,
    };
  };

  const alertState = (state: 'active' | 'inactive' | 'unknown', sinceMin: number | null, freshness: 'fresh' | 'stale' | 'unknown' = 'fresh') => ({
    state,
    level: state === 'active' ? 'red' : null,
    since: sinceMin === null ? null : at(sinceMin),
    freshness,
    lastSuccessfulFetchAt: freshness === 'unknown' ? at(15) : at(freshness === 'stale' ? 1.5 : 0.1),
  });
  const sources: SourceDto[] = [CHANNEL_A, CHANNEL_B].map((c, i) => ({
    id: uuid(100 + i),
    provider: 'telegram',
    username: c.username,
    displayName: c.name,
    enabled: true,
    lastSuccessfulSync: at(0.2),
    lastMessageAt: at(3),
    availability: 'ok',
  }));

  let d: Omit<SituationDto, 'area' | 'sources'>;
  let freshness: 'fresh' | 'stale' = 'fresh';
  switch (scenario) {
    case 'alert-shahed':
    case 'stale':
    case 'ai-off': {
      const feed = [
        post(CHANNEL_A, 3, 'Мопед з боку Козельщини, курс на Кременчук'),
        post(CHANNEL_B, 6, 'Над Градизьком, далі на воду', { replyToText: 'Де він зараз?' }),
        post(CHANNEL_A, 9, 'Ще 2 шахеди над Кобеляками, летять на північ'),
        post(CHANNEL_B, 14, 'Працює ППО, чути вибухи. Тримайтеся подалі від вікон', { editedAt: at(12) }),
        post(CHANNEL_A, 31, 'Увага, по району оголошено тривогу', { link: null }),
      ];
      const [p1, , p3, p4] = feed.map((p) => p.id);
      const low = scenario === 'ai-off' ? 'low' : 'high';
      const stale = scenario === 'stale';
      d = {
        alert: alertState('active', 32, stale ? 'stale' : 'fresh'),
        tile: 'alert',
        tileStale: stale,
        statuses: {
          threatNow: st(true, 'high', [p1!]),
          threatType: st('shahed', 'high', [p1!, p3!]),
          direction: st('towards', low, [p1!]),
          quantity: st('3', low, [p1!, p3!]),
          forecast: st('none'),
          explosions: st(true, low, [p4!]),
          airDefense: st(true, 'high', [p4!]),
        },
        route: [
          { name: 'Козельщина', placeId: null },
          { name: 'Кременчук', placeId: 'ua-pl-c-kremenchuk' },
          { name: 'Градизьк', placeId: null },
          { name: 'на воду', placeId: null },
        ],
        evaluation: {
          mode: scenario === 'ai-off' ? 'rules' : 'ai',
          evaluatedAt: at(stale ? 20 : 1),
          freshness: stale ? 'stale' : 'fresh',
        },
        feed,
      };
      if (stale) freshness = 'stale';
      break;
    }
    case 'alert-ballistic': {
      const feed = [
        post(CHANNEL_B, 1, 'Швидкісна ціль з півдня!'),
        post(CHANNEL_A, 2, 'Гучно в місті, був вибух'),
        post(CHANNEL_B, 4, 'Скоро мають дати відбій', { replyToText: 'Що там далі?' }),
      ];
      const [p1, p2, p3] = feed.map((p) => p.id);
      d = {
        alert: alertState('active', 5),
        tile: 'alert',
        tileStale: false,
        statuses: {
          ...QUIET,
          threatNow: st(true, 'high', [p1!]),
          threatType: st('ballistic', 'high', [p1!]),
          direction: st('towards', 'low', [p1!]),
          quantity: st('1', 'low', [p1!]),
          explosions: st(true, 'high', [p2!]),
          forecast: st('clear_expected', 'low', [p3!]),
        },
        route: null,
        evaluation: { mode: 'ai', evaluatedAt: at(0.5), freshness: 'fresh' },
        feed,
      };
      break;
    }
    case 'threat-no-alert':
    case 'eval-stale':
    case 'eval-unknown': {
      // eval-stale: the API still backs the threat tile with the aging analysis and flags it stale.
      // eval-unknown: the analysis is too old to drive the tile (the API computes it without statuses).
      const evalFreshness = scenario === 'eval-stale' ? 'stale' : scenario === 'eval-unknown' ? 'unknown' : 'fresh';
      const evalAge = { fresh: 1, stale: 20, unknown: 180 }[evalFreshness];
      const feed = [
        post(CHANNEL_A, 2, 'Реактивний мопед над Омельником, рухається до нас'),
        post(CHANNEL_B, 5, 'Омельник / Кременчук / Горішні Плавні і на воду'),
        post(CHANNEL_A, 7, 'Зараз буде тривога, будьте уважні'),
      ];
      const [p1, p2, p3] = feed.map((p) => p.id);
      d = {
        alert: alertState('inactive', 240),
        tile: evalFreshness === 'unknown' ? 'clear' : 'threat',
        tileStale: evalFreshness === 'stale',
        statuses: {
          ...QUIET,
          threatNow: st(true, 'high', [p1!]),
          threatType: st('jet_shahed', 'high', [p1!]),
          direction: st('passing', 'low', [p2!]),
          quantity: st('2', 'low', [p1!]),
          forecast: st('alert_expected', 'high', [p3!]),
        },
        route: [
          { name: 'Омельник', placeId: null },
          { name: 'Кременчук', placeId: 'ua-pl-c-kremenchuk' },
          { name: 'Горішні Плавні', placeId: 'ua-pl-c-horishni-plavni' },
          { name: 'на воду', placeId: null },
        ],
        evaluation: { mode: 'ai', evaluatedAt: at(evalAge), freshness: evalFreshness },
        feed,
      };
      break;
    }
    case 'clear':
      d = {
        alert: alertState('inactive', 48),
        tile: 'clear',
        tileStale: false,
        statuses: QUIET,
        route: null,
        evaluation: { mode: 'rules', evaluatedAt: at(0.5), freshness: 'fresh' },
        feed: [post(CHANNEL_A, 48, 'Відбій тривоги по району'), post(CHANNEL_B, 50, 'Все, мопеди пішли з області')],
      };
      break;
    case 'unknown': {
      // NEPTUN is down while the channels still write about a threat: the tile is ❔, never green or amber.
      const feed = [post(CHANNEL_A, 4, 'Шахед над Глобиним, курс на місто')];
      d = {
        alert: alertState('unknown', null, 'unknown'),
        tile: 'unknown',
        tileStale: false,
        statuses: { ...QUIET, threatNow: st(true, 'high', [feed[0]!.id]), threatType: st('shahed', 'high', [feed[0]!.id]) },
        route: null,
        evaluation: { mode: 'rules', evaluatedAt: at(1), freshness: 'fresh' },
        feed,
      };
      break;
    }
    case 'empty-feed':
      d = {
        alert: alertState('inactive', 300),
        tile: 'clear',
        tileStale: false,
        statuses: null,
        route: null,
        evaluation: null,
        feed: [],
      };
      break;
  }

  return SituationResponse.parse({
    data: { area: { id: 'ua-pl-c-kremenchuk', name: 'Кременчук' }, sources, ...d },
    generatedAt: new Date(now).toISOString(),
    projectionVersion: 'situation-v1',
    freshness,
  });
}

/** Stable ETag per scenario, so polling sees 304 until the scenario changes. */
export const situationHandlers: RequestHandler[] = [
  http.get('*/v1/situation', ({ request }) => {
    const scenario = currentScenario();
    const etag = `"situation:${scenario}"`;
    if (request.headers.get('if-none-match') === etag) return new HttpResponse(null, { status: 304, headers: { etag } });
    return HttpResponse.json(buildSituation(scenario), { headers: { etag } });
  }),
];
