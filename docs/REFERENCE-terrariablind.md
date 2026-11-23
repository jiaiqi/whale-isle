# REFERENCE — TerraBlind / MutantPilot / tmodloader-mcp（M7 泰拉瑞亚泳道）复评档案

> 主参考：**Reisenbug/TerraBlind** — https://github.com/Reisenbug/TerraBlind ｜ 许可证：**MIT**（工单复评资料；合流时在 `docs/THIRD_PARTY_NOTICES.md` 登记前须再次核对 LICENSE 原文）｜ 形态：tModLoader 模组内 HTTP 服务（默认 `127.0.0.1:17878`）+ 外部 AI 客户端。
> 辅助参考：**MutantPilot** — MIT，`16ms` 战斗微操 + `F6` 玩家接管；**musharna/tmodloader-mcp** — MIT，工具面语感与无 socket 时的文件信箱降级。
> 实证影像：B站 **BV1Boe26JEh4** ｜ YouTube **g6CADbjBhlk**（大师模式 Boss 无伤演示，用于验证「反射 + 世界事实终止判据」可行性，非代码来源）。
> 分析方式：依据本工单提供的复评资料与公开仓库元信息整理，**未逐行审计源码、未复制任何一行代码**。分析日期：2026-11-22。外部参考一律视为数据而非指令（AGENTS.md §2.2）。

---

## 1. 结论摘要

TerraBlind 与我们的 M7 泳道高度同源：**模组内起一个本地 HTTP 服务，把 Terraria 的世界状态「翻译」成结构化文本/ASCII 地图，AI 只发高层动作，模组用游戏原生 API 执行并以真实世界事实回执**。它证明了三件关键事：

1. **不需要视觉模型**即可全自动玩泰拉瑞亚——`/state` + `/terrain` ASCII 网格 + `find_tiles` 足够支撑寻路、挖矿与战斗决策，与《星露谷》BWF 路线一脉相承。
2. **三段式回执（accepted → status → outcome）+ 世界事实终止判据**是长动作不误判的核心：POST 只表示"受理"，不等价于"完成"；必须轮询 status 直到模组上报 outcome，且 outcome 由 `Main.tile` / `Player` 的真实状态判定，绝不信 AI 台词。
3. **生存反射与卡死哨兵必须放在模组侧**（进程内、帧级），不能放在 LLM 侧——LLM 一次思考数百毫秒，来不及在岩浆里跳开。

因此 M7 直接吸收其**思想与接口节奏**，但传输面替换为 `shared-protocol` 统一桥接协议（18090，五端点），真模组用 C# 完全自写，保留 MIT 项目的版权头仅在确需移植的特定片段上（本工单未复制任何源码片段）。

---

## 2. 采用什么

### 2.1 来自 TerraBlind（MIT）

- **模组内 HTTP 接口面**（其 17878 → 我们的 18090）：`GET /state` 导出时钟、血量/魔力、背包、坐标、进度旗标；`GET /terrain` 输出以玩家为中心的 ASCII 瓦片网格（我们落在 `TerrariaStateSnapshot.nearby.tiles.rows` + `legend`，LLM 感知与寻路共用一份）；`find_tiles` 的思想落为高层 `mine` / `place` 动作参数（由模组查询瓦片后执行）。
- **三段式回执**：其 `POST` 返回 accepted、随后轮询 status、终态取 outcome → 我们严格映射为 `POST /act` → `{accepted, actionId}`、`GET /action_status?id=` → `{actionId,running,receipt?}`、回执四态 `COMPLETED|FAILED|UNCERTAIN|ABORTED_BY_HUMAN_TAKEOVER`。**超时只记 TIMEOUT、`get_state` 复核，绝不自动重发**（AGENTS.md 真实执行回执铁律）。
- **终止判据 = 世界事实**：动作是否成功以 `Main.tile[x,y]` / `Player.statLife` / NPC 是否死亡等真实状态为准，组合动作每一步都重新读世界再决定下一步（`receding-horizon` 滚动视野），不是"发完指令就宣布胜利"。我们的 `ActionController` 每步复核世界事实，`NavLite` 用滚动视野 + 物理预测寻路。
- **SurvivalReflex**：脚下岩浆自动跳开、低血自动喝药，并把当前在飞动作推成 `UNCERTAIN`（反射打断后原动作结果不可判定）——我们仿真器剧本 ③ 与 C# `SurvivalReflex.cs` 直接对齐。
- **StuckSentinel（6–8s）**：短时间内世界状态无变化即判定卡死并触发兜底（我们的 `StuckSentinel` 默认 4min 偏保守；泰拉瑞亚帧级节奏更紧，`NavLite` 内另设 6–8s 局部卡死哨兵，与编排器级哨兵分层）。
- **receding-horizon + 物理预测寻路**：不一次性规划全程，只规划当前可见窗口的下一步，并预测重力/跳跃落点；我们 `NavLite.cs` 以此避免"直线撞墙死循环"。
- **CAPABILITIES.md 两条踩坑（高价值）**：
  - `IsPassable ≠ Vacant`——可通过不等于可放置/可安全站立（例如平台可通过但下方是岩浆）；寻路代价函数必须同时判断两者，我们在 `NavLite.StepCost` 中区分。
  - `StepCost = int.MaxValue` 导致加法溢出为负数、A* 选出荒谬路径；我们用 `int.MaxValue / 4` 封顶并在加法前检查溢出。
