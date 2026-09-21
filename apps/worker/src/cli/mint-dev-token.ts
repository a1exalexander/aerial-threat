// `cli mint-dev-token --role reviewer --sub alice`: prints an operator JWT signed with the local dev key.
// Refuses outside APP_ENV local/test, and the API accepts these tokens only there too. The ES256 key lives in
// DEV_JWT_KEY_FILE, default `.dev-jwt-key.json` at the workspace root (gitignored), created on first use.
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { WorkerEnv } from '@aerial/config';
import { type JWK, SignJWT, exportJWK, generateKeyPair, importJWK } from 'jose';

// Must match apps/api/src/auth/index.ts, which verifies these tokens.
const DEV_ISSUER = 'aerial-dev';
const DEV_AUDIENCE = 'aerial-api-dev';
const ROLES = ['viewer', 'reviewer', 'admin'];
const USAGE = 'usage: cli mint-dev-token [--role viewer|reviewer|admin] [--sub <operator id>] [--ttl 12h]';

function devKeyFile(): string {
  if (process.env.DEV_JWT_KEY_FILE) return process.env.DEV_JWT_KEY_FILE;
  for (let dir = process.cwd(); dirname(dir) !== dir; dir = dirname(dir)) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return join(dir, '.dev-jwt-key.json');
  }
  return resolve('.dev-jwt-key.json');
}

async function loadOrCreateKey(file: string): Promise<JWK> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as JWK;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const { privateKey } = await generateKeyPair('ES256', { extractable: true });
  const jwk = await exportJWK(privateKey);
  await writeFile(file, JSON.stringify(jwk), { flag: 'wx', mode: 0o600 });
  console.error(`mint-dev-token: created dev key ${file}`);
  return jwk;
}

export async function run(argv: string[]): Promise<number> {
  const appEnv = WorkerEnv.shape.APP_ENV.safeParse(process.env.APP_ENV).data;
  if ((appEnv !== 'local' && appEnv !== 'test') || process.env.NODE_ENV === 'production') {
    console.error(`mint-dev-token: refused, APP_ENV=${process.env.APP_ENV ?? ''} NODE_ENV=${process.env.NODE_ENV ?? ''} (local/test only)`);
    return 1;
  }
  let values: { role: string; sub: string; ttl: string };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        role: { type: 'string', default: 'viewer' },
        sub: { type: 'string', default: 'dev-operator' },
        ttl: { type: 'string', default: '12h' },
      },
    }));
  } catch (err) {
    console.error(`${(err as Error).message}\n${USAGE}`);
    return 1;
  }
  if (!ROLES.includes(values.role)) {
    console.error(`mint-dev-token: unknown role "${values.role}"\n${USAGE}`);
    return 1;
  }
  let jwt: SignJWT;
  try {
    jwt = new SignJWT({ roles: [values.role] }).setExpirationTime(values.ttl);
  } catch {
    console.error(`mint-dev-token: invalid --ttl "${values.ttl}"\n${USAGE}`);
    return 1;
  }
  const key = await importJWK(await loadOrCreateKey(devKeyFile()), 'ES256');
  const token = await jwt
    .setProtectedHeader({ alg: 'ES256' })
    .setIssuer(DEV_ISSUER)
    .setAudience(DEV_AUDIENCE)
    .setSubject(values.sub)
    .setIssuedAt()
    .sign(key);
  console.log(token);
  return 0;
}
