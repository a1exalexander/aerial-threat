import { adminHandlers } from './admin/handlers';
import { publicHandlers } from './public/handlers';

export const handlers = [...publicHandlers, ...adminHandlers];
