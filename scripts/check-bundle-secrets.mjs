#!/usr/bin/env node
// Fails (exit 1) if a built web bundle contains server env names or obvious secrets (doc 08: secrets never reach
// build artifacts). Usage: node scripts/check-bundle-secrets.mjs apps/web/dist
// Hits are printed as file + rule + offset only, never the matched value.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const RULES = {
  // Server-only env names (packages/config, docker-compose.prod.yml). VITE_* names are public by design;
  // the leading \b skips them because `_` is a word character (VITE_OIDC_ISSUER does not match).
  'server env name': /\b(?:DATABASE_URL|AI_GATEWAY_API_KEY|DEV_JWT_KEY|POSTGRES_PASSWORD|TELEGRAM_[A-Z_]+|OIDC_(?:CLIENT_SECRET|ISSUER|AUDIENCE|JWKS_URL))\b/g,
  'postgres URL with password': /postgres(?:ql)?:\/\/[^\s:@/'"`]+:[^\s@/'"`]+@/g,
  'private key': /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  'AI Gateway key': /\bvck_[A-Za-z0-9]{20,}/g,
  'API secret key': /\bsk-[A-Za-z0-9_-]{20,}/g,
  'GitHub token': /\bgh[pousr]_[A-Za-z0-9]{36,}/g,
  'AWS access key': /\bAKIA[0-9A-Z]{16}\b/g,
};

const dir = process.argv[2];
if (!dir) {
  console.error('usage: node scripts/check-bundle-secrets.mjs <built-web-dir>');
  process.exit(2);
}

let files;
try {
  files = (await readdir(dir, { recursive: true, withFileTypes: true })).filter((e) => e.isFile());
} catch (err) {
  console.error(`cannot read ${dir}: ${err.message}`);
  process.exit(2);
}
if (files.length === 0) {
  console.error(`${dir} is empty; build the web app first`);
  process.exit(2);
}

let hits = 0;
for (const f of files) {
  const path = join(f.parentPath, f.name);
  const text = await readFile(path, 'latin1'); // byte-preserving; every rule is ASCII
  for (const [rule, re] of Object.entries(RULES)) {
    for (const m of text.matchAll(re)) {
      hits++;
      const name = rule === 'server env name' ? ` (${m[0]})` : ''; // a name is safe to print; a value never is
      console.error(`${path}: ${rule}${name} at offset ${m.index}`);
    }
  }
}

if (hits) {
  console.error(`check-bundle-secrets: ${hits} hit(s) in ${dir}`);
  process.exit(1);
}
console.log(`check-bundle-secrets: ${files.length} files in ${dir}, no server secrets`);
