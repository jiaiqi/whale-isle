# P3 星露谷从 0 自动建档 / 联机房主 / 存储隔离与中文双保险 — 全链验证证据

> 工单范围：`V2-P3-07`（拆分为 `V2-P3-07A` → `(07B ∥ 07C)` → `07D` → `07E` 及 `fix(mods)` 1.6 小屋槽位修补）  
> 分支：`stardew-auto-new-save`（基于 `feat/whale-isle-v2`）  
> 结论：**契约、BWF C# 1.6 公开 API 建档/房主补丁、就绪判定硬化、默认隔离+中文双保险、 UI 状态机（10/10）以及  真机冷启动 R1–R4 与真实 Electron 中控台点击拉起 R5 全部实测通过； 全系列（–）全部达成 ，owner 常规存档  与  全程零写入、零改写。**

---

## 0. 提交与产物总览

| 子单 | 提交 SHA | 核心交付 | 诚实状态 |
| --- | --- | --- | --- |
| `V2-P3-07A` | `358f5a8` | `packages/shared-protocol/src/stardew-launch.ts`（`StardewLaunchOptions`/`LaunchStatus`/`LanHostStatus`/`LaunchPrefs`/`NewSaveConfig`、locale 映射与 cross-language 生成）+ `StardewAvatarSyncSchema.syncDisplayName` | **`DONE`** |
| `V2-P3-07B` + 1.6 修补 | `2f9d7e8` + `f8d7d2a` | 仓外 MIT BWF 第 3 份补丁 `mods/bwf-patches/2026-11-26-auto-new-save-and-lan-status.patch`（`WHALE_BWF_MCP_PORT`/`WHALE_STARDEW_LANG`、`EnsureLanguage()`、`create_new_save`、`load_save` 扩展、`GET /settings` 带 `runtime`/`lan` 与 `isUnclaimedFarmhand` 空余小屋计数）；`mods/stardew-avatar-sync/ModEntry.cs` `SyncDisplayName` 防覆写 | **`DONE`** |
| `V2-P3-07C` | `6a746bc` | `packages/game-bridge-mcp/src/mcp-client.ts`（`BwfMcpClient.ping()` 拒绝标题画面提示与 `isError=true`）+ `apps/desktop-host/src/main/game-health.ts`（`probeBwfRuntime()` 与 `requireLanHost` 门禁） | **`DONE`** |
| `V2-P3-07D` | `3ff7e8b` | `stardew-launch-prefs.ts`（默认 `isolated` 隔离目录 + `zh` 中文 XML 双保险）+ `stardew-launcher.ts`（`always_new`/`continue_or_create`/`load_only`/`manual`、重试 `LANGUAGE_LOADING`/`TITLE_NOT_READY`、快败 `BWF_PATCH_MISSING`、`coop_host` LAN 等待）+ `stardew-avatar-host.ts` + 宿主 IPC/preload/bridge | **`DONE`** |
| `V2-P3-07E` | `cceccd6` + R5 直通开关 | 中控台 `game-panel.tsx` / `App.tsx` / `views/stardew-view.tsx`（保留 `[data-stardew-launch]`，新增一键「从 0 单机开玩」「从 0 联机房主开玩」、存储模式切换与折叠表单、`⌘K` 与启动弹窗入口）、`WHALE_E2E_REAL_STARDEW_LAUNCHER=1` 真机 E2E 直通开关与 `e2e/stardew-launcher.e2e.spec.ts` | **`DONE`** |

---

## 1. `[SIMULATION]` 与门禁验证

- **全量自动化门禁（`pnpm verify:gate`）**：7/7 PASS
  - Gate 1 类型与边界：`tsc -b` 零错误 + `dependency-cruiser` 零违规 + Python `ruff` / `mypy --strict` 通过。
  - Gate 2 许可证与密钥：`license-scanner` 320 个源文件 0 违规 / 0 密钥泄漏 / 0 GPL 传染源；`pnpm audit` 0 high/critical；`luac -p` 5 Lua 通过。
  - Gate 3 确定性单测：全量 Vitest + pytest（61 passed）+ 7 个卡死回归剧本全绿；`packages/game-bridge-mcp/src/mcp-client.ts` 分支覆盖实测 **92.59%**（函数 100%，语句 95.52%）。
  - Gate 4 回环契约 E2E：通过（<2s < 15s 上限）。
