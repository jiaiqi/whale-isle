# `V2-P3-02` OBS 本地闭环实测证据（2026-11-26，`[REAL-DEVICE]`）

> 场景：本机 macOS（Darwin 27.2，Apple M4）/ OBS Studio **33.0.3** / obs-websocket **5.7.6**。
> **安全边界**：全程未开播、未录制、未读取也未回传推流密钥；只用独立测试场景 `WhaleIsle-E2E`，结束即删除；改动过的两处 OBS 配置（obs-websocket 开关、浏览器硬件加速）均已还原为原值并复核。
> **结论**：**WebSocket 控制链路与 overlay → OBS 画布两条都实测打通**；同时抓到一个真实环境缺陷：本机 OBS 开启「浏览器源硬件加速」时 `browser_source` 渲染全黑（连本地静态红页也黑），关闭后正常。音频侧验证到 OBS 输入真实电平，但**把我们 app 的声音接进 OBS** 仍受 macOS TCC 与虚拟声卡前置阻塞。

## 1. 安全与还原记录

| 项 | 处理 |
| --- | --- |
| obs-websocket 配置 | 备份 → 临时 `server_enabled=true`（沿用原端口 4455 与原密码，未读取/输出密码内容）→ 测试后还原 `server_enabled=false`，与原文件一致 |
| `global.ini` | 备份 → 临时 `BrowserHWAccel=false` → 还原 `BrowserHWAccel=true` |
| 场景集合 | 测试前 `未命名.json` 备份；测试场景 `WhaleIsle-E2E` 与两个测试输入用完即删；结束后 `sources` 与 `scene_order` 与备份完全一致（`场景` + `macOS 屏幕采集` / `窗口采集` / `麦克风/辅助音频`） |
| 推流/录制 | 全程 `GetStreamStatus.outputActive=false`、`GetRecordStatus.outputActive=false` |

## 2. WebSocket 真实连通（不是静态阅读）

- 连接 `ws://127.0.0.1:4455` 完成 v5 握手（Hello → 带 challenge 的 Identify → Identified），随后真实调用：
  `GetVersion`、`GetSceneList`、`CreateScene`、`SetCurrentProgramScene`、`CreateInput`、`GetSourceScreenshot`、`GetInputList`、`GetInputAudioTracks`、`GetInputVolume`、`SetInputVolume`、`RemoveInput`、`RemoveScene`、`GetStreamStatus`、`GetRecordStatus`，全部返回 `requestStatus.result=true`。
- 实测返回：`obsVersion=33.0.3`、`obsWebSocketVersion=5.7.6`、原场景 `场景`。

## 3. overlay 事件 → OBS 画面（真实像素证据）

1. 起真实 `createWebUIServer()`（`/obs` 路由，token 鉴权），在测试场景里建 `browser_source` 指向 `http://127.0.0.1:<port>/obs?token=…`。
2. 服务先推 `{type:'decision', tool:'water', intent:'弹幕骂大肥鱼，先喷水再记仇'}`，再推 `{type:'receipt', tool:'water', status:'COMPLETED'}`。
3. `GetSourceScreenshot` 前后两帧：**13186 B → 19775 B**，像素差包围盒 `(18, 368) - (200, 462)`，即事件发生后画面确实变化。
4. OBS 窗口实拍（`screencapture -l <windowId>`）可见画布上的真实卡片：`● 自动驾驶中 · 小鲸` / `water` / `弹幕骂大肥鱼，先喷水再记仇`。

证据文件（`artifacts/` 在 `.gitignore` 中，**不入库**，仅本机留证；路径如下）：

- `artifacts/acceptance/P3-02-obs-overlay-in-canvas.png`（OBS 窗口实拍，画布内可见 overlay 卡片）
- `artifacts/acceptance/P3-02-obs-overlay-frame-before.png` / `-after.png`（`GetSourceScreenshot` 两帧）
- `artifacts/acceptance/P3-02-obs-browser-black-hwaccel-on.png`（同一场景、同一 URL，硬件加速开启时的全黑画布）

