import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['packages/*/src/**/*.spec.ts', 'tools/*/src/**/*.spec.ts'],
    // 覆盖率门槛（Gate 3 ≥90%）自 T-M0-03 起随包接入时启用 coverage 配置
  },
});