- **专项单测**：
  - `packages/shared-protocol/src/stardew-launch.spec.ts`：覆盖 `mapLocaleToStardewLanguage`、`coop_host` 小屋校验、`isolateDataDir` 绝对路径校验与跨语言契约生成（`pnpm gen:contracts` & `pnpm py:check` 61 passed）。
  - `apps/desktop-host/src/main/stardew-launch-prefs.spec.ts`（4/4）：覆盖默认 `isolated`/`zh`/`skipIntro=true`、原子持久化、`ensureIsolatedStartupLanguage` 新建/替换/幂等/插入 `<languageCode>`。
  - `apps/desktop-host/src/main/stardew-launcher.spec.ts`（22/22）：覆盖 `always_new`、`continue_or_create` 无档转新建、`LANGUAGE_LOADING`/`TITLE_NOT_READY` 自动重试、`coop_host` 等 `lanListening=true`、`BWF_PATCH_MISSING` 快败、`--mods-path` 与环境变量注入。
  - `apps/desktop-host/src/main/game-health.spec.ts`：`probeBwfRuntime` 兼容旧版与 `requireLanHost` 门禁。

---

## 2. `[E2E-HOST]` Electron 45 真实宿主端到端验证

执行命令：
```sh
pnpm --filter @workbench/desktop-host build && \
PET_STAGE_E2E=1 pnpm exec vitest run --config vitest.e2e.config.mts \
  apps/desktop-host/e2e/stardew-launcher.e2e.spec.ts \
  apps/desktop-host/e2e/ui.e2e.spec.ts
```
实测结果：**2/2 文件、10/10 用例全部通过**（`ui.e2e.spec.ts` 9/9 / 33.04s，`stardew-launcher.e2e.spec.ts` 1/1 / 8.04s）：
- 原有 4 项回归全部通过（横幅 `[data-stardew-launch]` 唯一按钮、假启动器状态机推进至 `ready`、`⌘K`「启动星露谷」、顶栏「启动」弹窗与持久化选项）。
- 新增 4 项断言通过：
  1. 一键「从 0 单机开玩」推进至 `ready`，展示 `隔离 · zh` 与 `鲸屿_999000111`；
  2. 展开配置改小屋数为 `2` 并点击「从 0 联机房主开玩」推进经 `waiting_lan_server → ready`，显示 `[data-stardew-lan-status]` 含端口 `24642` 与 `2/2` 小屋；
  3. 切换存储模式（`isolated` ↔ `standard`）并 `director.reload()` 核实主进程 `userData/stardew-launch-prefs.json` 真实持久化（测试末切回 `isolated`）；
  4. `⌘K` 与顶栏启动弹窗均可见「从 0 单机」「从 0 联机房主」入口。
- E2E 截图证据：`artifacts/stardew-launcher-e2e.png`。

---

## 3. `[REAL-DEVICE]` 真机冷启动 R1–R4 全套验收（macOS Apple Silicon / Stardew Valley 1.6.15 / SMAPI 4.5.2）

### 3.1 R1：常规目录只读续玩回归 + `AutodriveRunner` 无竞态实证
- **触发配置**：主 `Mods/`（端口 `18088`）、常规存档目录（`storageMode: 'standard'`, `savePolicy: 'load_only'`，最近存档为 owner 个人存档 `泡泡湾_454908853`），并发启动 `AutodriveRunner(readyTimeoutMs=90_000)` + `StardewAdapter` 下发安全只读指令 `wait(minutes=1)`（**绝不 `sleep`、绝不存盘、绝不改写/新建存档**）。
- **实测结果（通过）**：
  - 启动器 **15.28s** 推进至 `state: 'ready', phase: 'ready', createdSaveSlot: '泡泡湾_454908853'`；
  - `AutodriveRunner` 在冷启动及标题画面等待期间完成 **6 次** `watchdog` 重探且零「BWF MCP 不可达」误报；进场后收到 `{"type":"state","clock":"第1年夏20日 06:00"}` 与回执 `{"type":"receipt","tool":"wait","status":"COMPLETED","summary":"成功：等待结束：从 06:00 等到 06:10\n⏱ 用时 10 分钟（06:00 → 06:10）"}`；
  - 截图证据：`artifacts/acceptance/P3-07-r1-standard-continue.png`（可见游戏画面右上角 `20日 星期六 06:10 46589G` 及左上角 BWF HUD `wait? 成功：等待结束`）；
  - 优雅 `SIGTERM` 退出后复核 `~/.config/StardewValley/Saves/` 与全部子项 `mtime`：`Saves=1795233013`、`qi的_451149533=1795535438`、`steam_autocloud.vdf=1795663826`、`泡泡湾_454908853=1795704766`，**100% 零改动**。

