# 01 · apps/desktop-host 主进程 / preload / WebUI 调查报告

- 仓库：`/Users/jiaqi/Documents/vibe/ai-vtuber-workbench`（whale-isle v0.2.0-dev.1）
- 调查日期：2026-11-24 · 只读调查（未改任何仓库文件、未 git、未 install）
- 范围：`apps/desktop-host/src/main/**`（spec 略读）、`src/preload/index.ts`、`src/webui/**`、`src/shared/brand.ts`、`package.json`、`scripts/build.mjs`；`README.md` 与 `AGENTS.md` 仅作待核对声明
- 证据等级标记：【代码】当前仓库实现 / 【文档】仓库内文档 / 【推断】本报告的判断

---

## 0. 结论摘要

1. **启动骨架**【代码，确定】：`index.ts` 在 `app.whenReady()` 里顺序装配 ~25 个 host，然后才创建窗口——先中控台（`renderer/director/index.html`），再 `await` 默认透明桌宠窗（`renderer/pet-stage/index.html`），最后托盘；托盘浮窗（`renderer/tray-popover/index.html`）懒创建。三类 BrowserWindow 共用同一份 preload。**没有 OBS 窗口**：OBS 是 WebUI 的一个 HTTP 路由 `/obs`。
2. **IPC 拓扑**【代码，确定】：主进程注册 **193 处 `ipcMain.handle`**（生产态 189 + E2E 门控 4），`ipcMain.on` 仅 1 处；preload 经 `contextBridge` 暴露 `directorBridge`（约 177 个键）与 `petStage`（约 59 个键）。`webui-server.ts` 实际是 **`node:http` + `ws` 的 HTTP/WebSocket 服务，默认 `127.0.0.1:18780`，`randomUUID` device token（`?token=` 或 `Authorization: Bearer`）鉴权，只绑回环**。
3. **AGENTS.md 的「18760 WebSocket + JSON-RPC 2.0 中心网关 / OBS 18765」不成立**【代码，确定】：`src/` 内 18760/18765 零命中；仓库文档自己也写明该设计稿已搁置（`CHANGELOG.md:198`、`docs/ARCHITECTURE.md:52`）。实际总线 = Electron IPC + 18780 HTTP/WS + 各游戏独立 HTTP（18080 MCP / 18090 / 18100）。`audio-ai-worker` 在主进程零引用。
4. **核心链路**【代码，确定】：`chat:say` → `autodrive-host.say()`（雷区反射 → 指令解析 → 记忆检索 → `model-gateway` 回话）→ 广播 `autodrive:event`（中控台 + 桌宠窗显示气泡）→ `voice-host.speak()` → `GlobalAudioLeaseManager`（单端锁、TTL 120s、P0 抢占）→ `mcode-tools` 失败回落 `say`+`ffmpeg`+`afplay` → 子进程退出即回执 → `pet:speech-result` 广播。**直播弹幕并未接入这条链**：`live-host` 只到 hub 广播 + 一句硬编码 P0 台词。
5. **依赖**【代码，确定】：主进程 import 全部 11 个 `@workbench/*` workspace 包；**没有任何外部 LLM SDK**（anthropic/openai 等），LLM 调用只经 `@workbench/model-gateway`；唯一外部运行时模块是 `ws`（`createRequire` 延迟加载）。
6. **规模**【代码，确定】：main 非 spec 57 文件 / 17,394 行；spec 45 文件 / 6,477 行；最大文件 `index.ts` 1,467 行。
7. **意外发现**【代码，高置信】：`src/webui/client.ts`（WebUIClient，392 行 + 514 行 spec）**零生产引用，是死代码**；`better-sqlite3` 在 desktop-host 是残留声明（实际 SQLite 走 `node:sqlite`）；Windows/Linux 语音未适配；`live-host.ts:84` 的 P0 回复是写死的一句台词。

---

## 1. 启动流程

### 1.1 `app.whenReady()` 之前的模块顶层动作（`src/main/index.ts`）

| 顺序 | 动作 | 位置 |
| --- | --- | --- |
| 1 | 把 `whale-pet://` 登记为特权协议（standard/secure/supportFetchAPI/stream/corsEnabled）——必须在 ready 前 | `index.ts:70` |
| 2 | 非 darwin 或打包态把 app 名改为「鲸屿」（Keychain 服务名兼容） | `index.ts:76` |
| 3 | userData 迁移：旧 `Electron` / `大肥鱼工作台` 目录「薄拷贝」到 `Whale Isle`（幂等 marker）；E2E 用 `e2e-profile` | `index.ts:97-158` |
| 4 | 单实例锁；拿不到锁直接 `app.quit()` | `index.ts:271-278` |

### 1.2 `whenReady` 内的装配顺序（`index.ts:283` 起，全部在一个 async 闭包里）

按代码出现顺序，关键节点（★ = 创建窗口/进程级资源）：

1. `setAppUserModelId` / Dock 图标 / About 面板 —— `:284-294`
2. `registerStageIpc`（穿透/屏幕/拖拽 IPC）—— `:295`
3. `protocol.handle('whale-pet://')` + `registerPetPacksIpc` —— `:299-308`
4. 供应商凭据库 IPC（safeStorage → `provider-vault.json`）、导入宿主、Mods 宿主 —— `:312-317`
5. 桌宠偏好 KV（`createPetPrefsStore`）、`switchDefaultCharacter`、角色注册表（内置 + 随包 + 自定义）—— `:319-385`
6. 峰谷换装定时器（60s）+ `pet:peak-status` IPC —— `:401-415`
7. 音色绑定 store + IPC —— `:419-425`
8. 角色包导入 / poke 台词 IPC —— `:426-451`
9. `PetWindowManager`（**此时不建窗**，只建管理器）—— `:456`
10. `petControl` 宿主 + IPC —— `:482-501`
11. 彩蛋小剧场 + IPC + 15 分钟随机彩蛋定时器 —— `:504-546`
12. 前台应用监听（macOS 3s 轮询 osascript）、自定义角色热重载 IPC、自定义角色宿主 —— `:558-596`
13. 创作中心宿主、验收台宿主 —— `:598-618`
14. `ui:open-creator` / `ui:open-bench` IPC —— `:633-634`
15. 工作跟随宿主、CLI 日志监听、Hook 安装器 + 4 个 IPC —— `:647-753`
16. 窗口管理 IPC（open/close/list/prefs/dock/undock/clear-dock/peek）—— `:755-808`
17. Alt 全局监视 + **50ms 轮询**（窥视透明度）；TEST_MODE 下 2 个测试 IPC —— `:809-821`
18. 全局快捷键 `Control+Alt+P`、macOS 全屏检测 **5s osascript 轮询** —— `:822-840`
19. ★ `voice = createVoiceHost(...)` + `registerVoiceHostIpc` —— `:844-855`
20. 记忆宿主、友谊宿主 + IPC、历史补录 IPC、`ipcMain.on('pet:sleep-state')`、久坐/喝水 **60s** 定时器 —— `:857-907`
21. 插件宿主 —— `:916`
22. ★ `autodrive = createAutodriveHost(...)`（内部注册 planner/chat/rice/pets/guides/brain/autodrive 共 14 个 IPC，并 `buildBrain()` 建 `ModelGateway`+`LlmPlanner`）—— `:927-938`
23. `coopHost = createCoopHost(...)`（复用 autodrive 的 gateway/planner）—— `:940-954`
24. 星露谷外观宿主 + 7 个 IPC —— `:956-1005`
25. 联机启动器宿主 + IPC —— `:1009-1024`
26. `live = createLiveHost(...)`；`autodrive.subscribe → plugins.emit` —— `:1026-1034`
27. 显示层级 1s 定时器 —— `:1037-1053`
28. ACP 会话缓存 + `harness = createHarnessHost(...)`（6 个 IPC）—— `:1056-1075`
29. `game:health` / `game:dst-state` IPC —— `:1076-1094`
30. ★ **WebUI（HTTP+WS）** 在 try/catch 里启动，不阻塞 —— `:1096-1140`
31. `wireTargets` 定义（把所有窗口 webContents 喂给 autodrive/harness/plugins/live）—— `:1142`
32. ★ `directorWindow = createDirectorWindow()` —— `:1156`
33. ★ `await petWindowManager.open('default', ...)` → 创建默认透明桌宠窗并加载 pet-stage —— `:1157`
34. `showDirector` / `second-instance` / `quitApp` —— `:1162-1191`
35. 杂项 IPC（`ui:open-director`、`app:quit`、`app:copy-text`、`tray:popover-hide`、`pet:windows-visible`、`pet:sleep-all/status`、`pet:dock-all`、`pet:context-menu`）—— `:1190-1243`
36. TEST_MODE：`test:tray-popover` —— `:1410-1418`
37. ★ `trayHost = await createTrayHost(...)`（Tray 图标；浮窗懒创建）—— `:1420-1437`
38. `app.on('activate')` —— `:1451`

