import {
  ClaimKind,
  GeoBasis,
  TemporalScope,
  ThreatType,
  type ClaimReviewCommand,
  type IncidentSplitCommand,
  type ReviewItemDto,
} from '@aerial/contracts';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { adminFetch, hasStatus } from '../../auth/adminFetch';
import { DECISION, GEO_BASIS, KIND, QUESTION, REASON, TEMPORAL, THREAT, assessmentAnswer, assessmentBasis } from './labels';
import { Time } from './resource';

type Action = 'confirm' | 'correct' | 'exclude' | 'split';
type Fields = {
  kind: ClaimKind;
  threatType: ThreatType;
  temporalScope: TemporalScope;
  placeId: string; // '' = не визначено
  geoBasis: GeoBasis;
};
/** Only fields the operator touched: untouched ones follow the latest record after a 409 re-read. */
type Draft = { action: Action; reason: string } & Partial<Fields>;
type WithoutKey<T> = T extends unknown ? Omit<T, 'idempotencyKey'> : never;
type Command = WithoutKey<ClaimReviewCommand | IncidentSplitCommand>;

const ACTIONS: Record<Action, { label: string; done: string }> = {
  confirm: { label: 'Підтвердити', done: 'Твердження підтверджено.' },
  correct: { label: 'Виправити категорію чи географію', done: 'Виправлення збережено.' },
  exclude: { label: 'Виключити', done: 'Твердження виключено.' },
  split: { label: 'Винести в окрему подію', done: 'Твердження винесено в окрему подію.' },
};
const anyBody = { parse: (d: unknown) => d };

const fieldsOf = (claim: ReviewItemDto['claim'], d: Draft): Fields => ({
  kind: d.kind ?? claim.kind,
  threatType: d.threatType ?? claim.threatType,
  temporalScope: d.temporalScope ?? claim.temporalScope,
  placeId: d.placeId ?? claim.placeId ?? '',
  geoBasis: d.geoBasis ?? (claim.geoBasis === 'unresolved' ? 'explicit' : claim.geoBasis),
});

/** The command for the current draft, or a validation message. Only changed fields go into a correction. */
function buildRequest(item: ReviewItemDto, d: Draft): { path: string; body: Command } | string {
  const reason = d.reason.trim();
  if (reason.length < 3) return 'Вкажіть причину: щонайменше 3 символи. Вона потрапить до аудиту.';
  const { claim, incident } = item;
  if (d.action === 'split') {
    if (!incident) return 'Твердження не входить до жодної події — виносити нічого.';
    return {
      path: `/v1/admin/incidents/${incident.id}/split`,
      body: { expectedVersion: incident.revision, reason, claimIds: [claim.id] },
    };
  }
  const path = `/v1/admin/claims/${claim.id}/review`;
  if (d.action !== 'correct') return { path, body: { action: d.action, expectedVersion: claim.version, reason } };
  const f = fieldsOf(claim, d);
  const placeId = f.placeId || null;
  // Geography basis only when the operator touched place or basis; never "fix" a record nobody asked to change.
  const geoTouched = d.placeId !== undefined || d.geoBasis !== undefined;
  const geoBasis = placeId ? f.geoBasis : 'unresolved';
  const correction = {
    ...(f.kind !== claim.kind && { kind: f.kind }),
    ...(f.threatType !== claim.threatType && { threatType: f.threatType }),
    ...(f.temporalScope !== claim.temporalScope && { temporalScope: f.temporalScope }),
    ...(placeId !== claim.placeId && { placeId }),
    ...(geoTouched && geoBasis !== claim.geoBasis && { geoBasis }),
  };
  if (!Object.keys(correction).length) return 'Змініть хоча б одне поле або оберіть іншу дію.';
  return { path, body: { action: 'correct', expectedVersion: claim.version, reason, correction } };
}

type Problem = { conflict: boolean; text: string };

