# V2-P4-01：LLM 单角色链路验证

> 证据等级：`[E2E-HOST]` + `[SIMULATION]`；真实 Electron 45 宿主、IPC、模型网关 HTTP、LLM 规划器、控制租约与磁盘记忆，模型服务与游戏服务均为本地确定性仿真。没有真实供应商推理，也没有真实游戏验收。

## 决策声明

采用现有 `ModelGateway → LlmPlanner → AutodriveRunner → GameCharacterControlLease → BWF → memoryHost` 生产链路，通过正常 `brain:apply-config` IPC 绑定本地 OpenAI Chat Completions stub，开发态凭据通道只注入无价值测试占位符。拒绝替换 planner、伪造宿主回执或引入外部平台写入，因这些做法无法证明真实装配链路；规则代驾只在经 Zod 校验的显式配置开启时生效，旧配置继续默认安全暂停。验证预算为单次规划请求有界超时、非法动作最多三次重问、Electron 确定性 E2E 与完整 `pnpm verify:gate`；失败时保留原始输出并区分模型响应成功、规则代驾和默认暂停，回滚只需撤回新增配置与测试。

## 能力域对照：复用 / 重写 / 拒绝

本机参考仓位于共享 `reference-clones/` 目录，本轮只读，不运行参考仓脚本，不复制外部源码。

| 能力域 | 对照来源 | 结论与原因 |
| --- | --- | --- |
| 模型入口、协议路由 | `magpie/docs/subsystems/gateway-routing.md:3`（MIT）与仓库既有 `packages/model-gateway` | **复用**现有模型网关；借鉴本地标准端点与失败候选隔离思想，不移植 Go 网关或新增直连出口。 |
| 动作执行与事实回执 | `dsh-stardew-blind-whale-farmer/BlindWhaleFarmer/McpServer.cs`，以及 `docs/REFERENCE-dsh-stardew-blind-whale-farmer.md` | **复用**现有 BWF 仿真器、租约、互斥锁与回执分类；**拒绝**Mod 内 DeepSeek 直连，所有模型请求统一经 `ModelGateway`。 |
| 故障与证据诚实性 | `dsh-living/packages/core/test/runtime.test.mjs:1111`（MIT）、`docs/REFERENCE-dsh-douyin-agent.md`、`docs/REFERENCE-dsh-live-studio.md` | **重写**适配本仓 Electron IPC 的确定性服务失败/超时/非法输出剧本；保留实际失败事件，不将模型台词或队列接受当作动作成功。 |
| OpenAI 假接口 | `docs/REFERENCES.md` 中 `Dsh_douyin` 假接口自测思路 | **重写**最小回环 HTTP stub；**拒绝**复制无 LICENSE 源码或引入 GPL vendor，也不读取任何真实服务 Key。 |

## 链路与故障策略

通过正常的 `brainApplyConfig()` IPC 提交现有供应商端点与角色槽位，唯一模型绑定为 `p4-local-stub/scripted-action`，端点监听 `127.0.0.1` 随机端口，HTTP 路径 `/v1/chat/completions`；占位凭据只供开发态解析，从不调用云端 API。没有替换 fetch、网关、规划器、租约、回执处理或记忆处理。

新增配置均先在 `BrainRuntimeConfigSchema` 定义并编译，JSON Schema 与 Python Pydantic 同步：

- `allowRuleStandin`：只有显式 `true` 才允许确定性规则代驾；省略或 `false` 沿用安全暂停。
- `plannerTimeoutMs`：整数范围 100–120000ms；宿主省略时采用 30000ms，真实传入 `AbortSignal.timeout()`。测试故障预算为 500ms；租约竞态用例为 15000ms，以便主动释放被阻塞的响应。
- 缺 Key 且允许代驾时可创建规则代驾规划器，但 `llmReady=false`；没有将离线状态包装成模型就绪。
- `buildBrain()` 重建时保留完整已验证配置，避免切换游戏后遗失自定义供应商与代驾策略。

