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

  it('defaults the Kremenchuk sources, channels and situation cadence; empty means default', () => {
    const env = loadWorkerEnv({ DATABASE_URL, TELEGRAM_CHANNELS: '', SITUATION_RULES_INTERVAL_S: '30' });
    expect(env).toMatchObject({
      KREMENCHUK_SOURCES: ['h_kremenchug', '2432204405'],
      TELEGRAM_CHANNELS: ['ppo_energy_poltava', 'h_kremenchug'],
      SITUATION_ALERT_INTERVAL_S: 60,
      SITUATION_QUIET_AI_INTERVAL_S: 3600,
      SITUATION_RULES_INTERVAL_S: 30,
    });
    expect(loadApiEnv({ DATABASE_URL, KREMENCHUK_SOURCES: ' a , 1 ' }).KREMENCHUK_SOURCES).toEqual(['a', '1']);
    expect(() => loadWorkerEnv({ DATABASE_URL, SITUATION_ALERT_INTERVAL_S: '0' })).toThrow(/SITUATION_ALERT_INTERVAL_S/);
  });

  it('picks the gateway evaluator only with a key and outside tests, unless set explicitly', () => {
    const evaluator = (over: Record<string, string>) => loadWorkerEnv({ DATABASE_URL, ...over }).AI_EVALUATOR;
    expect(evaluator({})).toBe('fake');
    expect(evaluator({ AI_EVALUATOR: '' })).toBe('fake');
    expect(evaluator({ AI_GATEWAY_API_KEY: 'k' })).toBe('gateway');
    expect(evaluator({ AI_GATEWAY_API_KEY: 'k', APP_ENV: 'test' })).toBe('fake');
    expect(evaluator({ AI_GATEWAY_API_KEY: 'k', AI_EVALUATOR: 'fake' })).toBe('fake');
    expect(evaluator({ APP_ENV: 'test', AI_EVALUATOR: 'gateway' })).toBe('gateway');
    expect(() => evaluator({ AI_EVALUATOR: 'openai' })).toThrow(/AI_EVALUATOR/);
  });
});