退出：`before-quit` 置 `isQuitting`、`will-quit` 销毁托盘、`window-all-closed` 只有显式退出才 `app.quit()`（`index.ts:1460-1467`）。

### 1.3 窗口清单

| 窗口 | 创建位置 | 关键选项 | renderer 入口 | preload |
| --- | --- | --- | --- | --- |
| 透明桌宠窗（每个 agentId 一个，default 为主窗） | `index.ts:171-233` `createManagedPetWindow`（由 `PetWindowManager.open()` 调用，`pet-window-manager.ts:112`） | `frame:false, transparent:true, alwaysOnTop:true('screen-saver'), skipTaskbar, resizable:false, hasShadow:false, show:false`；`sandbox:false, contextIsolation:true` | `../renderer/pet-stage/index.html`（`loadFile` + hash） | `../preload/index.cjs` |
| 中控台 | `index.ts:237-261` `createDirectorWindow` | 1360×860（min 1120×700），`autoHideMenuBar`，`backgroundColor:'#050507'`，`show:false`；`sandbox:true, contextIsolation:true`；关闭=隐藏（`shouldHideDirectorOnClose`） | `../renderer/director/index.html` | 同上 |
| 托盘快捷浮窗（360×500） | `tray-host.ts:246-282` `createPopover`，首次 `showPopover()` 时才建（`tray-host.ts:307-311`） | `frame:false, transparent:true, movable:false, skipTaskbar, alwaysOnTop('floating')`，macOS `vibrancy:'popover'`；`sandbox:false, contextIsolation:true, backgroundThrottling:false` | `../renderer/tray-popover/index.html` | 同上（`index.ts:1426` 传入 `preloadPath`） |
| OBS 图层窗 | **不存在** | — | OBS 浏览器源 = `GET /obs`（`webui-server.ts:808`，内联透明 HTML，`data-stage-protocol="1"`） | — |

构建对应（`scripts/build.mjs`）：main → `dist/main/index.js`（ESM，external electron/better-sqlite3）；preload → `dist/preload/index.cjs`（CJS）；pet-stage / director / tray-popover 各打一个 IIFE bundle + 拷 html；`package.json` 的 `main` 指向 `dist/main/index.js`。`tsconfig.json` 的 `outDir` 是 `build/`（composite 类型检查产物），与运行用的 `dist/` 是两套目录。

### 1.4 preload（`src/preload/index.ts`，453 行）

- `contextIsolation` 开启，`ipcRenderer` 不直接暴露；只暴露两个对象：
  - **`window.directorBridge`**（`:13` 起，约 177 个键）：供应商 vault（save-key/key-mask/copy-key/check-balance/discover-models/test-chat/open-external/import-*）、autodrive（start/stop/directive/status/onAutodriveEvent）、game health、harness（ACP）、plugin、live、pets manifest/preview、pet-studio catalog、rice、peak、character list/select、coop（endpoints/start/stop/blackboard/goal/chat/huddle/launch/dst/help）、多窗口（open/close/list/prefs）、pack catalog/import、prefs、brain/planner/chat、voice（speak/backend/config/catalog/audition/bindings）、mods、memory、webuiInfo、friendship、pet summon/assemble/dismiss/egg、托盘快捷（visible/sleep/dock/openDirector/openBench/appQuit/hidePopover/copyText）、work-follow、creator/stardew-avatar/custom/acceptance 全套。
  - **`window.petStage`**（`:323` 起，约 59 个键）：穿透（set/get/force）、屏幕/鼠标/窗口拖拽、prefs、窗口 prefs、poke、dock、peek、以及大量 `on*` 监听（global-prefs/window-prefs/coop:speaker/speech-result/pet action/bubble/state/pose/egg-theater/work-cards/bench sleep/carousel/guides/say/wake/crown/character-changed/bump/preview/rice）。
  - `TEST_MODE`（`PET_STAGE_E2E=1`）额外：`directorBridge.trayPopoverTest`；`petStage.forceAlpha / testGlobalAltPeek / testFullscreenApply / onTestAlpha`（`:8, :319-321, :441-452`）。
- 注意：桌宠窗也使用 `directorBridge`（`renderer/pet-stage/main.ts:791` 用 `window.directorBridge.onAutodriveEvent` 消费自驾事件），两个对象的边界并不严格。

---

## 2. 实际的进程间通信拓扑

### 2.1 `ipcMain.handle` 统计（main 非 spec 文件）

- 静态调用点 **193** 个；其中 4 个在 `TEST_MODE` 门控内（`test:alt-peek`、`test:fullscreen-apply`、`test:tray-popover`、`test:force-alpha`），生产态 **189**。
- `ipcMain.on` 仅 1 处：`pet:sleep-state`（`index.ts:892`）。
- 按前缀分类（前缀 → 数量）：

