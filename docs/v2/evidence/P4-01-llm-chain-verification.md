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

## PR CI 实测（PR #14，提交 `0cce081`）

```text
macOS · 完整 verify:gate + Electron E2E   pass  4m30s
ubuntu · 类型/边界/单测/Python             pass  2m14s

Electron E2E 步骤原始日志：
✓ apps/desktop-host/e2e/single-pet-llm-chain.e2e.spec.ts (6 tests) 54538ms
✓ apps/desktop-host/e2e/single-pet-chain.e2e.spec.ts (1 test) 7345ms
Test Files 9 passed (9) / Tests 23 passed (23)
```

两平台均无跳过步骤；macOS job 的 `Full gate · pnpm verify:gate` 与 `Electron E2E` 步骤均 `success`。

## 待人类真机验收

真实供应商推理、真实星露谷游戏动作、长时 LLM 浸泡、语音锁释放和气泡投影不在本次软件证据内，`V2-P4-01` 继续保持 `NEXT`。

---

## 2026-11-27 晚增补：记忆/知识接入决策、星露谷伴随反应、WAV 口型波纹与窗口贴边（`[E2E-HOST]` + `[SIMULATION]`）

### 1. 开工决策声明（AGENTS.md §2.1）

- **采用方案**：在现有单主线工单 `V2-P4-01` 与 ≤8 个业务源码文件约束下，打通四段软件闭环：
  1. **Memory + Verified Knowledge 接入决策（Voyager / Generative Agents / Reflexion，MIT）**：`formatKnowledgeUnitsForPlanner()` 从 `workbench.db` 筛出已验证/已晋升及已反证避坑知识，连同 `MemoryGraph.contextFor(buildPlannerMemoryQuery(...))` 以异常隔离方式注入 `LlmPlanner` 晨间规划与自主决策 Prompt。
  2. **去重冷却型星露谷伴随反应（Junimo-MCP / VPet 事件冷却思想）**：新增 `stardew-companion-reactions.ts`，按日/冷却去重并遵循 `xiaojing` / `kuroha` / `ruoshui` 三角色口吻，将生存阈值、里程碑、`UNCERTAIN`/失败、`watchdog` 卡死、接管交还与心得沉淀同步投递至 `pet:bubble` 与 `voiceHost.speak()`。
  3. **真实 WAV 口型联动（dsh-pet / VPet，MIT / Apache-2.0）**：在 `pet-stage` 通过 `.pet-bubble-voice` 三柱声波指示 + 轻柔垂直跃动呈现 WAV `lipFrames` 实时振幅，并修复被动状态轮询误解靠边停靠问题。
  4. **窗口化游戏自动贴边（dsh-desktop-petbox，MIT）**：在 `desktop-host/src/main/index.ts` macOS 前台轮询中检测窗口化《星露谷》与未锁定桌宠矩形重叠并自动 `dock`/`undock`（`TEST_MODE` 严格禁用）。
- **不采用与原因**：
  - 不引入 `GameKnowledge` 全量原文塞进系统提示词（破坏 Prompt 预算与前缀缓存稳定性，故限制 `maxItems=6`、≤1200 字）；
  - 不重写或替代 `tools/evolution-lite` 与 runtime 安全隔离，不引入无许可证或 GPL 源码；
  - 本单已占满 8 个业务文件预算，Windows 端 WAV 播放增强与跨平台进程窗口贴边留待独立工单。
- **验证路径与失败回退**：外部上下文读取使用 `resolvePlannerContexts()` `try/catch` 隔离；macOS `osascript` 检测异常静默忽略；`vitest` 分支覆盖 ≥90% 与 Electron 真实 E2E 回环门禁兜底。

### 2. 本轮修改文件清单（8 业务源码文件 + 5 测试文件）

