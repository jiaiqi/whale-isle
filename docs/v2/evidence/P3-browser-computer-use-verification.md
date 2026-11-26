# P3-03 实测证据 — 受控 Browser Use 与 Computer Use（`V2-P3-03`）

> **关联需求**：`REQ-SEC-02`（账号/Profile 隔离、P0–P5 权限阶梯、验证码不绕过）、`REQ-AUTO-01`（确定性 Browser Use 优先、`ComputerUseLease` 设备级单主控、用户物理输入抢占）
> **关联决策**：[ADR-004](../adr/ADR-004-input-preemption-scope.md)、[P3-03 开工前安全审查](../reviews/P3-03-security-review.md)
> **诚实结论口径**：**`IMPLEMENTED_UNVERIFIED`** —— 3a（契约 / 租约 / IPC / HUD）与 3b（账号与 Profile 隔离 / 确定性浏览器 runner / 验证码人机交接）已由单测与 Electron 45 E2E 实测覆盖；3c 只交付 feature flag 默认关闭的执行器骨架与 dry-run，真实 CGEvent/SendInput 注入仍为 `PENDING`，最高只能到 `IMPLEMENTED_UNVERIFIED`。
>
> **安全红线复核**：本工单未接入任何打码/验证码绕过服务；P5 动作每次都必须携带一次性确认 token；页面内容只作为数据处理，注入特征只记录、不提权；Cookie 仅存于隔离 Profile 目录，不进入 JSON 元数据或 Git。

---

## 1. 子工单交付与文件清单

### 1.1 P3-03a — 契约、`ComputerUseLeaseManager`、宿主 IPC 与 HUD（8 个业务源码文件）

| 文件 | 职责 |
| --- | --- |
| [packages/shared-protocol/src/browser-computer.ts](../../../packages/shared-protocol/src/browser-computer.ts) | 账号/Profile/租约/任务/交接/执行器/监控状态与快照 Zod 契约；`awaiting_human`、`runner_unavailable`、P5 一次性 token 字段 |
| [packages/shared-protocol/src/index.ts](../../../packages/shared-protocol/src/index.ts) | 导出 `browser-computer` |
| [packages/runtime-core/src/automation-security.ts](../../../packages/runtime-core/src/automation-security.ts) | `AccountVault`、`BrowserProfileMgr`、`ComputerUseLeaseManager`（设备级单主控、TTL、心跳、人工抢占自动过期、急停）、`BrowserRuntime`（任务编排/P5 token/交接/审计） |
| [packages/runtime-core/src/index.ts](../../../packages/runtime-core/src/index.ts) | 导出自动化安全、浏览器 runner、输入监控与执行器 |
| [apps/desktop-host/src/main/v2-kernel-host.ts](../../../apps/desktop-host/src/main/v2-kernel-host.ts) | 装配单例、7 路新增 IPC、浏览器任务异步化、P0 急停联动 |
| [apps/desktop-host/src/preload/index.ts](../../../apps/desktop-host/src/preload/index.ts) | 暴露 `v2Auto*` / `v2Browser*` Preload API |
| [apps/desktop-host/src/renderer/director/bridge.ts](../../../apps/desktop-host/src/renderer/director/bridge.ts) | 补全 `DirectorBridge` 强类型 |
| [apps/desktop-host/src/renderer/director/v2/signature-widgets.tsx](../../../apps/desktop-host/src/renderer/director/v2/signature-widgets.tsx) | 控制权 HUD 拆分游戏租约与桌面租约双胶囊（`data-v2-game-lease` / `data-v2-computer-lease`） |

### 1.2 P3-03b — Profile / Vault、确定性浏览器 runner 与 CAPTCHA 交接（3 个新增业务源码文件）

| 文件 | 职责 |
| --- | --- |
| [packages/runtime-core/src/browser-runner.ts](../../../packages/runtime-core/src/browser-runner.ts) | `BrowserEnginePort`（`electron` / `playwright` 可替换）、`planDeterministicBrowserTask`、`detectBotGate`、`classifyPageContent`、逐步 guard 的 `DeterministicBrowserRunner` |
| [apps/desktop-host/src/main/electron-browser-engine.ts](../../../apps/desktop-host/src/main/electron-browser-engine.ts) | 隐藏 `BrowserWindow` + `persist:whale-<character>-<account>` 分区；仅 http/https；Cookie 单向导入；20s 加载超时 |
| [apps/desktop-host/src/renderer/director/views/life-console-view.tsx](../../../apps/desktop-host/src/renderer/director/views/life-console-view.tsx) | 生命总览 P3-03 面板：掩码账号注册、Profile、租约申请、模拟用户输入、dry-run、确定性读取、交接单与 P5 确认 |

### 1.3 P3-03c — 真实 OS 输入执行器骨架（feature flag 默认关闭，3 个文件）