| 前缀 | 数量 | 前缀 | 数量 | 前缀 | 数量 |
| --- | --- | --- | --- | --- | --- |
| `pet:` | 35 | `coop:` | 15 | `work-follow:` | 10（6 在 host + 4 在 index） |
| `creator:` | 16 | `providers:` | 10 | `voice:` | 8 |
| `friendship:` | 8（7 host + 1 index） | `custom:` | 8 | `acceptance:` | 8 |
| `stardew-avatar:` | 7 | `plugin:` | 7 | `mods:` | 7 |
| `memory:` | 6 | `harness:` | 6 | `autodrive:` | 6 |
| `live:` | 5 | `test:` | 4（全部门控） | `ui:` | 3 |
| `passthrough:` | 3 | `app:` | 3 | `win:` | 2 |
| `rice:` | 2 | `planner:` | 2 | `pets:` | 2 |
| `game:` | 2 | `webui:` / `tray:` / `screen:` / `guides:` / `egg:` / `cursor:` / `chat:` / `brain:` | 各 1 | | |

- 注册点分散：`index.ts` 自身 ~55 个，其余在各 host 的 `registerIpc()` / 工厂函数内（详见 §3.1 表）。

### 2.2 主进程 → 渲染层通道（`webContents.send` / `sendAgent` / `broadcast` / `sendToUiWindows`）

约 35 个：`autodrive:event`、`coop:speaker`、`coop:blackboard-update`、`coop:comms-message`、`pet:speech-result`、`live:batch`、`harness:event`、`plugin:event`、`creator:gen-progress`、`work-follow:update`、`stardew-avatar:changed`、`ui:open-creator/bench`、`pet:preview/bubble/say/pose/state/action/rice/bump/crown/work-cards/egg-theater-mode/bench-sleep/guides/carousel/pause-events/summoned/wake/character-changed/global-prefs-changed/window-prefs-changed/scale-changed/window-list-changed/characters-changed/pack-import-progress/open-notebook`、`pet-stage:test-alpha`（门控）。

### 2.3 `webui-server.ts` 实际是什么

【代码，确定】

- **协议**：`node:http` 服务器 + `ws`（`WebSocketServer({ noServer: true })`，手工 `upgrade` 握手）—— `webui-server.ts:920`、`:601`、`:933-952`。**不是 JSON-RPC**，消息形状是自定义的 `{ type: 'hello' | 'event' | 'pong', data }`（`:616-630, :954-963`）。
- **端口**：默认 **18780**（`const DEFAULT_PORT = 18_780`，`:141`），`EADDRINUSE` 自动回退随机端口（`ready` Promise 段）；`index.ts:1131` 把实际端口经 `webui:info` 回传渲染层。
- **绑定**：只允许 `127.0.0.1` / `localhost`→`127.0.0.1` / `::1`，其它直接抛错（`normalizeBindHost`，`:170-175`）。
- **鉴权**：启动生成 `randomUUID()` token（`:583`）；`authorize()`（`webui/http-utils.ts:96-109`）接受 `?token=` 查询参数或 `Authorization: Bearer <token>`，`timingSafeEqual` 比对；**所有路由含静态资源与 WS upgrade 都先过 token**（`:786`、`:941`），无 token → 401。响应头 `X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、`Cache-Control: no-store`、CSP `connect-src 'self' ws://127.0.0.1:* ws://localhost:*`。
- **路由**（`handleRequest`，`:776-916`）：
  - `GET /` → 内联 HTML 外壳（`:238-390`，轮询 `/api/state` + WS）
  - `GET /obs` → OBS 透明只读挂件（`:395-540`，订阅 `/ws`，回放最近 20 条）
  - `GET /api/state` → 运行时快照 + 最近 100 条总线事件（`:825`）
  - `POST /api/command` → `onCommand(text)` = `autodrive.say(text)`（`index.ts:1109`）
  - `POST /api/approve` → `harness.manager.resolvePermission`（`index.ts:1118-1121`）
  - `GET/POST /api/pet/:agentId/{state,say,action}` → `petControl.petControlApi`，入参过 Zod（`:867-906`）
  - `GET /renderer/*` → `dist/renderer` 静态文件（`:908`，双重防穿越）
- **ws 加载方式**：`createRequire(import.meta.url)('ws')` 延迟加载（`:56-59`），避免 esbuild 把 CJS 的 ws 打进 ESM bundle；类型靠 `src/webui/ws-shim.d.mts` 手写垫片（未装 `@types/ws`）。
- `src/webui/http-utils.ts`（185 行）是它的纯函数工具（url 解析、`authorize`、`jsonResponse`、`readJsonBody`、`escapeHtml`、`isPathSafe`）。
- `src/webui/client.ts`（392 行，`WebUIClient` 类）是**浏览器侧传输层**，但全仓库**只有 `client.spec.ts` 引用它**（见 §7）。

### 2.4 核实 AGENTS.md 的「18760 / 18765 / JSON-RPC 中心网关」

| 声明 | 代码事实 | 证据 | 判定 |
| --- | --- | --- | --- |
| 主进程运行 WebSocket + JSON-RPC 2.0 中心网关，默认端口 18760 | `src/` 内 `18760`、`jsonrpc` 零命中（仅 `game-health.ts:140` 以 **客户端**身份向 18080 MCP 发 JSON-RPC 请求）；主进程唯一的 WS 服务是 18780 WebUI，消息非 JSON-RPC | `grep -rn "18760\|jsonrpc" apps/desktop-host/src` → 仅 `game-health.ts:140` 与 spec；`webui-server.ts:141` | **不成立** |
| 统管 pet-stage / director-ui | 实际走 Electron IPC（193 个 handle + contextBridge），不经任何 WS | §2.1、§1.4 | **不成立（IPC 才是总线）** |
| obs-overlay 端口 18765 | `src/` 内 `18765` 零命中（仅 `plugins-panel.tsx:31` 一条插件描述文案提到）；OBS = 18780 `/obs` | `webui-server.ts:808`；`docs/ARCHITECTURE.md:50`（ADR-9 合并到 18780）；`CHANGELOG.md:171` | **不成立** |
| 统管 audio-ai-worker（Python uv） | 主进程 `src/main`、`src/preload`、`src/webui` **零引用**；仅渲染层 `voice-studio-panel.tsx:137` 开发态直连 `127.0.0.1:18790`（注释自述"生产经主进程代理"，但主进程没有这个代理） | `grep -rn audio-ai-worker apps/desktop-host/src` → 1 处（renderer） | **不成立** |
| 统管 stardew-mcp-mod | 以 HTTP MCP 客户端身份访问 `http://127.0.0.1:18080/mcp`，经 `@workbench/game-bridge-mcp` 的 `gameAdapters` 适配（Stardew 18080 / Terraria 18090 / DST 18100） | `index.ts:926`、`game-health.ts:36-39`、`autodrive-host.ts:189` | **不成立（是 HTTP 客户端，不是 WS 网关）** |

仓库内其它文档已承认该设计被搁置：`CHANGELOG.md:198`「**18760 中心 WS 网关设计稿正式搁置**」、`docs/ARCHITECTURE.md:52`、`packages/game-bridge-mcp/src/adapter.ts:123`。**AGENTS.md §1 第 4 条是过时声明。**

实际拓扑（文字图）：