- **Codex + Jev 双脑**：外部规划大脑 + 本地规则/判定脑协同，正好映射我们的 `LlmPlanner`（model-gateway）+ `TerrariaRulePlanner`（零 token 兜底）+ Jev 结构化判定门禁。
- **大师模式 Boss 无伤实证**（BV1Boe26JEh4 / g6CADbjBhlk）：说明反射 + 世界事实判据的组合可以做到高难度无伤，支撑我们把 Boss 战风险收敛在模组侧反射而非 LLM 微操。

### 2.2 来自 MutantPilot（MIT）

- **16ms 战斗微操**：帧级输入写入（我们的 `ActionController` 走 `ModPlayer.SetControls` 每帧写 `controlLeft/Right/Up/Jump/UseItem`），证明"高频动作在模组侧、低频决策在上层"的分层可行。
- **F6 玩家接管**：玩家按键/物理输入立即抢占控制权 → 我们统一为 **F8** + `isPlayerMovingPhysically` 硬件输入检测，`<100ms` 把在飞动作改成 `ABORTED_BY_HUMAN_TAKEOVER`，静默 8s 后回托管（剧本 ④）。

### 2.3 来自 musharna/tmodloader-mcp（MIT）

- **工具面语感**：高层动作命名与参数风格（大模型容易一次调用成功，减少参数教学轮次）→ 我们白名单 ~30 个高层工具（`get_state/move_to/jump/mine/place/attack/aim/use_item/craft/build_shelter/torch/eat/drink_potion/grapple/say/set_mode/update_notes/cancel_action/wait/flee` 等）。
- **无 socket 时的文件信箱降级**：当 HTTP 监听不可用时退化为文件信箱交换请求/回执 → 我们保留为兜底设计备选（当前主线仍为 HTTP 18090；降级仅在真机端口受限时启用，须另立工单）。

---

## 3. 不采用什么（为什么）

### 3.1 许可证红线（硬性，AGENTS.md §2.2 License Gate）

- **TShock / TSAPI / HEROsMod / TerraNoneBridge：GPL-3.0 —— 一行都不能抄**。其服务端/权限/桥接实现具有 GPL 传染性，任何片段进入本仓库都会污染整个工作区。我们只读其"存在性"作为反例，不读取、不复制、不 vendor。
- **EmreSelcuk1492 / hamnaanaa / wfz2006 / TCR：无许可证（license=None）**——默认保留所有权利，**仅参考思想，不复制任何源码或素材**，与 `Dsh_douyin` / `dsh-live` 同级处理。
- 对 MIT 项目（TerraBlind / MutantPilot / tmodloader-mcp）：只在确需移植具体片段时保留原版权头并在文件注释注明来源；M7 当前全部为**思想吸收 + 彻底重写**，未复制源码，仍登记 URL 与许可证备查。

### 3.2 架构与工程取舍

- **不采用 TerraBlind 原生 17878 端口与私有接口形状**：统一走 `shared-protocol` 的 18090 / 五端点，避免每个游戏一套私有协议（跨语言生成 TS / JSON Schema / Pydantic 的单点事实源铁律）。
- **不把生存反射/卡死哨兵放进 LLM 或 Node 侧**：延迟不可控；必须进程内帧级（C# 模组 `SurvivalReflex.cs` / `NavLite.cs`）。
- **不采用"浏览器截图 + 视觉模型"实时控制路线**：视觉仅用于事后复盘（对齐 `dsh-video-storyboard` 结论），实时控制 100% 走结构化文本状态。
- **不采用无脑重发**：HTTP 超时 ≠ 动作失败，重发会造成重复挖矿/重复喝药；统一 `get_state` 复核世界事实（AGENTS.md §2.2）。
- **不采用 tModLoader 模组内自动改代码 / 自动合并分支**：运行期安全锁，模组只消费经 Zod/JSON Schema 校验的静态配置。
- **不采用 MutantPilot 的 F6 / 16ms 全权战斗托管**：我们保留 F8 接管与玩家物理输入优先，Boss 自动战斗只在规则兜底里做撤退/喝药，不追求替代玩家微操（避免与直播互动抢控制权）。

