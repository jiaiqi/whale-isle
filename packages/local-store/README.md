# packages/local-store — 本地存储双引擎底座

> 状态：**M0 已落地**（对应工单 `T-M0-03`，2026-11-15）｜ [SPEC §1 冻结决策](../../docs/SPEC.md)

## 职责

- **`'.'`（主进程侧）**：SQLite 单点事实源（`better-sqlite3`，WAL）
  - `grudge_ledger` 常客记仇/好感账本（标签去重合并、好感 bump、榜单）
  - `token_ledger` Token 消耗流水（1 粒米 = 1 Token；按 6 槽位汇总）
  - `song_cache_index` 点歌缓存索引（命中计数 / 二次点歌秒回的统计口径）
  - `meta` Schema 版本等仓库级元数据
  - **隐私合规**：`deleteViewer` / `wipeAllViewers`（观众记忆一键擦除）、`wipeAllData`（开发期总重置）
- **`'./dexie'`（渲染进程侧）**：Dexie.js 配置库——中控台配置与 UI 状态的即时响应（`setConfig/getConfig/snapshotConfigs/setUiState/...`）

## 边界（dependency-cruiser 强制）

- ❌ 渲染进程严禁 import `'.'`（better-sqlite3 原生模块只能在主进程）——`renderer-no-sqlite` 规则
- ❌ 本包运行时依赖仅 `better-sqlite3` / `dexie`，严禁引入业务包（`local-store-runtime-only-storage` 规则）
- ❌ 跨进程读数一律经主进程 IPC 网关，禁止多进程直开同一个 DB 文件（单点事实源）

## 验证

`packages/local-store/src/*.spec.ts`：`:memory:` 与文件库（WAL 持久化重开）双模式、脏数据容错、
一键删除断言；Dexie 侧 `fake-indexeddb`。覆盖率纳入 Gate 3 全局 ≥90% 门槛。