```
renderer: director ──ipcRenderer.invoke──┐
renderer: pet-stage ─┤                    ├─► Electron ipcMain.handle ×189 ──► 各 host
renderer: tray-popover ┴─(contextBridge)──┘            │ webContents.send ×~35
                                                       ▼
浏览器 / OBS ──HTTP+WS 127.0.0.1:18780 (token)──► webui-server ──(注入回调)──► petControl / autodrive / harness

主进程 ──HTTP──► 127.0.0.1:18080/mcp (星露谷 BWF MCP, JSON-RPC 客户端)
       ──HTTP──► 127.0.0.1:18090 (泰拉瑞亚) / 127.0.0.1:18100 (DST sidecar)
主进程 ──spawn──► mcode-tools / curl / afplay / say / ffmpeg / osascript / sqlite3 / 游戏 & sidecar 进程
主进程 ──(无)──► audio-ai-worker（未接线）
```

---

## 3. 各 `*-host.ts` 职责、依赖关系与核心链路

### 3.1 职责一句话（工厂定义行号；IPC 注册行号）

| 文件 | 职责 | 工厂 / IPC |
| --- | --- | --- |
| `index.ts` | 总装配：窗口创建适配、IPC 杂项、定时器、所有 host 的依赖注入 | `whenReady :283` |
| `autodrive-host.ts` | 单机自驾「大脑」：`ModelGateway`+`LlmPlanner`+`AutodriveRunner`+饭碗计量+聊天回话+指令解析，事件单源多播到所有窗口与 WS 订阅者 | `createAutodriveHost :150`；IPC `:323-724`（14 个） |
| `coop-host.ts` | 多桌宠联机协作：每 Agent 独立 Runner/Planner/persona，TeamBlackboard 分工、群聊 @ 路由、求助接力；驱动桌宠窗 `pet:state/action/bubble` 与 `voiceHost` | `createCoopHost :160`；`:385-394`、`:526`；IPC `:725-906`（10 个） |
| `coop-launch-host.ts` / `coop-launcher.ts` | 三游戏联机启动器：探测 → 隔离 profile → 参数数组 spawn，不拼 shell | `:29`；IPC `:54-112`（5 个） |
| `voice-host.ts` | 语音宿主：`mcode-tools` 合成 → 失败回落 macOS `say`(+ffmpeg 变调)+`afplay`；`GlobalAudioLeaseManager` 单端串行；非 darwin 未适配 | `createVoiceHost :313`；`registerVoiceHostIpc :267`（6 个） |
| `voice-bindings.ts` | 每角色音色覆盖表（`voice-bindings.json`） | `:50`；IPC `:106-107` |
| `audio-lease.ts` | 主进程全局串行抢麦租约：active≤1、P0 抢占、TTL 强制释放、回执闭合才启下一条 | `GlobalAudioLeaseManager :53` |
| `live-host.ts` | 直播最小链路：`LiveEventHub`（Zod→护栏→注意力）→ `live:batch` 广播 + 插件总线 + 一句固定 P0 台词；**真实弹幕/点歌/常客账本/OBS 渲染未接线** | `createLiveHost :54`；IPC `:88-99`（5 个） |
| `memory-host.ts` | 记忆图谱：回执入图谱、换日日记、混合检索给 LLM 注入上下文（JSONL） | `:30`；IPC `:51-100`（6 个） |
| `friendship-host.ts` | 友谊值/小本子/互聊/久坐喝水提醒（`node:sqlite` friendship.sqlite） | `:80`；`registerFriendshipIpc :211`（7 个 + index 1 个） |
| `pet-control-host.ts` | 多宠召唤/集合/解散/彩蛋 + 对外 `petControlApi(state/say/action)` | `:49`；IPC `:177-194`（6 个） |
| `pet-window-manager.ts` | 多窗口几何/贴边/锁定/层级/Alt 窥视/碰撞检测的唯一收口 | `PetWindowManager :92`；`open :112` |
| `egg-theater.ts` | 双宠彩蛋小剧场状态机（pop→pretend→caught/escape→bye） | `createEggTheater :108`；IPC 在 `index.ts:543-544` |
| `work-follow-host.ts` | 跨 AI CLI 工作跟随：只读事件 → 召唤/换装/姿态/任务卡/皇冠 | `:94`；IPC `:418-423`（6 个 + index 4 个 cli-*） |
| `work-follow-installer.ts` / `cli-log-watcher.ts` / `cli-history-backfill.ts` / `acp-session-cache.ts` | Hook 安装、Claude/Codex JSONL 只读监听、历史补录、ACP 会话 id 归并 | `:221` / `:166` / `:180` / `:14` |
| `agent-host.ts` | ACP Harness 宿主：启动/提示/审批/停止各 CLI agent，事件多播 | `createHarnessHost :13`；IPC `:25-40`（6 个） |
| `plugin-host.ts` | 外部插件装载（`userData/plugins/<id>/index.mjs` 动态 import）、工具注册、审批、崩溃隔离 | `:72`；IPC `:203-248`（7 个） |
| `creator-host.ts` | 创作中心：选图/拖入 → 零命令行后处理 → 写自定义角色；生图走 `image-gen-client`/`codex-image-backend` | `:100`；IPC `:489-712`（16 个） |
| `custom-character-host.ts` / `custom-character.ts` | 自定义角色 CRUD/克隆/热重载与匹配逻辑 | `:154`；IPC `:161-249`（8 个） |
| `acceptance-host.ts` / `acceptance-bench.ts` | 验收台：12 场景驱动真实桌宠窗 + 脱敏报告 | `:20`；IPC `:104-167`（8 个） |
| `stardew-avatar-host.ts` | 星露谷像素外观 Mod 安装/升级 + 原子写 `active-avatar.json` | `:115`；IPC 在 `index.ts:974-1005`（7 个） |
| `mods-host.ts` | 星露谷 Mods 目录扫描/启停/安装（委托 `@workbench/stardew-mods`） | `:63`；IPC `:75-152`（7 个） |
| `provider-vault.ts` / `provider-import-host.ts` / `provider-importer.ts` | safeStorage 凭据库；Magpie/CC Switch/文件只读导入（系统 `sqlite3 -readonly`） | `:324`（7 个 IPC）/ `:70`（3 个）/ `:887-1115` |
| `tray-host.ts` | 托盘图标 + 360×500 快捷浮窗（懒创建，几何为纯函数） | `createTrayHost :209`；`createPopover :246` |
| `webui-server.ts` | HTTP+WS 本机 WebUI / OBS 源 / 远程审批 / 本机驱动口 | `:580` |
| `passthrough.ts` | 穿透状态/屏幕 bounds/鼠标点/窗口拖拽/`app:meta` IPC | `registerStageIpc :63`（8 个） |
| `pet-packs.ts` | `whale-pet://` 协议、随包角色/彩蛋/姿势读取 | `:88`；IPC `:659-665`（4 个） |
| `character-registry.ts` / `character-persona.ts` / `pet-prefs.ts` | 角色注册表 + `pet:character-*` IPC；persona 口吻/雷区钩子（桥接 persona-brain）；桌面偏好 KV | `:38`/`:60`/`:17` |
| 纯逻辑辅助 | `chat-directive`、`prompt-compiler`、`pose-resolver`、`peak-schedule`、`greeting-schedule`、`break-reminders`、`front-app-watcher`、`fullscreen-detector`、`global-alt-peek`、`display-region`、`pet-context-menu`、`token-meter`、`bwf-settings`、`game-health`、`image-gen-client/drafts`、`codex-image-backend`、`image-pipeline`、`pixel-sprite-pipeline` | — |

