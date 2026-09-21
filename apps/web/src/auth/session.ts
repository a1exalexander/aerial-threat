import { useSyncExternalStore } from 'react';

export type Role = 'viewer' | 'reviewer' | 'admin';
const ROLES: readonly string[] = ['viewer', 'reviewer', 'admin'] satisfies Role[];

export type Session = {
  /** Bearer access token. Kept in memory only: never localStorage/sessionStorage. */
  token: string;
  via: 'oidc' | 'dev';
  subject: string | null;
  /** From the token's `roles` claim, for UI gating only (the server enforces). null = no such claim, unknown. */
  roles: Role[] | null;
};
/** expired: the server said 401. signedOut: the operator pressed «Вийти», so the next OIDC login asks for credentials. */
export type SessionState = { session: Session | null; expired: boolean; signedOut: boolean };

let state: SessionState = { session: null, expired: false, signedOut: false };
const listeners = new Set<() => void>();
const set = (next: SessionState) => {
  state = next;
  listeners.forEach((l) => l());
};

/** Decodes a JWT payload without verifying it: the signature is the server's job. */
export function readClaims(token: string): Pick<Session, 'subject' | 'roles'> {
  try {
    const part = token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(part), (c) => c.charCodeAt(0))));
    const roles: unknown = payload.roles;
    return {
      subject: typeof payload.sub === 'string' ? payload.sub : null,
      roles: Array.isArray(roles) ? (roles.filter((r) => ROLES.includes(r)) as Role[]) : null, // other claim layouts: unknown
    };
  } catch {
    return { subject: null, roles: null };
  }
}

export function signIn(token: string, via: Session['via']) {
  set({ session: { token, via, ...readClaims(token) }, expired: false, signedOut: false });
}

/** `expired` shows «сесія завершилась» on the login screen (401 from the server). */
export function signOut(expired = false) {
  set({ session: null, expired, signedOut: !expired });
}

export const currentToken = () => state.session?.token ?? null;

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
export const useSession = () => useSyncExternalStore(subscribe, () => state);

/** Reviewer actions: hidden for a known viewer-only token; shown when roles are unknown and left to the server. */
export const canReview = (s: Session) => s.roles === null || s.roles.includes('reviewer') || s.roles.includes('admin');
