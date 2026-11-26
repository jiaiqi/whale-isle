# `V2-P2-09` farmhand 联机控制与实例隔离：勘察、方案与工单拆解（2026-11-26，item 6）

> 性质：**只读勘察 + 方案设计**。未修改任何游戏/仓库文件，未启动或停止游戏，未 git 操作。
> 方法：本仓源码实读 + 本机 `Stardew Valley.dll` / `System.Private.CoreLib.dll` 反编译（产物仅落 `/tmp`）+ 本机 SMAPI 4 XML 文档 + 磁盘与 Steam Cloud 元数据。
> 背景：`V2-P2-08` 的验收路径已核实「同机/同账号即可，不必先购置第二设备」（见 [P2-08-coop-acceptance-path-analysis.md](./P2-08-coop-acceptance-path-analysis.md)），真实缺口是 **farmhand 身份下的 AI 控制**与**联机实例隔离**。

## 0. 结论先行

1. **「farmhand 由 AI 控制」在同机分屏下：有条件可行**。游戏侧支持（分屏是同进程多个 `Game1` 实例，SMAPI 4 每屏各触发一次更新回调并给 `Context.ScreenId`/`PerScreen<T>`），但**现版 BWF 完全没有分屏感知**（`grep ScreenId|PerScreen|IsSplitScreen` 全仓 0 命中），直接跑会把动作施加到当前正在 tick 的那一屏——**随机控制到人类角色**。
2. **同进程分屏的正确做法**：同一个 SMAPI 模组里，按 `Context.ScreenId` 把动作派发到目标屏的 tick 内执行；**不是**由房主屏越屏去改另一个实例的 `Farmer`（那是绕过实例静态字段的写，会与该屏自身的输入/更新打架）。
3. **隔离方案推荐 A′**：给游戏子进程注入**绝对路径**的 `XDG_CONFIG_HOME`（可加 `XDG_DATA_HOME`），**不要改 `HOME`**。不改 owner 任何文件，回滚 = 删掉那一处 env 注入或删除隔离目录。
4. **真正的硬阻塞是 BWF 的进程级单例结构**（MCP 服务端、`MainThread` 单队列、`PlayerInControl`、HUD、Session 各一份），这是代码缺口，不是设备缺口。

## 1. 现状勘察（文件:行号）

### 1.1 BWF 在哪、怎么拿到控制权

- 上游克隆（MIT，保留版权头，不在本仓）：`/Users/jiaqi/Documents/vibe/reference-clones/dsh-stardew-blind-whale-farmer/BlindWhaleFarmer/`；本仓只存补丁：`mods/bwf-patches/README.md`。
- 本机已装：`~/Library/Application Support/Steam/steamapps/common/Stardew Valley/Contents/MacOS/Mods/BlindWhaleFarmer/`，`manifest.json` 为 `Darian.BlindWhaleFarmer v1.1.27`、`MinimumApiVersion 4.0.0`，`config.json` 的 `McpPort` 为 `18088`。
- **它不注入键鼠**，而是直接调游戏原生 API 操纵本地农夫：
  - 走路写坐标 `Player.Position = target`（`GameActions.cs:258`）、贴格（`GameActions.cs:139-142`）
  - 朝向/走路帧（`GameActions.cs:144-150`、`158-185`）
  - 交互 `Loc.checkAction(...)`（`GameActions.Clearing.cs:84,204,309`）、放置 `Utility.tryToPlaceItem(...)`（`GameActions.Bombs.cs:110`）
  - 冻结/解冻 `Player.CanMove`（`GameActions.cs:627,4694,4750`、`GameActions.Adventure.cs:511`）、中止 `Game1.player?.Halt()`（`MainThread.cs:307-311`）
  - 自研 A* 寻路（`Pathfinder.cs:1-40`）
- **已经区分「主玩家 / 农场工人」，但不区分「哪一屏」**：`Game1.IsMasterGame` / `Context.IsMultiplayer` 分支见 `GameActions.cs:1342`（农场工人换图等主机发地图）、`:2001-2011 MyCabinDoor()`、`:4277`、`GameActions.Knowledge.cs:84`；`shared` 工具参数与 `OwnFieldRadius=10` 见 `Tools.cs:108,117` 与 `GameActions.cs:2000`。
  - 含义：**BWF 在「独立进程的联机客机」里本来就能正确工作**；缺的是「同一进程内第二块屏」这个维度。