### 3.2 实例化 / 依赖关系（谁 new 谁、谁调用谁；均在 `index.ts` whenReady 内）

```
prefs(createPetPrefsStore) ──► characters(createCharacterRegistry) ──► switchDefaultCharacter
        ▲                                   ▲
voiceBindings(createVoiceBindingStore) ────┤（defaultVoiceOf）
        │                                   │
        ▼                                   ▼
PetWindowManager ──createWindow──► createManagedPetWindow(BrowserWindow)   [index.ts:171/456]
   ▲  ▲  ▲  ▲  ▲
   │  │  │  │  └── tray(onTogglePets) / stardewAvatar.onChange 广播
   │  │  │  └───── coopHost(petWindows.sendAgent)             [coop-host.ts:385-394, :496]
   │  │  └──────── acceptanceHost(manager)                    [index.ts:610]
   │  └─────────── workFollow(summon/switch/pose)             [index.ts:647-720]
   └────────────── petControl(manager) ◄── plugins/webui(petControlApi) / eggTheater(openEgg/sayHost)
                        ▲
                        └── voice: () => voice ──► createVoiceHost ◄── voiceBindings.resolve
                                 ▲   ▲   ▲   ▲   ▲
   friendship.speak ─────────────┘   │   │   │   └── live(voiceHost) [live-host.ts:56]
   index 久坐提醒 ───────────────────┘   │   │   └── coopHost(voiceHost) [coop-host.ts:526]
                                      autodrive(voiceHost) [autodrive-host.ts:927]
                                             ▲
memory(createMemoryHost) ◄── autodrive(memoryHost.onReceipt/contextFor) ; friendship.remember → memory
                                             ▲
ModelGateway + LlmPlanner ◄── autodrive.buildBrain() ◄── readVaultKey(provider-vault) ; brain:apply-config(渲染层)
       │
       └── coopHost(brain: autodrive) → autodrive.createPlanner / completeForCoop [coop-host.ts:559/580/660]
                 creatorHost.chat → autodrive.completeForCoop('STARDEW_GAME_PLANNER') [index.ts:603]

autodrive.subscribe ──► plugins.emit('autodrive:event') [index.ts:1034]
                   ──► webui.getBusEventSources → WS publish [index.ts:1121-1123]
                   ──► applyWindowLayerNow(receipt 15s 活跃窗) [index.ts:1040-1041]
harness.onEvent ──► workFollow.ingest(ACP 事件) [index.ts:1061-1073]
webui.onApprove ──► harness.manager.resolvePermission [index.ts:1118-1121]
coopLaunch ◄── coopHost.list() / stardewAvatar / characters [index.ts:1009-1024]
wireTargets() ──► autodrive/harness/plugins/live.setTargets(所有窗口 webContents) [index.ts:1142-1154]
```

### 3.3 核心链路（聊天/事件 → persona/model-gateway → TTS → 桌宠窗 → 回执/语音锁）

入口：中控台 `directorBridge.chatSay` / 托盘浮窗 / WebUI `POST /api/command`（`index.ts:1109` → `autodrive.say`）→ `ipcMain.handle('chat:say')`（`autodrive-host.ts:485`）→ `say(text)`（`autodrive-host.ts:347`）。

```
① 雷区反射  currentPersonaReflex(text)  [autodrive-host.ts:349 → character-persona.ts:116 → @workbench/persona-brain]
     ├─ broadcastCurrent(receipt reflex_*)  → 'autodrive:event'  → 桌宠窗 directorBridge.onAutodriveEvent (pet-stage/main.ts:791) → 气泡
     └─ speak({scene:'p0'}) → P0_INTERRUPT 抢占
② 指令解析  resolveKeywordDirective 或 gateway.chat(PLANNER_SLOTS[gameId])  [autodrive-host.ts:375-404 → chat-directive.ts]
     （先 runner.client.callTool('get_state') 取游戏状态；离线则如实标记 gameOffline）
③ 记忆检索  memoryHost.contextFor(text)  [autodrive-host.ts:416 → memory-host.ts]
④ 主脑回话  gateway.chat('MAIN_PERSONA_BRAIN', [system = personaSystemPrompt()+记忆+ackHint, user=text], {maxTokens:260})
     [autodrive-host.ts:428-432；gateway = new ModelGateway(...) :≈296；personaSystemPrompt :337 ← character-persona.ts]
     ├─ replyVisible = stripThink(content).visible  (@workbench/persona-brain)
     ├─ broadcastCurrent({type:'receipt', tool:'chat_reply', summary: replyVisible})
     │     ├─ for wc of windows: wc.send('autodrive:event')  → 中控台事件流 + 桌宠窗 showBubble/showDialog (pet-stage/main.ts:834-840)
     │     └─ busListeners → WebUI WS publish → 浏览器/OBS `/obs`
     └─ speak({text: replyVisible, scene:'normal'})  [autodrive-host.ts:433]
⑤ 语音      voiceHost.speak()  [voice-host.ts:337]
     ├─ 8s 同文本节流（按 agent+音色+场景）
     ├─ leases.acquire({priority: P1_CADENCE|P2_IDLE|P0_INTERRUPT, ttlMs:120_000, start, abort})  [voice-host.ts:371-379 → audio-lease.ts:74]
     │     ├─ onActiveChange → 'coop:speaker' 广播  [index.ts:846-849 → petWindowManager.broadcast + directorWindow.send] → 桌宠 speaking 态 (pet-stage/main.ts:857)
     │     └─ start(): playVoice  [voice-host.ts:235]
     │           ├─ speakViaMcode: mcode-tools connector call → get_asset_url → curl 下载 → afplay  [:142-175]
     │           └─ 失败 → playViaSay: say -v … → (pitchMul>1) ffmpeg asetrate/atempo → afplay  [:200-230]
     └─ 播放子进程 exit → lease.finishActive → onReceipt  [audio-lease.ts:139] → onSpeechResult → 'pet:speech-result' 广播  [index.ts:851-854] → 气泡静音角标 (pet-stage/main.ts:881)
⑥ 接单执行  order≠null → runner.submitDirective / submitObjective  [autodrive-host.ts:445-470]
     → AutodriveRunner → GameAdapter → HTTP 127.0.0.1:18080/mcp → 回执事件 → makeRunnerEventHandler
       [autodrive-host.ts:≈598-640] → 短评 speak / memoryHost.onReceipt / recentReceipts 回灌 planner / broadcast
⑦ 饭碗      gateway.onUsage → meter.recordUsage (JSONL 流水, 日预算 500_000) → broadcastRice → 'pet:rice'  [autodrive-host.ts:297-310, :538-546]
```

