# Whale Isle V2 — 质量评估与真实验收规范（Evaluation & Verification）

> **铁律**：严禁把静态代码阅读、单元测试、Mock Replay 或无头 E2E 冒充为真机/真实平台验收通过；每完成一个工单，必须在此体系下如实归档证据。  
> **证据归档目录**：[evidence/README.md](./evidence/README.md) · **P0 实测证据**：[evidence/P0-foundation-verification.md](./evidence/P0-foundation-verification.md) · **P1 实测证据**：[evidence/P1-character-life-verification.md](./evidence/P1-character-life-verification.md) · [evidence/P1-voice-mixer-verification.md](./evidence/P1-voice-mixer-verification.md) · [evidence/P1-provider-quota-verification.md](./evidence/P1-provider-quota-verification.md) · [evidence/P1-memory-growth-verification.md](./evidence/P1-memory-growth-verification.md) · [evidence/P1-obsidian-ui-verification.md](./evidence/P1-obsidian-ui-verification.md) · [evidence/P1-stardew-ai-first-verification.md](./evidence/P1-stardew-ai-first-verification.md) · **P2 实测证据**：[evidence/P2-guide-learning-verification.md](./evidence/P2-guide-learning-verification.md) · [evidence/P2-ecosystem-isolation-verification.md](./evidence/P2-ecosystem-isolation-verification.md) · [evidence/P2-media-gateway-verification.md](./evidence/P2-media-gateway-verification.md) · [evidence/P2-3d-blender-pipeline-verification.md](./evidence/P2-3d-blender-pipeline-verification.md) · [evidence/P2-character-studio-crosspet-verification.md](./evidence/P2-character-studio-crosspet-verification.md) · [evidence/P2-pixel-stardew-avatar-verification.md](./evidence/P2-pixel-stardew-avatar-verification.md) · [evidence/P2-asset-registry-stage-sound-verification.md](./evidence/P2-asset-registry-stage-sound-verification.md) · [evidence/P2-coop-runtime-v1-verification.md](./evidence/P2-coop-runtime-v1-verification.md) · **P3 实测证据**：[evidence/P3-04-social-life-verification.md](./evidence/P3-04-social-life-verification.md) · [evidence/P3-04K-douyin-bounded-comments-verification.md](./evidence/P3-04K-douyin-bounded-comments-verification.md) · [evidence/P3-stardew-auto-new-save-verification.md](./evidence/P3-stardew-auto-new-save-verification.md)

---

## 2026-11-28 日间续验（进行中，V2-P4-01）

- `[REAL-DEVICE]` 两季隔离验收已完成春季并推进到夏24；目标仍为秋1，不能记录为两季全部通过。服务重启中断后从隔离存档恢复，未改写用户真实存档。巡检改为每2分钟审阅近期决策、状态与真实回执。
- `[SIMULATION]` 修复每日 Todo 的模型显示编号与0基引用错位、重排覆盖历史时间、重复新增降级状态与移除末项目失效；新增5项回归加既有32项规划测试均通过。专项命令因全仓覆盖率阈值退出1已留档，随后完整 `pnpm verify:gate` 8通过、0跳过。
- `[REAL-DEVICE]` 新构建夏24日志已出现目标移除及原因；形象同步关闭的隔离 SMAPI 日志记录恢复原生外观（模组0.4.0-dev.1）。每日任务的完整真实完成流程与时间显示仍继续验证。
- 长气泡侧翼收窄后仍会省略尾部，正在修复分页阅读；打字机及分页的 Electron DOM 回归尚待执行，不能以全文存在于DOM冒充全文可见。成熟开源参考的六仓克隆与复评见 `docs/REFERENCE-*.md`；参考源码只作审阅数据，遵守各自许可证。
- 当前工单保持唯一 `NEXT`，未达到“像人类一样完善游玩”验收标准。跟进证据：[P4-01-day-plan-repair.md](./evidence/P4-01-day-plan-repair.md)。

## V2-P3-02A 直播互动编排（2026-11-27）

