/**
 * Electron 宿主 E2E 专用配置（[E2E-HOST]）。
 *
 * 与主配置分离的原因：宿主 E2E 依赖 `apps/desktop-host/dist` 且会启动真实 Electron，
 * 不适合留在 `pnpm test`（Gate 3 确定性单测）里；由 verify-gate 的 Gate 4 与 CI macOS job
 * 显式调用：
 *   pnpm exec vitest run --config vitest.e2e.config.mts apps/desktop-host/e2e/gate4-loopback.spec.ts
 *   pnpm exec vitest run --config vitest.e2e.config.mts apps/desktop-host/e2e/desktop.e2e.spec.ts apps/desktop-host/e2e/ui.e2e.spec.ts
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['apps/*/e2e/**/*.spec.ts'],
    // 每个 spec 都会启动真实 Electron 并争用 18780/18765 等回环端口；串行执行避免多实例互相干扰
    // （曾出现透明穿透 Alt 态在并行跑时偶发读回 opacity=1）。
    fileParallelism: false,
    // E2E 不计入覆盖率门槛（v8 也无法统计 Electron 渲染/主进程），覆盖率只看 Gate 3。
    coverage: { enabled: false },
  },
});