## 4. 抓到的真实缺陷：浏览器源硬件加速导致全黑（**明确前置条件**）

| 条件 | `browser_source` 渲染结果 |
| --- | --- |
| `BrowserHWAccel=true`（本机原设置） | 全黑。连**本地静态红页**（`file:///tmp/…/simple.html`，背景 `#c00`）截图也是 `(0,0,0)`，排除是我们 overlay 的问题 |
| `BrowserHWAccel=false` | 正常渲染：静态红页取到 `(204,0,0)`，我们的 `/obs` 卡片可见且随事件变化 |

判定：这是**本机 OBS 33.0.3 + CEF 150 在 Darwin 27.2 上的渲染缺陷**，不是 `webui-server` 的 `/obs` 页面缺陷（同一页面在 Chromium 里正常）。

### 4.1 由此确立的**硬前置**

> **在关闭「浏览器源硬件加速」之前，任何「OBS 里看不到我们的 overlay」的现象都不得归因到我们的页面。**

该前置已写进运行手册 [RUNBOOK-OBS-OVERLAY.md](../RUNBOOK-OBS-OVERLAY.md) §0，并配套一条可复跑的检测方式（静态红页自检）。

**处置属于 owner 决策**：OBS → 设置 → 高级 → 源 → 关闭「浏览器源硬件加速」；改完用红页自检复核，确认可见后再决定是否改回原值，并记录「改动 → 验证 → 还原」三步。**本仓的工具只读 OBS 配置，不会代改 owner 的全局设置**（`tools/obs-selfcheck/src/config-probe.ts` 只做 `existsSync` + `readFileSync`）。

### 4.2 检测方式：静态红页自检（`pnpm obs:selfcheck`）

自检用的红页是一个**与我们的 overlay 完全无关**的独立静态 HTML（纯 `#c00` 背景），
因此「红页黑 ⇒ 责任在 OBS 侧；红页红而 `/obs` 黑 ⇒ 才是我们页面的问题」——两类故障可立即分流。

| 模式 | 行为 | 本机实测结果（2026-11-26） |
| --- | --- | --- |
| `pnpm obs:selfcheck` | 只读 `global.ini` 与 obs-websocket 配置，判定前置是否满足 | 读出 `BrowserHWAccel = true` → **前置不满足**；`server_enabled=false` → `--probe` 不可用 |
| `pnpm obs:selfcheck --serve` | 本机回环起静态红页（打印 `http://127.0.0.1:<port>/red`），人工粘贴进 OBS 目视 | 服务正常起；脚本同时提示「当前正处于已知会全黑的状态，红色结果需先关闭硬件加速才是有效对照」 |
| `pnpm obs:selfcheck --probe` | 连 obs-websocket 建**临时**场景与临时 `browser_source`，取中心像素后立即删除 | **未执行**：需 owner 先开启 obs-websocket（属 owner 开关，脚本只提示位置不代改）。退出码语义：`0` 红页正常 / `1` 命中全黑 / `2` ws 未开启或连不上 / `3` 有内容非红页 / `4` 探针异常 |

工具实现：`tools/obs-selfcheck/`（PNG 解码 `png-decode.ts` + 只读配置探测 `config-probe.ts` + obs-websocket v5 最小客户端 `obs-websocket-client.ts` + CLI `cli.ts`），单测 **46 例全绿**（`pnpm exec vitest run tools/obs-selfcheck`）。

其中 `obs-websocket-client.spec.ts` 用真实 WebSocket 服务端把 v5 的 op 0/1/2/6/9 全走一遍：无认证握手、salt+challenge 认证哈希校验、`result=false` 回执、请求超时、非 JSON 与未知 requestId 忽略、端口无人监听。对端是本地假服务端，仍属 `[SIMULATION]`，不等同于真实 OBS。


## 5. 音频链路

