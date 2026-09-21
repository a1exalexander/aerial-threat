import { describe, expect, it } from 'vitest';
import { backoffMs } from './queue';

describe('backoffMs', () => {
  it('doubles per attempt with jitter in [base/2, base] and caps at 10 minutes', () => {
    expect(backoffMs(1, () => 0)).toBe(500);
    expect(backoffMs(1, () => 1)).toBe(1000);
    expect(backoffMs(4, () => 1)).toBe(8000);
    expect(backoffMs(50, () => 1)).toBe(600_000);
  });
});
