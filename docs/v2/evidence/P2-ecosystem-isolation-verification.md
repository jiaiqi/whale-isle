# V2-P2-02 开放生态与插件进程隔离验证报告

- **工单**：`V2-P2-02`
- **结论口径**：
  - `REQ-SEC-01`（第三方插件进程隔离与 P0–P5 Broker 边界）：**`DONE`**（真实 Electron 45 E2E 与 Worker Isolate 沙箱单测实证通过，主进程直连 `import` 已退役）
  - `REQ-EXT-01` / 工单整体状态：**`IMPLEMENTED_UNVERIFIED`**（双向 MCP HTTP/STDIO、受控脱敏 MCP Server、`SkillRegistry` 与 7 家 Harness 执行器全部单测 + `verify:gate` 7/7 + Electron 45 E2E 实测通过；其中 Codex/Claude/OpenCode/Pi/OpenHands 真实外部 CLI 联调待本地安装与 Key 真机验收）
- **验证日期**：`2026-11-26`

## 一、架构迁移与功能摘要（严格 8 个业务源码文件）

1. **生态与隔离契约** [ecosystem.ts](file:///Users/jiaqi/Documents/vibe/ai-vtuber-workbench/packages/shared-protocol/src/ecosystem.ts) & [index.ts](file:///Users/jiaqi/Documents/vibe/ai-vtuber-workbench/packages/shared-protocol/src/index.ts)：新增并导出 `PluginTrustLevel`（`builtin-trusted | third-party-isolated`）、`ToolRiskTier`（`P0_READ`–`P5_FORBIDDEN`）、`PluginSandboxHealth`、`AgentSkillManifest`、双向 `McpServerConfig`/`McpAuditEntry` 与 `HarnessProtocolType`/`HarnessIntegrationLevel` Zod 契约。
2. **第三方插件 Worker Isolate 隔离与 `PolicyBroker` / `SkillRegistry`** [v2-sandbox-skills.ts](file:///Users/jiaqi/Documents/vibe/ai-vtuber-workbench/packages/plugin-kit/src/v2-sandbox-skills.ts) & [index.ts](file:///Users/jiaqi/Documents/vibe/ai-vtuber-workbench/packages/plugin-kit/src/index.ts)：
   - `IsolatedPluginRunner`：基于独立 `node:worker_threads` V8 Isolate 运行外部插件，显式剥离宿主机全部敏感 `process.env`、约束 V8 堆内存上限、支持 `setup`/`invoke` 硬超时 `worker.terminate()`（同步死循环立停且宿主存活）与跨线程 Broker 通信；
   - `PolicyBroker`：在主进程侧统一裁决 P0–P5 访问，硬拒 `vault://`/`shell://`/`P5_FORBIDDEN` 并留存完整审计轨迹；
   - `SkillRegistry`：兼容 Agent Skills 开放规范解析 `SKILL.md`（frontmatter + `references/scripts/assets`），静态安全扫描拦截危险脚本并坚守“Skill 是说明文档、非权限凭证”。
3. **宿主退役主进程直连装载** [plugin-host.ts](file:///Users/jiaqi/Documents/vibe/ai-vtuber-workbench/apps/desktop-host/src/main/plugin-host.ts)：移除第三方外部插件主进程直连 `import(moduleUrl)` 路径，全面切换为 `IsolatedPluginRunner` + `PolicyBroker`，对外 `PluginViewEntry` 诚实标示 `isolated: true`、`trustLevel: 'third-party-isolated'` 与 `sandboxStatus`。
4. **双向 MCP Client/Server 与多 Harness 扩展** [mcp-bridge.ts](file:///Users/jiaqi/Documents/vibe/ai-vtuber-workbench/packages/agent-harness/src/mcp-bridge.ts)、[providers.ts](file:///Users/jiaqi/Documents/vibe/ai-vtuber-workbench/packages/agent-harness/src/providers.ts)、[index.ts](file:///Users/jiaqi/Documents/vibe/ai-vtuber-workbench/packages/agent-harness/src/index.ts)：
   - `WhaleMcpClient`（Streamable HTTP + STDIO 双向接入 tools/resources/prompts）与 `WhaleMcpServer`（Token + Scope 鉴权、响应递归脱敏 `[REDACTED]` 与审计）；
   - 新增 Codex CLI / OpenCode CLI / Pi / OpenHands 预设与 `executeHarnessTask` 隔离执行器，如实标注 `verifiedStatus`。

## 二、实测命令与结果

| 检查项 | 证据等级 | 命令 | 实测结果 |
| --- | --- | --- | --- |
| 隔离沙箱 / Skills / 双向 MCP / Harness 单测 | `[SIMULATION]` | `pnpm exec vitest run --coverage.enabled=false packages/plugin-kit/src/v2-sandbox-skills.spec.ts packages/agent-harness/src/mcp-bridge.spec.ts` | **10/10 PASS**（642ms；覆盖 env 剥离、死循环强杀、Broker 拦截、Skills 扫描阻断、HTTP/STDIO MCP、密钥脱敏与超时/取消） |
| 宿主编译与前端资源构建 | `[E2E-HOST]` | `pnpm --filter @workbench/desktop-host build` | exit 0（CSS 60ms） |
| 仓库全量自动化门禁 | `[SIMULATION]` + 静态门禁 | `pnpm verify:gate` | **7/7 PASS**（TS `strict` + `dependency-cruiser` + Python `ruff/mypy --strict` + 274 源文件零违规 + 0 高危漏洞 + 5 Lua + 全量单测覆盖率 ≥90% + Gate 4 回环 0.3s） |
| Electron 45 E2E（含 Worker 外部插件实测） | `[E2E-HOST]` | `desktop.e2e` + `v2-obsidian-ui.e2e` + `v2-kernel.e2e` + `ui.e2e` | **3/3 PASS**（5.54s）+ **8/8 PASS**（12.82s，含 `外部插件：发现 → 启用 → 工具调用（ask 审批）` 经 Worker Isolate 真宿主运行通过） |
| Codex/OpenCode/Pi/OpenHands 真 CLI 实测 | `[REAL-DEVICE]` | 待真机环境逐 CLI 安装配置运行 | **UNVERIFIED**（已在 `providers.ts` 诚实标注 `verifiedStatus: 'adapter-only'`，仅 `gemini-cli`/`dsh-acp` 标 `real-device-verified`） |