| 验证项 | 结果 |
| --- | --- |
| OBS 能否收到真实音频并出电平 | **能**。测试场景内建 `ffmpeg_source` 播放本地 440Hz WAV，订阅 `InputVolumeMeters` 收到 **44 帧**电平事件，峰值 **0.0884**（非零即真实信号） |
| 输入音频轨道 | `GetInputAudioTracks` 返回 1–6 轨全开 |
| 把本 app 的 `afplay` 输出接进 OBS | **未验证**。macOS 上需 OBS 拿到「屏幕/系统音频录制」TCC 授权，且通常要虚拟声卡做路由；本机 `HAL` 只有 Oray / Parrot / ToDesk 三个第三方驱动，**没有 BlackHole/Loopback 这类可编程回环设备**，也不宜擅自安装系统级音频驱动 |

结论：OBS 的音频通道本身可用（有真实电平证据），但「鲸屿的声音进 OBS」这一条属 owner 前置（TCC 授权 + 是否安装虚拟声卡），本次不做也不宣称。

### 5.1 「必须装虚拟声卡」是过时认知——现成可用路径已核实（2026-11-26 追加）

后续专项核实（只读 + 本机临时对象探测，**未安装任何驱动、未改任何系统设置**）得出：

| 路径 | 需装驱动 | 需 TCC 授权 | 能否只抓本 App | macOS 要求 |
| --- | --- | --- | --- | --- |
| **A. 应用直接把音频推给 OBS**（`CreateInput` 建 Media Source 指到音频文件 + `TriggerMediaInputAction` 播放） | ❌ | ❌ | ✅ 完全精确 | 无要求 |
| B. OBS `macOS Audio Capture` → Desktop Audio Capture | ❌ | ✅ Screen Recording | ❌ 混入整机所有声音 | macOS 13+（OBS 28+/30+） |
| C. OBS `macOS Audio Capture` → Application Audio Capture | ❌ | ✅ Screen Recording | ⚠️ **抓不到 `afplay`** | macOS 13+（OBS 30+） |
| D. 应用侧 Core Audio process tap → 编码推流 → OBS Media Source | ❌ | ✅ 首次录制弹一次授权 | ✅ 按 PID 精确（含 `afplay`） | macOS 14.2+ |
| E. AudioDriverKit 自建虚拟声卡 | ✅ | ❌（需向 Apple 申请 entitlement） | — | — |
| F. BlackHole/Loopback 等第三方虚拟声卡 | ✅ | ❌ | ❌ 设备级混音 | — |

**推荐 A**：本项目的 TTS/点歌**本来就先把音频落到临时文件再 `afplay` 播放**，
所以「应用 → OBS Media Source」这条路径**零驱动、零 TCC、零系统设置改动**，
且本机 obs-websocket 已具备（4455 端口，握手已实测通过）。

**C 在本机不可行的原因（实测）**：`afplay` 是**独立于 Electron 主进程的进程**，且 **bundleID 为空**
（CoreAudio 进程列表实测确认），不在 `SCShareableContent.applications` 里，
因此按 bundleIdentifier 枚举的 Application Audio Capture **选不到它**。
只有 Electron 渲染进程自身的 `HTMLAudioElement`（桌宠 SFX）能被 C 覆盖。

**D 的可行性（本机实测）**：用未签名的 CLI Swift 程序对正在播放的 `afplay` 创建 Core Audio process tap
成功（`TAP_CREATED` → `TAP_DESTROYED`），**全程无弹窗、无授权、无驱动**，
系统 tap 列表复核为 0（无残留）。授权只在「从 aggregate device 开始录制」时触发一次。
注意 `afplay` 每次是**临时 PID**，需动态重绑。

**明确的无符合项声明**：不存在「既精确只抓本 App（含其 `afplay` 子进程）、又不装驱动、又不需任何 TCC、又不改应用代码」的路径。
要精确按进程抓 `afplay`，必须用 D（需首次录制授权）**或**走 A（零授权，推荐）。

