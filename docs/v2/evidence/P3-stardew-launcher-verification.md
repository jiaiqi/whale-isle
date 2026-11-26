# P3 星露谷一键启动器 — 真机验证（`[REAL-DEVICE]`）

> 验证时间：2026-11-26 11:28–11:31（本机 macOS 27.2.1 / Apple Silicon，用户已授权）
> 分支：`feat/stardew-launcher`（worktree `../ai-vtuber-workbench-launch`，基于 `feat/whale-isle-v2@05707af`）
> 结论：**两种启动方式都能真实拉起 SMAPI 并让 BWF MCP 就绪；选定 `直接 spawn SMAPI` 为主方式，`steam://rungameid/413150` 为回退。**
> 冒烟结束后已关闭游戏（本次已进入存档，但为保持环境干净仍关闭）。

## 0. 本机环境（实测）

| 项 | 实测值 |
|---|---|
| 游戏根目录 | `/Users/jiaqi/Library/Application Support/Steam/steamapps/common/Stardew Valley` |
| 可执行目录（macOS 无 `.app` 外层） | `…/Stardew Valley/Contents/MacOS` |
| SMAPI 可执行文件 | `…/Contents/MacOS/StardewModdingAPI`（SMAPI 4.5.2） |
| Mods 目录 | `…/Contents/MacOS/Mods` |
| 已装 Mod | `BlindWhaleFarmer`（BWF 1.1.27）、`WhaleIsleAvatar`（0.3.0-dev.1）、`ConsoleCommands`、`SaveBackup` |
| BWF MCP 端口 | `18088`（`BlindWhaleFarmer/config.json` 的 `McpPort`） |
| Steam 清单 | `appmanifest_413150.acf` 存在，`StateFlags=4`（已完整安装） |
| Steam 启动项 | 未设置 `LaunchOptions`；但 `Contents/MacOS/StardewValley` 已被 SMAPI 安装器替换为启动脚本（原版在 `StardewValley-original`），因此 Steam 启动也会进 SMAPI |
| 游戏版本 | Stardew Valley 1.6.15（游戏窗口标题：`running SMAPI 4.5.2 with 4 mods`） |

## 1. 实现要点

- 新文件 `apps/desktop-host/src/main/stardew-launcher.ts`：
  - `detectStardewInstall()` 复用 `@workbench/stardew-mods` 的 `guessGameRootDirs / gameExecutableDir / guessSmapiBinaries / guessModsDirs`；
  - 状态机：`not_installed / launching / waiting_mcp / ready / timeout / failed`；
  - `ready` 只由 **MCP `get_state` 真实应答** 触发；
  - 已在运行（端口 reachable 或 `pgrep StardewModdingAPI` 命中）不重复启动；
  - 子进程 `detached: true + stdio: 'ignore' + unref()`；
  - 标题画面自动调用 BWF `load_save({})`；失败则如实提示「请在标题画面手动选择存档」；
  - 端口一律 `127.0.0.1`（T-M6-74）。
- 共享修复 `game-health.ts`：BWF 在标题画面返回 `HTTP 200 + isError:false +「游戏还没有进入存档」`，原探活误判为 `online`；现按正文识别为 `reachable`。**这是本次真机冒烟抓到的真实缺陷**。

## 2. 真机冒烟记录

### 2.1 首轮（暴露 false-positive，已修复）

| 时间（UTC） | 事件 |
|---|---|
| 03:28:33 | `launch()` 直接 spawn SMAPI，pid 3128，状态 `launching` |
| 03:28:43 | 启动器误判 `ready`（9s）——随后手工 `get_state` 返回：`游戏还没有进入存档（在标题画面或正在加载）。请玩家先读取存档。` |

→ 结论：**探活把标题画面当成了 ready，属于编造就绪**。已修复 `probeStardew` 并补单测（`game-health.spec.ts`「标题画面 → reachable，不冒充 online」）。

### 2.2 主方式：直接 spawn SMAPI（修复后）

证据：`artifacts/p3-stardew-launcher/smapi-direct-autoload.log`

