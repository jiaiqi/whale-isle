import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['packages/*/src/**/*.spec.ts', 'tools/*/src/**/*.spec.ts'],
    coverage: {
      enabled: true,
      provider: 'v8',
      include: ['packages/*/src/**', 'tools/*/src/**'],
      exclude: ['**/*.spec.ts', '**/dist/**', '**/fixtures/**'],
      // Gate 3 硬指标（AGENTS.md §3.3）：分支覆盖率 ≥90%
      thresholds: { lines: 90, functions: 90, branches: 90, statements: 90 },
    },
  },
});