**需要 owner 提供的授权/决策**：

| 项 | owner 需要做什么 |
| --- | --- |
| 路径 A | 提供 obs-websocket 密码（本机 `auth_required=true`） |
| 路径 B/C | 在「系统设置 → 隐私与安全性 → 屏幕与系统音频录制」确认 OBS（本机已勾选，撤销后需重勾） |
| 路径 D | 首次录制时在弹出的 "Allow 鲸屿 to record system audio" 上点一次允许 |
| 路径 F | **本次明确排除**（装系统级驱动须 owner 明确同意） |

### 5.2 对旧表述的纠正

- 「通常要虚拟声卡做路由」→ **可选但非必需**（OBS 30+ 与 macOS 14.2+ 的 process tap 都不需要第三方驱动）。
- `SCStreamConfiguration.audioCapture` / `sampleRatesChannels` 在公开 SDK 中**不存在**（本机 macOS 27.2 SDK 全文检索无匹配），这两个名称无法核实，**不应在代码或文档中引用**。
- 「Audio Input entitlement」≠ process tap 所需权限：后者门槛是 `NSAudioCaptureUsageDescription` + 系统音频录制 TCC 提示，**不是** `com.apple.security.device.audio-input`（本机实测未签名 CLI 也能建 tap）。

## 6. 未验证 / 不得当成已通过

1. **真实开播**：按指令全程未开播、未录制、未接触推流密钥。
2. **OBS 硬件加速开启下的 Browser Source 观感**：本机已知全黑，未解决（需 OBS/CEF 侧修复或由 owner 关闭该选项——见 §4.1 与运行手册）。
3. **本 app 音频进 OBS 的实际听感与延迟**：未验证；§5.1 的路径 A/B/C/D 均**未在本机跑通端到端**（D 只验证了「能创建 tap 并销毁」，未验证把 PCM 送进 OBS）。
4. **推流画面观感/码率**：未开播，无可验证对象。

## 7. 三步前置与「六单重盘」（2026-11-26 追加）

三步前置：① 关闭浏览器源硬件加速；② 开启 obs-websocket（4455）；③ 音频路径 3A（零驱动零授权）。
**结论先行：三步只解锁 `V2-P3-02` 的画面侧，另加 `V2-P3-01` 的 obs-stage 可见性；其余四单的阻塞项与 OBS 无关。**

| 工单 | 三步前置解锁了什么 | 还差什么才能 `DONE` |
| --- | --- | --- |
| `V2-P3-02` 直播中控 + OBS 舞台 | **画面侧全解锁**（硬件加速关闭 + websocket 4455 已开，`pnpm obs:selfcheck --probe` 退出码 0 即闭环）；3A 接线完成后「本 app 声音进 OBS」也闭环 | 真实平台测试直播间 + 推流密钥 + 平台授权（E9）；3A 的代码接线（`obs-client.ts` / `obs-audio-bridge.ts` / `ObsAudioBridgeStatusSchema` / 宿主 IPC / 生活页状态），约 5–6 文件，**等 `--probe` 绿了再立项** |
| `V2-P3-01` 表演系统 | **只解锁 obs-stage 这一路的可见性验收** | 合法 `.moc3` / `.vrm`；SVS/SVC 推理后端权重与索引；5 组真实情绪参考音频（GPT-SoVITS 是 TTS，不能顶） |
| `V2-P1-06` 星露谷 AI-First | 不解锁（与 OBS 无关） | 星露谷+SMAPI 已具备，只差人跑满 1 个游戏日 + 8 条控制语义实按 + F7 三处开关同步 |
| `V2-P2-01` 攻略学习 | 不解锁 | 连续多日实玩 + 装一个影响机制的 Mod 验兼容提示 |
| `V2-P2-08` Coop v1 联机 | 不解锁 | 第二台机器或第二个 Steam 账号（E3） |
| `V2-P3-04` Digital Life L1 | 不解锁（桌宠气泡走 Electron 通道，不经 OBS） | 真实供应商多模态 Key；真实平台浏览需人工声明能力矩阵；L1 浏览执行器未接入 |

