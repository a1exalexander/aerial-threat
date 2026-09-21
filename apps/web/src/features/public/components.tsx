import {
  AreaDto,
  envelope,
  type AlertStateDto,
  type Envelope,
  type IncidentListItem,
  type Overview,
  type SourceDto,
} from '@aerial/contracts';
import { Component, lazy, Suspense, useId, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { ApiRequestError } from '../../api/client';
import { useApi, useOnline } from './api';
import {
  ALERT_LABEL,
  alertDisplayState,
  AVAILABILITY_LABEL,
  formatKyiv,
  FRESHNESS_LABEL,
  GEO_BASIS_LABEL,
  KIND_LABEL,
  levelLabel,
  LIFECYCLE_LABEL,
  MAP_UNAVAILABLE,
  NEPTUN_URL,
  oblastActiveLabel,
  THREAT_LABEL,
} from './present';
import './public.css';

const AreaMap = lazy(() => import('./area-map'));

export type Areas = ReadonlyMap<string, AreaDto>;

const AREAS_SCHEMA = envelope(AreaDto.array());
/** Used when /v1/areas fails, so the picker stays usable (IDs match @aerial/geo; kept static so the polygons stay in the map chunk). */
const raion = (id: string, name: string): AreaDto => ({ id, name, level: 'raion', parentId: 'ua-pl' });
const FALLBACK_AREAS: AreaDto[] = [
  { id: 'ua-pl', name: 'Полтавська область', level: 'oblast', parentId: null },
  raion('ua-pl-r-poltavskyi', 'Полтавський район'),
  raion('ua-pl-r-kremenchutskyi', 'Кременчуцький район'),
  raion('ua-pl-r-myrhorodskyi', 'Миргородський район'),
  raion('ua-pl-r-lubenskyi', 'Лубенський район'),
];

export function useAreas(): Areas {
  const { data } = useApi('/v1/areas', AREAS_SCHEMA, { poll: false });
  return useMemo(() => new Map((data?.data ?? FALLBACK_AREAS).map((a) => [a.id, a])), [data]);
}

export const areaName = (areas: Areas, id: string | null) => (id ? (areas.get(id)?.name ?? id) : null);

export const Time = ({ iso }: { iso: string }) => <time dateTime={iso}>{formatKyiv(iso)}</time>;

const LEVEL_GROUPS = [
  ['oblast', 'Область'],
  ['raion', 'Райони'],
  ['hromada', 'Громади'],
  ['city', 'Міста'],
  ['village', 'Села'],
] as const;

export function AreaPicker({ areas, value, onChange }: { areas: Areas; value: string; onChange: (id: string) => void }) {
  const id = useId();
  const list = [...areas.values()];
  return (
    <div className="pub-field">
      <label htmlFor={id}>Територія</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        {LEVEL_GROUPS.map(([level, label]) => {
          const items = list.filter((a) => a.level === level);
          return items.length === 0 ? null : (
            <optgroup key={level} label={label}>
              {items.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </optgroup>
          );
        })}
      </select>
    </div>
  );
}

export function OfflineBanner() {
  return useOnline() ? null : (
    <p className="pub-banner pub-banner--warn" role="alert">
      Немає з'єднання з мережею. Показано останні отримані дані — вони можуть бути застарілими. Після відновлення
      зв'язку дані оновляться автоматично.
    </p>
  );
}

/** Freshness of the whole snapshot plus the partial-failure label; announced politely to screen readers. */
export function StatusLine({ snapshot, error, archive }: { snapshot: Envelope<unknown> | null; error: unknown; archive?: boolean }) {
  return (
    <p className="pub-status" role="status" aria-live="polite">
      {snapshot ? (
        <>
          {archive ? 'Архівні дані; запит виконано' : 'Дані оновлено'}: <Time iso={snapshot.generatedAt} />.{' '}
          {archive ? null : <span className={`badge fresh-${snapshot.freshness}`}>{FRESHNESS_LABEL[snapshot.freshness]}</span>}
          {error ? (
            <strong className="pub-stale-note">
              {' '}
              Оновлення не вдалося — показано останні отримані дані, вони можуть бути застарілими.
            </strong>
          ) : null}
        </>
      ) : error ? null : (
        'Завантаження даних…'
      )}
    </p>
  );
}

export function ErrorPanel({ error, onRetry, what }: { error: unknown; onRetry: () => void; what: string }) {
  const notFound = error instanceof ApiRequestError && error.status === 404;
  return (
    <div className="pub-panel pub-panel--error" role="alert">
      <p>{notFound ? `${what}: не знайдено.` : `Не вдалося завантажити дані (${what}).`}</p>
      {notFound ? null : <p>Стан тривоги за даними NEPTUN — невідомо. Відсутність даних не означає безпеку.</p>}
      <button type="button" onClick={onRetry}>
        Спробувати ще раз
      </button>
    </div>
  );
}

export function NeptunAttribution() {
  return (
    <p className="pub-attribution">
      Дані:{' '}
      <a href={NEPTUN_URL} target="_blank" rel="noopener noreferrer">
        Карта повітряних тривог — NEPTUN
      </a>
      . Агрегатор не замінює офіційне оповіщення: орієнтуйтеся на сирени та офіційні застосунки тривог.
    </p>
  );
}

/** `activeLabel` overrides «Тривога», e.g. «Тривога в частині області» for an oblast row. */
export function AlertStateBadge({ alert, activeLabel }: { alert: AlertStateDto; activeLabel?: string }) {
  const state = alertDisplayState(alert);
  return (
    <>
      <span className={`badge state-${state}`}>{state === 'active' && activeLabel ? activeLabel : ALERT_LABEL[state]}</span>
      {alert.level && state !== 'unknown' ? (
        <>
          {' '}
          <span className="badge badge-muted">{levelLabel(alert.level)}</span>
        </>
      ) : null}
    </>
  );
}

export function AlertList({ alerts, areas }: { alerts: readonly AlertStateDto[]; areas: Areas }) {
  if (alerts.length === 0) {
    return (
      <p className="pub-panel">
        <span className="badge state-unknown">{ALERT_LABEL.unknown}</span> Немає даних від NEPTUN для цієї території.
      </p>
    );
  }
  const isOblast = (a: AlertStateDto) => areas.get(a.placeId ?? '')?.level === 'oblast';
  const raionRows = (a: AlertStateDto) =>
    isOblast(a) ? alerts.filter((r) => r.placeId && areas.get(r.placeId)?.parentId === a.placeId) : null;
  return (
    <ul className="pub-alerts">
      {[...alerts]
        .sort((a, b) => Number(isOblast(b)) - Number(isOblast(a)))
        .map((a) => (
          <AlertRow key={a.areaKey} alert={a} areas={areas} raions={raionRows(a)} />
        ))}
    </ul>
  );
}

/** `raions` is set for an oblast row: its state is worded as partial/whole and the breakdown is shown. */
function AlertRow({ alert: a, areas, raions }: { alert: AlertStateDto; areas: Areas; raions: readonly AlertStateDto[] | null }) {
  const state = alertDisplayState(a);
  const activeRaions = raions?.filter((r) => alertDisplayState(r) === 'active').length ?? 0;
  return (
    <li className={`pub-alert pub-alert--${state}`}>
      <span className="pub-alert-name">{areaName(areas, a.placeId) ?? a.areaKey}</span>{' '}
      <AlertStateBadge alert={a} activeLabel={raions ? oblastActiveLabel(raions) : undefined} />{' '}
      {raions && raions.length > 0 && state === 'active' ? (
        <span className="pub-breakdown">
          (районів із тривогою: {activeRaions} з {raions.length}, див. нижче)
        </span>
      ) : null}{' '}
      {a.freshness !== 'fresh' ? <span className={`badge fresh-${a.freshness}`}>{FRESHNESS_LABEL[a.freshness]}</span> : null}
      <dl className="pub-meta">
        {a.since && state !== 'unknown' ? (
          <div>
            <dt>Стан з</dt>
            <dd>
              <Time iso={a.since} />
            </dd>
          </div>
        ) : null}
        <div>
          <dt>Остання успішна перевірка NEPTUN</dt>
          <dd>{a.lastSuccessfulFetchAt ? <Time iso={a.lastSuccessfulFetchAt} /> : 'немає'}</dd>
        </div>
      </dl>
    </li>
  );
}

export function Section({ title, className = '', children }: { title: ReactNode; className?: string; children: ReactNode }) {
  const id = useId();
  return (
    <section className={`pub-section ${className}`} aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
      {children}
    </section>
  );
}

type AlertsSectionProps = {
  /** null = no reading to show (not loaded, failed or no place); never rendered as "no alert". */
  alerts: readonly AlertStateDto[] | null;
  areas: Areas;
  title?: ReactNode;
  /** Error of the latest refresh: last readings stay visible with a stale note. */
  error?: unknown;
  children?: ReactNode;
};

export function AlertsSection({ alerts, areas, title, error, children }: AlertsSectionProps) {
  return (
    <Section title={title ?? 'Стан тривоги за даними NEPTUN'} className="pub-area-alerts">
      {alerts ? <AlertList alerts={alerts} areas={areas} /> : null}
      {error ? (
        <p className="pub-stale-note">
          {alerts ? (
            'Оновлення стану тривоги не вдалося — показано останні отримані дані, вони можуть бути застарілими.'
          ) : (
            <>
              <span className="badge state-unknown">{ALERT_LABEL.unknown}</span> Не вдалося отримати стан тривоги.
            </>
          )}
        </p>
      ) : null}
      {children}
      <NeptunAttribution />
    </Section>
  );
}

export function IncidentCard({ incident: i, areas }: { incident: IncidentListItem; areas: Areas }) {
  const place = i.geoBasis === 'unresolved' ? null : areaName(areas, i.areaId);
  return (
    <li className={`pub-card${i.mode === 'archive' ? ' pub-card--archive' : ''}`}>
      <h3>
        <Link to={`/incidents/${i.id}`}>{i.summary}</Link>
      </h3>
      <p className="pub-card-place">
        {place ? (
          <>
            <strong>{place}</strong> · {GEO_BASIS_LABEL[i.geoBasis]}
          </>
        ) : (
          <strong>{GEO_BASIS_LABEL.unresolved}</strong>
        )}
      </p>
      <p className="pub-assessment">
        <span className="pub-label">Оцінка автоматичного розбору:</span> {KIND_LABEL[i.kind]}
        {i.threatTypes.length > 0 ? ` · ${i.threatTypes.map((t) => THREAT_LABEL[t]).join(', ')}` : null} ·{' '}
        {LIFECYCLE_LABEL[i.lifecycle]}
      </p>
      <IncidentFlags incident={i} />
      <dl className="pub-meta">
        <div>
          <dt>Перше повідомлення</dt>
          <dd>
            <Time iso={i.firstSeenAt} />
          </dd>
        </div>
        <div>
          <dt>Останнє оновлення</dt>
          <dd>
            <Time iso={i.lastEvidenceAt} />
          </dd>
        </div>
        <div>
          <dt>Джерел</dt>
          <dd>{i.sourceCount}</dd>
        </div>
      </dl>
    </li>
  );
}

export function IncidentFlags({ incident: i }: { incident: IncidentListItem }) {
  if (!i.hasConflict && !i.closureClaimed && i.mode !== 'archive') return null;
  return (
    <p className="pub-flags">
      {i.mode === 'archive' ? <span className="badge badge-archive">Архівний запис</span> : null}
      {i.hasConflict ? <span className="badge badge-conflict">Суперечливі дані в джерелах</span> : null}
      {i.closureClaimed ? (
        <span className="badge badge-closure">Канал повідомив про відбій — стан тривоги NEPTUN цим не змінюється</span>
      ) : null}
    </p>
  );
}

export function SourceList({ sources }: { sources: readonly SourceDto[] }) {
  const channels = sources.filter((s) => s.provider === 'telegram');
  if (channels.length === 0) return null;
  return (
    <ul className="pub-sources" aria-label="Стан джерел">
      {channels.map((s) => (
        <li key={s.id}>
          {s.displayName}: {AVAILABILITY_LABEL[s.availability]}
          {s.lastSuccessfulSync ? (
            <>
              , остання синхронізація <Time iso={s.lastSuccessfulSync} />
            </>
          ) : null}
          {s.availability !== 'ok' ? ' — повідомлення можуть бути неповними.' : null}
        </li>
      ))}
    </ul>
  );
}

type FeedProps = { overview: Overview; areas: Areas; freshness: Envelope<unknown>['freshness']; archive?: boolean };

function Feed({ overview, areas, freshness, archive }: FeedProps) {
  return (
    <Section title="Повідомлення каналу" className="pub-area-feed">
      <SourceList sources={overview.sources} />
      {overview.incidents.length === 0 ? (
        <p className="pub-panel pub-empty">
          Немає отриманих повідомлень за період. Відсутність повідомлень не означає безпеки. (
          {archive ? 'Архівний знімок' : FRESHNESS_LABEL[freshness]}, станом на <Time iso={overview.asOf} />
          .)
        </p>
      ) : (
        <ul className="pub-feed">
          {overview.incidents.map((i) => (
            <IncidentCard key={i.id} incident={i} areas={areas} />
          ))}
        </ul>
      )}
    </Section>
  );
}

/** A failed map chunk (offline, redeploy) or WebGL error must not take the alert state and feed down with it. */
class MapBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? <p className="pub-panel">{MAP_UNAVAILABLE}</p> : this.props.children;
  }
}