### 3.2 R2：后台遮挡 + 全新隔离目录 + 中文单机从 0 建档 + P2-06 像素形象 + 名字防覆写
- **触发配置**：独立隔离目录 `/tmp/whale-r2-isolated`（`XDG_CONFIG_HOME` / `XDG_DATA_HOME`，不动 `HOME`）、独立 `--mods-path /tmp/whale-r2-mods`（端口 `19088`，加载 2× 桌宠精灵表 `stardew-sprite-50c65bb7.png` 与 `syncDisplayName: false`），`savePolicy: 'always_new', gameMode: 'singleplayer', language: 'zh', skipIntro: true, farmerName: '小鲸零号', farmName: '鲸屿单机', favoriteThing: '白米饭'`；**全程保持后台窗口、零 CGEvent**。
- **实测结果（通过）**：
  - **27.13s**（含标题动画重探 `TITLE_NOT_READY` 自动重试 1 次后触发 `create_new_save`）到达 `state: 'ready', phase: 'ready', createdSaveSlot: '鲸屿单机_455382664'`；
  - 隔离目录 `/tmp/whale-r2-isolated/xdg-config/StardewValley/startup_preferences` 实测含 `<languageCode>zh</languageCode>`；
  - `POST /mcp get_state` 返回中文状态：`时间：第1年春1日 06:00（Mon）`、`FarmHouse（鲸屿单机农场）`、`斧头/锄头/喷壶`；
  - `GET /settings` 返回 `runtime.worldReady=true, runtime.languageCode='zh', runtime.saveFolderName='鲸屿单机_455382664'`；
  - 真实读回隔离盘 `Saves/鲸屿单机_455382664/SaveGameInfo` XML：实证 `<name>小鲸零号</name>`、`<farmName>鲸屿单机</farmName>`、`<favoriteThing>白米饭</favoriteThing>`（`WhaleIsleAvatar` 挂载 2× 精灵表且未覆盖自定义农夫名）；
  - 额外复跑了一次基于该隔离存盘的 `load_only` 冷启动 + `AutodriveRunner`，经历 9 次标题重探后 `state: 第1年春1日 06:00` 正常接管；
  - 截图证据：`artifacts/acceptance/P3-07-r2-singleplayer-new-save.png`。

### 3.3 R3：后台全新隔离目录 + 中文联机房主从 0 建档 + UDP 24642 监听
- **触发配置**：独立隔离目录 `/tmp/whale-r3-isolated`、`--mods-path /tmp/whale-r3-mods`（端口 `19088`）、`savePolicy: 'always_new', gameMode: 'coop_host', startingCabins: 2, cabinLayout: 'nearby', language: 'zh', skipIntro: true, farmerName: '鲸屿房主', farmName: '联机星露'`。
- **真机捉虫与修复（commit `f8d7d2a`）**：首次跑通 R3 创建 `联机星露` 并在 UDP 24642 监听后，发现 `availableFarmhandSlots` 为 `0` 而非 `2`。经 `ilspycmd` 反编译本机 `Stardew Valley.dll` (`StardewValley.Locations.Cabin.CreateFarmhand` / `CanAssignTo`) 实证：1.6 新建小屋时会自动预建未认领占位 Farmer（因此 `cabin.HasOwner == true` 但 `cabin.owner.isUnclaimedFarmhand == true`）。修正 BWF `ModEntry.cs` 判定为 `(!cabin.HasOwner || cabin.owner?.isUnclaimedFarmhand == true)` 并重编后重跑 R3 验证。
- **实测结果（通过）**：
  - **28.96s** 到达 `state: 'ready', phase: 'ready', createdSaveSlot: '联机星露_455382728'`；
  - `lanHost` 返回：`isHost: true, multiplayerMode: 2, serverRunning: true, lanListening: true, lanPort: 24642, acceptIpConnections: true, startingCabins: 2, availableFarmhandSlots: 2, languageCode: 'zh'`；
  - `probeGameHealth('stardew', { endpoint: 'http://127.0.0.1:19088/mcp', requireLanHost: true })` 延迟 7ms 返回 `online`；
  - 本机实测 `lsof -nP -iUDP:24642`：`StardewMo 63133 jiaqi 238u IPv4 UDP *:24642`；
  - 截图证据：`artifacts/acceptance/P3-07-r3-coop-host-new-save.png`。

