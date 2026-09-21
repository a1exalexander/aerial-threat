import type { Loop } from './index';

/** Owned by the live Telegram collector unit. Placeholder: returns immediately until implemented. */
export const telegramLoop: Loop = {
  name: 'telegram',
  start: async () => {},
  stop: async () => {},
};
