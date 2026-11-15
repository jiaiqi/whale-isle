import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['packages/*/src/**/*.spec.ts', 'tools/*/src/**/*.spec.ts', 'apps/*/src/**/*.spec.ts', 'apps/*/e2e/**/*.spec.ts'],
    coverage: {
      enabled: true,
      provider: 'v8',
      include: ['packages/*/src/**/*.ts', 'tools/*/src/**/*.ts', 'apps/*/src/**/*.ts'],
      // Electron 主进程/preload/装配层由 E2E 运行覆盖（v8 无法计入 Electron 进程），排除出统计
      exclude: [
        '**/*.spec.ts',
        '**/dist/**',
        '**/fixtures/**',
        '**/pet-renderer/src/index.ts',
        '**/desktop-host/src/main/**',
        '**/desktop-host/src/preload/**',
        '**/desktop-host/src/renderer/pet-stage/main.ts',
      ],
      // Gate 3 硬指标（AGENTS.md §3.3）：分支覆盖率 ≥90%
      thresholds: { lines: 90, functions: 90, branches: 90, statements: 90 },
    },
  },
});