| 时间（UTC） | 状态 | 说明 |
|---|---|---|
| 03:29:38 | `launching` | `strategy=smapi`，pid 4784，“已通过 SMAPI 启动” |
| 03:29:42–46 | `waiting_mcp` | 端口尚未监听（真实探测） |
| 03:29:48 | `waiting_mcp` | 检测到标题画面 → 向 BWF 发 `load_save({})` |
| 03:29:50 | `waiting_mcp` | “已请求载入最近存档，等待进入游戏…” |
| 03:29:54 | **`ready`** | `BWF MCP 在线 · get_state 正常应答`（14.1s） |

进程独立性实测：

```text
PID   PPID  PGID  COMMAND
4784     1  4784  …/Contents/MacOS/StardewModdingAPI
```

PPID=1、独立进程组 → 鲸屿/终端退出不会带走游戏。

BWF `load_save` 回执（`artifacts/p3-stardew-launcher/bwf-load-save-smapi.log`）：

```text
[] [MCP] load_save({}) → 成功：正在读取存档 泡泡湾_454908853（上次游玩 11-25 18:05），要十几秒。等 15 秒后用 get_state 确认进了游戏
```

`get_state` 真实返回（节选，HTTP 200 / SSE）：

```text
【你的长期笔记】海滩农场（沙地洒水器无效，要种在土上）…
## 基本状态
时间：第1年夏17日 06:00（Wed），天气：雷雨，明天天气：晴
金钱：44047g  体力：270/270  生命：100/100  今日运气：-0.08
## 当前界面
无（可以自由行动）
## 位置
地点：FarmHouse（泡泡湾农场），室内…
```

游戏内截图：`artifacts/p3-stardew-launcher/in-game-smapi.png`
（标题栏可见 `Stardew Valley 1.6.15 - running SMAPI 4.5.2 with 4 mods`；画面为夏17日 06:00、44047g 的农舍。）

### 2.3 回退方式：`open steam://rungameid/413150`

证据：`artifacts/p3-stardew-launcher/steam-fallback.log`

| 时间（UTC） | 状态 | 说明 |
|---|---|---|
| 03:30:25 | `launching` | `strategy=steam`，“已通过 Steam 启动” |
| 03:30:29–33 | `waiting_mcp` | 端口尚未监听 |
| 03:30:35 | `waiting_mcp` | 标题画面 → `load_save` |
| 03:30:39 | **`ready`** | 14.0s，`get_state` 返回同一存档真实数据 |

进程树实测（Steam 方式）：

```text
8572 bash …/Contents/MacOS/StardewValley
8577 open -W /tmp/open-smapi-terminal.command
8591 /bin/sh /tmp/open-smapi-terminal.command
8592 bash …/Contents/MacOS/StardewValley --use-current-shell
8596 ./StardewModdingAPI   (PPID=8592)
```

→ Steam 方式会经 SMAPI 官方脚本 **打开 Terminal 窗口**，游戏挂在 Terminal 的 `open -W` 进程树下；关掉终端可能终止游戏。

## 3. 选型

| 维度 | 直接 spawn SMAPI（主） | Steam URL（回退） |
|---|---|---|
| 是否保证加载 Mod | ✅ 直接跑 SMAPI | ✅（本机 `StardewValley` 已被 SMAPI 替换） |
| 是否需要 Steam 在线 | 否 | 是（未登录/未启动时不可靠） |
| 额外窗口 | 无 | 打开 Terminal |
| 失败可观测性 | spawn `error` 事件 + PID，立即失败 | `open` 立即返回 0，只能等超时 |
| 进程独立 | PPID=1，独立进程组 | 挂在 Terminal / `open -W` 下 |
| 真机就绪耗时 | 14.1s | 14.0s |

**结论：主方式 = 直接 spawn `Contents/MacOS/StardewModdingAPI`；回退 = `open steam://rungameid/413150`。**
不采用合成键鼠去点标题画面；读档只走 BWF 的 MCP `load_save` 工具（ADR-004：本功能不产生合成输入）。

