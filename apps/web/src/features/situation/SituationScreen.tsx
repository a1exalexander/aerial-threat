import { KREMENCHUK, type FeedItem, type SituationDto, type SituationTile } from '@aerial/contracts';
import { useClock, useOnline, useSituation, type Clock } from './api';
import { Icon } from './icons';
import {
  currentStatuses,
  evidenceIds,
  FORECAST_LABEL,
  inRaion,
  isWater,
  kyivClock,
  kyivShort,
  levelLabel,
  NEPTUN_URL,
  orderRoute,
  meaningfullyEdited,
  statusViews,
  telegramLink,
  TILE,
} from './present';
import './situation.css';

const Maybe = () => <span className="maybe">ймовірно</span>;

export default function SituationScreen() {
  const { data, error, expired, checked } = useSituation();
  const online = useOnline();
  const s = data?.data;
  // No response at all, or none for too long (API or network down): the alert state is unknown, never "clear".
  const tile: SituationTile | null = s && !expired ? s.tile : error ? 'unknown' : null;
  const stale = !!s && !expired && (s.tileStale || data?.freshness !== 'fresh' || !!error);

  return (
    <div className="sit">
      {tile ? <title>{`${TILE[tile].label} · ${KREMENCHUK.name}`}</title> : null}
      <header className="sit-top">
        <h1>{s?.area.name ?? KREMENCHUK.name}</h1>
        <Updated checked={checked} error={!!error} />
      </header>

      {online ? null : (
        <p className="sit-banner" role="alert">
          <Icon name="offline" />
          Немає з'єднання з мережею. Показано останні отримані дані — вони можуть бути застарілими.
        </p>
      )}
      {error ? (
        <p className="sit-banner" role="alert">
          <Icon name="warning" />
          {data
            ? 'Оновлення не вдалося — показано останні отримані дані, вони можуть бути застарілими. Повторюємо спробу…'
            : 'Сервер недоступний — стан тривоги невідомий. Повторюємо спробу…'}
        </p>
      ) : null}

      <main className="sit-main">
        <div className="sit-primary">
          <AlertTile tile={tile} alert={expired ? null : (s?.alert ?? null)} stale={stale} />
          {s ? <Statuses s={s} stale={!!error} /> : null}
        </div>
        {s ? <Feed feed={s.feed} evidence={evidenceIds(currentStatuses(s))} /> : null}
      </main>

      <footer className="sit-foot">
        <p>Статуси та повідомлення — з Telegram-каналів, автоматичний розбір може помилятися.</p>
        <p>
          <strong>Агрегатор не замінює офіційне оповіщення.</strong> Під час тривоги прямуйте в укриття.
        </p>
        <p className="sit-foot-note">
          Стан тривоги отримується через API{' '}
          <a href={NEPTUN_URL} target="_blank" rel="noopener noreferrer">
            NEPTUN
          </a>
          .
        </p>
      </footer>
    </div>
  );
}

function Updated({ checked, error }: { checked: Clock; error: boolean }) {
  const at = useClock(checked);
  return (
    <p className="sit-updated">
      {at ? (
        <>
          Оновлено о <time dateTime={new Date(at).toISOString()}>{kyivClock(at)}</time>
        </>
      ) : error ? (
        'Немає даних'
      ) : (
        'Завантаження…'
      )}
    </p>
  );
}

/** One live region from the first paint, so the first real state is announced too. */
function AlertTile({ tile, alert, stale }: { tile: SituationTile | null; alert: SituationDto['alert'] | null; stale: boolean }) {
  if (!tile) {
    return (
      <section className="tile tile--loading" aria-live="polite" aria-atomic="true" aria-label="Стан тривоги" aria-busy="true">
        <span className="sr-only">Завантаження стану тривоги…</span>
      </section>
    );
  }
  const t = TILE[tile];
  const since = (tile === 'alert' || tile === 'clear') && alert?.since ? alert.since : null;
  return (
    <section
      className={`tile tile--${tile}${tile === 'alert' && alert?.level === 'yellow' ? ' tile--yellow' : ''}`}
      aria-live="polite"
      aria-atomic="true"
      aria-label="Стан тривоги"
    >
      <div className="tile-top">
        <span className="tile-icon">
          <Icon name={t.icon} />
        </span>
        {stale ? <span className="badge">дані застарілі</span> : null}
      </div>
      <h2 className="tile-label">{t.label}</h2>
      <p className="tile-note">{t.note}</p>
      {since || (tile === 'alert' && alert?.level) ? (
        <p className="tile-meta">
          {since ? (
            <>
              з <time dateTime={since}>{kyivShort(since)}</time>
            </>
          ) : null}
          {since && tile === 'alert' && alert?.level ? ' · ' : null}
          {tile === 'alert' && alert?.level ? levelLabel(alert.level) : null}
        </p>
      ) : null}
    </section>
  );
}