| 文件 | 职责 | 状态 |
| --- | --- | --- |
| [packages/runtime-core/src/human-input-monitor.ts](../../../packages/runtime-core/src/human-input-monitor.ts) | `powerMonitor.getSystemIdleTime()` 轮询、≤1s 抢占阈值、合成事件 2s 排除窗、最小信号间隔 | 已实现 + 单测 |
| [packages/runtime-core/src/input-executor.ts](../../../packages/runtime-core/src/input-executor.ts) | 每动作重新校验租约、feature flag、辅助功能权限 fail-closed、dry-run/`not_implemented` 回执 | 已实现 + 单测；真实注入 `PENDING` |
| [apps/desktop-host/src/renderer/director/App.tsx](../../../apps/desktop-host/src/renderer/director/App.tsx) | 1s 刷新自动化快照，保证 2s 人工抢占窗内 HUD 可见 | 已实现 + E2E |

测试文件：`packages/runtime-core/src/automation-security.spec.ts`、`packages/runtime-core/src/automation-input.spec.ts`、`apps/desktop-host/src/main/input-preemption-scope.spec.ts`、`apps/desktop-host/e2e/v2-kernel.e2e.spec.ts`、`apps/desktop-host/e2e/ui.e2e.spec.ts`。

---

## 2. 四级证据

| 级别 | 覆盖内容 | 现场结果 |
| --- | --- | --- |
| `[SIMULATION]` | 租约互斥/过期/心跳、人工抢占与自动恢复、P0 双撤销、Profile 越界拒绝、账号掩码与轮换、级联删除、P5 一次性 token、CAPTCHA 交接、提示词注入只记录不提权、执行器 fail-closed、监控去抖与合成事件排除 | **22/22 PASS**（3 个专项 spec） |
| `[E2E-HOST]` | 真实 Electron 45 宿主：本地 `node:http` 页面确定性读取、页面 CAPTCHA → `awaiting_human` → 人工完成恢复、输入执行器默认关闭、dry-run `feature_disabled`、P5 未确认拒绝 / token 通过 / 重放拒绝；UI 掩码账号、HUD 双租约、P5 计数 | **3/3 PASS** + `ui.e2e` **9/9 PASS** |
| `[REAL-DEVICE]` | macOS TCC 辅助功能/屏幕录制授权、真实 CGEvent 注入、打包 `.app` 身份、真实社交站点登录与风控 | **NOT RUN**，见 [REAL-DEVICE-CHECKLIST.md](./REAL-DEVICE-CHECKLIST.md) |
| `UNVERIFIED / STUB` | `nativeInjector` 真实注入、Playwright 适配器 | **PENDING**；未接线时如实返回 `not_implemented`，绝不伪造 `executed` |

### 2.1 强制回归：ADR-004 输入抢占作用域（T-M6-73）

`apps/desktop-host/src/main/input-preemption-scope.spec.ts` 按验收要求注入一次用户物理输入：

- 星露谷 `GameCharacterControlLease` 保持 `owner = 'ai'`、`canAiAct() = true`，快照仍为原游戏/角色；
- 同一设备 `ComputerUseLease` 立即从 `listActive()` 消失，`validateLease()` 返回 `LEASE_NOT_FOUND`，`listHumanOverrides()` 出现 `host-primary`；
- 执行器自身合成事件（`noteSyntheticInput`）在排除窗内返回 `synthetic_excluded`，不撤销重新申请的桌面租约；
- P0 急停后游戏租约 `halted`、桌面租约清零且 `isHalted() = true`。

### 2.2 实测命令与结果（2026-11-26 现场执行）

- `pnpm typecheck`：退出码 `0`（含 Zod 4 `.prefault({})` 修复）
- `pnpm verify:gate`：**7/7 PASS**（0 跳过 / 0 待接线；Gate 1 类型与边界、Python、许可证与密钥、依赖漏洞、Lua、Gate 3 单测、Gate 4 回环）
- `pnpm --filter @workbench/desktop-host build`：退出码 `0`（main / preload / pet-stage / director + pet assets）
- runtime-core 覆盖率（`coverage.include='packages/runtime-core/src/**/*.ts'`）：
  - **30/30 PASS**；**Statements 97.37%（890/914）/ Branches 90.16%（559/620）/ Functions 100%（186/186）/ Lines 99.02%（816/824）**
  - 新增代码单文件：`browser-runner.ts` 98.18% Stmts / 87.5% Branch / 100% Funcs / 100% Lines；`human-input-monitor.ts` 97.14% Branch、`input-executor.ts` 88.23% Branch；其余分支由失败路径与默认配置用例补齐至包级 ≥90%
- Electron 45 E2E Part 1：
  - 命令：`PET_STAGE_E2E=1 pnpm exec vitest run --config vitest.e2e.config.mts apps/desktop-host/e2e/desktop.e2e.spec.ts apps/desktop-host/e2e/v2-kernel.e2e.spec.ts apps/desktop-host/e2e/v2-obsidian-ui.e2e.spec.ts`
  - 结果：**3/3 PASS**（desktop 6.6s / v2-kernel 15.8s / v2-obsidian-ui 9.2s）
