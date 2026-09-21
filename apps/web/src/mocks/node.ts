import { setupServer } from 'msw/node';
import { situationHandlers } from './situation/handlers';

/** Same handlers for vitest (jsdom); started in src/test/setup.ts. */
export const server = setupServer(...situationHandlers);