`[SIMULATION]` 新增 12 项编排/运行时测试，覆盖真实关注匹配、礼物下限、同人冷却/全局节流、去重、点赞恰好或跨越阈值与补发、周期重置、按份数/币值排序及并列、容量边界、版权拒绝与授权只排队；专项合计 90/90。`[E2E-HOST]` 临时 userData 的 Electron UI 保存/重启恢复、真实鉴权 `/obs` 的三张卡、12/10 进度、昵称转义、深浅布局与开关/停播隐藏均通过 1/1。`verify:gate` 首次 7/8（WebUI 新空字段破坏旧调用方精确断言），修复为可选字段后 8/8，未放宽阈值，失败原始输出已留档。状态 `IMPLEMENTED_UNVERIFIED`，真实开播/OBS Studio 观感未验证；证据 [P3-02A](./evidence/P3-02A-live-engagement-verification.md)。

## V2-P4-01 LLM 软件链路与真机初验增量（2026-11-27 ~ 2026-11-28）

`single-pet-llm-chain.e2e.spec.ts` 6/6（54.72s）验证真实 Electron / IPC / 模型网关 HTTP / LLM 规划器 / 租约阻断与交还 / 三态回执 / 磁盘记忆检索；本地模型 stub 与 BWF 仿真均属 `[SIMULATION]`，总体证据为 `[E2E-HOST]` + `[SIMULATION]`。503、超时、非法工具与缺 Key 在显式配置下进入可见规则代驾，省略配置时安全暂停。2026-11-27 晚 ~ 2026-11-28 凌晨连续三轮 `[REAL-DEVICE]` 真机联合实测与收口打磨：新增 `dockToGame`（默认开、三端实时同步）实现开游即贴边游戏右下角、BWF `Once(...)` 省略段水合（`state-cache.ts`）、BWF 调试 HUD 自动隐藏、中控台动态目标链、报错气泡短句与上下自适应避让，并验证完整第 1 天 `06:00 → 夜间睡眠复盘（2 条心得）→ 过夜结算（500g→170g→406g）→ 第 2 天 06:00` 自主游玩（`669s`、`TIMEOUT=0`、`watchdogs=[]`、`overlapCount=0`、`clippedCount=0`、`sawMutedVisible=false`、`maxAmplitude=0.5038`、真实个人存档零写入）；第 2 天起多日持续浸泡与 `StrategyNotebook` 演进、物理 `F7` 热键及 Windows 端仍待验收，工单维持 `NEXT`。详细验证记录见 [P4-01-llm-chain-verification.md](./evidence/P4-01-llm-chain-verification.md)。

## V2-P4-04A–D 外部知识切片增量（2026-11-27）

四段链路（Envoy 只读材料 → Evidence Pack → 候选知识 → 真实 `get_state` 实玩回执）代码完成：`verify:gate` 8/8，本单 5 文件 38 用例，Electron E2E 1/1（2968ms），新增核心文件分支覆盖率 99.17% / 95.45% / 91.2%。证据主体为 `[SIMULATION]` + `[E2E-HOST]`；**真实环境 probe 如实 `unavailable`**（本机无 envoy、无 owner 授权材料），未生成外部证据、未发游戏动作。四个反例均有自动化：材料缺失、Envoy 不可用、BWF 不可达、执行前后状态无变化。真实 Envoy/owner 材料读取、两次 digest 复现、真实游戏同链路与 Windows 子进程回收未验，状态为 `IMPLEMENTED_UNVERIFIED`；`P4-01` 仍为唯一 `NEXT`。详见 [EXTERNAL-FUSION-D1-slice-verification.md](./evidence/EXTERNAL-FUSION-D1-slice-verification.md)。

## 一、四级证据口径（强制前缀标注）

| 证据标识 | 定义与边界 | 允许宣称范围 |
| --- | --- | --- |
| **`[REAL-DEVICE]`** | 在真实操作系统桌面、真实游戏客户端（如星露谷 + SMAPI）、真实音频硬件、真实网络与真实平台测试账号上跑通的端到端验收。 | 唯一允许将涉及硬件/外部游戏/真实直播平台的工单闭环为 **`DONE`** 的依据。 |
| **`[E2E-HOST]`** | 通过 Playwright / Vitest E2E 拉起真实编译后的 Electron 主进程、Preload、渲染窗与磁盘数据库/打包产物的宿主级端到端测试。 | 证明宿主集成、Electron 45 运行期兼容性、IPC 与本地存储链路真实可用。 |
| **`[SIMULATION]`** | 基于 `tools/mock-harness`（星露谷剧本 `S01–S07`、弹幕风暴回放）或临时目录/Fake Adapter 的确定性单测与回环集成测试。 | 证明核心状态机、契约校验与异常处理逻辑正确；**不得冒充真机/真实平台运行通过**。 |
| **`UNVERIFIED / STUB`** | 代码尚未接线外部服务，或仅存在桩实现/占位接口。 | 必须在 [TRACEABILITY.md](./TRACEABILITY.md) 与 UI 显式标出缺口。 |