## 4. 限制与遗留

- `ready` 判定依赖 `get_state` 正文；若未来 BWF 改文案，需要同步更新 `NOT_IN_SAVE_TEXT_RE`（已有单测锁定当前真机文案）。
- Steam 回退方式在本机可用，但会打开 Terminal；若用户在 Steam 里设置了别的启动项，回退路径可能不再指向 SMAPI——启动器仍会以 MCP 是否真实就绪为准，不会假报成功。
- 本机只验证了 macOS 默认 Steam 库；Windows/Linux 路径只做了纯函数单测，未真机。
- 冒烟期间关闭了游戏；证据文件保存在 `artifacts/p3-stardew-launcher/`（`artifacts/` 按仓库约定不入库）。

## 5. 中控台 IPC 通道复测（2026-11-26，合入 V2 后）

> 目的：确认启动器合入主线后，从真实桌面端（`electron --remote-debugging-port=9333 apps/desktop-host/dist/main/index.js`）经 `window.directorBridge` 触发的路径仍然可用。

- `stardewLaunchStatus()` 初始 `state=not_installed`（尚未探测），调用 `stardewLaunch({strategy:'smapi'})` 后安装探测四项全 `true`，`gameRunning=true`，`message="已通过 SMAPI 启动（pid 71062），等待 MCP 端口 18088…"`。
- 22 秒内轮询状态：**`state=ready`**，`elapsedMs=13976`、`attempts=6`、`saveLoadRequested=true`，`message="BWF MCP 已就绪：BWF MCP 在线 · get_state 正常应答"`。
- 与第 2 节真机冒烟的 14.1s 一致，说明合流后的构建产物没有回退。

**剩余缺口**：中控台按钮的鼠标点击路径未单独录屏（本次走的是同一条 preload/IPC）；Windows / Linux 仍只有纯函数单测。

## 6. 中控台「启动」按钮真实鼠标点击验收（2026-11-26，`[REAL-DEVICE]`）

> 目的：补上第 5 节留下的缺口——**不调 IPC 直接点按钮**，用 computer use 真实 CGEvent 点击走完
> 「游戏未运行 → 点顶栏「启动」→ 弹窗确认 → 游戏拉起并自动读档 → 自动驾驶接管」全链路。

**手段**：`v2AutoLease` 申请 `ComputerUseLease` → `v2AutoExecInput` 注入真实 CGEvent 点击（`mode=live`）
→ 坐标由 CDP 实时读取按钮 `getBoundingClientRect()` 换算到屏幕坐标（不硬编码）；窗口置前用
`Page.bringToFront` + `osascript set frontmost of Electron`（**关键**：CGEvent 点击必须落在前台窗口，
否则被其他浮窗吃掉，表现为「executed 但无反应」）。

**冷启动链路实测**（游戏进程先被退出，`pgrep StardewModdingAPI` 为空）：

| 步骤 | 证据 |
| --- | --- |
| 真实点击顶栏「启动」（1496,170） | `{"ok":true,"executed":true,"mode":"live","code":"executed"}` |
| 启动弹窗出现 | CDP `waitForSelector('[data-stardew-launch-prompt]')` 命中，确认按钮文本「先启动游戏」 |
| 真实点击弹窗确认 | 第二次 `executed=true` |
| 游戏被拉起 | `screencapture -l` 截到 SMAPI 窗口（`running SMAPI 4.5.2 with 4 mods`），`P3-06-title-screen.png` |
| 自动读档 | `stardewLaunchStatus()` 回执 `saveLoadRequested=true, autoLoadSave=true, attempts=6, state=ready, message="BWF MCP 已就绪"` |
| BWF 真实应答 | `get_state` 返回第1年夏17日 06:10 / 44047g / FarmHouse(9,9) |

**接管链路实测**（游戏已就绪时直接点「启动」）：帧连拍 0.25s/帧 共 60 帧留下完整状态跃迁——