**直播弹幕支线（未接入 ①-④）**：`ipcMain.handle('live:ingest')` / `live:replay`（`live-host.ts:88-96`）→ `LiveEventHub`（Zod 校验 → 护栏 → 注意力分档）→ `hub.subscribe` → `live:batch` 广播到所有窗口 + `plugins.emit('live:batch')` + 若有 P0 则 `voiceHost.speak({ text: '才不是大肥鱼！哼——', scene: 'p0' })`（`live-host.ts:84`，硬编码，不经 persona/LLM）。`live-host.ts:8` 自述「真实 dyhub/抖音弹幕流、SQLite 常客账本落盘、点歌执行链、OBS 图层渲染」均未接线。

### 3.4 核心链路模块 vs 外围功能模块

- **核心链路（去掉则聊天→动作→语音闭环断）**：`index.ts`（装配）、`autodrive-host.ts`、`chat-directive.ts`、`character-persona.ts`、`memory-host.ts`、`provider-vault.ts`（key）、`token-meter.ts`（饭碗）、`voice-host.ts`、`voice-bindings.ts`、`audio-lease.ts`、`pet-control-host.ts`、`pet-window-manager.ts`、`passthrough.ts`、`webui-server.ts`（含 OBS）、`game-health.ts`（探活）、`character-registry.ts`、`pet-prefs.ts`、`pet-packs.ts`（素材）。
- **外围 / 独立功能**：`live-host.ts`（半核心：只到广播）、`coop-host.ts` + `coop-launch-host.ts` + `coop-launcher.ts`、`agent-host.ts` + `acp-session-cache.ts`、`work-follow-host.ts` + `work-follow-installer.ts` + `cli-log-watcher.ts` + `cli-history-backfill.ts`、`friendship-host.ts`、`egg-theater.ts`、`acceptance-host.ts` + `acceptance-bench.ts`、`creator-host.ts` + `custom-character(-host).ts` + `prompt-compiler.ts` + `image-gen-*` + `codex-image-backend.ts` + `image-pipeline.ts` + `pixel-sprite-pipeline.ts`、`stardew-avatar-host.ts`、`mods-host.ts`、`bwf-settings.ts`、`plugin-host.ts`、`provider-importer.ts` + `provider-import-host.ts`、`tray-host.ts`、`pet-context-menu.ts`、`peak-schedule.ts`、`greeting-schedule.ts`、`break-reminders.ts`、`front-app-watcher.ts`、`fullscreen-detector.ts`、`global-alt-peek.ts`、`display-region.ts`、`pose-resolver.ts`。

---

## 4. 主进程依赖

### 4.1 workspace 包（`package.json` 声明 11 个，**全部被 main 实际 import**）

| 包 | 声明 | main 中的引用文件 |
| --- | --- | --- |
| `@workbench/shared-protocol` | ✓ | 22 个文件（Zod Schema / 类型） |
| `@workbench/game-bridge-mcp` | ✓ | `autodrive-host`、`coop-host`、`chat-directive`、`game-health`、`index`（`AutodriveRunner`/`gameAdapters`/`RulePlanner`/`LlmPlanner`） |
| `@workbench/model-gateway` | ✓ | `autodrive-host.ts:19`（`ModelGateway`）—— **唯一的 LLM 入口** |
| `@workbench/persona-brain` | ✓ | `autodrive-host.ts:27`（`stripThink`）、`character-persona.ts:11` |
| `@workbench/stardew-mods` | ✓ | `mods-host`、`coop-launcher`、`coop-launch-host`、`stardew-avatar-host` |
| `@workbench/live-stream-hub` | ✓ | `live-host.ts:13`（`LiveEventHub`） |
| `@workbench/local-store/friendship` | ✓ | `friendship-host.ts:13`（内部用 `node:sqlite`，见 §7-S4） |
| `@workbench/memory-graph` | ✓ | `memory-host.ts:10` |
| `@workbench/agent-harness` | ✓ | `agent-host.ts:6` |
| `@workbench/plugin-kit` | ✓ | `plugin-host.ts:24-25` |
| `@workbench/pet-renderer/aboutme-pets`、`/festivals` | ✓ | `index.ts:42`、`pet-packs.ts:29`、`greeting-schedule.ts:14` |

### 4.2 外部依赖

- **没有** `anthropic` / `openai` / `@google/generative-ai` / `@ai-sdk` / `@modelcontextprotocol/*` 等 SDK import（`grep` 覆盖 main/preload/webui，零命中）。所有 LLM 流量经 `ModelGateway`，key 由 `provider-vault.ts` safeStorage 解密（`autodrive-host.ts:262-268`）。
- 唯一第三方运行时模块：`ws`（`webui-server.ts:23` 仅 `import type`，运行时 `createRequire` 加载 `:56-59`）。
- `zod` 在 `package.json` 声明但 main/preload/webui **未直接 import**（经 shared-protocol 间接使用）。
- 子进程/CLI 依赖（无 npm 包）：`mcode-tools`、`curl`、`afplay`、`say`、`ffmpeg`（`voice-host.ts:142-230`）；`osascript`（`index.ts:826-838`、`global-alt-peek.ts:23`）；`sqlite3 -readonly`（`provider-importer.ts:742`）；codex CLI（`codex-image-backend.ts`）；游戏/sidecar 进程（`coop-launcher.ts:124-345`）。

---

## 5. 规模统计（`wc -l`，2026-11-24）

| 范围 | 非 spec 文件 | 行数 | spec 文件 | 行数 |
| --- | --- | --- | --- | --- |
| `src/main` | 57 | **17,394** | 45 | **6,477** |
| `src/preload` | 1 | 453 | 0 | 0 |
| `src/webui` | 3（client 392 / http-utils 185 / ws-shim.d.mts 55） | 632 | 3（client.spec 514 / http-utils.spec 300 / webui-server.spec 555） | 1,369 |
| `src/shared/brand.ts` | 1 | 38 | 0 | 0 |
| 整个 `src`（含 renderer，TS/TSX） | — | 45,391（含 spec） | — | — |

最大 5 个非 spec 文件：`index.ts` 1,467 · `provider-importer.ts` 1,127 · `webui-server.ts` 1,046 · `coop-host.ts` 971 · `autodrive-host.ts` 809。
最大 5 个 spec：`provider-importer.spec.ts` 877 · `pet-window-manager.spec.ts` 377 · `coop-host.spec.ts` 292 · `pixel-sprite-pipeline.spec.ts` 271 · `pet-packs.spec.ts` 252。
另有 `apps/desktop-host/e2e/` 7 个 Playwright 套件（desktop / gate4-loopback / iteration / pet-evolution / studio / tray-popover / ui），未计入上表。

---

## 6. 文档 vs 代码不一致清单

### 6.1 `AGENTS.md`（根目录宪章）