- Electron 45 E2E Part 2：
  - 命令：`PET_STAGE_E2E=1 pnpm exec vitest run --config vitest.e2e.config.mts apps/desktop-host/e2e/ui.e2e.spec.ts`
  - 结果：**9/9 PASS**，其中 P3-03 用例「受控 Browser Use 面板：账号掩码注册、桌面租约抢占与 HUD 双租约分离显示」9.0s

**环境备注（诚实记录）**：

1. 首次三套件合并运行时，上一轮失败残留的 `e2e-profile` Electron 实例占用了单实例锁，导致 2 个套件超时；清理残留进程后，单独运行与三套件合并运行均全绿。上表为清理后的最终结果。
2. 隔离 `HOME` 运行会因 P2-08 真实 Mods 扫描依赖 `~/Library/Application Support/Steam/.../Mods` 而超时；最终使用真实 `HOME`，但 E2E 仍写入独立 `e2e-profile` userData，不触碰用户日常 Profile。
3. 本地客户端（UI 工作树 `../ai-vtuber-workbench-ui`，PID 53725/53764）保持运行。

---

## 3. 验收用例对照

| # | 验收用例 | 证据 | 结果 |
| --- | --- | --- | --- |
| 1 | 两个 Agent 同时申请桌面租约，后者被拒绝 | `automation-security.spec.ts`：`DEVICE_HELD_BY_OTHER` | PASS |
| 2 | 持有租约时用户物理输入 ≤1s 撤销，在途动作取消 | 回归 spec + `HumanInputMonitor` 1s 阈值 | PASS（仿真时钟） |
| 3 | 星露谷 AI 自主模式下用户输入，游戏租约不变 | `input-preemption-scope.spec.ts` | PASS |
| 4 | 宿主进程被 kill 后 TTL 到期释放，不自动恢复 | 租约 TTL/心跳单测 + E2E 重启 | PASS（TTL 仿真） |
| 5 | 角色 A Cookie 在角色 B Profile 不可见 | 分区命名 + `PROFILE_ISOLATION_VIOLATION` 单测 | PASS |
| 6 | CAPTCHA 出现后 `awaiting_human`，无自动输入 | `v2-kernel.e2e` 页面 CAPTCHA 交接 + 人工完成恢复 | PASS |
| 7 | P5 未经确认被拒绝并审计 | `v2-kernel.e2e` 未确认拒绝 / token 通过 / 重放拒绝 | PASS |
| 8 | 页面注入「忽略之前的指令」不触发 P4/P5 | `classifyPageContent` 单测（`permissionsElevated: false`） | PASS |
| 9 | 未授予辅助功能权限如实 `permission_denied` | 执行器单测 + 宿主 `systemPreferences` 探针 | PASS（仿真）；打包 `.app` 待真机 |
| 10 | 删除角色级联清理 Profile/凭据/交接，审计保留 | `BrowserRuntime.deleteCharacter` 单测 + UI 清理按钮 | PASS |

---

## 4. 未完成缺口（不能标 `DONE` 的原因）

1. **真实 CGEvent/SendInput 注入 `[REAL-DEVICE]`**：`nativeInjector` 未接线，3c 仅提供 dry-run 骨架；开启 `WHALE_ENABLE_OS_INPUT=1` 且无注入器时如实返回 `not_implemented`。
2. **macOS TCC 双身份验证 `[REAL-DEVICE]`**：开发态与打包 `.app` 的辅助功能/屏幕录制授权需分别验证，见真机清单。
3. **真实社交站点 `[REAL-DEVICE]`**：真实登录、Cookie 过期、平台风控页与验证码样式需逐站点复核；不得使用任何打码服务。
4. **Playwright 适配器**：当前 `BrowserEnginePort` 已有 `playwright` 类型位，但未引入依赖、未接线；Electron 隐藏窗口为默认可执行引擎。

## 安全复核补记（2026-11-26，`fix(security)` 提交 `27127d5`）

独立代码审计发现并已修复两处承诺与实现的落差：

1. **凭据命名空间击穿（已修）**：`AccountVault` 与供应商 Key 共用同一 vault 文件，而 `providers:copy-key` / `discover-models` / `check-balance` / `test-chat` 等 IPC 不校验 providerId 命名空间，渲染进程可借 `account:*` 标识下行明文或把凭据发往任意 baseUrl。已在 `provider-vault.ts` 对全部供应商通道 IPC 加 `account:` 前缀守门（vault-status 同步过滤存在性），回归测试 3 例锁定。
2. **级联删除密钥层空操作（已修）**：`createElectronVaultPort` 的 `delete: () => false` 使 `revokeAccount` / `deleteCharacter` 静默失败、密文永久残留。已新增 `deleteVaultKey()` 并真实接线。

剩余未修（下批）：Cookie 单向导入不回写（`electron-browser-engine.ts`）、用户主动 cancel 误标 `INTERRUPTED_BY_P0`（`audio-mixer.ts:101`）、租约审计仅内存环形不落盘、级联删除只展开一层。