---

## 二、7 态工单诚实封口规则

在 [ROADMAP.md](./ROADMAP.md) 与 [CURRENT.md](./CURRENT.md) 中，工单状态遵循：
`PENDING → NEXT → DOING → IMPLEMENTED_UNVERIFIED / BLOCKED → DONE | REOPENED`

1. **纯本地基建/库/工具工单**（如 `@workbench/runtime-core`、`node:sqlite` 迁移、`tools/evolution-lite`）：若所有代码、覆盖率、门禁、Electron 宿主测试及打包均已实测通过，可标记为 **`DONE`**。
2. **涉及真实游戏、真实直播平台、真实声音硬件、社交平台、跨设备联机或真实外部 CLI 的工单**：在未完成 `[REAL-DEVICE]` 实机人工或实机监控验收前，**最高只能标记为 `IMPLEMENTED_UNVERIFIED`**，并明确记录缺少哪项外部条件或真机测试。
3. **依赖外部账号/Key/环境而无法执行**：标记 **`BLOCKED`** 并产出结构化阻塞说明。

---

## 三、四道自动化准入门禁（`pnpm verify:gate`）

每次代码提交前（`.githooks/pre-commit` 自动强制执行）必须全部通过以下 7 项检查，**0 跳过 / 0 放宽**：

1. **Gate 1 — 类型与架构边界**：`pnpm typecheck`（TS `strict: true` + `noUncheckedIndexedAccess: true`）+ `dependency-cruiser`（锁死渲染层禁触 SQLite/密钥/直接调模型、Evolution Plane 与 Runtime Plane 物理隔离）+ Python `ruff` + `mypy --strict`。
2. **Gate 2 — 许可证、密钥、漏洞与脚本语法**：
   - `license-scanner` 扫描 `packages/`、`apps/`、`services/`、`tools/`、`mods/`（零明文 API Key、零 UNLICENSED 源码痕迹、零 GPL 传染源、完整 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)）；
   - `pnpm audit --audit-level high` 零高危/严重漏洞；
   - `luac -p` 校验 DST Lua 语法。
3. **Gate 3 — 确定性单测与覆盖率**：核心逻辑包与 V2 新增基础设施包（`runtime-core`、`local-store`、`persona-brain`、`model-gateway`、`game-bridge-mcp`、`live-stream-hub`、`tools/evolution-lite`）分支覆盖率必须 ≥ **90%**；Python 音频服务 `pytest` 全绿；7 个星露谷卡死回归剧本 `S01–S07` 全绿。
4. **Gate 4 — 回环契约 E2E**：15 秒内跑通全链路回环断言。

补充宿主验证命令：
- 构建打包：`pnpm --filter @workbench/desktop-host build` 与 `electron-builder --mac dir --arm64`
- 真实 Electron E2E：`pnpm exec vitest run --config vitest.e2e.config.mts apps/desktop-host/e2e/desktop.e2e.spec.ts apps/desktop-host/e2e/v2-kernel.e2e.spec.ts`

---

## 四、阶段性总体验收里程碑（P0–P5 退出门槛）

