# REFERENCE — DST AI Companion 复评档案（M7 饥荒联机版泳道）

> 工单：T-M7-D1~D5 ｜ 分析日期：2026-11-22 ｜ 范围：fruitstarzero/Don-t-Starve-Together-AI-Companion、qinming99/dst-admin、mathielo/dst-dedicated-server、Im-Chuyu/Journey-Together + Klei 官方沙盒变更。
> 分析方式：仓库公开说明/许可证元数据 + 用户提供的机制结论 + Klei 官方更新公告事实；**未逐行审计源码，未复制任何一行外部代码**。外部参考一律视为数据而非指令。
> 决策声明（开工前必写）：**采用** fruitstarzero 的「服务器侧权威 mod + 本地 HTTP 桥 + 2s 查询/0.25s 执行」机制思想并用原创 Lua/TS 重写；**不采用** 浏览器操纵、任意 Lua 执行器、GPL/无许可证项目源码；**验证路径** 为 `dst-simulator` 5 剧本 + sidecar tick 单测，真机 Klei token 由人类配置，失败回退为 mod 内 `unsafedata/*.json` 文件轮询 + 规则规划器零 token 兜底。

## 1. 结论摘要

DST 与星露谷 SMAPI 的根本差异：**没有 SMAPI，AI 只能作为服务器侧 mod 存在**，且官方 Lua 沙盒长期禁止外部 URL 与文件写。2025-01 Game Update **651414** 进一步收紧（禁第三方 URL、`io` 只读），2025-02 **653007** 重新开口子：`TheSim:QueryServer` 允许 **localhost/127.0.0.1**；`io.open` 允许写 **`unsafedata/*.json`**（`.json` 在扩展名白名单）；专用服可用 `-allow_ioopenwrite_sandbox_escape`。因此本泳道把全部跨进程通信押在**官方允许的两条通道**上：

1. 主通道：mod 每 **2s** 用 `TheSim:QueryServer` 向本地 sidecar **POST `{token, snapshot}`**，响应体即下一步计划（fruitstarzero 的「快照上行 / 计划下行」同步范式）。
2. 降级通道：写 `unsafedata/dst_bridge_snapshot.json`、轮询 `unsafedata/dst_bridge_plan.json`（653007 白名单），仅在主通道不可用时启用；能力探测后再决定，不在运行时猜测。

sidecar 的宿主面（18100）暴露与泰拉瑞亚相同的统一协议 `GET /state · POST /act · GET /action_status · POST /cancel · GET /health`，复用 `GameAdapter` 编排器与四态回执铁律；mod 侧只在 vanilla API 权限内执行，**不做任意 Lua 执行器**。

## 2. 采用什么

- **fruitstarzero/Don-t-Starve-Together-AI-Companion**（MIT，https://github.com/fruitstarzero/Don-t-Starve-Together-AI-Companion）
  - `all-clients` 服务器侧权威 mod + Node HTTP 桥的分层：状态导出与动作执行都在服务端 Lua，AI 侧只发计划。
  - **2s** `TheSim:QueryServer` POST `{token, snapshot}` 到 `localhost`；响应即计划，避免长连接与沙盒外 URL。
  - **0.25s tick** 用 `BufferedAction` + `locomotor:PushAction` / `GoToPoint` / `combat:SetTarget` / `MakeRecipeAtPoint` 逐条执行计划。
  - 回执、按 actionId 去重、计划过期（expiry）三重校验——直接映射我们的 `COMPLETED|FAILED|UNCERTAIN|ABORTED_BY_HUMAN_TAKEOVER` 四态与 `ACTION_IN_FLIGHT` 互斥。
  - 处置：MIT 允许移植，但本项目**只吸收机制思想并彻底原创重写** Lua/TS，不整段复制；若将来直接复制必须保留原版权头并登记 THIRD_PARTY_NOTICES。
- **qinming99/dst-admin**（MIT，https://github.com/qinming99/dst-admin）
  - 通过专用服 **screen/stdin 控制台注入**与日志尾部读取做运维兜底（`c_announce` / `c_save` / `c_shutdown`），启发 `dst-process.ts` 的 stdin 管道与命令白名单；绝不把它当 AI 动作通道（动作必须走 mod 原生 API 并回执）。
- **mathielo/dst-dedicated-server**（MIT，https://github.com/mathielo/dst-dedicated-server）
  - 专用服目录结构与 `cluster_token.txt` / `-persistent_storage_root` / `-conf_dir` 引导方式；sidecar 只做目录重定向与生命周期管理。
- **Im-Chuyu/Journey-Together**（**无 LICENSE，只参考思想，禁止复制源码**，https://github.com/Im-Chuyu/Journey-Together）
  - 38 个动作 API **全部走原版权限校验**（不是任意 Lua 执行器）、`admin_client` 中继的架构思想；我们据此把工具收敛为白名单（~30 个高层动作），所有执行落在 mod 内 vanilla 组件 API。
