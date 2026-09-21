import { setupWorker } from 'msw/browser';
import { situationHandlers } from './situation/handlers';

export const worker = setupWorker(...situationHandlers);