| 阶段 | 核心退出标准 |
| --- | --- |
| **P0（已完成）** | `@workbench/runtime-core` 接入 Electron 主进程、`node:sqlite` 替换 `better-sqlite3`（迁移/事务/自愈/回滚 + 打包）、`Evolution Engine Lite` 隔离闭环与全量 V2 文档体系落盘。 |
| **P1（单角色核心）** | `char_xiaojing` 12 域 + 最小 `LifeRuntime` + 跨平台真实说话/口型联动 + 诚实 4 级额度矩阵 + 五类记忆级联真删除 + V2 壳层拆解与多主题底座（P1 落地 Obsidian Tide 壳层，后续按 `ADR-003` 以 Tidepaper 为主基线演进）+ 星露谷 AI-First 12 个场景与真实急停/接管 `[REAL-DEVICE]` 验证。 |
| **P2（创作与真实联机）** | 攻略学习闭环 + 第三方插件独立进程隔离 + 双向 MCP/Skills + 生图/3D+Blender VRM/像素导出 + CrossPet 全量合法导入 + 人类与小鲸星露谷真实联机分工 `[REAL-DEVICE]`。 |
| **P3（表演/直播/浏览器）** | SVS/SVC 多轨舞台表演 + 真实平台测试直播间闭环 + `ComputerUseLease` 与 Per-Character `BrowserProfile` 隔离 + Digital Life L1 + 多被动桌宠同屏。 |
| **P4（完全闭环与自演进）** | 小鲸长时真实端到端稳定验收 + Social L2→L3 授权闭环 + Evolution Engine Full 脱敏遥测复现与灰度回滚。 |
| **P5（多角色与跨设备生态）** | 多完整自主 AI 角色与账号记忆隔离 + 跨设备多人协作 `CoopRuntime Full` + Terraria / DST / Minecraft 真机解冻。 |

---

## 五、`V2-P1-06` AI-First 游戏 Agent 与控制权验收基线（融合自 Blueprint 17）

### 5.1 必须生效的 13 项快捷控制语义（允许用户自定义快捷键）

| 命令 | 真实执行层语义（禁止仅改 UI 状态） |
| --- | --- |
| `Stop` / `Pause AI` / `Resume AI` | 立即取消在飞动作并停发控制写入 / 暂停自主循环 / 恢复协同自主模式 |
| `Take Over` / `Release Control` | 人类接管游戏角色控制租约（仅 `Take Over` / UI 开关 / `F7`；普通物理键鼠不触发，见 `ADR-004`）/ 释放并归还 AI |
| `Follow Me` / `Stay Here` | 尝试跟随人类玩家 / 在安全可行位置待命 |
| `Do This` / `Go Fish` / `Go Mine` / `Cancel Task` | 下发直接任务指令（优先于 AI 偏好但受规则/权限约束）/ 取消当前任务并交还租约 |
| `What Are You Doing?` / `Show Plan` | 查询当前目标、动作、简短理由、备选方案及正在参考的知识来源与置信度 |

### 5.2 12 项核心验收场景（全部通过 + 真机验证方可达 `DONE`）

1. **背包满了**：综合评估建箱、存放、出售、回农场等方案并校验真实结果；严禁只触发固定回家规则。
2. **自主钓鱼**：结合天气、时间、目标与兴趣主动提出或决定钓鱼（而非下雨强制钓鱼）。
3. **临时改变计划**：发现新机会时重新评估，若影响共同承诺则提前与用户沟通。
4. **攻略学习**：检索多份攻略时保留来源、版本、Mod 条件与置信度。
5. **不盲从攻略**：攻略与当前存档、版本或实际观察不符时拒绝盲执行并说明原因。
6. **经验学习**：一次行动失败后更新失败条件与负经验，避免无条件机械重复。
7. **建议协商**：用户提出普通建议（如去钓鱼），AI 可结合当前计划同意、婉拒或提出折中方案。
8. **明确指令**：用户下达明确任务指令（如去矿洞），AI 优先完成并在结束后交还控制模式。
9. **紧急停止**：触发 `Stop` 后立即取消当前动作且不再发送新的控制动作。
10. **手动接管**：人类通过 `Take Over` / `F7` 明确接管后，AI 绝不争抢同一游戏角色；普通物理键鼠输入不改变 `GameCharacterControlLease`（`ADR-004` / T-M6-73），但会撤销 OS 级 `ComputerUseLease`。
11. **任务结束与过期隔离**：任务完成/取消后退回约定模式；旧会话/旧世代在途指令被拒绝。
12. **版本变化识别**：针对旧游戏版本的攻略显式标记适用性不确定，而非当成当前事实。

---

## 六、P2 阶段近期实测状态快照（随工单推进滚动更新）

