# Whale Isle V2 — 质量评估与真实验收规范（Evaluation & Verification）

> **铁律**：严禁把静态代码阅读、单元测试、Mock Replay 或无头 E2E 冒充为真机/真实平台验收通过；每完成一个工单，必须在此体系下如实归档证据。  
> **证据归档目录**：[evidence/README.md](./evidence/README.md) · **P0 实测证据**：[evidence/P0-foundation-verification.md](./evidence/P0-foundation-verification.md) · **P1 实测证据**：[evidence/P1-character-life-verification.md](./evidence/P1-character-life-verification.md) · [evidence/P1-voice-mixer-verification.md](./evidence/P1-voice-mixer-verification.md) · [evidence/P1-provider-quota-verification.md](./evidence/P1-provider-quota-verification.md) · [evidence/P1-memory-growth-verification.md](./evidence/P1-memory-growth-verification.md) · [evidence/P1-obsidian-ui-verification.md](./evidence/P1-obsidian-ui-verification.md) · [evidence/P1-stardew-ai-first-verification.md](./evidence/P1-stardew-ai-first-verification.md) · **P2 实测证据**：[evidence/P2-guide-learning-verification.md](./evidence/P2-guide-learning-verification.md) · [evidence/P2-ecosystem-isolation-verification.md](./evidence/P2-ecosystem-isolation-verification.md) · [evidence/P2-media-gateway-verification.md](./evidence/P2-media-gateway-verification.md) · [evidence/P2-3d-blender-pipeline-verification.md](./evidence/P2-3d-blender-pipeline-verification.md)

---

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
| `Take Over` / `Release Control` | 人类接管控制租约（键鼠输入同样触发）/ 释放并归还 AI |
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
10. **手动接管**：人类接管或物理键鼠操作后，AI 绝不争抢同一游戏角色。
11. **任务结束与过期隔离**：任务完成/取消后退回约定模式；旧会话/旧世代在途指令被拒绝。
12. **版本变化识别**：针对旧游戏版本的攻略显式标记适用性不确定，而非当成当前事实。

---

## 六、P2 阶段近期实测状态快照（随工单推进滚动更新）

- **`V2-P2-01`..`V2-P2-04`**：均已通过 `pnpm verify:gate` 7/7 与 Electron 45 E2E，因缺少真实星露谷联机客户端、外部新 CLI、在线生图 Key 或本机 Blender 二进制，诚实保持 `IMPLEMENTED_UNVERIFIED`。
- **`V2-P2-05`（Character Bible、2D/Live2D QA 与 CrossPet 全量导入）**：`character-studio-v2.spec.ts`（含随包 30 角色真实目录全量导入、`.provenance.json`、`CC BY-NC-SA 4.0` 直播/商用拦截）、`verify:gate` 7/7 与 Electron 45 E2E 全绿；外部真实 Cubism `.moc3` 舞台渲染切换待 `V2-P3-01` 实机补验，状态记为 `IMPLEMENTED_UNVERIFIED`。
