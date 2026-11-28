# REFERENCE — dsh-stardew-blind-whale-farmer（BlindWhaleFarmer）复评档案

> 仓库：https://github.com/Darianliu23/dsh-stardew-blind-whale-farmer ｜ 许可证：**MIT**（LICENSE 原文核实，此前"待核实"解除——**可在保留版权头前提下直接改造**）｜ 主语言：C#（SMAPI mod）+ JS（DSH 插件）｜ Stars：21 ｜ 最近推送：2026-11-14
> 分析方式：README 全文 + `docs/dsh-plugin.md` + `BlindWhaleFarmer/` 目录结构；未逐行审计源码。分析日期：2026-11-15

## 1. 结论摘要

**M3《星露谷》模块的直接底座**：SMAPI 模组把游戏"翻译"成纯文字（状态/背包/29×19 字符地图/作物坐标/出口/村民好感生日/动物/钓鱼点/矿洞），AI 经 function calling 发指令，模组用**游戏原生 API** 执行（寻路、用工具、播种浇水），全程无视觉模型——与 SPEC §3.5 的设计完全同源，且许可证允许直接改造而非重写。

## 2. 采用什么

- **状态树 → 文字观察**（`Observer.cs`）：体力/生命/金钱/技能/背包/当前菜单与选项/本地点出口与营业时间/村民位置好感生日/作物状态坐标/附近物体带建议工具/29×19 以玩家为中心字符地图/动物待办/送礼喜好——`gameStateSnapshot` 契约的蓝本。
- **寻路与移动**：`Pathfinder.cs`（当前地图 A*）+ `Exits.cs`（跨地图出口图 BFS，自动开门）；寻路失败返回原因（`PATH_BLOCKED` 类）。
- **真实执行铁律**：工具全部走游戏原生逻辑（`BeginUsingTool`/`checkAction`/`tryToPlaceItem`/`shipItem`），体力消耗、动画、掉落与手动一致——严禁结果造假的技术实现。
- **接管语义**：按 **F7** 立即中止 AI 正在执行的动作，之后游戏动作被拒绝并回"玩家接管了"提示，再按交还——映射我们 `ABORTED_BY_HUMAN_TAKEOVER` + `GameControlAuthoritySchema`。（BWF 是显式按键接管，无 0.1s 物理键鼠监听——我们的 Seamless Co-Play 是增强而非替代。）
- **游玩预算**：`SessionDays` / `SessionMinutes`（到点先回家睡觉存档再停下汇报）——防沉迷式任务边界。
- **时间冻结**：AI 思考时冻结游戏时钟；MCP 客户端空闲 120s 暂停游戏。
- **攻略分层省 token**：主攻略 + 钓鱼/采矿/节日专题**按需 `get_guide`**，不塞进常驻上下文。
- **坏回复自动续玩**：模型吐坏工具调用文本时等会话空闲自动"接着玩"，连续上限 3 次、有成功即重新计数——`uncertain` 重试上限的现实参照。
- **离线测试**：`tests/HarnessTest/` 不启动游戏即可测模组逻辑——`stardew-mcp-simulator` 的对接思路（真实 mod 逻辑也可离线断言）。
- **成本画像**：每步 10k–14k 输入 token（系统提示+工具定义约 7.5k 固定、命中 DeepSeek 缓存），每 10–20 秒一步——**印证粘性路由 + Prompt Cache 假设**。
- **联机三模式**：指令做完接着自己玩（默认）/ 主要听指令 / 自己玩，固定口令即时切换——托管/接管状态机的语义参照。

## 3. 不采用什么（为什么）