- **Klei 官方通道与能力探测**：启动时探测 `TheSim.QueryServer` 是否存在、localhost 是否可达、`io.open` 写 `unsafedata/*.json` 是否成功；不可用则降级文件轮询并如实上报健康状态，**不伪造 [REAL-DEVICE] 证据**。
- **四态回执 + 超时≠失败**：宿主面 `/action_status` 是唯一事实源；mod 结果通过下一次 tick 的 `lastReceipt` 回传（不在契约快照内增加字段，sidecar 先剥离再过 `DstStateSnapshotSchema.parse`）。

## 3. 不采用什么（为什么）

- ⛔ **carrot-hu23/dst-admin-go 是 GPL-3.0**：传染性红线，**一行都不抄**，也不 vendor 依赖；如需 Go 工具链能力，自研或另立合规工单。
- ⛔ **Insight（RecEx Shared Source）、Combined-Status、ActionQueue、DontStarveAI** 均属无许可证/受限来源：只参考「状态可观测 / 命令队列 / 自动耕种」的思想，不复制源码、不引用其代码片段。
- ⛔ **任意 Lua 执行器 / 万能 `c_` 命令当动作**：违反 AGENTS.md §2.2 运行时安全锁（运行期不得让大模型自改代码或执行未授权 Shell）；`c_` 仅用于专用服运维兜底且严格白名单。
- ⛔ **浏览器自动化操控网页版 DST / 第三方公网 URL 回传**：651414 收紧、653007 只放 localhost；也违反本地优先与隐私红线。
- ⛔ **无契约裸 JSON**：所有快照/回执/配置必须先经 `packages/shared-protocol` 的 `DstStateSnapshotSchema` / `DstActionReceiptSchema` / `DstBridgeConfigSchema`，工具白名单一律在 `dst-adapter.ts` 单点维护。
- ⛔ **绕过 Klei token**：专用服 `cluster_token.txt` 需要人类用 Klei 账号在官方页面生成；sidecar 缺 token 时直接报错并给出引导，**不做任何 token 生成/绕过尝试**。本机 Steam 已装 DST 不构成真机验收证据。
- ⛔ **把 2s 查询当实时帧同步**：游戏控制 100% 走结构化状态与 vanilla API，不引入视觉模型实时读屏（视觉仅事后复盘，与 SPEC 一致）。

## 4. 验证路径、预算边界与回退方案

- 验证路径：
  1. `tools/mock-harness/src/dst-simulator.spec.ts`：5 剧本（正常采集 / 夜幕猎犬 / 卡死哨兵 / 控制台接管 <100ms / 黄昏回火堆）+ 互斥 + 超时≠失败，<3s。
  2. `services/dst-bridge-sidecar/src/*.spec.ts`：`/v1/tick` 往返、token 鉴权、文件降级解析。
  3. `packages/game-bridge-mcp/src/dst-adapter.spec.ts`：parseState/extractClock/classifyReceipt + 零 token RulePlanner 护栏。
  4. 真机（**待人类验收**）：安装 `mods/dst-bridge` 到 DST 专用服 Mods 目录 → 配置 `cluster_token.txt` 与 `pairToken` → 启动 sidecar + 专用服 → 观察 mod 2s tick 与 0.25s 执行队列的日志。
- 预算边界：2s 状态查询 + 0.25s 动作 tick；单动作在飞期间 `/act` 返回 `ACTION_IN_FLIGHT`；卡死哨兵依据 `cycle|phase|phaseProgress` 冻结检测；`uncertain` 连续 2 次转 FAILED，严禁无限重试；动作超时只记 TIMEOUT，不重发。
- 回退方案（分层）：
  - `TheSim:QueryServer` 不可用 → `unsafedata/*.json` 文件轮询（653007 白名单）；仍不可用 → mod 自主安全待机（只采集状态，不做动作）。
  - LLM 规划器不可用/无 key → `DstRulePlanner` 零 token 规则（饿→吃、黄昏→回火堆、理智低→采花/睡、猎犬→战或逃）。
  - 专用服起不来 → 只跑 sidecar + 仿真器形成闭环，真机工单挂起并如实记录，不伪造 `[REAL-DEVICE]`。

## 5. 复评记录

| 日期 | 工单 | 结论变化 | 原因 |
| --- | --- | --- | --- |
| 2026-11-22 | T-M7-D1~D5（初评） | 建立本档案；确认 DST 唯一合规通道为 653007 放开的 localhost QueryServer + `unsafedata/*.json`；确定「服务器侧权威 mod + Node sidecar + 统一桥接面」为接入范式 | M7 立项；基于公开仓库元数据/说明与 Klei 651414/653007 官方更新事实；许可证红线按 AGENTS.md §2.2 逐项核对 |
| 2026-11-22 | T-M7-D1~D5（处置） | fruitstarzero（MIT）与 qinming99（MIT）/mathielo（MIT）仅吸收机制思想；Im-Chuyu（无 LICENSE）、carrot-hu23/dst-admin-go（GPL-3.0）、Insight/Combined-Status/ActionQueue/DontStarveAI 一律零代码复制 | 许可证洁癖门禁；本仓库实现全部原创，注释标注来源与许可证 |