- **业务源码（8/8）**：
  1. `packages/game-bridge-mcp/src/knowledge-evidence.ts`（`formatKnowledgeUnitsForPlanner`）
  2. `packages/game-bridge-mcp/src/llm-prompt.ts`（`buildPlannerMemoryQuery`、`resolvePlannerContexts`、`longTermMemoryText`/`verifiedKnowledgeText` 注入）
  3. `packages/game-bridge-mcp/src/llm-planner.ts`（可选上下文端口接线与 `debugSnapshot().retrieval`，保持 489 行 ≤500）
  4. `apps/desktop-host/src/main/stardew-companion-reactions.ts`（新增伴随反应状态机与角色台词复用）
  5. `apps/desktop-host/src/main/autodrive-host.ts`（记忆/知识端口注入、伴随反应分发与 `onInsight` 播报）
  6. `apps/desktop-host/src/main/index.ts`（3s 知识库缓存接线、macOS 窗口化《星露谷》重叠自动停靠）
  7. `apps/desktop-host/src/renderer/pet-stage/widgets/bubbles.ts`（`.pet-bubble-voice` 振幅波形与节能降级适配）
  8. `apps/desktop-host/src/renderer/pet-stage/main.ts`（`lipFrames` 声波驱动、微跃动画与 `dockedEdge` 防误解停靠保护）
- **单测与 E2E（5）**：
  - `packages/game-bridge-mcp/src/knowledge-evidence.spec.ts`
  - `packages/game-bridge-mcp/src/llm-planner.spec.ts`
  - `apps/desktop-host/src/main/stardew-companion-reactions.spec.ts`
  - `apps/desktop-host/src/main/autodrive-host.spec.ts`
  - `apps/desktop-host/e2e/single-pet-llm-chain.e2e.spec.ts`

### 3. 自动化实测证据（2026-11-27 晚）

| 校验命令 / 范围 | 等级标识 | 结果 | 说明 |
| --- | --- | --- | --- |
| `pnpm lint:deps` | 静态门禁 | 通过（0 违规） | 1117 模块 / 2653 依赖边 |
| `pnpm --filter @workbench/desktop-host build` | 构建门禁 | 通过 | main / preload / pet-stage / director 产物齐备 |
| `vitest` (`packages/game-bridge-mcp`) | `[UNIT]` / `[SIMULATION]` | 22 套件 / **317/317 通过** | 分支覆盖率 **90.58%**（`knowledge-evidence` 96.42% / `llm-prompt` 90.02% / `llm-planner` 89.88% / 整包 ≥90%） |
| `vitest`（反应与宿主单测） | `[UNIT]` / `[SIMULATION]` | 3 套件 / **10/10 通过** | `stardew-companion-reactions` 3/3 + `autodrive-host` 4/4 + `autodrive-character-parity` 3/3 |
| Electron E2E（4 套件） | `[E2E-HOST]` + `[SIMULATION]` | 4 套件 / **9/9 通过**（61.21s） | `single-pet-llm-chain` 6/6（已验证 LLM 请求包含 `## 长期经验与主人记忆`）、`desktop` 1/1、`single-pet-chain` 1/1、`knowledge-slice` 1/1 |
| `pnpm verify:gate` | 完整四道门禁 | **8/8 通过** | `tsc -b` / `depcruise` / `ruff+mypy` / `desktop-host build` / `license-scanner`（365 文件 0 违规） / `pnpm audit` / `luac` / `vitest+pytest` / Gate 4 回环 |

### 4. 仍待真机验收（`[REAL-DEVICE]`，工单 `V2-P4-01` 维持 `NEXT`）

- 未使用真实付费模型 API Key 与真机《星露谷》游戏窗口连续运行长时浸泡（`pnpm soak:real`）。
- 未在真实桌面同时打开窗口化《星露谷》观察 macOS 重叠自动停靠手感、真实气泡/TTS 伴随节奏与 `.pet-bubble-voice` 口型同步视觉表现。

---

## 2026-11-27 深夜增补：桌宠贴边游戏右下角、首日真机验收与界面/口型/提示修复（`[REAL-DEVICE]` + 回归测试）

### 1. 真机验收暴露问题与修复落盘（6 类改动 + 贴边开关）

根据真实桌面截图反馈与前三轮真机实测暴露的问题，完成以下修复并通过编译、边界与单测门禁：

1. **桌宠打开游戏自动贴边右下角（默认开，多端开关实时同步）**：
   - `packages/shared-protocol/src/index.ts`：`PetDesktopPrefsSchema` 新增 `dockToGame: z.boolean().default(true)`。
   - `apps/desktop-host/src/main/game-dock.ts`（+ `game-dock.spec.ts`）：实现纯几何算法 `computeGameBottomRightBounds(gameRect, petSize, workArea)` 与状态机 `GameDockTracker`——检测到窗口化《星露谷》即自动将 `default` 桌宠贴靠至游戏窗内右下角（避开底部物品栏与右侧体力条 `E`），跟随游戏窗口移动，支持手动拖拽让位，游戏关闭（2 tick 防抖）或关闭开关后恢复游前位置。
   - `apps/desktop-host/src/main/index.ts`、`pet-window-manager.ts`、`pet-context-menu.ts` 与中控台 `views/stardew-view.tsx`、`pet-stage-panel.tsx`、`director/App.tsx`：接入即时探测、600ms 自移动防误判保护，并在中控台星露谷工作区顶栏（`[data-dock-to-game]`）、桌宠舞台面板（`[data-desk-pref="dockToGame"]`）及桌宠右键菜单（`打开游戏时贴边右下角`）双向实时同步。