### 7.1 `--probe` 的判据（owner 自查用）

命令：`OBS_WEBSOCKET_PASSWORD='<密码>' pnpm obs:selfcheck --probe`

| 退出码 | 含义 | 输出特征 |
| --- | --- | --- |
| 0 | 通过 | `已连接 OBS …` → `截图尺寸 64x64，中心像素 rgb(204,0,0)` → `结论：browser_source 正常渲染静态红页` → `已清理临时输入与临时场景` |
| 1 | 全黑（硬件加速未真正关闭 / 未重启 OBS） | `结论：browser_source 渲染全黑——命中本机已知缺陷` |
| 2 | 连不上（密码错 / OBS 没开 / websocket 未启用） | 连接错误原文 |
| 3 | 有画面但不是红页 | `结论：browser_source 有内容但不是红页` |
| 4 | 其它异常（建源失败等） | 原始错误 |

探针动作全集：`GetVersion` → 建**临时**场景 → 建 **64×64 临时** `browser_source` 指向本地红页 → 等 1.5 s → `GetSourceScreenshot` 取中心像素 → `finally` 里 `RemoveInput` + `RemoveScene` 并断开。不碰已有场景、不推流、不录制、不留持久对象。

### 7.2 2026-11-26 22:38 复跑记录（只读）

`pnpm obs:selfcheck` 仍输出 `BrowserHWAccel = true`。证据链：`global.ini` 第 6 行原文为 `true`；该文件 mtime 20:16 且当时 22:38 未再被写过；OBS 进程自 20:16 前启动后未重启。该开关由 OBS 启动时读取、退出/应用时写回，故「界面取消勾选但未应用/未重启」时磁盘仍是旧值。**必须完全退出 OBS 再重开，`pnpm obs:selfcheck` 显示 `BrowserHWAccel = false` 才算真关。**

### 7.3 认证算法缺陷与修复（2026-11-26，owner 真机定位）

**症状**：真机用正确密码连接，OBS 5.7.6 一律回 `CLOSE 4009 Authentication failed.`，之前所有「密码不对」的结论都是误判。

**根因**：`obs-websocket-client.ts` 的认证串算错，写成三步且拼接顺序反了：

| 口径 | 公式 |
| --- | --- |
| 协议（obs-websocket 5.x `Authentication` 节） | `secret = b64(sha256(password + salt))`；`authentication = b64(sha256(secret + challenge))` |
| 修复前实现（错） | `b64(sha256(challenge + b64(sha256(salt + b64(sha256(password))))))` |

**为什么单测没拦住**：`obs-websocket-client.spec.ts` 里的假服务端照抄了被测实现的同一套公式，实现错、测试也错、两边自洽，于是永远是绿的。这类「自洽的错」是比缺测试更危险的一类缺陷。

**修复与防退化**：

- `computeAuthentication(password, salt, challenge)` 按协议两步重写，注释写明出处与「假服务端不能照抄实现公式」的教训。
- 假服务端改为按协议公式**独立实现**；认证不通过时回 `4009 Authentication failed.`（之前只 `close()`，关闭码不明确）。
- 新增固定向量断言：`password='pw-123' / salt='salt-abc' / challenge='chal-xyz'` → `XZoiWAVck3AYkCEZPmxkUuT7YWggKQwaNrmOAkjCqdw=`，常量由 `node -e` 与 Python 双向交叉核对后写成字面量，不从被测实现取值；同时断言旧的三步写法算出的值不等于该常量。
- 新增「假服务端按协议独立校验」用例：密码错回 4009、密码对才 `Identified`。

**边界**：真实密码全程未写入任何文件、注释、测试或提交信息；真机探针由 owner 亲自执行。`obs-selfcheck` 全量 **56 例通过**，`pnpm verify:gate` 7/7。
