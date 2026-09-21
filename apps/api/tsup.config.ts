import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts'],
  format: 'esm',
  platform: 'node',
  target: 'node22',
  clean: true,
  // Workspace packages are TS source, so bundle them. Deps declared in this package.json stay external;
  // npm deps reached only through workspace packages (drizzle, postgres, pino, zod) are bundled.
  noExternal: [/^@aerial\//],
  // Lets bundled CommonJS code require Node built-ins from ESM output.
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});
