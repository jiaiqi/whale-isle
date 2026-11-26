import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Gate 3 只跑确定性单元/契约测试。Electron 宿主 E2E（apps/*/e2e/**）依赖先构建 dist，
    // 由 CI 的 macOS job 与 `pnpm exec vitest run apps/desktop-host/e2e` 单独执行；
    // Gate 4 的 gate4-loopback 由 verify-gate.mjs 显式点名运行，不受此 include 影响。
    include: ['packages/*/src/**/*.spec.ts', 'tools/*/src/**/*.spec.ts', 'apps/*/src/**/*.spec.ts', 'services/*/src/**/*.spec.ts'],
    coverage: {
      enabled: true,
      provider: 'v8',
      include: ['packages/*/src/**/*.ts', 'tools/*/src/**/*.ts', 'apps/*/src/**/*.ts', 'services/*/src/**/*.ts'],
      // Electron 主进程/preload/装配层由 E2E 运行覆盖（v8 无法计入 Electron 进程），排除出统计
      exclude: [
        '**/*.spec.ts',
        '**/dist/**',
        '**/fixtures/**',
        '**/pet-renderer/src/index.ts',
        '**/model-gateway/src/index.ts',
        '**/model-gateway/src/types.ts',
        '**/persona-brain/src/index.ts', // 纯 re-export 桶与仅类型声明文件不计入
        '**/desktop-host/src/main/**',
        '**/desktop-host/src/renderer/director/**', // Shell UI 由 E2E 覆盖（bridge.ts 纯类型声明）
        '**/desktop-host/src/renderer/tray-popover/**', // T-M6-60 快捷浮窗由 Electron E2E 真实渲染覆盖
        '**/game-bridge-mcp/src/index.ts', // 纯 re-export 桶
        '**/agent-harness/src/index.ts', // 纯 re-export 桶
        '**/memory-graph/src/index.ts', // 纯 re-export 桶
        '**/plugin-kit/src/index.ts', // 纯 re-export 桶
        '**/runtime-core/src/index.ts', // 纯 re-export 桶
        '**/character-core/src/index.ts', // 纯 re-export 桶
        '**/voice-runtime/src/index.ts', // 纯 re-export 桶
        '**/live-stream-hub/src/index.ts', // 纯 re-export 桶
        '**/stardew-mods/src/index.ts', // 纯 re-export 桶
        '**/evolution-lite/src/index.ts', // 纯 re-export 桶
        '**/dst-bridge-sidecar/src/index.ts', // 进程装配入口（main() + SIGINT/SIGTERM），由进程级运行覆盖
        '**/desktop-host/src/preload/**',
        '**/desktop-host/src/renderer/pet-stage/main.ts',
        '**/desktop-host/src/renderer/pet-stage/widgets/bubbles.ts',
        '**/desktop-host/src/renderer/pet-stage/widgets/rice-bowl-widget.ts', // DOM 挂件由 E2E 真实渲染覆盖（v8 不计 Electron 进程）
      ],
      // Gate 3 硬指标（AGENTS.md §3.3）：分支覆盖率 ≥90%
      thresholds: { lines: 90, functions: 90, branches: 90, statements: 90 },
    },
  },
});