| # | 声明（原文要点） | 代码事实 | 证据 | 判定 |
| --- | --- | --- | --- | --- |
| A1 | §1.4「Electron 主进程运行 WebSocket + JSON-RPC 2.0 中心网关（默认端口 18760）」 | 不存在；主进程唯一 WS 是 18780 WebUI 且非 JSON-RPC | §2.4；`webui-server.ts:141`；`CHANGELOG.md:198` | **不符** |
| A2 | §1.4「统管 pet-stage、director-ui、obs-overlay、audio-ai-worker、stardew-mcp-mod」 | pet-stage/director 走 Electron IPC；OBS = 18780 `/obs`；audio-ai-worker 主进程零引用；星露谷经 HTTP MCP 18080 | §2.4 表 | **不符** |
| A3 | §1.4「obs-overlay（OBS 透明图层源，端口 18765）」 | `src/` 内 18765 零命中；ADR-9 已合并到 18780 | `webui-server.ts:808`；`docs/ARCHITECTURE.md:50` | **不符** |
| A4 | §1.3「跨进程共享…统一使用主进程 SQLite (`better-sqlite3`)」 | desktop-host 任何 src 文件都不 import `better-sqlite3`；友谊账本用 `node:sqlite`；饭碗/记忆是 JSONL；直播常客账本未接线 | `packages/local-store/src/friendship.ts:8`；`token-meter.ts:4`；`live-host.ts:8` | **不符（实现换成了 node:sqlite + JSONL）** |
| A5 | §1.1「透明桌宠窗…VP9-Alpha .webm 双 `<video>` 交叉淡入」 | 成立：pet-stage 注入 `videoFactory`（`pet-stage/main.ts:187-220`），`WebmVideoRenderer` 头注释即「双 `<video>` 交叉淡入」 | `packages/pet-renderer/src/webm-renderer.ts:4` | **一致**（高置信，未逐行核对两元素切换） |
| A6 | §1.1「预留 `Live2DRenderer` 扩展接口」 | 仅接口注释预留，无实现 | `packages/pet-renderer/src/types.ts:50` | **一致（仅预留）** |
| A7 | §1.1「Electron + React 19 + TS；macOS Apple Silicon 与 Windows x64」 | `electron ^45.4.1`、`react ^19.2.0`；打包 mac arm64 dmg + win nsis x64 | `package.json` devDependencies / build.mac / build.win | **一致** |
| A8 | §1.3「前端中控台配置…Dexie.js (IndexedDB)」 | 成立（renderer） | `renderer/director/main.tsx:3` | **一致** |
| A9 | §1.5「拖拽…统一使用 `@dnd-kit` 或原生 Pointer Events」 | 无 `@dnd-kit` import；桌宠拖拽用原生 mouse/pointer 事件 | `pet-stage/main.ts:1302-1384` | **一致（走"或"分支）** |

### 6.2 `apps/desktop-host/README.md`

| # | 声明 | 代码事实 | 证据 | 判定 |
| --- | --- | --- | --- | --- |
| R1 | 「状态：**未开工**（T-M1-02、T-M1-05、T-M2-01 宿主侧、T-M4-03）」 | main 17k 行、7 个 e2e 套件、大量 DONE 工单 | §5；`apps/desktop-host/e2e/`；`CHANGELOG.md` | **严重过时** |
| R2 | 「src/main/ … SQLite（better-sqlite3）服务、WebSocket + JSON-RPC 2.0 中心网关（端口 18760）、Python Sidecar 守护」 | 三项均不存在于 main | A1/A4；`grep -rn "sidecar\|18760\|better-sqlite3" src/main` 仅注释命中 | **不符** |
| R3 | 「src/renderer/obs-layer/ OBS 专用透明浏览器源（端口 18765）」 | 目录不存在（`src/renderer/` 只有 director / pet-stage / tray-popover）；OBS = `/obs` 路由 | `ls src/renderer`；`webui-server.ts:808` | **不符** |
| R4 | 「跨进程通信统一走 JSON-RPC 2.0（18760）」 | Electron IPC + 18780 HTTP/WS + 各游戏 HTTP | §2 | **不符** |
| R5 | 「单端语音播放锁：带 TTL 的 `AudioLease`，以 **WebAudio `onended`** 真实回执」 | 锁已上移到主进程 `GlobalAudioLeaseManager`，回执来自**播放子进程退出**，不是 WebAudio | `audio-lease.ts:1-8, 53`；`voice-host.ts:142-230` | **部分过时**（渲染层仍有 `pet-stage/audio-lease.spec.ts`，但主进程才是唯一音频输出方） |
| R6 | 「像素级鼠标穿透：pet-stage 每 50ms 离屏 1x1 Canvas 读 Alpha」 | 成立（renderer alpha-probe）；main 侧 `passthrough:*` IPC + 50ms Alt 窥视轮询是配套 | `pet-stage/main.ts:912-1028`；`passthrough.ts:63-131`；`index.ts:817` | **一致** |
| R7 | 「渲染进程严禁直接调 LLM API / SQLite；一律经主进程网关」 | 主进程侧成立；但 renderer `voice-studio-panel.tsx:137` 开发态直连 audio-ai-worker `:18790`（非 LLM/SQLite，但属直连外部服务） | 见 §7-S6 | **待核对** |

### 6.3 仓库其它文档（对照用）

- `docs/ARCHITECTURE.md:50-52`（ADR-9）与 `CHANGELOG.md:171/198` 已如实记录「18765 合并到 18780 `/obs`」「18760 设计稿搁置」—— **与代码一致**；AGENTS.md 与 desktop-host README 是落后的一方。
- `docs/SPEC.md:10/12`、`docs/PRODUCT-DESIGN.md:42/57`、`docs/VERIFY.md:27`、`docs/ROADMAP.md:50/66` 仍写 18760/18765（属其它调查区域，仅记一笔）。

---

## 7. 意外发现

