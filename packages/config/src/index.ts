// Server env only. The web app never imports this package (see eslint boundaries).
import { z } from 'zod';

const csv = z
  .string()
  .default('')
  .transform((s) =>
    s
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean),
  );
const optional = z
  .string()
  .optional()
  .transform((v) => v || undefined); // empty string in .env means "not set"

const base = {
  APP_ENV: z.enum(['local', 'test', 'staging', 'production']).default('local'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
};

export const ApiEnv = z.object({
  ...base,
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  CORS_ORIGINS: csv,
  OIDC_ISSUER: optional,
  OIDC_AUDIENCE: optional,
  OIDC_JWKS_URL: optional,
});
export type ApiEnv = z.infer<typeof ApiEnv>;

export const WorkerEnv = z.object({
  ...base,
  AI_GATEWAY_API_KEY: optional,
  AI_MODEL_ID: z.string().default('typesafe-ai/jev'),
  AI_DAILY_REQUEST_LIMIT: z.coerce.number().int().nonnegative().default(1000),
  AI_CONCURRENCY: z.coerce.number().int().positive().default(2),
  TELEGRAM_API_ID: optional,
  TELEGRAM_API_HASH: optional,
  TELEGRAM_SESSION_SECRET_REF: optional,
  NEPTUN_BASE_URL: z.url().default('https://neptun.in.ua'),
});
export type WorkerEnv = z.infer<typeof WorkerEnv>;

export class EnvError extends Error {
  override name = 'EnvError';
}

/** Parses env or throws an EnvError naming the bad keys. Values are never echoed (they may be secrets). */
export function parseEnv<S extends z.ZodType>(schema: S, source: Record<string, string | undefined> = process.env): z.infer<S> {
  const result = schema.safeParse(source);
  if (result.success) return result.data;
  const lines = result.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`);
  throw new EnvError(`Invalid environment:\n${lines.join('\n')}`);
}

export const loadApiEnv = (source?: Record<string, string | undefined>) => parseEnv(ApiEnv, source);
export const loadWorkerEnv = (source?: Record<string, string | undefined>) => parseEnv(WorkerEnv, source);