### 1.2 「玩家一动即接管」现在怎么检测

**没有自动检测，只有显式 F7**：

- 只订阅了一个输入事件：`helper.Events.Input.ButtonPressed += OnButtonPressed`（`ModEntry.cs:91`）。
- F7 → `SetPlayerInControl(!PlayerInControl)`（`ModEntry.cs:282-286`）；F8 启停内置 AI（`:287-292`）；F6 聊天（`:277-281`）。
- `SetPlayerInControl` 语义：取消在跑动作、停内置 AI、解冻时间、`Game1.player.CanMove = true`、HUD 提示（`ModEntry.cs:441-460`）。
- 远端同开关：`/settings` 收 `playerInControl`（`ModEntry.cs:190-207`，本仓补丁 `mods/bwf-patches/2026-11-25-player-in-control-settings.patch`）。
- 拒绝执行：`PlayerInControl` 时除信息类工具外一律拒绝（`McpServer.cs:425,452`）。
- 结论：**没有全局键鼠钩子**；本仓 `ADR-004` 已把这条固化成决策（游戏租约只认 F7 / 界面开关 / P0 急停）。
- 契约里的 `isPlayerMovingPhysically`（`packages/shared-protocol/src/index.ts:295`）**只有契约与仿真器实现**（`tools/mock-harness/src/stardew-simulator.ts:36,134,179`），C# 侧 0 实现。

### 1.3 动作回执链路（以及一个必须纠正的口径）

1. MCP `tools/call`（`McpServer.cs:244`）→ 工具体现在 `Tools.cs`（74 动作）→ `main.RunAction(...)`（`Tools.cs:594`）
2. 主线程协程 `MainThread.RunAction/Tick/Finish`（`MainThread.cs:145-190,193-269,317-331`）。**回执是纯文本前缀**：`成功：` / `失败：` / `错误：`，超时/被打断/取消都折叠成「失败：+原因」
3. HTTP 回复（早期 45s + SSE keep-alive，`McpServer.cs:659-672` 附近 `EarlyReplyMs`）
4. TS 客户端 `BwfMcpClient.callTool`（`packages/game-bridge-mcp/src/mcp-client.ts:66-123`）
5. 分类 `classifyStardewReceipt`（`packages/game-bridge-mcp/src/adapter.ts:99-118`）→ `StardewAdapter`（`adapter.ts:133-170`）
6. 事件 `AutodriveEvent{type:'receipt'}`（`packages/game-bridge-mcp/src/autodrive.ts:32-47`）
7. 任务板 `CoopRuntimeV1.reportTaskOutcome`（`packages/game-bridge-mcp/src/coop-runtime.ts:404-424`，`UNCERTAIN → blocked`）
8. 宿主接线 `v2:coop-task-action`（`apps/desktop-host/src/main/v2-kernel-host.ts:1118-1123`）

**诚实口径纠正**：`CoopRuntimeV1` 的房间/任务/预留全在内存 `Map`（`coop-runtime.ts:163-166`），回执只广播给渲染层；**目前不存在「动作回执写入 SQLite」的实现**，不得按「已落库」写验收。

### 1.4 联机世界状态

可见但是**文本观察**：`Observer.Build()` 把 `Game1.player` 周边转纯文本（`Observer.cs:65` 起），其他玩家经 `GameActions.OtherPlayersLine()`（`GameActions.Chat.cs:116-126`）拼进状态文本（`Observer.cs:153`）；聊天靠 Harmony 补 `ChatBox.receiveChatMessage`（`ModEntry.cs:339-354`）。TS 侧只解析少量文本（游戏时钟正则 `adapter.ts:120`），**没有「其他玩家坐标/背包」的结构化契约**。

### 1.5 启动器现状（隔离缺口在这里）