### 3.4 R4：旧版未打补丁 BWF 5s 内快败 `BWF_PATCH_MISSING` + 恢复补丁版复核
- **触发配置**：备份主 `Mods/BlindWhaleFarmer/BlindWhaleFarmer.dll`（1,098,240B, sha256 `4a07f7ab856a...`），临时将未打新补丁的旧版备份 `BlindWhaleFarmer.dll.bak-1.1.27-stock`（1,082,880B）换为主 `BlindWhaleFarmer.dll`（备份保留），在隔离目录 `/tmp/whale-r4-final-isolated` 发起 `savePolicy: 'always_new'`（超时设 `60_000ms`）。
- **实测结果（通过）**：
  - BWF `/settings` 首次返回 HTTP 200 后仅 **`1812ms`（< 5000ms）**（进程冷启动起总耗时 `8182ms`），启动器立刻 fail-closed 返回：`state: 'failed', phase: 'failed', errorCode: 'BWF_PATCH_MISSING', message: '检测到旧版 BlindWhaleFarmer Mod（缺少 create_new_save 能力），无法自动从 0 建档', hint: '请编译部署 mods/bwf-patches/2026-11-26-auto-new-save-and-lan-status.patch 补丁后重试。'`；
  - 恢复补丁版 `BlindWhaleFarmer.dll` 后校验体积 `1,098,240B`、sha256 `4a07f7ab856a...` 与原件 100% 一致，`BlindWhaleFarmer.dll.bak-1.1.27-stock` 等备份完好保留；
  - 重启一次隔离 SMAPI 实测恢复后的 `GET http://127.0.0.1:18088/settings`：`runtime.capabilities = ["load_save", "host_load_save", "create_new_save", "lan_status", "language_sync"]` 全部恢复；
  - 结束时全部 `StardewModdingAPI` 测试进程已退出，`~/.config/StardewValley/Saves/` 与 `startup_preferences` 与初始基线 100% 一致。

### 3.5 R5：真实 Electron 中控台点击「从 0 单机开玩」→ 真实拉起与隔离建档端到端闭环（`[REAL-DEVICE]` + `[E2E-HOST]`）
- **触发配置**：编译后的 `apps/desktop-host/dist/main/index.js` 在 `PET_STAGE_E2E=1 WHALE_E2E_REAL_STARDEW_LAUNCHER=1` 下启动（仍使用独立 `e2e-profile` 与常驻客户端 `PID 38542` 互不碰撞，但直通生产级 `createStardewLauncher()`），在真实中控台共玩页点击 `[data-stardew-new-singleplayer]`（「从 0 单机开玩」）。
- **实测结果（通过）**：
  - 点击按钮后拉起真实 `StardewModdingAPI`（`pid 44533`，隔离目录 `.../Whale Isle/e2e-profile/stardew-isolated`，`zh`），经 `launching → waiting_bwf → waiting_title (TITLE_NOT_READY 重试) → creating_save → waiting_world → ready` 耗时 **`17.53s`**（`elapsedMs=17526`, `createdSaveSlot='鲸屿_455395474'`）；
  - 中控台横幅自动刷新翻绿为 `[data-game-conn-banner][data-game-conn="online"]`（`《星露谷物语》已连接 BWF MCP 在线 · get_state 正常应答`）；
  - 隔离目录实测写入 `<languageCode>zh</languageCode>` 与 `Saves/鲸屿_455395474/SaveGameInfo`（含 `<farmName>` 与 `<name>`）；
  - 双截图留证并经目视核验：[P3-07-07e-director-real-click.png](../../../artifacts/acceptance/P3-07-07e-director-real-click.png) 与 [P3-07-07e-stardew-real-window.png](../../../artifacts/acceptance/P3-07-07e-stardew-real-window.png)；
  - 清理退出测试游戏 `pid 44533` 与测试 Electron，删除 `e2e-profile/stardew-isolated` 与 `stardew-launch-prefs.json` 还原至点击前态；复核 `Post-cleanup Stardew PIDs: []`、`Resident Electron PID 38542 alive after: true`、`Saves/` 全目录与各子项 `mtime` 100% 零改动；同时重跑默认假启动器 E2E `stardew-launcher.e2e.spec.ts` **1/1（7.15s）** 零回归。
