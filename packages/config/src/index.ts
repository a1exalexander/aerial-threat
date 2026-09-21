// Server env only. The web app never imports this package (see eslint boundaries).
import { z } from 'zod';

/** Comma list; unset or empty means `fallback`. */
const list = (fallback = '') =>
  z
    .string()
    .optional()
    .transform((s) =>
      (s || fallback)
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean),
    );
const seconds = (fallback: number) => z.coerce.number().int().positive().default(fallback);
const optional = z
  .string()
  .optional()
  .transform((v) => v || undefined); // empty string in .env means "not set"

const base = {
  APP_ENV: z.enum(['local', 'test', 'staging', 'production']).default('local'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  /** Telegram channels of the Kremenchuk screen (usernames or bare channel IDs): the API feed and the AI window. */
  KREMENCHUK_SOURCES: list('h_kremenchug,2432204405'),
};

export const ApiEnv = z.object({
  ...base,
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  CORS_ORIGINS: list(),
  OIDC_ISSUER: optional,
  OIDC_AUDIENCE: optional,
  OIDC_JWKS_URL: optional,
});
export type ApiEnv = z.infer<typeof ApiEnv>;

export const AiEvaluatorKind = z.enum(['fake', 'gateway']);
export type AiEvaluatorKind = z.infer<typeof AiEvaluatorKind>;

export const WorkerEnv = z.object({
  ...base,
  AI_GATEWAY_API_KEY: optional,
  /** Unset: resolved by loadWorkerEnv (gateway only with a key and outside tests). */
  AI_EVALUATOR: z.preprocess((v) => v || undefined, AiEvaluatorKind.optional()),
  AI_MODEL_ID: z.string().default('typesafe-ai/jev'),
  AI_DAILY_REQUEST_LIMIT: z.coerce.number().int().nonnegative().default(1000),
  AI_CONCURRENCY: z.coerce.number().int().positive().default(2),
  TELEGRAM_API_ID: optional,
  TELEGRAM_API_HASH: optional,
  TELEGRAM_SESSION_SECRET_REF: optional,
  /** Live collector allowlist (usernames). */
  TELEGRAM_CHANNELS: list('ppo_energy_poltava,h_kremenchug'),
  NEPTUN_BASE_URL: z.url().default('https://neptun.in.ua'),
  /** Situation cadence: AI at most this often during an alert (on new posts). */
  SITUATION_ALERT_INTERVAL_S: seconds(60),
  /** Situation cadence: AI at most this often without an alert (on new posts). */
  SITUATION_QUIET_AI_INTERVAL_S: seconds(3600),
  /** Situation cadence: free rules snapshot. */
  SITUATION_RULES_INTERVAL_S: seconds(60),
});
export type WorkerEnv = Omit<z.infer<typeof WorkerEnv>, 'AI_EVALUATOR'> & { AI_EVALUATOR: AiEvaluatorKind };

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
export function loadWorkerEnv(source?: Record<string, string | undefined>): WorkerEnv {
  const env = parseEnv(WorkerEnv, source);
  // Never the paid gateway by accident: it needs a key and is off in tests unless AI_EVALUATOR says otherwise.
  return { ...env, AI_EVALUATOR: env.AI_EVALUATOR ?? (env.AI_GATEWAY_API_KEY && env.APP_ENV !== 'test' ? 'gateway' : 'fake') };
}