- 主启动器 `apps/desktop-host/src/main/stardew-launcher.ts`：直接 spawn `Contents/MacOS/StardewModdingAPI`，`cwd=Contents/MacOS`，**env 继承 `process.env` + `SMAPI_NO_TERMINAL/SMAPI_USE_CURRENT_SHELL`**（`:384-390`；这两个变量其实只被 bash 包装脚本读，直接 spawn 二进制时是空转）；回退 `open steam://rungameid/413150`（`:393-398`，**无法携带自定义 env**）。
- 联机启动器 `apps/desktop-host/src/main/coop-launch-host.ts`：`prepareStardewProfile` 造隔离 **Mods 目录**后 spawn `StardewModdingAPI --mods-path …`（`:144-162`）；但 `spawnGameProcess` **不传 env**（`coop-launcher.ts:124-126`）。
- **结论：现在只隔离了 Mod 目录，没有隔离 HOME/XDG/存档**，第二个实例会与 owner 共用 `~/.config/StardewValley`。
- 契约 `StardewLaunchOptionsSchema` 只有 `port/timeoutMs/autoLoadSave/strategy`（`packages/shared-protocol/src/index.ts:885-893`），**没有隔离字段**。

## 2. 隔离方案（反编译 + 磁盘 + Steam Cloud 三方互证）

| 事实 | 证据 |
| --- | --- |
| 存档 = `SpecialFolder.ApplicationData` + `StardewValley/Saves` | `Stardew Valley.dll` 反编译 `StardewValley.Program.GetAppDataFolder()/GetSavesFolder()` |
| 设置 `startup_preferences` / `default_options` 同目录 | `StardewValley.StartupPreferences` |
| **没有「自定义存档位置」选项** | `StartupPreferences` 字段里只有 `lastEnteredIP`/`displayIndex`/`languageCode` |
| Unix 上 `ApplicationData` = `XDG_CONFIG_HOME`（**必须绝对路径**）否则 `$HOME/.config` | 本机 `System.Private.CoreLib.dll` 反编译 `Environment.GetFolderPathCoreWithoutValidation` 的 `ApplicationData` 分支与 `GetXdgConfig` |
| `LocalApplicationData` = `XDG_DATA_HOME` 或 `$HOME/.local/share`（ErrorLogs/截图） | 同上 |
| 本机实际只用 `~/.config/StardewValley` | `~/Library/Application Support/StardewValley` 不存在；`~/.config/StardewValley` 含 `Saves/`、`startup_preferences`、`default_options`、`.smapi/mod-data/` |
| Steam Cloud 认的就是这个相对路径 | `~/.config/StardewValley/Saves/steam_autocloud.vdf`；`~/Library/Application Support/Steam/userdata/395340529/413150/remotecache.vdf` 键为 `StardewValley/Saves/...` |
| `~/Applications/Stardew Valley.app` **不是独立副本** | `Contents/MacOS/run.sh` 内容只有 `open steam://run/413150` → 是 Steam 快捷方式（**修正 `P2-08` 文档原表述**） |
| 游戏运行时 | `net6.0` 自包含 `Microsoft.NETCore.App 6.0.32`；SMAPI `MinimumGameVersion = 1.6.14` |

> 传闻澄清：macOS 版存档根由 .NET 的 XDG 语义决定，**与是否 Steam 版无关**；Steam 只影响安装位置与云同步。

### 2.1 三个方案

| 方案 | 做法 | 可行性 | 风险 | 回滚 |
| --- | --- | --- | --- | --- |
| **A′（推荐）** | spawn 时注入 `XDG_CONFIG_HOME=<userData>/coop-profiles/stardew/<agentId>/xdg-config`（可加 `XDG_DATA_HOME`） | 高（运行时源码已证明路径来源） | 低：不动 HOME → 不动 Steam/许可；SMAPI `mod-data`（BWF 笔记、`active-avatar.json`）也随之隔离（正是所需）；中：隔离实例看不到 owner 存档；`strategy:'steam'` 回退无法带 env，必须走 `smapi` 直启；env 必须是绝对路径，否则静默失效 | 删 env 注入处，或删隔离目录 |
| B | 注入 `HOME=<隔离目录>` | 中 | **高**：Steam/Steamworks 可能失去登录态；macOS 部分 API 走 `NSHomeDirectory()` 行为不确定 | 同上，但需重新登录 Steam |
| C | `launchctl setenv` / `open -n` 包装 | 低 | 污染系统级环境、不可精确回滚（`open` 也没有 `--env`） | `launchctl unsetenv` + 重启进程 |

