import type { Loop } from './index';

/** Owned by the ops unit (retention: raw 30 d, aggregates/audit 180 d). Placeholder: returns immediately until implemented. */
export const retentionLoop: Loop = {
  name: 'retention',
  start: async () => {},
  stop: async () => {},
};
