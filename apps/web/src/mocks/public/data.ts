import {
  AlertStateDto,
  AreaDto,
  envelope,
  IncidentDetail,
  Overview,
  type AlertState,
  type Envelope,
  type EvidenceItemDto,
  type Freshness,
  type SourceDto,
} from '@aerial/contracts';

// Synthetic demo data only: invented texts and usernames, no real channel content.

export const SCENARIOS = ['fresh', 'stale', 'neptun-down', 'empty', 'conflict', 'archive', 'error'] as const;
export type Scenario = (typeof SCENARIOS)[number];

export const AREAS: AreaDto[] = [
  { id: 'ua-pl', name: 'Полтавська область', level: 'oblast', parentId: null },
  { id: 'ua-pl-r-poltavskyi', name: 'Полтавський район', level: 'raion', parentId: 'ua-pl' },
  { id: 'ua-pl-r-kremenchutskyi', name: 'Кременчуцький район', level: 'raion', parentId: 'ua-pl' },
  { id: 'ua-pl-r-myrhorodskyi', name: 'Миргородський район', level: 'raion', parentId: 'ua-pl' },
  { id: 'ua-pl-r-lubenskyi', name: 'Лубенський район', level: 'raion', parentId: 'ua-pl' },
  { id: 'ua-pl-c-poltava', name: 'Полтава', level: 'city', parentId: 'ua-pl-r-poltavskyi' },
  { id: 'ua-pl-c-kremenchuk', name: 'Кременчук', level: 'city', parentId: 'ua-pl-r-kremenchutskyi' },
  { id: 'ua-pl-c-horishni-plavni', name: 'Горішні Плавні', level: 'city', parentId: 'ua-pl-r-kremenchutskyi' },
  { id: 'ua-pl-c-myrhorod', name: 'Миргород', level: 'city', parentId: 'ua-pl-r-myrhorodskyi' },
  { id: 'ua-pl-c-lubny', name: 'Лубни', level: 'city', parentId: 'ua-pl-r-lubenskyi' },
];

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SRC_A = uuid(101);
const SRC_B = uuid(102);
const SRC_NEPTUN = uuid(103);
export const INCIDENT_IDS = { uav: uuid(1), closure: uuid(2), unresolved: uuid(3), missile: uuid(4) };

const MIN = 60_000;

/** Every snapshot is parsed through the contracts, so a mock that drifts from the API shape fails loudly. */
export function buildOverview(scenario: Scenario, areaId: string | null, asOfParam: string | null, now = Date.now()) {
  const archive = scenario === 'archive' || asOfParam !== null;
  const asOfMs = asOfParam ? Date.parse(asOfParam) : archive ? now - 24 * 60 * MIN : now;
  const at = (minAgo: number) => new Date(asOfMs - minAgo * MIN).toISOString();
  const neptunDown = scenario === 'neptun-down';
  const alertFreshness: Freshness = neptunDown ? 'unknown' : scenario === 'stale' ? 'stale' : 'fresh';

  const alert = (placeId: string, areaKey: string, state: AlertState, sinceMin: number): AlertStateDto => ({
    areaKey,
    placeId,
    state: neptunDown ? 'unknown' : state,
    level: placeId === 'ua-pl' ? 'oblast' : 'raion',
    since: neptunDown ? null : at(sinceMin),
    freshness: alertFreshness,
    lastSuccessfulFetchAt: at(neptunDown ? 14 : scenario === 'stale' ? 1.5 : 0.1),
    lastProviderChangeAt: neptunDown ? null : at(sinceMin),
  });
  const alerts = [
    alert('ua-pl', 'полтавська', 'inactive', 95),
    alert('ua-pl-r-poltavskyi', 'полтавський', archive ? 'active' : 'inactive', archive ? 20 : 95),
    alert('ua-pl-r-kremenchutskyi', 'кременчуцький', archive ? 'inactive' : 'active', 12),
    alert('ua-pl-r-myrhorodskyi', 'миргородський', 'inactive', 95),
    alert('ua-pl-r-lubenskyi', 'лубенський', 'inactive', 95),
  ];

  const incidents = scenario === 'empty' ? [] : buildIncidents(scenario, at, archive);
  const sources: SourceDto[] = [
    source(SRC_A, 'demo_poltava_channel', 'Канал «Полтава» (демо)', scenario === 'stale' ? 'degraded' : 'ok', at),
    source(SRC_B, 'demo_kremenchuk_channel', 'Канал «Кременчук» (демо)', 'ok', at),
    {
      id: SRC_NEPTUN,
      provider: 'neptun',
      username: null,
      displayName: 'NEPTUN',
      enabled: true,
      lastSuccessfulSync: at(neptunDown ? 14 : 0.1),
      lastMessageAt: null,
      availability: neptunDown ? 'unavailable' : 'ok',
    },
  ];

  const inArea = (id: string | null) => !areaId || areaId === 'ua-pl' || id === null || related(id, areaId);
  const data: Overview = {
    asOf: new Date(asOfMs).toISOString(),
    areaId,
    alerts: alerts.filter((a) => a.placeId === 'ua-pl' || inArea(a.placeId)),
    incidents: incidents.filter((i) => inArea(i.areaId)).map(({ evidence: _evidence, ...item }) => item),
    sources,
  };
  return envelope(Overview).parse({
    data,
    generatedAt: new Date(scenario === 'stale' ? now - 4 * MIN : now).toISOString(),
    projectionVersion: `${scenario}-1`,
    freshness: scenario === 'stale' ? 'stale' : 'fresh',
  });
}

