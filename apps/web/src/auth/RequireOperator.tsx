import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { completeOidcLogin, isOidcCallback, oidcEnabled, oidcLogin } from './oidc';
import { signIn, signOut, useSession, type Session } from './session';

const rolesText = (roles: Session['roles']) =>
  roles === null ? 'невідомі (перевіряє сервер)' : roles.length ? roles.join(', ') : 'немає';

/** UI guard for operator routes. It only hides screens; every /v1/admin request is authorised by the server. */
export function RequireOperator({ title, children }: { title: string; children: ReactNode }) {
  const { session, expired, signedOut } = useSession();
  // After a 401 the screen stays mounted but hidden, so open drafts survive the re-login.
  const wasIn = useRef(false);
  if (session) wasIn.current = true;
  if (signedOut) wasIn.current = false;
  const navigate = useNavigate();
  const [finishing, setFinishing] = useState(isOidcCallback);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!finishing) return;
    completeOidcLogin()
      .then((to) => navigate(to, { replace: true }))
      .catch(() => setError('Не вдалося завершити вхід через OIDC. Спробуйте ще раз.'))
      .finally(() => setFinishing(false));
  }, [finishing, navigate]);

  if (finishing) return <p role="status">Завершуємо вхід…</p>;
  return (
    <>
      {!session && <Login title={title} expired={expired} forceLogin={signedOut} error={error} onError={setError} />}
      {(session || (expired && wasIn.current)) && (
        <div className="admin" hidden={!session}>
          {session && (
            <p className="operator-bar">
              <span>
                Оператор: <strong>{session.subject ?? 'невідомий'}</strong> · ролі: {rolesText(session.roles)}
                {session.via === 'dev' && ' · dev-токен'}
              </span>
              <button type="button" onClick={() => signOut()}>
                Вийти
              </button>
            </p>
          )}
          {children}
        </div>
      )}
    </>
  );
}

function Login(props: {
  title: string;
  expired: boolean;
  forceLogin: boolean;
  error: string | null;
  onError: (e: string) => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const location = useLocation();
  useEffect(() => heading.current?.focus(), []);
  return (
    <section className="admin" aria-labelledby="login-heading">
      <h1 id="login-heading" tabIndex={-1} ref={heading}>
        {props.title}: потрібен вхід
      </h1>
      <p>Розділ доступний лише операторам. Права перевіряє сервер на кожен запит.</p>
      {props.expired && (
        <p role="alert" className="banner warn">
          Сесія завершилась або токен недійсний. Увійдіть знову.
        </p>
      )}
      {props.error && (
        <p role="alert" className="banner error">
          {props.error}
        </p>
      )}
      {oidcEnabled && (
        <button
          type="button"
          onClick={() =>
            oidcLogin(location.pathname, props.forceLogin).catch(() => props.onError('Сервер входу недоступний. Спробуйте пізніше.'))
          }
        >
          Увійти через OIDC
        </button>
      )}
      {import.meta.env.DEV && <DevTokenForm />}
      {!oidcEnabled && !import.meta.env.DEV && (
        <p className="banner warn">Вхід не налаштовано: задайте VITE_OIDC_AUTHORITY і VITE_OIDC_CLIENT_ID.</p>
      )}
    </section>
  );
}

/** Dev builds only (`import.meta.env.DEV` is false in production bundles, so this is dropped). */
function DevTokenForm() {
  const [token, setToken] = useState('');
  return (
    <form
      className="card"
      onSubmit={(e) => {
        e.preventDefault();
        if (token.trim()) signIn(token.trim(), 'dev');
      }}
    >
      <h2>Dev-вхід за токеном</h2>
      <label htmlFor="dev-token">Bearer-токен</label>
      <p id="dev-token-hint" className="hint">
        Лише для локальної розробки: <code>pnpm --filter @aerial/worker cli mint-dev-token</code>. Токен живе лише в пам'яті
        вкладки.
      </p>
      <textarea
        id="dev-token"
        aria-describedby="dev-token-hint"
        rows={3}
        required
        autoComplete="off"
        spellCheck={false}
        value={token}
        onChange={(e) => setToken(e.target.value)}
      />
      <button type="submit">Увійти з токеном</button>
    </form>
  );
}
