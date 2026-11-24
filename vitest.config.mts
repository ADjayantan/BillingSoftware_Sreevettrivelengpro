import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Each DB test file boots its own in-memory Postgres (PGlite): a few seconds per file.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
