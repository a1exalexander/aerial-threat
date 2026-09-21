import { AlertStateDto, envelope, IncidentDetail, type EvidenceItemDto } from '@aerial/contracts';
import type { ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { useApi } from '../features/public/api';
import {
  AlertsSection,
  areaName,
  type Areas,
  ErrorPanel,
  IncidentFlags,
  OfflineBanner,
  Section,
  StatusLine,
  Time,
  useAreas,
} from '../features/public/components';
import {
  GEO_BASIS_LABEL,
  KIND_LABEL,
  LIFECYCLE_LABEL,
  RELATION_LABEL,
  telegramUrl,
  THREAT_LABEL,
} from '../features/public/present';

const DETAIL = envelope(IncidentDetail);
const ALERTS = envelope(AlertStateDto.array());

export default function Incident() {
  const { id = '' } = useParams();
  const areas = useAreas();
  const { data, error, reload } = useApi(`/v1/incidents/${encodeURIComponent(id)}`, DETAIL);
  const incident = data?.data;
  const archive = incident?.mode === 'archive';
  // Current NEPTUN state only makes sense next to a live event whose place was actually determined.
  const placeId = incident && incident.geoBasis !== 'unresolved' ? incident.areaId : null;
  const alerts = useApi(placeId && !archive ? `/v1/alerts?areaId=${encodeURIComponent(placeId)}` : null, ALERTS);

  return (
    <div className={archive ? 'pub pub--archive' : 'pub'}>
      <p>
        <Link to="/">← До огляду</Link>
      </p>
      <h1>Деталі події</h1>
      <OfflineBanner />
      {archive ? (
        <p className="pub-banner pub-banner--archive" role="note">
          АРХІВНИЙ ЗАПИС. Це збережена подія, а не поточна ситуація.
        </p>
      ) : null}
      <StatusLine snapshot={data} error={error} archive={archive} />
      {!incident ? (
        error ? (
          <ErrorPanel error={error} onRetry={reload} what="подія" />
        ) : null
      ) : (
        <>
          <Assessment incident={incident} areas={areas} />
          {incident.hasConflict || incident.evidence.some((e) => e.relation === 'conflicting') ? (
            <Conflicts incident={incident} />
          ) : null}
          {archive ? null : (
            <AlertsSection alerts={alerts.data?.data ?? null} error={alerts.error} areas={areas}>
              {!placeId ? (
                <p className="pub-panel">Місце події не визначено, тому стан тривоги для неї не підібрано. Дивіться огляд.</p>
              ) : !alerts.data && !alerts.error ? (
                <p>Завантаження…</p>
              ) : null}
              {incident.closureClaimed ? (
                <p>
                  Канал повідомив про відбій. Це повідомлення каналу; стан тривоги визначає лише NEPTUN і офіційне
                  оповіщення.
                </p>
              ) : null}
            </AlertsSection>
          )}
          <Evidence evidence={incident.evidence} />
        </>
      )}
    </div>
  );
}

function Assessment({ incident: i, areas }: { incident: IncidentDetail; areas: Areas }) {
  const rows: [string, ReactNode][] = [
    ['Тип повідомлення', KIND_LABEL[i.kind]],
    ['Загроза', i.threatTypes.map((t) => THREAT_LABEL[t]).join(', ') || THREAT_LABEL.unknown],
    ['Територія', (i.geoBasis === 'unresolved' ? null : areaName(areas, i.areaId)) ?? 'Місце не визначено'],
    ['Як визначено місце', GEO_BASIS_LABEL[i.geoBasis]],
    ['Стан події', LIFECYCLE_LABEL[i.lifecycle]],
    ['Перше повідомлення', <Time key="f" iso={i.firstSeenAt} />],
    ['Останнє оновлення', <Time key="l" iso={i.lastEvidenceAt} />],
    ['Джерел', i.sourceCount],
    ['Версія запису', i.revision],
  ];
  return (
    <Section title="Оцінка автоматичного розбору">
      <p className="pub-summary">{i.summary}</p>
      <IncidentFlags incident={i} />
      <dl className="pub-meta">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <p className="pub-attribution">
        Зведення складено за шаблоном з розпізнаних тверджень. Автоматичний розбір не змінює стан тривоги.
      </p>
    </Section>
  );
}

function Conflicts({ incident }: { incident: IncidentDetail }) {
  const conflicting = incident.evidence.filter((e) => e.relation === 'conflicting');
  return (
    <Section title="Суперечності">
      <p>
        Джерела розходяться. Значення не усереднюються — нижче наведено варіанти з посиланнями на оригінальні
        повідомлення.
      </p>
      {conflicting.length > 0 ? (
        <ul>
          {conflicting.map((e) => (
            <li key={e.claimId}>
              {sourceLabel(e)}, <Time iso={e.publishedAt} />: <q>{e.text}</q>
            </li>
          ))}
        </ul>
      ) : null}
    </Section>
  );
}

const sourceLabel = (e: EvidenceItemDto) => (e.sourceUsername ? `@${e.sourceUsername}` : 'Джерело без публічного імені');

function Evidence({ evidence }: { evidence: readonly EvidenceItemDto[] }) {
  const sorted = [...evidence].sort((a, b) => Date.parse(a.publishedAt) - Date.parse(b.publishedAt));
  return (
    <Section title="Повідомлення каналу">
      {sorted.length === 0 ? (
        <p className="pub-panel">Немає повідомлень, пов'язаних із цією подією.</p>
      ) : (
        <ul className="pub-evidence">
          {sorted.map((e) => {
            const url = telegramUrl(e.sourceUsername, e.messageExternalId);
            return (
              <li key={e.claimId}>
                <p className="pub-flags">
                  <strong>{sourceLabel(e)}</strong>
                  <span className={`badge ${e.relation === 'conflicting' ? 'badge-conflict' : 'badge-muted'}`}>
                    {RELATION_LABEL[e.relation]}
                  </span>
                  {e.active ? null : <span className="badge badge-muted">Не враховується (змінено або видалено)</span>}
                </p>
                <dl className="pub-meta">
                  <div>
                    <dt>Опубліковано</dt>
                    <dd>
                      <Time iso={e.publishedAt} />
                    </dd>
                  </div>
                  <div>
                    <dt>Географія</dt>
                    <dd>{GEO_BASIS_LABEL[e.geoBasis]}</dd>
                  </div>
                </dl>
                {/* Plain React text node: markup in a post is shown as characters, never interpreted. */}
                <p className="pub-text">{e.text}</p>
                {url ? (
                  <a href={url} target="_blank" rel="noopener noreferrer">
                    Відкрити допис у Telegram ({sourceLabel(e)}, №{e.messageExternalId})
                  </a>
                ) : (
                  <span>Посилання на допис недоступне (немає публічного імені каналу).</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}
