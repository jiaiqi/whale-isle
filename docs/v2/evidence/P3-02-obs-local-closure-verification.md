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

## 4. 抓到的真实缺陷：浏览器源硬件加速导致全黑

| 条件 | `browser_source` 渲染结果 |
| --- | --- |
| `BrowserHWAccel=true`（本机原设置） | 全黑。连**本地静态红页**（`file:///tmp/…/simple.html`，背景 `#c00`）截图也是 `(0,0,0)`，排除是我们 overlay 的问题 |
| `BrowserHWAccel=false` | 正常渲染：静态红页取到 `(204,0,0)`，我们的 `/obs` 卡片可见且随事件变化 |

判定：这是**本机 OBS 33.0.3 + CEF 150 在 Darwin 27.2 上的渲染缺陷**，不是 `webui-server` 的 `/obs` 页面缺陷（同一页面在 Chromium 里正常）。处置建议：在 OBS「设置 → 高级 → 源」里关闭浏览器源硬件加速，或等 OBS/CEF 修复。**本次测试后已还原为原设置，未擅自长期改动用户配置。**

## 5. 音频链路

| 验证项 | 结果 |
| --- | --- |
| OBS 能否收到真实音频并出电平 | **能**。测试场景内建 `ffmpeg_source` 播放本地 440Hz WAV，订阅 `InputVolumeMeters` 收到 **44 帧**电平事件，峰值 **0.0884**（非零即真实信号） |
| 输入音频轨道 | `GetInputAudioTracks` 返回 1–6 轨全开 |
| 把本 app 的 `afplay` 输出接进 OBS | **未验证**。macOS 上需 OBS 拿到「屏幕/系统音频录制」TCC 授权，且通常要虚拟声卡做路由；本机 `HAL` 只有 Oray / Parrot / ToDesk 三个第三方驱动，**没有 BlackHole/Loopback 这类可编程回环设备**，也不宜擅自安装系统级音频驱动 |

结论：OBS 的音频通道本身可用（有真实电平证据），但「鲸屿的声音进 OBS」这一条属 owner 前置（TCC 授权 + 是否安装虚拟声卡），本次不做也不宣称。

## 6. 未验证 / 不得当成已通过

1. **真实开播**：按指令全程未开播、未录制、未接触推流密钥。
2. **OBS 硬件加速开启下的 Browser Source 观感**：本机已知全黑，未解决（需 OBS/CEF 侧修复或长期关闭该选项）。
3. **本 app 音频进 OBS 的实际听感与延迟**：受 TCC 与虚拟声卡阻塞。
4. **推流画面观感/码率**：未开播，无可验证对象。