## 逐项证据边界

| 用例 | 模型侧实际发生 | 动作侧实际发生 | 结论 |
| --- | --- | --- | --- |
| 模型动作与租约 | stub 收到真实模型请求，返回带随机运行标记的合法动作 JSON；并无神经模型推理 | HTTP 在途时收回租约，迟到动作零下发；交还后动作才进入 BWF HTTP 回放 | 生产软件链路跑通，模型响应未被规则动作替代。 |
| 三态回执与记忆 | 每个动作意图均带 stub 专属标记，规划器为 `llm-xiaojing`，无 `rule-standin` 事件 | BWF 回放逐项返回成功、失败、不确定文本，真实分类器产生 `COMPLETED / FAILED / UNCERTAIN`；同会话/世代，三条原文分别可检索 | 三态来自预设仿真事实文本；不能据此声称真实游戏收获/失败/打断。 |
| 服务不可用 | stub 实际返回 HTTP 503 | 产生可见代驾原因与 `规则代驾：` 意图，活农场仿真收到规则工具并产生回执 | **规则兜底成功，模型失败**。 |
| 请求超时 | stub 保持 HTTP 不响应，由宿主 AbortSignal 实际终止请求 | 显式切 `rule-standin` 后执行规则工具与回执 | **规则兜底成功，模型超时**。 |
| 非法动作 | stub 连续三次返回非白名单 `unauthorized_shell` | 非法工具零下发，三次预算耗尽后产生规则代驾动作与回执 | **规则兜底成功，模型输出被拒绝**。 |
| 缺 Key | stub 收到零次请求，`llmReady=false` | 显式规则代驾执行真实农场仿真工具与回执 | **仅规则兜底，无模型调用**。 |
| 旧配置默认暂停 | stub 返回 HTTP 503，配置省略代驾开关 | `paused` 事件，零决策、零游戏动作写入 | 默认 AI-first 行为保持，未静默启动规则机器人。 |

## 本机实跑（2026-11-27）

```text
pnpm exec tsc -b packages/shared-protocol
pnpm gen:contracts
→ 契约编译与 JSON Schema / Pydantic 导出通过。

pnpm --filter @workbench/desktop-host build
pnpm exec vitest run --config vitest.e2e.config.mts apps/desktop-host/e2e/single-pet-llm-chain.e2e.spec.ts
→ Test Files 1 passed (1) / Tests 6 passed (6) / Duration 54.72s

pnpm exec vitest run --config vitest.e2e.config.mts apps/desktop-host/e2e/single-pet-chain.e2e.spec.ts apps/desktop-host/e2e/single-pet-llm-chain.e2e.spec.ts
→ 最终回归：Test Files 2 passed (2) / Tests 7 passed (7) / Duration 55.15s

pnpm verify:gate
→ PASS Gate 1 类型与边界：tsc -b + dependency-cruiser
→ PASS Gate 1 类型与边界(Python)：ruff + mypy --strict
→ PASS Gate 1 打包护栏：main / preload / pet-stage / director
→ PASS Gate 2 许可证与密钥：0 违规
→ PASS Gate 2 依赖漏洞：0 high / 0 critical
→ PASS Gate 2 DST Lua 语法：5 文件
→ PASS Gate 3 确定性单测：vitest + pytest，覆盖率阈值不变
→ PASS Gate 4 回环契约 E2E
→ verify:gate 通过：8 过 / 0 跳过 / 0 待接线
```

macOS CI `.github/workflows/ci.yml` 显式加入 `single-pet-llm-chain.e2e.spec.ts`，保留原规则链路 E2E。跨语言生成器同时带出的既有语音字段漂移已从本单补丁移除；本单只提交 `BrainRuntimeConfig` 的新增字段。

## 待人类真机验收

真实供应商推理、真实星露谷游戏动作、长时 LLM 浸泡、语音锁释放和气泡投影不在本次软件证据内，`V2-P4-01` 继续保持 `NEXT`。
