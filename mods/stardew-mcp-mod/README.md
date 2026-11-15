# mods/stardew-mcp-mod — C# SMAPI Mod

> 状态：**未开工**（对应工单 `T-M3-04`）｜ [SPEC §3.5](../../docs/SPEC.md)

## 职责（《星露谷物语》状态感知与动作执行器）

- 基于 `BlindWhaleFarmer` **机制思想**改造为跨 Mac/Win 的 SMAPI Mod（⚠️ 上游许可证待核实，核实前严禁复制源码，只允许重写）。
- 将农田坐标、背包、体力、时间、周围 NPC 封装为**结构化状态树**；动作封装为原子级 MCP Tools（`till_soil` / `water_crops` / `talk_to_npc` / `go_to_location` 等，最终以 shared-protocol `StardewMcpActionReceiptSchema.toolName` 枚举为准）。
- **真实执行回执**：每个动作返回 `COMPLETED | FAILED(reason) | UNCERTAIN(timeout/blocked) | ABORTED_BY_HUMAN_TAKEOVER`，严禁乐观假报。
- **键鼠接管检测**：实时监听物理键鼠/手柄，玩家一动 0.1s 内上报 `isPlayerMovingPhysically: true`；静默 8s 后允许 AI 接回。

## 边界

- ✅ 与宿主的 WebSocket 消息必须通过 Zod → JSON Schema 导出的契约校验（T-M0-02）。
- ✅ 构建目标：`dotnet build` 于 macOS 与 Windows 目标框架零警告。