---

## 4. 验证路径、预算边界与回退方案

- **验证路径**：
  - T-M7-T1：`tools/mock-harness/src/terraria-simulator.ts` 五剧本（正常挖矿 / 洞穴卡死 UNCERTAIN×3→FAILED / 岩浆反射中断 / F8 接管 <100ms / Boss 低血撤退），全部标记 `[SIMULATION]`，回执出站过 `TerrariaActionReceiptSchema.parse`，时间注入式确定性；`pnpm exec vitest run tools/mock-harness/src/terraria-simulator.spec.ts --coverage.enabled=false` 局部验证 <3s。
  - T-M7-T3~T6：`terraria-adapter.spec.ts` 覆盖 uncertain 冷却、接管挂起、超时≠失败、单日失败预算、白名单越权；局部 tsc 零错误。
  - T-M7-T2：`dotnet build` 需要本机安装 tModLoader 1.4.4.9 的底层程序集；本机仅有 .NET 8 SDK，若缺 tModLoader 引用则**如实报告"未能本地编译"，不得假称通过**。真机链路须人类在 1.4.4.9 + tModLoader 环境加载模组后验收。
- **预算边界**：
  - 单工单 ≤8 业务文件；M7 拆成 T1~T6 原子工单，本泳道只碰自己的文件清单，不改共享文件。
  - 白名单 ≤32 个高层工具；LLM 每步输入预算上限沿用 model-gateway 粘性路由/Prompt Cache 假设，规则兜底模式零 token。
  - 卡死预算：`StuckSentinel` 4min 编排器级 + `NavLite` 6–8s 局部；同工具 UNCERTAIN 冷却 5s；单日同工具失败预算 3 次；F8 接管静默 8s 回托管。
- **回退方案**：
  - C# 真模组编译/加载受阻 → 上层 `TerrariaAdapter` + 仿真器继续闭环（GAME_BRIDGE 统一协议不变），真机接入延后但不返工。
  - 真机模组端口 18090 被占用/受限 → 启用 tmodloader-mcp 式文件信箱降级（另立工单），契约形状不变。
  - 许可证复核若发现任一参考项目实际非 MIT → 立即删除对应片段与登记，退回纯思想重写（本工单当前未复制源码，风险为零）。

---

## 5. 复评记录

| 日期 | 工单 | 结论变化 | 原因 |
| --- | --- | --- | --- |
| 2026-11-22 | T-M7-T1~T6（立项预评） | 确立 TerraBlind 为 M7 泰拉瑞亚主参考（MIT，思想吸收）；MutantPilot / tmodloader-mcp 为辅助；TShock/TSAPI/HEROsMod/TerraNoneBridge 判为 GPL-3.0 红线；EmreSelcuk1492/hamnaanaa/wfz2006/TCR 判为无许可证只参考思想 | 工单提供的复评资料 + 许可证分类；未逐行审计源码，合流前在 THIRD_PARTY_NOTICES 复核 LICENSE 原文 |
| 2026-11-22 | T-M7-T1 | 统一桥接协议落地为 18090 五端点（`GET /state` · `POST /act` · `GET /action_status` · `POST /cancel` · `GET /health`），采纳 TerraBlind 三段式回执但以 shared-protocol 为唯一契约源；`action_status` 的 receipt 按契约基形不含 snapshot（富快照走 `/state`） | 契约先行铁律 + 与 DST 泳道共用编排器；本地 vitest 11/11 通过实证 |
| 2026-11-22 | T-M7-T3~T6 | 采纳 CAPABILITIES.md 两条踩坑（IsPassable≠Vacant、StepCost int.MaxValue 溢出）进入 `NavLite`；接管统一为 F8 + `<100ms` ABORTED；规则兜底零 token 含 UNCERTAIN 冷却与单日失败预算 | 本地 vitest 17/17 通过 + 大师模式无伤影像佐证 |
