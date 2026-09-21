import { OpsResponse, type OpsDto } from '@aerial/contracts';
import { useState } from 'react';
import { connectorStatus, formatAge } from './labels';
import { AsOf, ResourceState, Time, useAdminResource } from './resource';

const LIVE_LAG_MS = 60_000; // doc 08: live job older than 60 s is a lag signal

export function OpsScreen() {
  const [res, reload] = useAdminResource('/v1/admin/ops', OpsResponse);
  const [busy, setBusy] = useState(false);
  const refresh = async () => {
    setBusy(true);
    await reload();
    setBusy(false);
  };
  return (
    <section aria-labelledby="ops-heading">
      <h1 id="ops-heading">Операційний стан</h1>
      <ResourceState res={res} retry={reload} need="viewer або вище" />
      {res.status === 'ready' && (
        <>
          <div className="toolbar">
            <AsOf env={res.value} />
            <button type="button" onClick={refresh} disabled={busy}>
              {busy ? 'Оновлення…' : 'Оновити'}
            </button>
          </div>
          <Connectors ops={res.value.data} now={res.value.generatedAt} />
          <Queue ops={res.value.data} />
          <Ai ops={res.value.data} />
        </>
      )}
    </section>
  );
}

function Connectors({ ops, now }: { ops: OpsDto; now: string }) {
  return (
    <section aria-labelledby="ops-connectors">
      <h2 id="ops-connectors">Конектори й останні синхронізації</h2>
      {ops.connectors.length === 0 ? (
        <p className="empty">Джерела не налаштовано.</p>
      ) : (
        <ul className="grid">
          {ops.connectors.map((c) => {
            const st = connectorStatus(c, now);
            const provider = c.provider === 'neptun' ? 'NEPTUN' : 'Telegram';
            return (
              <li key={c.id} className="card">
                <h3>
                  {c.displayName}
                  {c.username && ` (@${c.username})`}
                  {provider !== c.displayName && ` · ${provider}`}
                </h3>
                <p className={`pill ${st.tone}`}>{st.label}</p>
                <dl className="facts">
                  <dt>Остання успішна синхронізація</dt>
                  <dd>
                    <Time iso={c.lastSuccessfulSync} empty="ніколи" />
                  </dd>
                  {c.provider === 'telegram' && (
                    <>
                      <dt>Останній допис</dt>
                      <dd>
                        <Time iso={c.lastMessageAt} empty="немає" />
                      </dd>
                    </>
                  )}
                  <dt>Затримка</dt>
                  <dd>{c.lagMs === null ? '—' : formatAge(c.lagMs)}</dd>
                  <dt>Помилка</dt>
                  <dd>{c.errorKind ?? 'немає'}</dd>
                </dl>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function Queue({ ops }: { ops: OpsDto }) {
  return (
    <section aria-labelledby="ops-queue">
      <h2 id="ops-queue">Черга завдань</h2>
      <ul className="grid">
        {ops.queue.map((q) => {
          const lagging = q.lane === 'live' && (q.oldestQueuedAgeMs ?? 0) > LIVE_LAG_MS;
          return (
            <li key={q.lane} className="card">
              <h3>{q.lane === 'live' ? 'Live' : 'Архів і replay'}</h3>
              <dl className="facts">
                <dt>У черзі</dt>
                <dd>{q.queued}</dd>
                <dt>Виконується</dt>
                <dd>{q.running}</dd>
                <dt>Dead-letter</dt>
                <dd className={q.dead ? 'warn' : undefined}>{q.dead ? `${q.dead} — потрібен перегляд` : '0'}</dd>
                <dt>Найстаріше в черзі</dt>
                <dd className={lagging ? 'warn' : undefined}>
                  {q.oldestQueuedAgeMs === null ? 'черга порожня' : formatAge(q.oldestQueuedAgeMs)}
                  {lagging && ' — відставання (понад 60 с)'}
                </dd>
              </dl>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Ai({ ops: { ai } }: { ops: OpsDto }) {
  // Compare against the daily limit only when the window is a day; thresholds use the unrounded share.
  const share = ai.dailyRequestLimit && ai.windowHours === 24 ? ai.requests / ai.dailyRequestLimit : null;
  const budget =
    share === null ? null : share >= 1 ? 'ліміт вичерпано' : share >= 0.8 ? 'понад 80 %' : share >= 0.5 ? 'понад 50 %' : null;
  return (
    <section aria-labelledby="ops-ai">
      <h2 id="ops-ai">AI (Jev через Gateway)</h2>
      <dl className="card facts">
        <dt>Запити за {ai.windowHours} год</dt>
        <dd className={budget ? 'warn' : undefined}>
          {ai.requests}
          {share !== null && ` з ${ai.dailyRequestLimit} на добу (${Math.floor(share * 100)} %)`}
          {share === null && ai.dailyRequestLimit && ` (денний ліміт ${ai.dailyRequestLimit})`}
          {budget && ` — ${budget}`}
        </dd>
        <dt>Помилки</dt>
        <dd className={ai.failures ? 'warn' : undefined}>
          {ai.failures}
          {ai.requests > 0 && ` (${Math.round((ai.failures / ai.requests) * 100)} %)`}
        </dd>
        <dt>Остання помилка</dt>
        <dd>
          {ai.lastErrorKind ? (
            <>
              {ai.lastErrorKind}, <Time iso={ai.lastFailureAt} />
            </>
          ) : (
            'немає'
          )}
        </dd>
        <dt>Токени (вхід / вихід)</dt>
        <dd>
          {ai.inputTokens.toLocaleString('uk-UA')} / {ai.outputTokens.toLocaleString('uk-UA')}
        </dd>
        <dt>Вартість</dt>
        <dd>{ai.costUsd === null ? 'невідомо — тариф не налаштовано' : `$${ai.costUsd.toFixed(2)}`}</dd>
      </dl>
    </section>
  );
}