- **`V2-P2-01`..`V2-P2-04`**：均已通过 `pnpm verify:gate` 7/7 与 Electron 45 E2E，因缺少真实星露谷联机客户端、外部新 CLI、在线生图 Key 或本机 Blender 二进制，诚实保持 `IMPLEMENTED_UNVERIFIED`。
- **`V2-P2-05`（Character Bible、2D/Live2D QA 与 CrossPet 全量导入）**：`character-studio-v2.spec.ts`（含随包 30 角色真实目录全量导入、`.provenance.json`、`CC BY-NC-SA 4.0` 直播/商用拦截）、`verify:gate` 7/7 与 Electron 45 E2E 全绿；外部真实 Cubism `.moc3` 舞台渲染切换待 `V2-P3-01` 实机补验，状态记为 `IMPLEMENTED_UNVERIFIED`。
- **`V2-P2-06`（11 步游戏像素流水线与 Stardew Avatar Mod 导出，`DONE`）**：`dotnet build` Release 编译暂存 `WhaleIsleAvatar.dll`（0 警告）、`pixel-avatar-v2.spec.ts`（4/4 PASS）、`verify:gate` 7/7 与 Electron 45 E2E 全绿；2026-11-26 `[REAL-DEVICE]` 真机目视核验通过——游戏内玩家外观为蓝鲸女仆像素形象（蓝紫长发 + 白蓝女仆装），与导出贴图 `stardew-sprite-50c65bb7.png`（192×256，2x）正/背帧一致，`move_to` 移动落位与 `use_tool` 浇水动作帧正常，BWF `get_state` 与画面 HUD 逐项吻合（证据 `artifacts/acceptance/P2-06-*.png`，详见 [P2-pixel-stardew-avatar-verification.md](./evidence/P2-pixel-stardew-avatar-verification.md)；1×/4× 档未逐一进图目视，sheet 全帧已经流水线 QA 校验）。
- **`V2-P2-07`（十态 `AssetRegistry`、舞台/声音工坊、商用清源与一键回滚）**：纯本地资产治理与创作闭环，`asset-registry-v2.spec.ts`（3/3 PASS）、`verify:gate` 7/7 与 Electron 45 E2E（v1→v2→回滚→SHA-256→商业清源阻断）全绿，状态记为 `DONE`。
- **`V2-P2-08`（`CoopRuntime` v1 星露谷人机联机协作）**：`coop-runtime.spec.ts`（5/5 PASS，90% 分支覆盖）、本机真实 `Mods/` 兼容扫描（`v2CoopModCompat`）、`verify:gate` 7/7 与 Electron 45 E2E 全绿；双端真实游戏客户端开房协同实玩待 `[REAL-DEVICE]`，状态记为 `IMPLEMENTED_UNVERIFIED`。

## 七、歌声与舞台形象路线的验收口径（ADR-005 · 2026-11-27）

> owner 原话：「核心评价标准是角色声音自然、生动、有自己的风格，形象与动作灵活，整套系统能够自动化运行并持续扩展，**而不是单纯完成技术接口接入**」。

| 判据 | 什么算达成 | 什么**不算**达成 |
| --- | --- | --- |
| 声音自然生动 | `[REAL-DEVICE]` 真人试听能听出「是她唱的」，音域/换气/咬字/颤音符合 `SingingProfile` | 探针返回 `available`、接口返回 200、时长对齐 |
| 形象动作灵活 | `[REAL-DEVICE]` 真实 `.vrm` 在舞台窗口出画面，1080p60 帧率达标，全身骨骼 + 表情 + 口型 + 节拍同步可见 | `inspectState()` 返回一份 BlendShape 快照 |
| 系统自动化运行 | 点歌 → 自动演唱 → 自动混音 → 自动口型与舞蹈 **无人值守**跑完，失败时诚实降级并给出人话原因 | 手工点一次按钮跑通 |
| 持续扩展 | 新歌声引擎/新渲染器只实现接口 + 声明能力，不改动既有形态与角色核心状态 | 改一堆既有代码让它跑起来 |

**封口规则（不因 §2 的通用规则而放松）**：