2. **气泡 `[静音]` 误标与旧语音串台**：`voice-host.ts` 为 `VoiceHostSpeechResult` 附带 `text`；`pet-stage/main.ts` 启动时水合 `voiceConfigGet()` 并仅在 `event.text` 匹配当前气泡时更新语音/静音标记。
3. **长文本截字与 mid-word 断词**：`bubbles.ts` 与 `bubble-layout.ts` 恢复侧翼 `cLowerY` 候选、切回 `overflow-wrap: break-word` 防 `clear_ar\nea` 断词，放宽 `dialog` 高度并按 `bodyMaxHeight / linePx` 动态计算显示行数，避免 5~6 行对话底部像素被裁。
4. **日内计划刷新刷屏**：`autodrive-host.ts` 将 `event.type === 'plan'` 且 `reason === 'update'` 的内部调整改为低干扰 `thought` 气泡（`ttlMs: 8000`），避免顶掉当前对话并重复触发 TTS。
5. **游玩期桌宠乱跑**：`pet-stage/main.ts` 在 `gameDockActive` 或 `autodrive` 活跃期内暂停 `patrolTick` 自主散步。
6. **首日参数与环境认知**：`packages/game-bridge-mcp/src/llm-prompt.ts` 规范化 `clear_area` / `till_area` 冲突入参；`state-hints.ts` 补充 `FarmHouse` 礼盒坐标 `interact({"x":...,"y":...})` 与 `Farm` 首动 `till_area` 矩形及背包低余量造箱提示。

### 2. 自动化回归证据（最新构建与单测）

| 校验项 | 等级标识 | 结果 | 说明 |
| --- | --- | --- | --- |
| `@workbench/game-bridge-mcp` + `@workbench/desktop-host` 构建 & `pnpm typecheck` & `pnpm lint:deps` | 静态 / 构建门禁 | 通过（0 错误 / 0 违规） | `depcruise` 1123 模块 0 违规，dist 产物完整 |
| `vitest`（`packages/game-bridge-mcp` + `bubbles.spec.ts` + `game-dock.spec.ts`） | `[UNIT]` / `[SIMULATION]` | 24 套件 / **341/341 通过** | 覆盖 `dockToGame` 几何/状态机、气泡防裁切/防重叠、LLM 参数归一化与状态提示（先期全量跑过 `shared-protocol`/`pet-window-manager`/`pet-context-menu`/`voice-host`/`autodrive-host` 41 套件 458 例通过） |

### 3. `[REAL-DEVICE]` 真机联合验收（真实 Keychain + 真实 DeepSeek + 真实 MiMo TTS + 真实星露谷 SMAPI，孤立用户目录）

通过真实未修改 Electron 主进程（`--remote-debugging-port=19229` + macOS Keychain `provider-vault.json` 解密 `loaded=9`、独立用户目录 `/tmp/whale-real-accept-ud3` 与 `storageMode: 'isolated'`，不触碰宿主个人存档）实测：

- **真实供应商与语音链路**：中控台顶栏显示 `"语音开 · MiMo 锁声"`；`deepseek-official` 连通测试 `ok=true`（`latencyMs=898`）；`BrainSwitch` 应用 `mode="llm"`（`llmReady=true`）。
- **开游戏自动贴边游戏右下角 + 开关实测**：
  - 自动从 0 拉起中文隔离存档 `鲸屿三验_455470176`（SMAPI `16.875s` `ready`）；
  - **在开启自主托管之前**，主进程检测到游戏窗口 `{x:560, y:238, width:1280, height:748}` 后，桌宠已自动从 `(80, 80)` 贴边至 `{x:1399, y:638, width:400, height:284}`（右下角物品栏上方、`E` 体力条左侧）；
  - 实按中控台 `[data-dock-to-game]` 开关：`off` 立即恢复 `(80, 80)`，`on` 立即回贴 `(1399, 638)`。