| # | 发现 | 证据 | 等级 |
| --- | --- | --- | --- |
| S1 | **死代码**：`src/webui/client.ts` 的 `WebUIClient`（392 行 + 514 行 spec，重连退避/HTTP API 都写好了）全仓库**零生产引用**，只有 `client.spec.ts` 用它；WebUI 实际外壳是 `webui-server.ts:238-390` 内联的 HTML 字符串 | `grep -rn "webui/client\|WebUIClient" apps packages` → 仅自身与 spec | 代码·确定 |
| S2 | 实现与测试分家：`webui-server.ts` 在 `src/main/`，其 spec 在 `src/webui/webui-server.spec.ts`；任务简报假设的 `src/webui/webui-server.ts` **不存在** | `ls src/webui` | 代码·确定 |
| S3 | 直播链路是「最小闭环」而非真实链路：`live:ingest` 只由中控台回放喂入（`[SIMULATION]`），P0 回复是硬编码台词 `'才不是大肥鱼！哼——'`，弹幕**不进** persona/model-gateway | `live-host.ts:8, 84`；`replaySamples :37-52` | 代码·确定 |
| S4 | `better-sqlite3` 是残留声明：`build.mjs:23` 把它 external、`packages/local-store/package.json:27` 声明依赖，但 `local-store/src/sqlite.ts`（唯一使用者）**只被自己的 spec 引用**；真正的 SQLite 走 `node:sqlite`（Node 24+） | `packages/local-store/src/friendship.ts:8, 81`；`dist/main/index.js:31558` 实际打进去的是 `node:sqlite` | 代码·确定 |
| S5 | 语音只在 darwin 可用：非 darwin 且无测试注入时直接返回「平台语音引擎待适配」；且依赖外部 CLI `mcode-tools`/`curl`/`afplay`/`say`/`ffmpeg`，任一缺失即降级或失败 | `voice-host.ts:113, 361-364, 142-230` | 代码·确定 |
| S6 | 渲染层开发态直连外部服务：`voice-studio-panel.tsx:137` 直接 fetch `127.0.0.1:18790`（audio-ai-worker），注释称"生产经主进程代理"，但主进程无此代理 | 同左 | 代码·确定（影响面待核） |
| S7 | `index.ts` 是 1,467 行的装配「上帝文件」：`whenReady` 闭包约 1,180 行、串 25+ 个 host；靠模块级 `let`（`coopHost`、`petWindowManager`、`trayHost`、`webuiRef`）与闭包晚绑定（`workFollowRef`、`applyWindowLayerNow`、`showDirectorImpl`）绕开 TDZ | `index.ts:158-170, 556, 635, 1043, 1163` | 代码·高置信（可维护性判断） |
| S8 | 定时器密集且多为 `unref()`：50ms Alt 窥视、1s 层级、3s 前台应用、5s 全屏 osascript、60s 峰谷/提醒、15min 彩蛋 | `index.ts:403, 545, 817, 838, 897, 1047`；`front-app-watcher.ts` | 代码·确定 |
| S9 | IPC 面很大且扁平：189 个生产通道，`pet:` 前缀 35 个；preload 暴露 177+59 个键；桌宠窗同时拿到 `directorBridge`（含供应商/创作中心等与桌宠无关的方法） | §2.1、§1.4；`pet-stage/main.ts:791` | 代码·确定（安全面判断：`sandbox:false` 的桌宠窗拿到全部 bridge） |
| S10 | 运行期动态 import 用户目录代码：`plugin-host.ts:164` `await import(moduleUrl)` 加载 `userData/plugins/<id>/index.mjs`；头注释自述安全边界（manifest Zod、权限硬拒 vault://*/shell://*、崩溃隔离） | `plugin-host.ts:1-30, 146, 164` | 代码·确定（与 AGENTS §3.5「运行时安全锁」的关系需产品判断） |
| S11 | 硬编码兜底：`autodrive-host.ts` `FALLBACK_PROFILE` 8 个槽位全部 `deepseek-official/deepseek-flash`（`:≈198-210`）；`coop-host.ts:≈205-215` 角色缺失时兜底字面量 `'blue-whale-maid'` + 人设 `'你是傲娇干饭蓝鲸女仆小鲸。'`；`shortReplyPool`（`autodrive-host.ts:162-176`）按角色 id 写死台词 | 同左 | 代码·确定 |
| S12 | TODO/FIXME 密度低：`TODO|FIXME|HACK|待接线|未接线|占位|placeholder|stub` 在 17k 行里 14 处，且多为 501 分支的错误文案（`webui-server.ts:732/766/876`）与 `live-host.ts:8` 的诚实声明 | §7 检索 | 代码·确定 |
| S13 | `void modsHost;`、`void characters;`、`void dayKeyOf;`、`void initialBrain;` 等「用了但故意不接返回值」的 lint 安抚写法 | `index.ts:317, 385, 858`；`autodrive-host.ts:≈549` | 代码·确定（无害） |
| S14 | 品牌更名迁移逻辑硬编码旧目录名 `['Electron', '大肥鱼工作台']` 并按文件名嗅探「像我们的数据」才迁移 | `index.ts:82-140`；`brand.ts:12-13` | 代码·确定 |

---

## 8. 待证项（未定位到一手证据，不进结论）

1. `providers:test-chat` / `providers:check-balance`（`provider-vault.ts:370-410`）是否用 Electron `net.fetch` 直连供应商 baseUrl——未读实现；与「渲染层不直连 LLM」的边界相关。
2. `voice-studio-panel.tsx:137` 的 18790 直连是否只在开发态生效（renderer，超出本区范围）。
3. `WebmVideoRenderer` 双 `<video>` 交叉淡入的具体切换时序（`packages/pet-renderer/src/webm-renderer.ts`）——只核到头注释与注入点。
4. README 的「50ms 1×1 Canvas alpha 探针」节拍在 `pet-stage/alpha-probe.ts`（未读）。
5. 7 个 e2e 套件与 45 个 main spec 是否实际全绿（只读调查，未运行）。

## 9. 建议的下一步

1. **文档纠偏（优先）**：AGENTS.md §1.3/§1.4 与 `apps/desktop-host/README.md` 的 18760/18765/JSON-RPC/better-sqlite3/「未开工」表述应改为代码事实（Electron IPC + 18780 HTTP/WS + 18080/18090/18100 HTTP + node:sqlite/JSONL）。这属于治理文件，按规则只提建议、由用户决定。
2. 若继续深挖主进程：读 `packages/model-gateway`（供应商协议、脱敏、计量回调）与 `renderer/director/bridge.ts`（IPC 封装层），补齐「渲染层 → IPC → host」的另一端。
3. 决策项：`src/webui/client.ts` 是删除还是接入 director 的浏览器形态；`better-sqlite3` 残留声明是否清理。

---

## 附：检索记录

| 轮次 | 关键词 / 范围 | 命中 |
| --- | --- | --- |
| 1 | `find apps/desktop-host -type f`（排除 node_modules/dist/build） | 文件清单；`build/` 为 tsc 产物、`dist/` 为 esbuild 产物 |
| 2 | `wc -l src/**/*.{ts,tsx}` | 规模统计（§5） |
| 3 | 通读 `index.ts`（1,467 行）、`preload/index.ts`、`webui-server.ts`、`package.json`、`build.mjs`、`brand.ts`、`README.md` | §1、§2.3 |
| 4 | `grep 18760\|18765\|jsonrpc` 于 `apps/desktop-host/src` 与全仓（排除 node_modules/dist/build） | src 内仅 `game-health.ts:140`（客户端）与 `plugins-panel.tsx:31`（文案）；全仓命中集中在 docs/ 与 CHANGELOG（已搁置声明） |
| 5 | `grep ipcMain.handle/on` 于 `src/main`（排除 spec） | 193 / 1；前缀表（§2.1） |
| 6 | `grep "\.send\|sendAgent\|broadcast\|sendToUiWindows"` | 主→渲染通道（§2.2） |
| 7 | `grep "@workbench/"`、`grep "from '(anthropic\|openai\|better-sqlite3\|ws\|zod)"`、`createRequire\|import(` | §4 |
| 8 | 各 `*-host.ts` 头注释 + `export function/class` 行号；`voice-host`/`autodrive-host`/`live-host`/`pet-control-host`/`coop-host`/`tray-host`/`pet-window-manager`/`audio-lease` 关键段通读 | §3 |
| 9 | `grep TODO\|FIXME\|待接线\|未接线\|占位\|placeholder\|stub` | 14 处（§7-S12） |
| 10 | `grep webui/client\|WebUIClient` 全仓；`ls src/renderer`；`grep Live2D\|dexie\|@dnd-kit\|audio-ai-worker` | S1/S2、A5-A8、A2 |
| 11 | `grep better-sqlite3` 于 `packages/local-store`、`dist/main/index.js`、`pnpm-workspace.yaml` | S4 |