export function buildIncident(scenario: Scenario, id: string, now = Date.now()): Envelope<IncidentDetail> | null {
  const archive = scenario === 'archive';
  const asOfMs = archive ? now - 24 * 60 * MIN : now;
  const found = buildIncidents(scenario, (m) => new Date(asOfMs - m * MIN).toISOString(), archive).find((i) => i.id === id);
  if (!found) return null;
  return envelope(IncidentDetail).parse({
    data: found,
    generatedAt: new Date(now).toISOString(),
    projectionVersion: `${scenario}-1`,
    freshness: scenario === 'stale' ? 'stale' : 'fresh',
  });
}

export function buildAlerts(scenario: Scenario, areaId: string | null, now = Date.now()) {
  const overview = buildOverview(scenario, areaId, null, now);
  return envelope(AlertStateDto.array()).parse({ ...overview, data: overview.data.alerts });
}

const chain = (id: string) => {
  const ids: string[] = [];
  for (let cur: string | null | undefined = id; cur; cur = AREAS.find((a) => a.id === cur)?.parentId) ids.push(cur);
  return ids;
};
/** The area itself, anything inside it, or anything containing it (an oblast-wide alert covers a city). */
const related = (id: string, areaId: string) => chain(id).includes(areaId) || chain(areaId).includes(id);

function source(id: string, username: string, displayName: string, availability: SourceDto['availability'], at: (m: number) => string): SourceDto {
  return { id, provider: 'telegram', username, displayName, enabled: true, lastSuccessfulSync: at(0.5), lastMessageAt: at(4), availability };
}

function buildIncidents(scenario: Scenario, at: (minAgo: number) => string, archive: boolean): IncidentDetail[] {
  const conflict = scenario === 'conflict';
  const mode = archive ? 'archive' : 'live';
  const lifecycle = archive ? 'archived' : scenario === 'stale' ? 'stale' : 'reported';
  const evidence = (
    n: number,
    src: 'a' | 'b',
    messageId: string,
    minAgo: number,
    text: string,
    extra: Partial<EvidenceItemDto> = {},
  ): EvidenceItemDto => ({
    claimId: uuid(200 + n),
    sourceId: src === 'a' ? SRC_A : SRC_B,
    sourceUsername: src === 'a' ? 'demo_poltava_channel' : 'demo_kremenchuk_channel',
    messageExternalId: messageId,
    messageUrl: null,
    publishedAt: at(minAgo),
    text,
    spans: [],
    geoBasis: 'explicit',
    relation: 'primary',
    originGroup: null,
    active: true,
    ...extra,
  });

  return [
    {
      id: INCIDENT_IDS.uav,
      kind: 'threat_report',
      threatTypes: ['uav'],
      areaId: 'ua-pl-c-kremenchuk',
      geoBasis: 'explicit',
      lifecycle,
      mode,
      firstSeenAt: at(11),
      lastEvidenceAt: at(4),
      summary: conflict
        ? 'Канали повідомляють про БпЛА у напрямку Кременчука; кількість у джерелах різниться.'
        : 'Канал повідомляє про БпЛА у напрямку Кременчука. Місце визначено з тексту.',
      sourceCount: 2,
      hasConflict: conflict,
      closureClaimed: false,
      revision: 3,
      evidence: [
        evidence(1, 'b', '900101', 11, conflict ? '3 БпЛА у напрямку Кременчука.' : 'БпЛА у напрямку Кременчука. Будьте в укритті.'),
        evidence(
          2,
          'a',
          '500201',
          4,
          conflict
            ? '5 БпЛА курсом на Кременчук.'
            : 'Повтор: <script>alert("xss")</script> група БпЛА курсом на Кременчук.',
          { relation: conflict ? 'conflicting' : 'supporting', originGroup: 'og-1' },
        ),
      ],
    },
    {
      id: INCIDENT_IDS.closure,
      kind: 'clear_claim',
      threatTypes: ['unknown'],
      areaId: 'ua-pl-r-kremenchutskyi',
      geoBasis: 'explicit',
      lifecycle,
      mode,
      firstSeenAt: at(2),
      lastEvidenceAt: at(2),
      summary: 'Канал повідомив про відбій для Кременчуцького району.',
      sourceCount: 1,
      hasConflict: false,
      closureClaimed: true,
      revision: 1,
      evidence: [evidence(3, 'b', '900102', 2, '🟢 Відбій по Кременчуцькому району.', { relation: 'closure' })],
    },
    {
      id: INCIDENT_IDS.unresolved,
      kind: 'threat_report',
      threatTypes: ['uav'],
      areaId: null,
      geoBasis: 'unresolved',
      lifecycle: archive ? 'archived' : 'candidate',
      mode,
      firstSeenAt: at(6),
      lastEvidenceAt: at(6),
      summary: 'Канал повідомляє про БпЛА. Місце не визначено.',
      sourceCount: 1,
      hasConflict: false,
      closureClaimed: false,
      revision: 1,
      evidence: [evidence(4, 'a', '500202', 6, 'Шахед біля аеродрому, слідкуйте за оновленнями.', { geoBasis: 'unresolved' })],
    },
    {
      id: INCIDENT_IDS.missile,
      kind: 'threat_report',
      threatTypes: ['missile'],
      areaId: 'ua-pl-c-poltava',
      geoBasis: 'reply_context',
      lifecycle,
      mode,
      firstSeenAt: at(9),
      lastEvidenceAt: at(8),
      summary: 'Канал повідомляє про ракетну загрозу для Полтави. Місце визначено з контексту відповіді.',
      sourceCount: 1,
      hasConflict: false,
      closureClaimed: false,
      revision: 2,
      evidence: [
        evidence(5, 'a', '500203', 9, 'Ракетна небезпека по області.', { geoBasis: 'explicit' }),
        evidence(6, 'a', '500204', 8, 'Туди ж, будьте уважні.', { geoBasis: 'reply_context', relation: 'supporting' }),
      ],
    },
  ];
}
