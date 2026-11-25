/**
 * dependency-cruiser 架构边界锁（T-M0-01）
 * 设计原则来自 feiyu-os「确定性准入」：边界必须机器可查，违规在 Gate 1 自动报错。
 * 规则随工单推进扩充（新包落地时在此登记边界，并同步该包 README）。
 */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: '禁止任何循环依赖（feiyu-os：依赖方向必须是单向事实源）',
      from: {},
      to: { circular: true },
    },
    {
      name: 'shared-protocol-no-business-deps',
      severity: 'error',
      comment: '零依赖核心层：shared-protocol 严禁依赖任何其他业务包',
      from: { path: '^packages/shared-protocol' },
      to: { path: '^packages/(?!shared-protocol)' },
    },
    {
      name: 'shared-protocol-runtime-only-zod',
      severity: 'error',
      comment: 'shared-protocol 只允许 zod（运行时）；*.spec.ts 额外允许 vitest（测试期）',
      from: { path: '^packages/shared-protocol', pathNot: '\\.spec\\.(ts|tsx)$' },
      // pnpm 下 zod 的解析路径为 node_modules/.pnpm/zod@x/node_modules/zod/...，需两种形态都放行
      to: {
        dependencyTypes: ['npm', 'npm-dev'],
        pathNot: ['^zod($|/)', '/node_modules/zod/', '^vitest($|/)', '/node_modules/vitest/'],
      },
    },
    {
      name: 'renderer-no-sqlite',
      severity: 'error',
      comment: '渲染进程严禁直接依赖 SQLite（node:sqlite / better-sqlite3 只在主进程，经网关访问）',
      from: { path: '^apps/desktop-host/src/renderer' },
      to: { path: '^(?:node:)?sqlite$|^better-sqlite3' },
    },
    {
      name: 'pet-renderer-no-cross-layer',
      severity: 'error',
      comment: '渲染抽象层禁止横向依赖其他业务层（只许依赖 shared-protocol）',
      from: { path: '^packages/pet-renderer' },
      to: { path: '^packages/(model-gateway|persona-brain|game-bridge-mcp|live-stream-hub)' },
    },
    {
      name: 'persona-brain-runtime-only-zod',
      severity: 'error',
      comment: '人格层运行时依赖只允许 zod（shared-protocol 为 workspace 依赖；*.spec.ts 额外允许测试库）',
      from: { path: '^packages/persona-brain', pathNot: '\\.spec\\.(ts|tsx)$' },
      to: {
        dependencyTypes: ['npm', 'npm-dev'],
        pathNot: [
          '^zod($|/)', '/node_modules/zod/',
          '^vitest($|/)', '/node_modules/vitest/',
        ],
      },
    },
    {
      name: 'model-gateway-runtime-only-zod',
      severity: 'error',
      comment: '网关层运行时依赖只允许 zod（shared-protocol 为 workspace 依赖；*.spec.ts 额外允许测试库）',
      from: { path: '^packages/model-gateway', pathNot: '\\.spec\\.(ts|tsx)$' },
      to: {
        dependencyTypes: ['npm', 'npm-dev'],
        pathNot: [
          '^zod($|/)', '/node_modules/zod/',
          '^vitest($|/)', '/node_modules/vitest/',
        ],
      },
    },
    {
      name: 'local-store-runtime-only-storage',
      severity: 'error',
      comment: '存储层运行时 npm 依赖只允许 dexie（SQLite 用内置 node:sqlite；*.spec.ts 额外允许测试库）',
      from: { path: '^packages/local-store', pathNot: '\\.spec\\.(ts|tsx)$' },
      to: {
        dependencyTypes: ['npm', 'npm-dev'],
        pathNot: [
          '^dexie($|/)', '/node_modules/dexie/',
          '^fake-indexeddb($|/)', '/node_modules/fake-indexeddb/',
          '^vitest($|/)', '/node_modules/vitest/',
        ],
      },
    },
    {
      name: 'mock-harness-only-protocol',
      severity: 'error',
      comment: 'AI 自测沙盒只允许依赖 shared-protocol 与测试库，严禁引入业务实现。'
        + '例外：*.spec.ts 可驱动真实 AutodriveRunner 跑卡死回归剧本（T-M6-68 回放真机现场）；'
        + '回放服务等运行期仿真源码仍只依赖协议层。',
      from: { path: '^tools/mock-harness/src', pathNot: '\\.spec\\.ts$' },
      to: { path: '^packages/(?!shared-protocol)' },
    },
    {
      name: 'runtime-core-boundary',
      severity: 'error',
      comment: 'V2 运行时微内核仅允许依赖 shared-protocol 与 plugin-kit，严禁反向依赖业务领域包或宿主应用',
      from: { path: '^packages/runtime-core' },
      to: { path: '^(apps|services)/|^packages/(?!shared-protocol|plugin-kit|runtime-core)' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)dist/' }, // 构建产物不入巡检（源文件为准）
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      extensions: ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json'],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
