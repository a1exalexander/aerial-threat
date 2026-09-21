import { InMemoryWebStorage, UserManager, WebStorageStateStore } from 'oidc-client-ts';
import { signIn } from './session';

const authority = import.meta.env.VITE_OIDC_AUTHORITY;
const clientId = import.meta.env.VITE_OIDC_CLIENT_ID;
/** The one redirect URI to register at the IdP; the page to return to travels in `state`. */
const CALLBACK_PATH = '/review';

export const oidcEnabled = Boolean(authority && clientId);

let manager: UserManager | undefined;
function userManager() {
  manager ??= new UserManager({
    authority: authority!,
    client_id: clientId!,
    redirect_uri: `${location.origin}${CALLBACK_PATH}`,
    response_type: 'code', // authorization code + PKCE (S256), no client secret
    scope: import.meta.env.VITE_OIDC_SCOPE || 'openid profile', // add the API scope if the IdP needs one for our audience
    automaticSilentRenew: false, // expiry → 401 → login again
    // Tokens stay in memory; only the short-lived PKCE verifier/state goes to storage across the redirect.
    userStore: new WebStorageStateStore({ store: new InMemoryWebStorage() }),
  });
  return manager;
}

/** `forceLogin` after an explicit sign-out: the IdP session would otherwise log the same account straight back in. */
export function oidcLogin(returnTo: string, forceLogin: boolean) {
  return userManager().signinRedirect({ state: returnTo, ...(forceLogin && { prompt: 'login' }) });
}

export function isOidcCallback() {
  const p = new URLSearchParams(location.search);
  return oidcEnabled && p.has('state') && (p.has('code') || p.has('error'));
}

let callback: Promise<string> | undefined;
/** Finishes the IdP redirect once (StrictMode runs effects twice) and returns the path to go back to. */
export function completeOidcLogin() {
  callback ??= userManager()
    .signinRedirectCallback()
    .then((user) => {
      signIn(user.access_token, 'oidc');
      return typeof user.state === 'string' && user.state.startsWith('/') ? user.state : CALLBACK_PATH;
    });
  return callback;
}
