# REFERENCE — ValleyServer（Lixeer/ValleyServer）复评档案

> 仓库：https://github.com/Lixeer/ValleyServer ｜ 许可证：**Apache-2.0**（`reference-clones/ValleyServer/LICENSE` L1–3 核实；`Mods/` 二次开发 MOD 按其各自原协议）｜ 主语言：C#（`.NET 6` SMAPI MOD + `.NET 8` 3.x 无头探索）
> 分析方式：只读本地克隆 `reference-clones/ValleyServer/` 源码与 README（仅作数据审阅，未执行构建或脚本）。分析日期：2026-11-28

---

## 1. 结论摘要

仓库包含两条技术路线：
1. **`src/ValleyServer/`（3.x 反编译无头服务端实验）**：为绕过反序列化崩溃，必须直接丢弃联机增量消息（`HeadlessGameServer.cs` L77–85、`Program.cs` L72–77）并缺失完整农业/NPC/节日系统——**不可用作自主游玩载体**。
2. **`Mods/ValleyWhale/`（Blind Whale Farmer 的 Apache-2.0 衍生分支 v1.1.1）**：成熟完整的多模块 AI/MCP 游玩实现，沉淀了多条可直接供 `game-bridge-mcp` / 模组侧参考的高可靠性工程实践。

## 2. 采用什么（纯思想借鉴，未复制源码）

- **全场景 24 符号纯文本 `Observer`**：按行编码地图符号（区分干湿空地/可收作物/有产物机器 `&`）+ 天气/运气/施工/生日偏好/跨图动线（`Observer.cs`）。
- **真脚底碰撞盒校准 A\* + 跨图 BFS**：按 `top = Sprite.getHeight() - 32` 与 `(x*64+8, y*64+top, 48, 32)` 校验真实脚步框，`skipCollisionEffects: true` 避免推人副作用（`Pathfinder.cs` L24–28、`Exits.cs`）。
- **双模 пауза与安全兜底**：等模型决策时仅用 `Game1.isTimePaused`（且显式避开多人模式防冲突）；MCP 长时间无调用启用 `Game1.paused` 防矿洞晕倒；`F7` 秒接管 + 假剧情死锁自解（`RecoverStuckEvent`：`eventUp` 但无真实剧情/菜单切图时解锁，`GameActions.cs` L2122–2125）。
- **睡前归家耗时估算 `EstimateMinutesToBed`**（`GameActions.cs` L2028–2054）：沿跨图路径按移速和切图损耗计算归程游戏分钟数（已在 Batch 8 中引入「22:45+ 屋外回屋提醒」）。
- **12 帧物理前瞻钓鱼 & 刀弧通视战斗**：`bobberBarPos + bobberBarSpeed * 12f` 模拟按压增量（`GameActions.Fishing.cs`）；`MeleeWeapon.getAreaOfEffect` 并集 + 隔石视线检测 `HasDamageLineOfSight` + 识破装甲虫（`GameActions.Adventure.cs`）。
- **SSE `: keep-alive` 与断连即中止**（`McpServer.cs` L446–462）：客户端断连立即触发主线程 `CancelCurrent`。

## 3. 不采用什么（为什么）

- **3.x 无头服务端**：缺少完整玩法循环与正常存档状态机。
- **`ChatInput.cs`（WinForms + PowerShell + `user32.dll`）**：纯 Windows 强绑定，无法运行在 macOS Apple Silicon。
- **单体 `GameActions.cs` 与文件级松散结构**：我们坚持 `shared-protocol` Zod 契约 + 中心 WS/JSON-RPC 网关架构。

## 4. 复评记录

| 日期 | 结论变化 | 原因 |
| --- | --- | --- |
| 2026-11-28 | 首次建档；确认为 Apache-2.0（`Mods/` 按各自原协议）；沉淀 `RecoverStuckEvent`、`EstimateMinutesToBed`、12 帧钓鱼/LOS 战斗与 `Pathfinder` 脚步盒思路 | 只读审计本地克隆 `reference-clones/ValleyServer` |