**推荐 A′**：不改 owner 任何文件、一条改动即回滚、不触碰 Steam。

## 3. farmhand 实现拆解（建议 `V2-P2-09A–F`，各 ≤8 业务文件）

| 子单 | 标题 | 主要文件 | 验收 | 前置 | 诚实口径 |
| --- | --- | --- | --- | --- | --- |
| A | 契约：联机身份与分屏隔离 | `packages/shared-protocol/src/index.ts`（`StardewLaunchOptionsSchema` 加 `profileDir`/`xdgConfigHome`；新增 `StardewScreenBindingSchema{screenId, uniqueMultiplayerID, role}`） | 类型编译 + Zod 非法值单测 | 无 | 可 `DONE` |
| B | 隔离启动：XDG 注入 | `stardew-launcher.ts`、`coop-launcher.ts`、`coop-launch-host.ts`、`packages/stardew-mods/src/paths.ts` + spec | 单测断言 spawn env 含绝对 `XDG_CONFIG_HOME`；Steam 回退显式报「不支持隔离」；真机确认 owner 存档 mtime 不变 | A | `IMPLEMENTED_UNVERIFIED` |
| C | 宿主联机身份绑定（谁控制哪个身体） | `coop-runtime.ts`、`v2-kernel-host.ts`、`preload/index.ts`、`renderer/director/bridge.ts` | 单测：host/farmhand 两租约互不抢占；Electron E2E | A | `IMPLEMENTED_UNVERIFIED` |
| D | BWF 分屏感知补丁（按 `Context.ScreenId` 路由） | `mods/bwf-patches/<date>-split-screen-routing.patch`（上游 `ModEntry.cs`/`MainThread.cs`/`McpServer.cs`/`Tools.cs`）+ `mods/bwf-patches/README.md` | `dotnet build -c Release`；`/settings` 回读 `screenId`；真机：只有目标屏角色移动 | B | `IMPLEMENTED_UNVERIFIED` 或 `BLOCKED` |
| E | 按屏「玩家一动即接管」与 `ABORTED_BY_HUMAN_TAKEOVER` 回执 | 同上补丁 + `adapter.ts` + 契约回执枚举 | 仿真：farmhand 屏输入 → 该屏 `ABORTED_BY_HUMAN_TAKEOVER`，房主屏不受影响；真机 ≤1s 中止 | D | `IMPLEMENTED_UNVERIFIED` |
| F | 分屏 farmhand 沙盒剧本与回归 | `tools/mock-harness/src/stardew-simulator.ts` + spec + E2E + 证据文档 | 剧本：AI 在 farmhand 屏种地、房主屏人类走路，两条回执互不串 | A–E | 仿真可 `DONE`，真机留 `[REAL-DEVICE]` |

落地顺序：**A → B → C →（D → E）→ F**。A/B/C 纯 TS，可自动验收；D/E 必须真机分屏迭代，owner 需先完成「单机建 cabin + 接手柄 + Start Local Co-op」。

## 4. 硬阻塞与不可核实项

**硬阻塞**

1. BWF 是进程级单例（`ModEntry.Mcp`、`MainThread` 单队列、`PlayerInControl`、`Session`、`Hud`、内置 Agent 各一份）→ 分屏两屏共享，动作会被任一屏 tick 取走。
2. 现版 BWF 零分屏感知——代码缺口。
3. 同机第二个独立客户端进程受 Steam 同账号限制（本仓 `P2-08` 已记，**本次未实测**）。
4. 官方分屏的人类前置不可绕过：单机建 cabin、接手柄、Options→Multiplayer→Start Local Co-op，键盘固定给 1P（AI 不需模拟手柄，它直接改 `Farmer`）。
5. `ButtonPressed` 每屏各触发一次 → 分屏下 F7 无法区分「人类在哪一屏按键」，要做「玩家一动即接管」必须 per-screen 事件 + 目标屏匹配。
6. 隔离与回执落库都尚未实现。

