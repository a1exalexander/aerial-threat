// Test-only helpers (never imported by main.ts): a throwaway dev key file and a JWT signer.
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type CryptoKey, SignJWT, exportJWK, generateKeyPair } from 'jose';
import { DEV_AUDIENCE, DEV_ISSUER } from './index';

type TokenOptions = { roles?: string[]; sub?: string | null; iss?: string; aud?: string; exp?: number | string; kid?: string };

export function signToken(key: CryptoKey, { roles, sub = 'alice', iss = DEV_ISSUER, aud = DEV_AUDIENCE, exp = '5m', kid }: TokenOptions) {
  const jwt = new SignJWT(roles ? { roles } : {})
    .setProtectedHeader({ alg: 'ES256', ...(kid ? { kid } : {}) })
    .setIssuer(iss)
    .setAudience(aud)
    .setIssuedAt()
    .setExpirationTime(exp);
  return (sub ? jwt.setSubject(sub) : jwt).sign(key);
}

/** Writes a fresh dev key to a temp file, points DEV_JWT_KEY_FILE at it and returns a dev-token signer. */
export async function useDevKey() {
  const { privateKey } = await generateKeyPair('ES256', { extractable: true });
  const file = join(await mkdtemp(join(tmpdir(), 'aerial-dev-key-')), 'key.json');
  await writeFile(file, JSON.stringify(await exportJWK(privateKey)));
  process.env.DEV_JWT_KEY_FILE = file;
  return (opts: TokenOptions = {}) => signToken(privateKey, opts);
}