export function ReviewCard(props: {
  item: ReviewItemDto;
  canAct: boolean;
  reload: () => Promise<{ data: ReviewItemDto[] } | undefined>;
  announce: (text: string) => void;
}) {
  const { item } = props;
  const { claim, message } = item;
  const id = `claim-${claim.id}`;
  const placeName = (placeId: string) => item.candidates.find((c) => c.placeId === placeId)?.name ?? placeId;
  const [draft, setDraft] = useState<Draft>({ action: 'confirm', reason: '' });
  const fields = fieldsOf(claim, draft);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [busy, setBusy] = useState(false);
  // Same submission retried (network error, 5xx) → same key; any change, incl. a new version after 409 → new key.
  const attempt = useRef<{ request: string; key: string } | null>(null);
  const problemRef = useRef<HTMLDivElement>(null);
  useEffect(() => problemRef.current?.focus(), [problem]);

  const edit = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    const req = buildRequest(item, draft);
    if (typeof req === 'string') return setProblem({ conflict: false, text: req });
    const request = JSON.stringify(req);
    setBusy(true);
    setProblem(null);
    try {
      if (attempt.current?.request !== request) attempt.current = { request, key: crypto.randomUUID() };
      await adminFetch(req.path, anyBody, {
        method: 'POST',
        body: JSON.stringify({ ...req.body, idempotencyKey: attempt.current.key }),
      });
      attempt.current = null;
      setDraft({ action: 'confirm', reason: '' }); // a record that stays queued must not resend the old decision
      props.announce(ACTIONS[draft.action].done);
      await props.reload();
    } catch (err) {
      if (hasStatus(err, 401)) return; // the guard shows the login screen; this card stays mounted with its draft
      if (hasStatus(err, 409)) {
        setProblem({ conflict: true, text: 'Запис змінено іншим оператором.' });
        const fresh = await props.reload(); // re-read the record; the draft stays in this component's state
        if (fresh && !fresh.data.some((i) => i.claim.id === claim.id))
          props.announce('Запис змінено іншим оператором, і його вже немає в черзі.');
      } else if (hasStatus(err, 403)) {
        setProblem({ conflict: false, text: 'Недостатньо прав для цієї дії (403). Потрібна роль reviewer або admin.' });
      } else {
        setProblem({ conflict: false, text: 'Не вдалося надіслати рішення. Повторна спроба безпечна: той самий ключ ідемпотентності.' });
      }
    } finally {
      setBusy(false);
    }
  }

  // The current place may come from context rather than the candidates; it must stay selectable (and clearable).
  const placeOptions = ['', ...new Set([...(claim.placeId ? [claim.placeId] : []), ...item.candidates.map((c) => c.placeId)])];
  const reasons = [...claim.uncertainty.classification, ...claim.uncertainty.geo, ...claim.uncertainty.time];
  const quantity = claim.quantity !== null ? ` × ${claim.quantity}` : claim.quantityText ? ` (${claim.quantityText})` : '';

  return (
    <article className="card" aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`}>
        {message.sourceDisplayName} · <Time iso={message.publishedAt} />
      </h2>
      <p className="hint">
        Допис №{message.messageExternalId}
        {message.messageUrl && (
          <>
            {' · '}
            <a href={message.messageUrl} target="_blank" rel="noopener noreferrer">
              відкрити в Telegram
            </a>
          </>
        )}
      </p>
      <blockquote className="post">{message.text}</blockquote>

      <h3>Поточне твердження (версія {claim.version})</h3>
      <dl className="facts">
        <dt>Тип</dt>
        <dd>{KIND[claim.kind]}</dd>
        <dt>Загроза</dt>
        <dd>
          {THREAT[claim.threatType]}
          {quantity}
          {claim.threatQualifier && `, «${claim.threatQualifier.value}»`}
        </dd>
        <dt>Час події</dt>
        <dd>{TEMPORAL[claim.temporalScope]}</dd>
        <dt>Місце</dt>
        <dd>
          {claim.placeId ? placeName(claim.placeId) : 'не визначено'} — {GEO_BASIS[claim.geoBasis]}
        </dd>
        {claim.movementMention && (
          <>
            <dt>Рух (з тексту)</dt>
            <dd>{claim.movementMention}</dd>
          </>
        )}
        <dt>Рішення системи</dt>
        <dd>{DECISION[claim.publicationDecision]}</dd>
        {item.incident && (
          <>
            <dt>Подія</dt>
            <dd>{item.incident.summary}</dd>
          </>
        )}
      </dl>

      <h3>Причини перевірки</h3>
      {reasons.length ? (
        <ul>
          {reasons.map((r) => (
            <li key={r}>{REASON[r]}</li>
          ))}
        </ul>
      ) : (
        <p>Причину не вказано.</p>
      )}

      <h3>Оцінки</h3>
      {claim.assessments.length ? (
        <table>
          <thead>
            <tr>
              <th scope="col">Питання</th>
              <th scope="col">Відповідь</th>
              <th scope="col">Підстава</th>
            </tr>
          </thead>
          <tbody>
            {claim.assessments.map((a) => (
              <tr key={a.question}>
                <th scope="row">{QUESTION[a.question] ?? a.question}</th>
                <td>{assessmentAnswer(a, placeName)}</td>
                <td>{assessmentBasis(a, claim)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p>Оцінок немає (модель не викликалась або відповідь відхилено).</p>
      )}

      <h3>Кандидати місця</h3>
      {item.candidates.length ? (
        <ul>
          {item.candidates.map((c) => (
            <li key={c.placeId}>
              {c.name}
              {c.placeId === claim.placeId && ' — обрано'}
            </li>
          ))}
        </ul>
      ) : (
        <p>Правила не знайшли жодного кандидата місця.</p>
      )}

      <details open={item.context.length > 0}>
        <summary>Контекст: {item.context.length} дописів</summary>
        <ol className="context">
          {item.context.map((m) => (
            <li key={`${m.sourceId}:${m.messageExternalId}`}>
              <p className="hint">
                {m.relation === 'reply_parent' ? 'Допис, на який відповідають' : 'Попередній допис каналу'} ·{' '}
                <Time iso={m.publishedAt} />
              </p>
              <blockquote className="post">{m.text}</blockquote>
            </li>
          ))}
        </ol>
      </details>

      {problem && (
        <div ref={problemRef} tabIndex={-1} role="alert" className={`banner ${problem.conflict ? 'warn' : 'error'}`}>
          <p>{problem.text}</p>
          {problem.conflict && (
            <p>
              Показано актуальну версію запису ({claim.version}). Вашу чернетку збережено — перевірте зміни й надішліть ще раз.
            </p>
          )}
        </div>
      )}

      {props.canAct ? (
        <form onSubmit={submit} aria-labelledby={`${id}-form`}>
          <h3 id={`${id}-form`}>Рішення</h3>
          <fieldset>
            <legend>Дія</legend>
            {(Object.keys(ACTIONS) as Action[]).map((a) => (
              <label key={a} className="choice">
                <input
                  type="radio"
                  name={`${id}-action`}
                  value={a}
                  checked={draft.action === a}
                  disabled={a === 'split' && !item.incident}
                  onChange={() => edit({ action: a })}
                />
                {ACTIONS[a].label}
                {a === 'split' && !item.incident && ' (немає події)'}
              </label>
            ))}
          </fieldset>

          {draft.action === 'correct' && (
            <fieldset>
              <legend>Виправлення</legend>
              <Select id={`${id}-kind`} label="Тип" value={fields.kind} options={ClaimKind.options} names={KIND} onChange={(kind) => edit({ kind })} />
              <Select
                id={`${id}-threat`}
                label="Загроза"
                value={fields.threatType}
                options={ThreatType.options}
                names={THREAT}
                onChange={(threatType) => edit({ threatType })}
              />
              <Select
                id={`${id}-time`}
                label="Час події"
                value={fields.temporalScope}
                options={TemporalScope.options}
                names={TEMPORAL}
                onChange={(temporalScope) => edit({ temporalScope })}
              />
              <Select
                id={`${id}-place`}
                label="Місце"
                value={fields.placeId}
                options={placeOptions}
                names={Object.fromEntries(placeOptions.map((p) => [p, p ? placeName(p) : 'не визначено']))}
                onChange={(placeId) => edit({ placeId })}
              />
              {fields.placeId && (
                <Select
                  id={`${id}-basis`}
                  label="Підстава місця"
                  value={fields.geoBasis}
                  options={GeoBasis.options.filter((g) => g !== 'unresolved')}
                  names={GEO_BASIS}
                  onChange={(geoBasis) => edit({ geoBasis })}
                />
              )}
            </fieldset>
          )}

          <label htmlFor={`${id}-reason`}>Причина (обов'язково, потрапляє до аудиту)</label>
          <textarea
            id={`${id}-reason`}
            rows={2}
            required
            minLength={3}
            maxLength={1000}
            value={draft.reason}
            onChange={(e) => edit({ reason: e.target.value })}
          />
          <button type="submit" disabled={busy}>
            {busy ? 'Надсилання…' : 'Надіслати рішення'}
          </button>
        </form>
      ) : (
        <p className="hint">Ваша роль дозволяє лише перегляд; рішення ухвалюють reviewer або admin.</p>
      )}
    </article>
  );
}

function Select<T extends string>(props: {
  id: string;
  label: string;
  value: T;
  options: readonly T[];
  names: Record<string, string>;
  onChange: (v: T) => void;
}) {
  return (
    <>
      <label htmlFor={props.id}>{props.label}</label>
      <select id={props.id} value={props.value} onChange={(e) => props.onChange(e.target.value as T)}>
        {props.options.map((o) => (
          <option key={o} value={o}>
            {props.names[o] ?? o}
          </option>
        ))}
      </select>
    </>
  );
}
