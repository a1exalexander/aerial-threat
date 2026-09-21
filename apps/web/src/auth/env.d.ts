interface ImportMetaEnv {
  /** OIDC issuer URL for operator login (public value). Unset = OIDC login hidden. */
  readonly VITE_OIDC_AUTHORITY?: string;
  /** Public OIDC client ID (PKCE, no secret). */
  readonly VITE_OIDC_CLIENT_ID?: string;
  /** Requested scopes, default "openid profile"; add the API scope when the IdP needs it to issue our audience. */
  readonly VITE_OIDC_SCOPE?: string;
}