function MapSection({ overview, areas }: { overview: Overview; areas: Areas }) {
  const id = useId();
  // The feed is complete without the map, so narrow screens start with it collapsed.
  const [shown, setShown] = useState(() => window.matchMedia?.('(min-width: 60rem)').matches ?? false);
  return (
    <Section title="Карта" className="pub-area-map">
      <button type="button" aria-expanded={shown} aria-controls={`${id}-body`} onClick={() => setShown(!shown)}>
        {shown ? 'Сховати карту' : 'Показати карту'}
      </button>
      <div id={`${id}-body`} hidden={!shown}>
        {shown ? (
          <MapBoundary>
            <Suspense fallback={<p>Завантаження карти…</p>}>
              <AreaMap alerts={overview.alerts} incidents={overview.incidents} areas={areas} />
            </Suspense>
          </MapBoundary>
        ) : null}
      </div>
    </Section>
  );
}

/** Shared by the live overview and the archive: NEPTUN state, feed and map of one consistent snapshot. */
export function OverviewBody({ snapshot, areas, archive }: { snapshot: Envelope<Overview>; areas: Areas; archive?: boolean }) {
  const overview = snapshot.data;
  return (
    <div className="pub-grid">
      <AlertsSection
        alerts={overview.alerts}
        areas={areas}
        title={
          archive ? (
            <>
              Стан тривоги за даними NEPTUN на <Time iso={overview.asOf} />
            </>
          ) : undefined
        }
      />
      <Feed overview={overview} areas={areas} freshness={snapshot.freshness} archive={archive} />
      <MapSection overview={overview} areas={areas} />
    </div>
  );
}
