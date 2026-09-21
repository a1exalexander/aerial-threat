// Shared flat config. The repo-root eslint.config.js re-exports it, so `files` globs are root-relative.
import { builtinModules } from 'node:module';
import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// ponytail: no-restricted-imports matches import strings, not resolved paths; a relative
// cross-app import that never spells "apps/" slips through (pnpm strictness blocks package-name ones).
const noAppImports = {
  group: ['@aerial/api', '@aerial/api/**', '@aerial/worker', '@aerial/worker/**', '@aerial/web', '@aerial/web/**', '**/apps/**'],
  message: 'Apps must not import other apps; move shared code into packages/*.',
};

export default defineConfig(
  { ignores: ['**/dist/**', '**/.turbo/**', '**/coverage/**', '**/node_modules/**', '**/public/mockServiceWorker.js'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    languageOptions: { globals: globals.node },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-restricted-imports': ['error', { patterns: [noAppImports] }],
    },
  },
  {
    // The browser bundle may only see public contracts and static geometry.
    files: ['apps/web/**'],
    languageOptions: { globals: globals.browser },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: builtinModules.map((name) => ({ name, message: 'Node built-ins are not allowed in the web app.' })),
          patterns: [
            noAppImports,
            {
              regex: '^@aerial/(?!(contracts|geo/geometry)$)',
              message: 'apps/web may import only @aerial/contracts and @aerial/geo/geometry from the workspace.',
            },
            { group: ['node:*'], message: 'Node built-ins are not allowed in the web app.' },
          ],
        },
      ],
    },
  },
);