- **真实 LLM 首日自主游玩（零参数报错）**：DeepSeek 自主完成 `FarmHouse` `interact(3, 7)` 拆礼盒 → 对话推进 → `travel_to(Farm)` → `till_area (62,17)-(66,20)` 清障 3/3 并耕地 15/15 → `plant_seeds` 种防风草 15/15 → `water_crops`，消耗 `riceConsumed: 20570`。
- **桌宠伴随口型与控制权 HUD**：22 轮桌面窗口采集 `overlapCount: 0`；语音触发时真实观测到 `sawSpeakingAttr=true`、`sawWaveVisible=true`、`sawMutedVisible=false`、`maxAmplitude: 0.7417`；`takeoverHud` 实测切换「`游戏接管中` ↔ `AI 自主托管`」；宿主真实个人存档（`~/.config/StardewValley/Saves/` 与 `startup_preferences`）事后 `mtime` 校验 `changed: []`（零写入）。
- **视觉截图核验**：人工查看真机截图（`scratch/accept-out3/02-stardew-docked-on-launch.png`、`03-pet-during-play.png`、`05-stardew-during-play.png`），确认文字无裁切、无 `clear_ar\nea` 断词、无遮挡脸部或技能栏。

### 4. 仍待真机验收（`[REAL-DEVICE]`，工单 `V2-P4-01` 维持 `NEXT`）

- 未使用真实《星露谷》连续运行完整 1 个游戏日（`06:00` → 次日清晨 `pnpm soak:real` 0 卡死证明）及多日 `StrategyNotebook` 演进验证。
- 尚未验证游戏内物理热键 `F7` 接管与全量 13 项控制语义逐项实按，以及 Windows 端真机兼容测试。

---

## 2026-11-28 凌晨增补：全天实机浸泡、BWF 省略段水合与气泡/超时彻底收口（`[REAL-DEVICE]`）

### 1. 真机多轮浸泡暴露缺陷与闭环打磨（三批次聚焦提交）

在真机长时间联跑中定位并修复了以下实际影响体验与决策连贯性的问题：

1. **BWF `Once(...)` 省略段水合与日内防重复**：
   - `packages/game-bridge-mcp/src/state-cache.ts`（+ `state-cache.spec.ts`）与 `autodrive.ts`：新增 `BwfStateSectionCache`，自动缓存并在后续回合回填 BWF 10 分钟折叠省略的 `## 穿戴` / `## 箱子` / `## 本地出口` / `图例：` / `农田：` / `【花钱建议】`，冷启动遇省略时主动补拉一次 `get_state({ full: true })`。
   - `packages/game-bridge-mcp/src/day-plan.ts`：`DayPlanStore.applyUpdate` 按 `normalizeGoalKey()` 对 `add` 去重，消除日内重复目标条。
   - `packages/game-bridge-mcp/src/state-hints.ts` / `llm-prompt.ts` / `mcp-client.ts`：修正礼盒坐标正则并补「屋里已领种子直接 `travel_to(Farm)`」、对照 `Observer.cs` 识别在田间「`生长中：...` 且无 `需要浇水` 行即 0 株待浇水」（消除 5 连重复 `water_crops` 与 IslandWest 误导）、限定仅状态明示未读信时调 `read_mail`、无箱且木材 `<50` 阻断盲目 `tidy_backpack`/`craft(Chest)`、补充低体力可食/[无食用]分流与 `open_shop`/`fish`/`sleep` 参数归一化，并将全图走动采集 `forage` 与 `use_tool`/`take_items`/`upgrade_tool`/`donate_museum` 纳入 `isLongAction()`（消除森林 `forage` 超 30s 假超时）。
