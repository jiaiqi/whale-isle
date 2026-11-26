# `V2-P2-08` 双端联机验收路径核实（2026-11-26）

> 背景：此前证据文档写「需要第二台机器或第二个 Steam 账号」，派工要求按项目验收条件与游戏实际启动限制重新核实，不要先要求 owner 购置设备。
> 结论先行：**同机验收在项目条款内是允许的，且有一条不需要第二账号、不需要第二台机器的官方路径——本地分屏合作（Start Local Co-op）**；但 AI 端以 farmhand 身份受控这件事仍是实现缺口，不是设备缺口。

## 1. 项目侧验收条件（本仓真源）

- `docs/v2/TRACEABILITY.md` **REQ-GAME-04**：「真人+AI 联机与多 AI/多设备协作（`CoopRuntime`：**同机/多机**、分工、资源预留、外观同步、掉线恢复）」——「同机」写在需求里，属合法验收形态。
- `docs/v2/ROADMAP.md` `V2-P2-08` 的待验项原文是「双端星露谷客户端真机联机实玩」，未强制要求两台物理设备。

## 2. 游戏侧事实（官方 Wiki 原文核实）

来源：<https://stardewvalleywiki.com/Multiplayer>（2026-11-26 抓取）

| 事实 | 原文要点 |
| --- | --- |
| 联机方式 | 「1–8 players can join the same world through **split-screen**, over LAN, GameShare, or by **IP address**」 |
| 分屏启动步骤 | 「Create or load the save normally. **Build a cabin for each new player** in single-player mode. **Connect a controller** to the computer/console for each extra player.（The keyboard on PC is always reserved for the first player…）Open the in-game menu → Options → Multiplayer → **Start Local Co-op**」 |
| 分屏是否要第二账号 | 「**Local split-screen multiplayer is free**」——同机同账号即可，无第二个 Steam 账号要求 |
| 远程加入 | 经 Steam 好友列表、GOG/Steam **invite code**，或 **IP 地址**（默认 UDP `24642`） |
| 平台互通 | PC 版本之间（Windows ↔ macOS）可互通 |

本机盘点：

- 游戏已装：`~/Library/Application Support/Steam/steamapps/common/Stardew Valley`。**订正（2026-11-26）**：`~/Applications/Stardew Valley.app` 经查 `Contents/MacOS/run.sh` 只有 `open steam://run/413150`，是 Steam 快捷方式，**不是**独立副本；本机没有第二份游戏。
- Steam `userdata` 仅 **1 个真实账号**（`395340529`）＋ `anonymous`。
- 存档目录 `~/.config/StardewValley/Saves`（`qi的_451149533`、`泡泡湾_454908853`），**不得改动**。
- 抓取时刻 SMAPI 进程（`StardewModdingAPI`）已运行约 1 小时但无游戏进程，疑似停在启动提示，未干扰。

## 3. 两条同机路径的可行性判定

| 路径 | 需要第二账号？ | 需要第二台机器？ | 现状与风险 |
| --- | --- | --- | --- |
| **A. 本地分屏合作**（推荐先做） | **不需要** | **不需要** | 需要「单机模式先建 cabin」＋「为额外玩家接一个手柄」；键盘固定给 1P。**真正的缺口是 AI 端**：现有 BWF 实测全部是单客户端房主（键盘/鼠标注入），farmhand 的输入与控制语义未验证 |
| B. 同机双实例 + IP 直连 | 需要（Steam 同账号不能同时跑同一游戏两个实例），或用非 Steam 副本绕过 | 不需要 | 双实例共享 `~/.config/StardewValley`，必须先隔离 HOME/存档，否则**有污染现有存档的风险**；IP 直连客户端是否仍需 Steam/GOG 在线未核实 |

## 4. 结论与建议动作

1. **不要先要求 owner 购置第二台设备**。按项目条款与官方能力，同机即可完成「真人 + AI 同一农场」的验收。
2. 先走路径 A：owner 在单机模式建 cabin、接一个手柄、Options → Multiplayer → Start Local Co-op；我方验证 farmhand 场景下 `CoopRuntime` 控制租约、任务板、资源预留与「仅替换本端玩家」的外观同步。
3. **实现缺口（需单独立工单）**：BWF/SMAPI 目前只对房主生效，farmhand 身份下的动作回执、输入路由与「玩家一动即接管」判定未实现/未验证。这条不解决，路径 A 只能验到「两人同屏不打架」，验不到「AI 真的替 farmhand 干活」。
4. 只有在需要「两个独立客户端 + 网络同步」的证据（如跨端外观差异、断线重连）时，才需要第二个 Steam 账号或第二台机器；这属于 `V2-P5-02` 的范围，不阻塞 `V2-P2-08` 结项口径。