**无法核实（不要写成结论）**

1. `XDG_CONFIG_HOME` 隔离在真实启动后是否 100% 生效（路径来源已证明，但未实际启动游戏）。
2. Steam 同账号能否同机跑两个实例、第二实例能否正常作为 farmhand 加入。
3. Steam Cloud 在 XDG 重定向下的退出行为。
4. `Farmer.controller` 在分屏农场工人身上的确切赋值时机。
5. `mock-harness` 现有 `stardew-simulator` 是否足以表达「双屏」语义（需在 F 里评估）。

## 3.5 二次核实补充（官方 Wiki + 反编译交叉验证）

| 事项 | 结论 | 依据 |
| --- | --- | --- |
| 分屏第二玩家能否用键盘 | **不能**。加入分屏只检测手柄 Start 键（`GamePad.GetState(playerIndex).IsButtonDown(Buttons.Start)`，遍历 `PlayerIndex.One..Four`），非第一实例还会强制 `gamepadMode = ForceOn` | 官方 Wiki「Connect a controller … the keyboard on PC is always reserved for the first player」+ `GameRunner.cs` 反编译 |
| 分屏对 Mod 的语义 | 每个 Mod 跑在每一屏上；4 个本地玩家时 `UpdateTicked` 每 tick 触发 4 次，官方建议用 `PerScreen<T>` / `ScreenId` 区分 | 官方 Wiki「Modding:Modder Guide/APIs/Multiplayer」 |
| `Farmer.controller` 是什么 | **`PathFindController`（寻路/AI 移动控制器）**，不是手柄控制器；输入由 `Game1.instancePlayerOneIndex` 与每实例的 `Game1.input`/`Game1.options` 决定 | `Character.cs` / `Game1.cs` 反编译 |
| `Game1.player` setter | 1.6.9 起为 `internal`，官方不建议替换玩家对象；BWF 改的是 `Player.Position`/`faceDirection`/`CanMove` 等字段**不是**替换对象，因此不受影响 | 官方 Wiki「Migrate to Stardew Valley 1.6.9」 |
| 存档路径常量 | `Program.GetAppDataFolder()`（`SpecialFolder.ApplicationData` + `StardewValley`）、`GetSavesFolder()`、`StartupPreferences`、`DefaultOptions`；`Game1.savePathOverride` 只是「按完整路径读档」的内部字段，**不是用户设置** | 反编译 1.6.3 / 1.6.15 |
| 跨进程控制另一个玩家 | **没有受支持的路径**：每个客户端只处理自己 `IsLocalPlayer` 的输入；要让房主侧 AI 稳定驱动客机角色，必须在客机进程也装 Mod + `Helper.Multiplayer.SendMessage` 消息协议。**不要设计「房主越权操控客机 farmer」** | 官方 Wiki「Game Fundamentals / Multiplayer API」 |
| Steam Cloud | 同步的是 `Saves` 目录（本机 `~/.config/StardewValley/Saves/steam_autocloud.vdf` + `remotecache.vdf` 键 `StardewValley/Saves/...`）；XDG 隔离后云同步路径与实际写入路径不一致，预期不影响隔离实例（未实测） | Steamworks Auto-Cloud 文档 + 本机实测 |

结论不变：**同机分屏由「同一个模组按屏分派」驱动；独立客机进程由「客机进程内的模组 + 双端消息协议」驱动。**

## 5. 本单不改的东西

- 不改 owner 的 `~/.config/StardewValley`（含两个存档）、不改 Steam 配置、不改 OBS 配置。
- 不启动游戏、不改 BWF 上游克隆（补丁只以 patch 文件形式进本仓）。
- 不在本单宣称「farmhand 已可由 AI 控制」——现版本会控制错人。

---

## 6. 已实现部分：`V2-P2-09A` 契约 + `V2-P2-09B` 隔离启动（2026-11-26）

