import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  // One .env at the repo root; Vite exposes only VITE_* keys to the bundle.
  envDir: '../..',
  test: { environment: 'jsdom', setupFiles: ['./src/test/setup.ts'] },
});
