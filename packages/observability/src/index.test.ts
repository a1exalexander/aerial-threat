import { describe, expect, it } from 'vitest';
import { createLogger, getTraceId, withTrace } from './index';

function capture() {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({ name: 't' }, { write: (s: string) => void lines.push(JSON.parse(s)) });
  return { logger, lines };
}

describe('observability', () => {
  it('redacts message text, payloads and credentials', () => {
    const { logger, lines } = capture();
    logger.info({ rawText: 'secret text', msg2: { rawPayload: { a: 1 } }, req: { headers: { authorization: 'Bearer x' } } }, 'hi');
    expect(JSON.stringify(lines)).not.toMatch(/secret text|Bearer x|"a":1/);
  });

  it('propagates trace IDs through async work', async () => {
    const { logger, lines } = capture();
    await withTrace('trace-1', async () => {
      await new Promise((r) => setTimeout(r, 1));
      logger.info('inside');
      expect(getTraceId()).toBe('trace-1');
    });
    logger.info('outside');
    expect(lines.map((l) => l.traceId)).toEqual(['trace-1', undefined]);
  });
});