| 帧 | 画面 |
| --- | --- |
| `P3-06-before-click.png` | 顶栏「星露谷 ▾ / ▶ **启动**」，左栏「游戏共玩」无绿点 |
| `P3-06-after-click-driving.png` | 顶栏「星露谷 ▾ / ■ **停止**」，左栏「游戏共玩」绿点，右下角 toast「✓ **自动驾驶已启动：接管星露谷物语**」，顶部出现「AI 安全暂停」入口 |

`autodriveStatus()` 同步回报 `running=true`（点击后 1 秒内），BWF `get_state` 持续真实应答。

**证据文件**（`artifacts/acceptance/`，按仓库约定不入库）：
`P3-06-before-click.png`、`P3-06-after-click-driving.png`、`P3-06-title-screen.png`、
`P3-06-game-in-game.png`、`P3-06-game-under-autodrive.png`、`P3-06-director-click-recording.mov`（屏幕录屏）。

**验收结论**：**通过** —— 中控台「启动」按钮的**真实鼠标点击路径**已端到端验证，取代第 5 节的「剩余缺口」。

**本次抓到的真实缺陷（非阻塞，但需修）**：
1. **就绪竞态**：游戏刚启动、BWF MCP 尚未稳定应答时立刻调用 `autodriveStart` 会收到
   「BWF MCP 不可达」而失败（本次第 1 轮冷启动即命中；`gameHealth` 判 offline 与真实端口就绪之间存在窗口期）。
   建议：`start()` 在 `waitForStardewReady()` 返回 ready 后增加一次短重试/健康确认。
2. **CGEvent 点击依赖前台窗口**：窗口被其他应用遮挡时点击「executed」但无响应。
   建议：注入前由宿主确保目标窗口前台（或改用 AXPress 元素级动作而非坐标点击）。
3. **macOS 录屏取帧不稳**：`screencapture -V -l <窗口ID>` 会对遮挡窗口取到**陈旧缓冲**（连续 10 帧内容完全不变），
   本次改用 0.25s 间隔的 `screencapture -l` 连拍才拿到真实状态跃迁。

## 7. 缺陷①（就绪竞态）修复：`start()` 就绪重探（2026-11-26，`[SIMULATION]`）

- **根因**：`AutodriveRunner.start()` 只做一次 `adapter.ping()`，而 `gameHealth` 判 offline 与 BWF 端口真正可应答之间存在窗口期，冷启动后立刻点「启动」就命中「BWF MCP 不可达」。
- **改法**：`AutodriveOptions` 新增 `readyTimeoutMs`（默认 `0` = 保持旧行为）与 `readyPollMs`（默认 2s）。`readyTimeoutMs > 0` 时首探失败按间隔重探，每次等待发 `watchdog/heartbeat` 事件说明「游戏/Mod 尚未就绪（启动竞态）：第 N 次重探，Xs 后再试，最长等 Ys」；窗口耗尽仍抛 `adapter.unreachableMessage`，**不装成功**。
- **取消语义**：等待期间 `stop()` 置 `startAborted`，`start()` 安静返回而非误报「不可达」（否则用户点停止会看到一条假故障）。
- **宿主接线**：`apps/desktop-host/src/main/autodrive-host.ts` 的 `createRunner()` 注入 `readyTimeoutMs: 90_000, readyPollMs: 2_000`（实测就绪耗时 14s，90s 留足冷启动余量）。
- **测试**：`autodrive.spec.ts` 新增 3 例——重探后成功（`ping` 序列 false/false/true，断言 3 次 ping、2 条竞态事件、假时钟 4s）、窗口耗尽仍抛错（假时钟 6s 且 `isRunning=false`）、等待中 `stop()` 安静取消；原有「ping 失败 start 抛错」用例在默认 `readyTimeoutMs=0` 下继续通过（77/77）。
- **证据等级**：`[SIMULATION]`（假适配器 + 假时钟），**真机冷启动等待表现待复验**：游戏退出后立刻点「启动」，应能看到竞态事件且不再失败。
- **缺陷②（CGEvent 点击依赖前台）未修**，转入单桌宠链路待办，方向改为 AXPress 元素级动作。
