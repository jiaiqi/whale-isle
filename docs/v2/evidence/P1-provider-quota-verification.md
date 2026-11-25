# P1 阶段验证证据归档 — `V2-P1-03`（模型供应商与四级诚实额度矩阵）

> **分支**：`feat/whale-isle-v2`  
> **状态口径**：**`IMPLEMENTED_UNVERIFIED`**（契约、探针单测、门禁 7/7 与 Electron 45 E2E 全部通过；DeepSeek / OpenRouter / OpenCode Go 已有既有 `[REAL-DEVICE]` 实测，但新增的 Kimi 与 MiniMax Coding Plan 实时端点尚待填入用户真实 Key 实测，故按诚实口径标为 `IMPLEMENTED_UNVERIFIED`）  
> **测试环境**：macOS arm64 · Node `v24.22.2` · pnpm `12.16.1` · Electron `45.4.1` · Vitest `5.1.0`

---

## 一、实现摘要

1. **契约先行（`packages/shared-protocol/src/quota.ts`）**：定义 `ProviderQuotaReport` 与 `ProviderQuotaMatrix`，涵盖余额（`currency`/`total`/`granted`/`toppedUp`/`used`/`limit`/`remaining`）、多尺度窗口（`rolling_5h`/`daily`/`weekly`/`monthly`/`total`、百分比、Token/请求计数、重置时间 `resetsAt`）以及强制元信息（`source` 四级枚举、`scope`、`authState`、`planName`、`fetchedAt`、`errorDetail`、`rawExcerpt`）。
2. **预设与探针引擎（`packages/model-gateway/src/{presets.ts,quota-probes.ts}`）**：
   - 新增 `kimi-moonshot`（CN / GLOBAL）预设，为 `minimax` 补充 `CODING_PLAN` 变体；
   - 实现 `probeProviderQuota` 与 `probeQuotaMatrix`：支持 DeepSeek、Kimi、OpenRouter、SiliconFlow、OpenCode Go、MiniMax Coding Plan（5h 窗口）、本地 Ollama（`/api/tags`）与本地 CLI Harness（`codex` / `claude` / `gemini` / `opencode`）；
   - 对 MiniMax 按量付费、OpenAI、Anthropic、火山方舟等无公开查询 API 的厂商强制返回 `queryable: false, source: 'unknown', balance: null, windows: []`，绝不编造数字；`sanitizeQuotaText` 对错误上下文与摘要执行 Bearer/Key 脱敏。
3. **Electron 宿主接线（`apps/desktop-host`）**：`provider-vault.ts` 将 `platform.moonshot.cn` / `.ai` 纳入控制台白名单；`v2-kernel-host.ts` 暴露 `v2:provider-quota` 与 `v2:provider-quota-matrix`（仅在主进程解析 `kernel.secrets`，绝不下行明文 Key）。

---

## 二、实测证据记录

### 1. 契约与探针确定性单测（`[SIMULATION]`）
- **命令**：`pnpm exec vitest run packages/model-gateway/src/quota-probes.spec.ts packages/shared-protocol/src/quota.spec.ts`
- **结果**：2 个测试文件 / **6 个用例全部通过**。
- **覆盖率**：
  - `packages/model-gateway/src/quota-probes.ts`：`100%` Stmts / **`90.86%` Branch** / `100%` Funcs / `100%` Lines。
  - `packages/shared-protocol/src/quota.ts`：`100%` Stmts / `100%` Branch / `100%` Funcs / `100%` Lines。

### 2. 全仓四道自动化门禁（`pnpm verify:gate`）
- **结果**：**`7 过 / 0 跳过 / 0 待接线`**（退出码 `0`）：
  - Gate 1 类型与边界（TS `tsc -b` + `dependency-cruiser`）：PASS
  - Gate 1 类型与边界（Python `ruff` + `mypy --strict`）：PASS
  - Gate 2 许可证与密钥（`license-scanner` 扫描 **264 个源文件**，0 违规；`pnpm audit --audit-level high` 0 漏洞；`luac -p` 5 Lua PASS）：PASS
  - Gate 3 确定性单测（全仓 Vitest 含全局 ≥90% 分支门槛 + Pytest + 7 个卡死回归剧本 `S01–S07`）：PASS
  - Gate 4 回环契约 E2E（`[SIMULATION]` `0.3s < 15s`）：PASS

### 3. Electron 45 构建与宿主集成 E2E（`[E2E-HOST]`）
- **构建**：`pnpm --filter @workbench/desktop-host build` 通过。
- **E2E 命令**：`pnpm exec vitest run --config vitest.e2e.config.mts apps/desktop-host/e2e/desktop.e2e.spec.ts apps/desktop-host/e2e/v2-kernel.e2e.spec.ts`
- **结果**：**2/2 PASS**。
  - 在真实 Electron 45.4.1 主进程中验证：`openai` 返回 `queryable: false, source: 'unknown', balance: null`；未配置 Key 的 `deepseek-official` 返回 `authState: 'missing_key', balance: null`；`v2ProviderQuotaMatrix` 聚合 5 个预设厂商 + 4 个本地 CLI 状态并返回有效 `fetchedAt`。

---

## 三、待人类真机验收缺口（转 `DONE` 前必须补齐）

1. **Kimi 官方余额端点真机 Key 实测（`[REAL-DEVICE]`）**：使用真实 Moonshot API Key 验证 `GET /v1/users/me/balance` 返回结构与字段解析。
2. **MiniMax Coding Plan 5h 窗口真机 Key 实测（`[REAL-DEVICE]`）**：使用真实 MiniMax Coding Plan Key 验证 `GET /v1/api/openplatform/coding_plan/remains` 实测响应结构与重置时间解析。
