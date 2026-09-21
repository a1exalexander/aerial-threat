import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeJwt } from 'jose';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { run } from './mint-dev-token';

let dir: string;
let out: string[];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aerial-mint-'));
  vi.stubEnv('DEV_JWT_KEY_FILE', join(dir, 'key.json'));
  out = [];
  vi.spyOn(console, 'log').mockImplementation((line: string) => void out.push(line));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

it('refuses outside local/test (and under NODE_ENV=production) without creating a key', async () => {
  for (const appEnv of ['staging', 'production', 'bogus']) {
    vi.stubEnv('APP_ENV', appEnv);
    expect(await run(['--role', 'admin'])).toBe(1);
  }
  vi.stubEnv('APP_ENV', 'local');
  vi.stubEnv('NODE_ENV', 'production');
  expect(await run(['--role', 'admin'])).toBe(1);
  await expect(stat(join(dir, 'key.json'))).rejects.toThrow();
  expect(out).toEqual([]);
});

it('mints a dev token with the role and subject, reusing one private key file', async () => {
  vi.stubEnv('APP_ENV', 'test');
  expect(await run(['--role', 'reviewer', '--sub', 'alice'])).toBe(0);
  expect(decodeJwt(out[0]!)).toMatchObject({ iss: 'aerial-dev', aud: 'aerial-api-dev', sub: 'alice', roles: ['reviewer'] });
  expect((await stat(join(dir, 'key.json'))).mode & 0o777).toBe(0o600);
  expect(await run([])).toBe(0);
  expect(decodeJwt(out[1]!)).toMatchObject({ roles: ['viewer'] });
  expect(await run(['--role', 'root'])).toBe(1);
  expect(await run(['--nope'])).toBe(1);
  expect(await run(['--ttl', 'soon'])).toBe(1);
});