- **传输协议**：BWF 的 MCP 是本机 Streamable HTTP（`127.0.0.1:18080/mcp`）；我们统一走 WS + JSON-RPC 2.0（端口 18760），契约以 `shared-protocol` 为准——仅保留其工具语义，不改我们的总线。
- **内置 DeepSeek 直连**（`DeepSeekClient.cs` 直连 api.deepseek.com）：我们所有模型调用必须经 `model-gateway`（脱敏/路由/计量）。
- ~~53 个全量工具直接搬~~（已过时，见复评 2026-11-22）：实测 `Tools.cs` 注册 **81 个工具**（74 动作 + 3 Schema.Add + 4 MCP 专属），我们已放行 78 个进 LLM 白名单、按需扩充策略。
- **「无字面 UNCERTAIN」**：BWF 回执只有 `成功：/失败：/错误：` 三前缀，「打断了/超时/被接管」都折叠成「失败：+原因」——我们的 workbench 需在上层按原因文本映射出 UNCERTAIN 语义（见 `mcp-client` 分层超时）。

## 4. 验证路径、预算边界与回退方案

- 验证路径：T-M3-01 在 `stardew-mcp-simulator` 跑 5 剧本（含 `uncertain` 卡死与接管）；T-M3-04 `dotnet build` 零警告（BWF 用 .NET 6 + SMAPI 4.5.2 + 游戏 1.6.15，直接沿用其构建链 `build.ps1`）。
- 预算边界：游玩预算字段（SessionDays/Minutes）进 C# Mod 配置，硬上限写在 Mod 侧而非 LLM 侧。
- 回退：C# 改造受阻时，上层逻辑（规划器/回执处理/接管）先用模拟器闭环，Mod 最后接入。

## 5. 复评记录

| 日期 | 工单 | 结论变化 | 原因 |
| --- | --- | --- | --- |
| 2026-11-15 | 预置 | 许可证由"待核实"变更为 **MIT 可直接改造**；补充真实工具清单与成本画像 | GitHub API + LICENSE 原文核实 |
| 2026-11-22 | T-M6-12 | ①工具数纠正为 **81**（`Tools.cs` 74 + Schema.Add 3 + MCP 4；README"72"为旧数），我们白名单已放行 78；②新增三条「最值得移植的回执设计」：**参数教学回执**（坏 JSON 六步自修 + 参数别名表 + 「缺什么参数」报错，真机实测 LLM 一轮就学会补 `give_gift.item`）、**头部回执补投通道**（【上一个动作的结果】【正在执行】，45s 先回不丢结果）、**Agent 规则第 4 条**「同一失败动作不重复超过两次」→ 已移植为 LlmPlanner 单日失败预算/冷却（真机 dialogue×191 / place_item×96 死循环的根因修复）；③`get_state(section=)` 分段读取与 `bundle_info`/`update_notes`/`reserve_items`/`perfection` 等被忽略工具列入后续工单清单 | 本地克隆全量审计（`Agent.cs:28`、`McpServer.cs:433-472`、`Tools.cs:682-727`）+ 真机 transcript 实证 |
| 2026-11-28 | 真机两季打磨 | 实盘拉取上游最新 **`v1.1.32`** 源码至 `reference-clones/dsh-stardew-blind-whale-farmer` 复核（35,758 行）：①总工具增至 **95**（较主仓 `v1.1.27` 多出 `prepare_field` / `cut_hay` / `list_machines` / `collect_machines` / `storage_info` / `furniture` / `drop_item` / `prepare_fishing` / `museum_info` / `raccoon` / `crystal_cave` / `gem_shrine` / `mermaid_puzzle` / `darts_game` / `toggle_ai` / `load_save` 共 16 个工具）；②新增 `FieldPlan.cs` 蓝图造田、`Bombs.cs` 逃生校验、`Volcano.cs` 泼水铺路、`TryAutoTidyBeforeMine`、`EstimateMinutesToBed`、`RecoverStuckEvent`、`RecoverOffMap`、`OwnersOutNote`、`SeedWontRipen` 及 40+ 参数别名表；③⚠️ 上游 `1.1.32` **仍未合入主仓 `mods/bwf-patches/` 3 项补丁**，因此保持先在 TS 侧精准归一化与环境提示、暂不贸然替换运行中 DLL，后续专开 BWF 1.1.32+补丁 rebase 工单迁移 | 全量只读源码对比 `v1.1.32` vs `mods/bwf-patches` 与两季实测失败特征 |
