import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { pino, type DestinationStream, type Logger } from 'pino';

export type { Logger };

// Message texts, provider payloads, credentials and sessions never reach logs.
const SENSITIVE = [
  'rawText',
  'normalizedText',
  'cleanedText',
  'raw_text',
  'normalized_text',
  'cleaned_text',
  'rawPayload',
  'raw_payload',
  'text',
  'prompt',
  'token',
  'accessToken',
  'idToken',
  'refreshToken',
  'apiKey',
  'password',
  'session',
  'sessionString',
  'authorization',
  'cookie',
  'DATABASE_URL',
  'AI_GATEWAY_API_KEY',
  'TELEGRAM_API_HASH',
];
export const REDACT_PATHS = [
  ...SENSITIVE,
  ...SENSITIVE.map((k) => `*.${k}`),
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  'headers.cookie',
];

const traceStore = new AsyncLocalStorage<{ traceId: string }>();

/** Runs fn with a trace ID (a new one when omitted); every log line inside carries it. */
export function withTrace<T>(traceId: string | undefined, fn: () => T): T {
  return traceStore.run({ traceId: traceId ?? randomUUID() }, fn);
}

export const getTraceId = (): string | undefined => traceStore.getStore()?.traceId;

export function createLogger(opts: { name: string; level?: string }, destination?: DestinationStream): Logger {
  return pino(
    {
      name: opts.name,
      level: opts.level ?? 'info',
      redact: { paths: REDACT_PATHS, censor: '[redacted]' },
      mixin: () => {
        const traceId = getTraceId();
        return traceId ? { traceId } : {};
      },
    },
    destination,
  );
}
