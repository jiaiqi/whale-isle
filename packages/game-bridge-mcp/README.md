# packages/game-bridge-mcp — 游戏控制层

> 状态：**未开工**（对应工单 `T-M3-01` ~ `T-M3-03`）｜ [SPEC §3.5](../../docs/SPEC.md)

## 职责（《星露谷物语》MCP 具身代理与丝滑共玩）

- **MCP 客户端**：连接 SMAPI Mod（`mods/stardew-mcp-mod`）的 WebSocket 服务；动作封装为原子级 Tools（`move_to_tile` / `use_tool_on_tile` / `water_crops_batch` / `interact_with_npc` / `check_trash_can` / `eat_food_for_stamina` / `go_to_sleep`，见 `StardewMcpActionReceiptSchema`）。
- **动作互斥锁**：同一时刻仅允许一个游戏动作在途。
- **`uncertain` 状态机**：`FAILED/UNCERTAIN` 触发"大肥鱼"冒失甩锅台词（`clumsy_panic`），写入短期记忆防止死循环撞墙；重试上限受控。
- **键鼠一动即接管（Seamless Co-Play）**：检测玩家物理输入 → 0.1s 内挂起 AI 动作锁（`ABORTED_BY_HUMAN_TAKEOVER`）→ 切换场边解说陪玩模式；物理输入静默 8s 后平滑接回自动驾驶。

## 铁律

**真实执行回执铁律**：严禁把大模型台词里的"我已经做好了"当成任务完成；一切以 SMAPI 真实返回的 `COMPLETED | FAILED | UNCERTAIN` 为准。