function Statuses({ s, stale: failing }: { s: SituationDto; stale: boolean }) {
  const st = currentStatuses(s);
  const views = st ? statusViews(st) : [];
  const forecast = st?.forecast.value === 'none' ? null : st?.forecast;
  const route = st && s.route?.length ? orderRoute(s.route) : null;
  const stale = failing || s.evaluation?.freshness === 'stale';
  return (
    <section className={`sit-statuses${stale ? ' sit-statuses--stale' : ''}`} aria-live="polite" aria-labelledby="statuses-h">
      <div className="sit-statuses-head">
        <h2 id="statuses-h" className="sit-h2">
          За даними каналів
        </h2>
        {stale ? <span className="badge">дані застарілі</span> : null}
      </div>
      {s.statuses && !st ? (
        <p className="sit-note">Аналіз застарів — статуси не показано.</p>
      ) : !st ? (
        <p className="sit-note">Аналіз ще не виконано.</p>
      ) : views.length === 0 && !forecast ? (
        <p className="sit-note">У свіжих повідомленнях каналів деталей не знайдено.</p>
      ) : null}
      {views.length ? (
        <ul className="stats">
          {views.map((v) => (
            <li key={v.key} className={`stat${v.low ? ' stat--low' : ''}${v.danger ? ' stat--danger' : ''}`}>
              <span className="stat-head">
                <Icon name={v.icon} />
                {v.label}
              </span>
              <span className="stat-value">{v.value}</span>
              {v.low ? <Maybe /> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {forecast && forecast.value !== 'none' ? (
        <p className={`forecast${forecast.confidence === 'low' ? ' forecast--low' : ''}`}>
          <Icon name="broadcast" />
          {FORECAST_LABEL[forecast.value]}
          {forecast.confidence === 'low' ? <Maybe /> : null}
        </p>
      ) : null}
      {route ? (
        <div className="route">
          <h3 className="route-h">
            <Icon name="pin" />
            Маршрут за даними каналів
          </h3>
          <ol className="route-list">
            {route.map((stop, i) => (
              <li key={`${i}:${stop.name}`}>
                {i > 0 ? (
                  <span className="route-sep" aria-hidden="true">
                    →
                  </span>
                ) : null}
                <span className={`chip${isWater(stop) ? ' chip--water' : inRaion(stop) ? ' chip--raion' : ''}`}>
                  {isWater(stop) ? <Icon name="water" /> : null}
                  {stop.name}
                  {inRaion(stop) ? <span className="sr-only"> (Кременчуцький район)</span> : null}
                </span>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
      {s.evaluation && s.statuses ? (
        <p className="sit-eval">
          Аналіз: {s.evaluation.mode === 'ai' ? 'AI' : 'правила'} ·{' '}
          <time dateTime={s.evaluation.evaluatedAt}>{kyivShort(s.evaluation.evaluatedAt)}</time>
        </p>
      ) : null}
    </section>
  );
}

function Feed({ feed, evidence }: { feed: FeedItem[]; evidence: Set<string> }) {
  const posts = [...feed].sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
  return (
    <section className="sit-feed" aria-labelledby="feed-h">
      <h2 id="feed-h" className="sit-h2">
        Повідомлення каналів
      </h2>
      {posts.length === 0 ? (
        <p className="sit-note">Немає повідомлень за останні години.</p>
      ) : (
        <ol className="posts">
          {posts.map((p) => (
            <li key={p.id}>
              <Post p={p} evidence={evidence.has(p.id)} />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function Post({ p, evidence }: { p: FeedItem; evidence: boolean }) {
  const link = telegramLink(p.link);
  const time = kyivShort(p.publishedAt);
  return (
    <article className="post">
      <header className="post-head">
        <span className="post-src">{p.sourceName}</span>
        <time className="post-time" dateTime={p.publishedAt}>
          {time}
        </time>
        {meaningfullyEdited(p) ? <span className="tag">змінено</span> : null}
        {evidence ? (
          <span className="tag tag--evidence" title="Використано для статусів">
            доказ
          </span>
        ) : null}
      </header>
      {p.replyToText ? (
        <blockquote className="post-reply">
          <Icon name="reply" />
          <span className="sr-only">У відповідь на: </span>
          <span className="post-reply-text">{p.replyToText}</span>
        </blockquote>
      ) : null}
      <p className="post-text">{p.text}</p>
      {link ? (
        <a className="post-link" href={link} target="_blank" rel="noopener noreferrer" aria-label={`Відкрити в Telegram: ${p.sourceName}, ${time}`}>
          Відкрити в Telegram
          <Icon name="external" />
        </a>
      ) : null}
    </article>
  );
}
