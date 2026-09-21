import { describe, expect, it } from 'vitest';
import { EnvError, loadApiEnv, loadWorkerEnv } from './index';

const DATABASE_URL = 'postgres://aerial:aerial@localhost:54329/aerial';

describe('env', () => {
  it('applies defaults and splits CORS origins', () => {
    const env = loadApiEnv({ DATABASE_URL, CORS_ORIGINS: 'http://a.test, http://b.test', OIDC_ISSUER: '' });
    expect(env).toMatchObject({ APP_ENV: 'local', API_PORT: 3000, CORS_ORIGINS: ['http://a.test', 'http://b.test'] });
    expect(env.OIDC_ISSUER).toBeUndefined();
  });

  it('fails fast naming keys without echoing secret values', () => {
    const secret = 'not-a-url-but-a-secret-value';
    const run = () => loadWorkerEnv({ DATABASE_URL: secret, AI_CONCURRENCY: '0' });
    expect(run).toThrow(EnvError);
    expect(run).toThrow(/DATABASE_URL[\s\S]*AI_CONCURRENCY/);
    expect(run).not.toThrow(new RegExp(secret));
  });
});
