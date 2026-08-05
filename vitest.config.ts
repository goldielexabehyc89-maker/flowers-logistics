import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['apps/**/*.test.ts', 'packages/**/*.test.ts', 'deploy/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/generated/**', 'e2e/**'],
    passWithNoTests: false,
  },
});
