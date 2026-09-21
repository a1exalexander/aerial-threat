import { setupServer } from 'msw/node';
import { handlers } from './handlers';

/** Same handlers for vitest (jsdom); started in src/test/setup.ts. */
export const server = setupServer(...handlers);