2. **中控台/游戏 HUD/桌宠气泡与口型观感统一**：
   - `apps/desktop-host/src/main/{mods-host.ts,index.ts}`：新增 `syncBwfHud()` 并在星露谷启动及就绪时同步 `bwfShowHud` 至 BWF `/settings`（实图验证左上角技术调试框彻底隐藏）。
   - `apps/desktop-host/src/renderer/director/views/stardew-view.tsx`：将 `<GameGoalChain>` 绑定真实 `dayPlan`（含 `✓` 完成标记与当前进行中焦点），替代静态示例步骤。
   - `apps/desktop-host/src/main/autodrive-host.ts`：将节奏调至 `stepDelayMs: 900`，并将晨间口播摘要精简至 `<=38` 字，适配窄翼气泡并降低 MiMo 合成耗时。
   - `apps/desktop-host/src/main/stardew-companion-reactions.ts`：新增 `summarizeFailureForBubble()`，过滤原始 `DialogueBox`/换行报错文本，仅在反应气泡呈现简洁人设短句。
   - `apps/desktop-host/src/renderer/pet-stage/{main.ts,widgets/bubble-types.ts,widgets/bubble-layout.ts,widgets/bubbles.ts}`：`dockToGame` 激活时强制 `edgeHint: 'right'` 使气泡优先展开在桌宠左侧开阔区域（避开右缘体力条 `E`），提高各类型气泡行高预算并新增真实 DOM `scrollHeight` 上下自适应避让（含中心 `petZone` 碰撞保护）。

### 2. 自动化校验与真机第 1 天 → 第 2 天完整浸泡实测（最终代码后运行）

- **构建与单测（最终改动后重跑）**：`pnpm --filter @workbench/game-bridge-mcp build`、`pnpm --filter @workbench/desktop-host build` 通过；Batch 3 聚焦 5 套件（`state-hints.spec.ts`、`autodrive.spec.ts`、`llm-planner.spec.ts`、`stardew-companion-reactions.spec.ts`、`bubbles.spec.ts`）**149/149** 全绿；完整 `pnpm verify:gate` 见下方终验记录。
- **`[REAL-DEVICE]` 第 1 天 06:00 → 过夜结算 → 第 2 天 06:00 全自主浸泡（`task-1424`，隔离用户目录 `/tmp/whale-real-soak` + 隔离存档 `鲸屿全天农场`）**：
  - **自主开局与农耕采购**：`06:00 FarmHouse` 拆礼盒取 15 颗防风草种子 → 关弹窗进 `Farm` → `clear_area` 9/9 → `till_area` 15/15 → 播种并浇透 15/15（**0 次重复 `water_crops`**）→ 清杂出货纤维与石头 → `09:50` 进 `SeedShop` `open_shop` 自主购入 5 颗土豆种子 + 1 颗花椰菜种子（`500g → 170g`）→ `10:20` 对主人建议自然回应 `[CHAT-STANCE modify]`（「逛什么逛，种子还没下地呢！先开田，哼。」）→ 再开 20 格新田。
  - **真人体力统筹与社交**：体力降至 `36/270` 后自动转向 Town 零耗体与 10 位村民打招呼并全图 `forage` 收获黄水仙×3（`12:10 → 13:30`，超 30s 零超时误报）→ 回农场出货腾格后种完并浇透 5 株土豆（`22/270`）→ 16:10 决定 `sleep({"force":true})` 补觉保命。
  - **夜间复盘与过夜结算**：生成 2 条真实复盘心得（`insightsCount: 2`），过夜出货结算资金增至 **`406g`**，准时醒于 **`第1年春2日 06:00`**（`reachedDay2: true`，总耗时 `669s`，途径 5 张地图，消耗 `riceConsumed: 265488`）。
  - **零缺陷关键指标**：`TIMEOUT: 0`、`ERROR: 0`、`uncertainDetails: []`、`watchdogs: []`、`consoleErrors: []`、`overlapCount: 0`、**`clippedCount: 0`（零气泡裁字）**、MiMo 真实语音 3/3 完成（`sawSpeakingAttr=true`、`sawWaveVisible=true`、`sawMutedVisible=false`、`maxAmplitude=0.5038`）、真实个人存档（`~/.config/StardewValley/Saves/` 与 `startup_preferences`）事后 `mtime` 校验 **`changed: []`**。
  - **辅助参考（终改前 Batch 2 运行 `task-1290`，`284s`）**：亦已实测次日晨间 `06:20` 触发 `read_mail` 读威利信并续浇 15/15 幼苗，截图确认左上角调试 HUD 彻底隐藏且中控台显示真实动态目标链。

### 3. 仍待真机验收（`[REAL-DEVICE]`，工单 `V2-P4-01` 维持 `NEXT`）

- 终改后连续第 2 天全天至第 3 天以上的长期 `StrategyNotebook` 置信度演进与多日连续游玩。
- 游戏内物理热键 `F7` 接管、全量 13 项控制语义逐项实按，以及 Windows x64 真机端验证。
