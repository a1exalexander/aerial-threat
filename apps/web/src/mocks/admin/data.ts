import type { Claim, OpsDto, ReviewItemDto, ReviewMessageDto } from '@aerial/contracts';

// Invented posts and IDs for mocks/tests only: no real channel text or personal data.
const uuid = (n: number) => `0199a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const POLTAVA = { sourceId: uuid(1), sourceUsername: 'poltava_demo', sourceDisplayName: 'Канал Полтава (демо)' };
const KREMENCHUK = { sourceId: uuid(2), sourceUsername: 'kremenchuk_demo', sourceDisplayName: 'Канал Кременчук (демо)' };

const post = (src: typeof POLTAVA, id: string, at: string, text: string): ReviewMessageDto => ({
  ...src,
  messageExternalId: id,
  messageUrl: `https://t.me/${src.sourceUsername}/${id}`,
  publishedAt: at,
  text,
});

const claim = (n: number, patch: Partial<Claim>): Claim => ({
  id: uuid(100 + n),
  runId: uuid(200 + n),
  revisionId: uuid(300 + n),
  kind: 'threat_report',
  threatType: 'uav',
  threatQualifier: null,
  temporalScope: 'current',
  quantity: null,
  quantityText: null,
  placeId: null,
  geoBasis: 'unresolved',
  movementMention: null,
  evidence: [{ revisionId: uuid(300 + n), start: 0, end: 10, rawStart: 0, rawEnd: 10 }],
  assessments: [],
  publicationDecision: 'review',
  uncertainty: { time: [], geo: [], classification: [] },
  active: true,
  version: 1,
  ...patch,
});

export const REVIEW_ITEMS: ReviewItemDto[] = [
  {
    message: post(KREMENCHUK, '4101', '2026-09-21T09:12:00Z', 'Група БпЛА з півночі, курсом на Кременчук.'),
    context: [],
    candidates: [
      { placeId: 'ua-pl-c-kremenchuk', name: 'Кременчук' },
      { placeId: 'ua-pl-r-kremenchutskyi', name: 'Кременчуцький район' },
    ],
    incident: { id: uuid(401), revision: 2, summary: 'БпЛА у напрямку Кременчука' },
    claim: claim(1, {
      placeId: 'ua-pl-c-kremenchuk',
      geoBasis: 'explicit',
      movementMention: 'курсом на Кременчук',
      uncertainty: { time: ['no_explicit_time'], geo: ['direction_only'], classification: ['small_margin'] },
      assessments: [
        { type: 'choice', question: 'message_kind', selected: 'threat_report', probabilities: { threat_report: 0.96, alert_claim: 0.03 } },
        { type: 'choice', question: 'threat_type', selected: 'uav', probabilities: { uav: 0.94, missile: 0.02 } },
        {
          type: 'choice',
          question: 'place_candidate',
          selected: 'ua-pl-c-kremenchuk',
          probabilities: { 'ua-pl-c-kremenchuk': 0.55, 'ua-pl-r-kremenchutskyi': 0.4 },
        },
        { type: 'boolean', question: 'needs_context', probability: 0.05 },
      ],
    }),
  },
  {
    message: post(POLTAVA, '9207', '2026-09-21T09:20:00Z', 'Ще 2 на підльоті.'),
    context: [post(POLTAVA, '9206', '2026-09-21T09:14:00Z', 'Увага! Рух БпЛА в районі Полтави.')].map((m) => ({
      ...m,
      relation: 'reply_parent' as const,
    })),
    candidates: [{ placeId: 'ua-pl-c-poltava', name: 'Полтава' }],
    incident: { id: uuid(402), revision: 1, summary: 'БпЛА біля Полтави' },
    claim: claim(2, {
      quantity: 2,
      placeId: 'ua-pl-c-poltava',
      geoBasis: 'reply_context',
      uncertainty: { time: [], geo: ['from_reply_context'], classification: ['needs_context'] },
      assessments: [
        { type: 'choice', question: 'message_kind', selected: 'threat_report', probabilities: { threat_report: 0.92, other: 0.05 } },
        { type: 'boolean', question: 'needs_context', probability: 0.93 },
        { type: 'choice', question: 'place_candidate', selected: 'ua-pl-c-poltava', probabilities: { 'ua-pl-c-poltava': 0.91 } },
      ],
    }),
  },
  {
    message: post(POLTAVA, '9215', '2026-09-21T09:41:00Z', 'Можливо, вибухи чути на околицях. Уточнюємо.'),
    context: [],
    candidates: [],
    incident: null,
    claim: claim(3, {
      kind: 'aftermath',
      threatType: 'unknown',
      temporalScope: 'unknown',
      uncertainty: { time: ['no_explicit_time'], geo: ['no_place_mention'], classification: ['tentative_language', 'low_score'] },
      assessments: [
        { type: 'choice', question: 'message_kind', selected: 'aftermath', probabilities: { aftermath: 0.61, threat_report: 0.3 } },
        { type: 'boolean', question: 'is_tentative', probability: 0.88 },
      ],
    }),
  },
];

export function opsData(now: number, empty: boolean): OpsDto {
  const ago = (ms: number) => new Date(now - ms).toISOString();
  return {
    connectors: [
      {
        id: POLTAVA.sourceId,
        provider: 'telegram',
        username: POLTAVA.sourceUsername,
        displayName: POLTAVA.sourceDisplayName,
        enabled: true,
        lastSuccessfulSync: ago(20_000),
        lastMessageAt: ago(3 * 60_000),
        availability: 'ok',
        lagMs: 1_200,
        errorKind: null,
      },
      {
        id: KREMENCHUK.sourceId,
        provider: 'telegram',
        username: KREMENCHUK.sourceUsername,
        displayName: KREMENCHUK.sourceDisplayName,
        enabled: true,
        lastSuccessfulSync: ago(15_000),
        lastMessageAt: ago(2 * 3_600_000),
        availability: 'ok',
        lagMs: 900,
        errorKind: null,
      },
      {
        id: uuid(3),
        provider: 'neptun',
        username: null,
        displayName: 'NEPTUN',
        enabled: true,
        lastSuccessfulSync: ago(4 * 60_000),
        lastMessageAt: null,
        availability: 'unavailable',
        lagMs: null,
        errorKind: 'timeout',
      },
    ],
    queue: empty
      ? [
          { lane: 'live', queued: 0, running: 0, dead: 0, oldestQueuedAgeMs: null },
          { lane: 'archive', queued: 0, running: 0, dead: 0, oldestQueuedAgeMs: null },
        ]
      : [
          { lane: 'live', queued: 3, running: 1, dead: 0, oldestQueuedAgeMs: 75_000 },
          { lane: 'archive', queued: 120, running: 2, dead: 2, oldestQueuedAgeMs: 3_720_000 },
        ],
    ai: {
      windowHours: 24,
      requests: 412,
      failures: 9,
      lastErrorKind: 'rate_limited',
      lastFailureAt: ago(40 * 60_000),
      inputTokens: 812_345,
      outputTokens: 20_480,
      costUsd: null,
      dailyRequestLimit: 1000,
    },
  };
}