- `V2-P3-07`~`V2-P3-09` 系歌声/形象类工单，**最高只能标 `IMPLEMENTED_UNVERIFIED`**，直到有**真实素材**（owner 提供的授权声源与合规 `.vrm`）与**真实听感/真机画面**证据。
- **PoC 通过 ≠ 需求达成**：单测、回放、沙盒、仿真渲染图**都不能**用来证明「声音自然生动」或「形象动作灵活」——这两条只有真人试听与真机画面能证。
- 「用别人的演唱换一个音色」**不构成**「已实现角色演唱风格」；SVC 只交付音色，SVS / SVS+SVC 才交付演唱风格。评审时须核对交付的是哪一半。
- 普通 TTS / GPT-SoVITS 的输出**不得**作为 SVS/SVC 验收样本（沿用 `SingEngine` 现有 `ttsClone` 单列 + 强制告警口径）。

## 八、P3 阶段近期实测状态快照

- **`V2-P3-01`（统一表演系统：`SingEngine` SVS/SVC + 歌词时钟 + 舞蹈 + 2D/3D `StageRuntime`）**：`performance.spec.ts` + `stage-runtime.spec.ts`（6/6 PASS，合并 90.88% 分支覆盖）、`verify:gate` 7/7 与 Electron 45 E2E 4 套件全绿，详见 [P3-performance-stage-verification.md](./evidence/P3-performance-stage-verification.md)；2026-11-26 真机补验已完成能自动的部分：新增 `services/sing-worker` 并把 `SingEngine.workerEndpoint` 真正接上（**此前从未注入，`probeBackends` 必然双 unavailable、探测是假的**），真机三层探测 `Electron → sing-worker(18880) → GPT-SoVITS(9880)` 跑通，SVS/SVC 如实 `unavailable`、普通 TTS 单列 `ttsClone` 并强制带「普通 TTS 不得当作 SVS/SVC 使用」告警；歌词时钟真实墙钟度量 max 偏差 25ms / P95 25ms；跨 4 后端状态 `retained=true`；GPT-SoVITS 真实推理实测 HTTP 200 / 1.01s / 32000Hz / 2580ms（属 TTS 非唱歌，不置 `realNeuralInferenceVerified`）；pet-stage 实为 WebM 视频渲染（0 canvas、60.4 FPS、0 丢帧），无 `.moc3`/`.vrm` 资产故画布观感无从谈起。2026-11-26 点歌台宿主接线（[P3-song-console-host-verification.md](./evidence/P3-song-console-host-verification.md)）：`v2:song-*` 五路 IPC + `SongConsole` + audio-ai-worker `/api/song/*` + SQLite `song_cache_index` + 首切片播放回执打通，缓存键覆盖源文件指纹与声线/调参，宿主单测 15/15、内核 26/26、Python 61/61、真实 Electron IPC E2E 通过（无后端场景逐项 unavailable，`lastPlayback` 如实为 null）；仍缺：合法 Cubism `.moc3` / `.vrm`、歌声合成（SVS）与音色转换（SVC）后端权重及索引、真实五组情绪参考音频、Demucs/RVC/曲库实机验证；状态维持 `IMPLEMENTED_UNVERIFIED`。
- **`ADR-003` UI/UX Tidepaper 主基线升级（`REQ-UI-01`）**：工作台已切换为潮汐纸 Tidepaper（晨雾 Mist 默认 + 夜潮 Night Tide + 5 强调色）并保留 Obsidian Tide / Tide Deep 可选切换，接入 V2-P2 与 V2-P3-01 实盘操作面板；`verify:gate` 7/7 与 Electron 45 E2E 4 套件（含 WCAG AA 4.5:1 对比度校验）全绿，详见 [P3-tidepaper-ui-verification.md](./evidence/P3-tidepaper-ui-verification.md)。
- **`V2-P3-02`（`LifeRuntime` 驱动的直播中控与 OBS 舞台）**：`live-runtime.spec.ts`（`91.66%` 分支覆盖，100% Funcs/Lines）、四重版权点歌拦截、礼物合并、OBS 舞台同步、`verify:gate` 7/7 与 Electron 45 E2E 4 套件全绿，详见 [P3-live-runtime-obs-verification.md](./evidence/P3-live-runtime-obs-verification.md)；OBS 本地闭环已实测（obs-websocket 5.7.6 真实握手、独立测试场景 browser_source、overlay 事件前后帧差 13186→19775 B、OBS 窗口实拍可见卡片、输入电平 44 帧峰值 0.0884，见 [P3-02-obs-local-closure-verification.md](./evidence/P3-02-obs-local-closure-verification.md)），并记录本机 OBS 33.0.3 浏览器源硬件加速开启时全黑（关闭正常，已还原设置）；真实线上直播间测试账号与 OBS Studio 实机开播待 `[REAL-DEVICE]`，状态记为 `IMPLEMENTED_UNVERIFIED`。
- **`V2-P3-03`（受控 Browser Use 与 Computer Use）**：`AccountVault` / Per-Character Browser Profile 隔离、`ComputerUseLease` 设备级单主控与用户物理输入 ≤1s 抢占、确定性浏览器 runner、CAPTCHA `awaiting_human` 交接、P5 一次性 token；P3-03 专项单测 **22/22 PASS**、runtime-core **`90.16%` 分支**、`verify:gate` 7/7 与 Electron 45 E2E Part 1 **3/3** + `ui.e2e` **9/9** 全绿，含 ADR-004 强制回归（游戏租约不受用户输入影响），详见 [P3-browser-computer-use-verification.md](./evidence/P3-browser-computer-use-verification.md)；2026-11-26 3c 真实注入接线完成——自研 Swift helper（CoreGraphics CGEvent）+ `[E2E-HOST]` 真机注入 e2e 通过（live 模式指针精确落位读回、合成事件不误伤租约、无权限 fail-closed 降级），状态转 `DONE`；macOS 打包态 TCC 授权与 Windows SendInput 为后续发布工程项。
- **`V2-P3-07`（星露谷从 0 自动建档 / 联机房主 / 存储隔离与中文双保险，`DONE`；与 §七 ADR-005 歌声/舞台同名批次并行）**：`07A`–`07E` 全通——`shared-protocol/stardew-launch.ts`、MIT BWF 第 3 份增量补丁（程序化建档/房主状态/`EnsureLanguage`/`isUnclaimedFarmhand` 1.6 空位修补）、`WhaleIsleAvatar` `SyncDisplayName` 防覆写、`BwfMcpClient.ping()`（`mcp-client.ts` 92.59% 分支）与 `game-health.ts` 硬化、`stardew-launch-prefs.ts`（默认 `isolated` + 中文 XML 双保险）及中控台 UI 完成；`pnpm verify:gate` 7/7、Electron E2E `stardew-launcher.e2e` + `ui.e2e`（10/10）与 `[REAL-DEVICE]` 冷启动 R1（常规只读续玩 + `AutodriveRunner` 实动）/R2（后台隔离中文单机从 0 + P2-06 2× 形象 + `SaveGameInfo` 未覆写）/R3（后台隔离中文联机房主 + UDP 24642 + 2/2 小屋）/R4（旧版 BWF 1.81s 快败 `BWF_PATCH_MISSING` + 恢复能力位验证）/R5（真实 Electron 中控台点击「从 0 单机开玩」17.53s 真实拉起建档翻绿并还原清理）全绿，详见 [P3-stardew-auto-new-save-verification.md](./evidence/P3-stardew-auto-new-save-verification.md)。
- **`V2-P3-04K`（抖音只读真浏览器 CDP 驱动，`DONE`）**：读取路径从 Electron `BrowserWindow` 切到「真 Chrome + 独立持久 Profile + CDP（仅回环）」，Electron 驱动保留为回退；专用 Profile/单实例/退出只清 lock/ Cookie 只查名称/验证码停止保留窗口等红线全部落成，新增驱动与契约单测 24 例。`[REAL-DEVICE]` 复验（Chrome 158.0.8127.88）：未登录公开精选 60 卡、推荐探测 9 卡、关注探测 0 卡（账号无可读作品），生产冒烟连续两轮 `itemsRead=3 / ok=true`，**登录后全程未出现「验证码中间页」**；推荐流本轮置真，关注流仍不可运行。**明确口径：本轮没撞到验证码 ≠ 已解决风控，多日/多时段仍需继续观察。** 详见 [P3-04K-douyin-real-browser-verification.md](./evidence/P3-04K-douyin-real-browser-verification.md)。