### 6.1 改动（5 个业务源码文件 + 3 个测试）

| 文件 | 改动 |
| --- | --- |
| `packages/shared-protocol/src/index.ts` | `StardewLaunchOptionsSchema` 增 `isolateDataDir`（**必须绝对路径**，正则同时接受 POSIX 与盘符形式）；新增 `StardewScreenBindingSchema { screenId, uniqueMultiplayerID, role }` |
| `packages/stardew-mods/src/paths.ts` | 新增纯函数 `isolateDataEnv(dir)`（返回 `XDG_CONFIG_HOME`/`XDG_DATA_HOME`，非绝对路径返回 `null`）与 `isAbsoluteDataDir()` |
| `apps/desktop-host/src/main/stardew-launcher.ts` | 参数不合法不再静默丢弃而是 `failed` 如实报错；`isolateDataDir` 相对路径 → 拒绝启动；`strategy='steam'` + 隔离 → 拒绝（Steam 无法携带 env）；隔离下 `auto` 只尝试 `smapi`；spawn 前 `mkdir` 隔离目录并注入两个 XDG 变量（**不动 `HOME`**） |
| `apps/desktop-host/src/main/coop-launcher.ts` | `spawnGameProcess` 增可选 `env` 形参（保持既有 4 参调用不变） |
| `apps/desktop-host/src/main/coop-launch-host.ts` | 星露谷队友实例默认隔离：`<profilesRoot>/<agentId>/stardew-data`，创建目录并注入 XDG，返回值带 `isolateDataDir` |

### 6.2 为什么这样改（取舍）

- **只注入 `XDG_*`、不动 `HOME`**：.NET 的 `ApplicationData` 在 Unix 上就是 `$XDG_CONFIG_HOME`（须绝对路径）否则 `$HOME/.config`；动 `HOME` 会让 Steam/Steamworks 找不到 `~/Library/Application Support/Steam`，风险远大于收益。
- **参数不合法要显式失败**：单测里真的复现了「相对路径被 Zod 拒 → 整个 options 被当成 `{}` → 用 owner 存档正常启动」的静默失效，所以把 `safeParse` 失败改成 `failed` 并报出字段名。
- **隔离下禁止 Steam 回退**：`open steam://…` 无法携带 env，回退等于共用 owner 存档。

### 6.3 验证（`[SIMULATION]`/单测，不是真机）

| 用例 | 结果 |
| --- | --- |
| 相对路径 `isolateDataDir` → `failed` 且不 spawn（消息含 `isolateDataDir`） | PASS |
| 隔离 + `strategy:'steam'` → `failed` 且不 spawn | PASS |
| `smapi` 启动注入 `XDG_CONFIG_HOME=<dir>/xdg-config`、`XDG_DATA_HOME=<dir>/xdg-data`，`HOME` 保持父进程值，目录被创建 | PASS |
| 隔离 + `auto` 且 SMAPI 失败 → 只尝试过 SMAPI，不回退 Steam | PASS |
| `spawnGameProcess` 传 env 原样交给子进程；不传时 `env` 为 `undefined` | PASS |
| `isolateDataEnv` 尾部斜杠裁剪、Windows 盘符、相对路径/`/` 返回 `null` | PASS |
| `stardew-launcher.spec.ts` 全量 | **16/16 PASS** |
| `coop-launcher.spec.ts` + `stardew-mods.spec.ts` | **58/58 PASS** |
| `pnpm typecheck` / `pnpm lint:deps` | 零错误 / 零违规 |

### 6.4 尚未验证（不得当成已完成）

1. **真机隔离生效**：未启动游戏；「隔离目录真的接住了 `Saves`/`startup_preferences`」需要跑一次并核对 owner `~/.config/StardewValley` 的 mtime 不变（`[REAL-DEVICE]`）。
2. **Steam Cloud 在隔离实例下的行为**：未实测。
3. **C/D/E/F 未开工**：宿主身份绑定、BWF 分屏路由补丁、按屏接管、沙盒剧本都还没做，farmhand 仍不能由 AI 安全控制。
