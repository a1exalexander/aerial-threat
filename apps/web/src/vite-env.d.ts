/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Public API base URL, e.g. http://localhost:3000. Only VITE_* values reach the bundle. */
  readonly VITE_API_URL?: string;
  /** "1" enables msw mocks in `vite dev`. */
  readonly VITE_MOCKS?: string;
}
