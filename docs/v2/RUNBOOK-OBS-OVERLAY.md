# RUNBOOK — OBS 舞台接线与浏览器源前置（item 4 / `V2-P3-02`）

> 本手册是 **item 4**（OBS 本地闭环与真机验收）的执行说明：前置条件、操作步骤、检测方式与还原要求。
> **口径铁律**（沿用 AGENTS.md）：沙盒/静态推演标 `[SIMULATION]`，本机实测标 `[REAL-DEVICE]`，两者不得互相替代；涉及 owner 全局设置的一律**只报告不代改**。

---

## 0. 硬前置：关闭「浏览器源硬件加速」

### 0.1 为什么这是前置而不是建议

本机（macOS Darwin 27.2 / OBS Studio 33.0.3 / CEF 150）实测发现：

| `global.ini` 的 `BrowserHWAccel` | `browser_source` 渲染结果 |
| --- | --- |
| `true`（OBS 默认，也是本机原设置） | **全黑**。连本地静态红页（`background:#c00`）截图也是 `(0,0,0)` |
| `false` | 正常。静态红页取到 `(204,0,0)`，我们的 `/obs` overlay 卡片可见且随事件变化 |

因此：**在关闭该选项之前，任何「OBS 里看不到我们的 overlay」的现象都不能归因到我们的页面**。这不是我们的 bug，是 OBS/CEF 在该平台上的渲染缺陷。

### 0.2 处置方式（owner 手动执行，脚本不代改）

1. OBS → 设置 → 高级 → 源 → 关闭「浏览器源硬件加速」（英文界面为 *Hardware acceleration*）。
2. 用 §1 的静态红页自检确认浏览器源能出画面。
3. 若要还原为原设置，**先确认红页在关闭状态下可见**，再改回 `BrowserHWAccel=true`，并把「改动 → 验证 → 还原」三步都记进证据文档。

> **红线**：本仓的工具**只读** OBS 配置文件，**不会**替 owner 改任何 OBS 全局设置。`tools/obs-selfcheck` 的 `config-probe.ts` 只做 `existsSync` + `readFileSync`。

### 0.3 检测方式（静态红页自检）

```bash
pnpm obs:selfcheck          # ① 只读前置自检：读 global.ini 与 obs-websocket 配置，给出「前置是否满足」
pnpm obs:selfcheck --serve  # ② 起本地静态红页，人工粘贴进 OBS 目视验证
pnpm obs:selfcheck --probe  # ③ 自动探针：连 obs-websocket 建临时 browser_source 并取中心像素
```

- ① 的输出直接给出 `BrowserHWAccel` 当前值与「前置满足 / 不满足」判定，退出码 `0`。
- ② 会打印形如 `http://127.0.0.1:<port>/red` 的地址；在 OBS 里加一个「浏览器」源粘贴该 URL：
  - 画面为**红色** → 浏览器源渲染正常；
  - 画面**全黑** → 命中本机已知缺陷（且脚本会提示当前正处于该状态）。
- ③ 需要 OBS 正在运行且 **WebSocket 服务器已开启**（属 owner 开关，脚本只提示位置、不代改）：
  - 密码通过 `--password <值>` 或环境变量 `OBS_WEBSOCKET_PASSWORD` 提供；
  - 脚本会创建**临时**场景 `WhaleIsle-SelfCheck-<时间戳>` 与临时 `browser_source`，
    截图取中心像素后**立即删除**该输入与该场景，不触碰 owner 已有场景；
  - 退出码：`0` 正常渲染红页 / `1` 命中全黑缺陷 / `2` obs-websocket 未开启或连不上 /
    `3` 有内容但不是红页（需人工目视核对）/ `4` 探针执行异常。

> 探针**不推送、不录制**，全程不接触推流密钥。

### 0.4 静态红页自检为什么能排除「我们页面有问题」

自检用的红页是一个与我们的 overlay **完全无关**的独立静态 HTML（纯 `#c00` 背景）。
它黑 → 责任在 OBS 侧；它红而我们的 `/obs` 页面黑 → 才是我们页面的问题。
这条对照让两类故障可以立刻分流，避免把 OBS 缺陷当成自己代码的 bug 去查。

---

## 1. OBS 舞台接线的标准步骤

1. 起我们的 `webui-server`（`/obs` 路由，token 鉴权），拿到 `http://127.0.0.1:<port>/obs?token=…`。
2. OBS 里新建「浏览器」源，粘贴上面地址（**先确认 §0.3 的红页自检通过**）。
3. 把该源加进目标场景，必要时调整尺寸（建议 1920×1080，透明背景）。
4. 我们的服务推送 `decision` / `receipt` 事件，OBS 画布上的卡片应随之变化。

**验收判据**：事件前后两帧截图字节数不同（实测 13186 B → 19775 B），像素差包围盒非空，且 OBS 窗口实拍可见卡片文字。

---

## 2. 音频进入 OBS（本机现状与 owner 前置）

| 验证项 | 状态 |
| --- | --- |
| OBS 能否收到真实音频并出电平 | **能**。测试场景内 `ffmpeg_source` 播放本地 440Hz WAV，收到 44 帧电平事件，峰值 0.0884（非零即真实信号） |
| 把本 app 的声音接进 OBS | **未验证**。§2.1 给出四条不装驱动的可行路径与各自授权要求 |

本机 `HAL` 只有 Oray / Parrot / ToDesk 三个第三方驱动，**没有 BlackHole / Loopback 这类可编程回环设备**。
**安装系统级音频驱动需要 owner 明确同意**，本仓不会擅自安装。

### 2.1 四条路径与最小步骤

> 核实结论：**「必须装虚拟声卡」是过时认知**。OBS 30+ 与 macOS 14.2+ 的系统内置路径都不需要第三方驱动。

#### 路径 A（推荐）：应用直接把音频推给 OBS —— 零驱动、零 TCC、零系统设置改动

本项目的 TTS/点歌**本来就先把音频落到临时文件再 `afplay` 播放**，所以直接把文件交给 OBS 即可：

1. 起 `webui-server`（或任意服务），确认 obs-websocket 可达（本机 4455 端口，`auth_required=true`）。
2. 通过 obs-websocket `CreateInput` 建一个 `media_source` 输入，`local_file` 指向该音频文件
   （或常驻一个源，用 `SetInputSettings` 换文件）。
3. 用 `TriggerMediaInputAction` 触发播放。
4. 验收：OBS 混音器出现该源的电平（可复用 `InputVolumeMeters` 订阅，非零即真实信号）。

**最小步骤**：只需 owner 提供 obs-websocket 密码。

#### 路径 B：OBS `macOS Audio Capture` → Desktop Audio Capture

1. OBS「源」→ 添加「macOS Audio Capture」→ Method 选 **Desktop Audio Capture**。
2. 确认 OBS 在「系统设置 → 隐私与安全性 → 屏幕与系统音频录制」已勾选。
3. 播放本 App 音频，看混音器电平。

**代价**：混入**整机所有声音**（通知声、其他 App）。要求 macOS 13+。

#### 路径 C：OBS `macOS Audio Capture` → Application Audio Capture

同 B 的步骤，但 Method 选 **Application Audio Capture** 并在 Application 下拉里选宿主 App。

**本机不可行（实测）**：TTS/点歌走 `afplay`——它是**独立于 Electron 主进程的进程**且 **bundleID 为空**，
不在 `SCShareableContent.applications` 列表里，按 bundleIdentifier 枚举的 Application Capture **选不到它**。
只有 Electron 渲染进程自身的 `HTMLAudioElement`（桌宠 SFX）能被覆盖。

#### 路径 D：应用侧 Core Audio process tap → 编码推流 → OBS Media Source

1. 应用枚举 Core Audio 进程对象，找到本 App / `afplay` 的进程。
2. `CATapDescription.initStereoMixdownOfProcesses` 建 private tap，建含该 tap 的 aggregate device。
3. 读 PCM → FFmpeg 编 MPEG-TS → `udp://127.0.0.1:<port>`（本机 ffmpeg **无 libsrt**，走 UDP/RTP）。
4. OBS 建 Media Source 输入指向该 UDP 地址。

**本机已实测的部分**：未签名的 CLI Swift 程序对正在播放的 `afplay` 创建 tap 成功（`TAP_CREATED` → `TAP_DESTROYED`），
**全程无弹窗、无授权、无驱动**，系统 tap 列表复核为 0（无残留）。
**未验证**：把 PCM 真正送进 OBS 并听到声音。

**授权**：首次「从 aggregate device 开始录制」时系统弹一次 "Allow 鲸屿 to record system audio"，owner 点一次即可。
**注意**：`afplay` 每次是**临时 PID**，需动态重绑。

### 2.2 明确的无符合项声明

不存在「既精确只抓本 App（含其 `afplay` 子进程）、又不装驱动、又不需任何 TCC、又不改应用代码」的路径。
要精确按进程抓 `afplay`，必须用路径 D（需首次录制授权）**或**走路径 A（零授权，推荐）。

### 2.3 对旧表述的纠正

- 「通常要虚拟声卡做路由」→ **可选但非必需**。
- `SCStreamConfiguration.audioCapture` / `sampleRatesChannels` 在公开 SDK 中**不存在**，不应在代码或文档中引用。
- 「Audio Input entitlement」≠ process tap 所需权限（后者是 `NSAudioCaptureUsageDescription` + TCC 提示）。

---

## 3. 还原清单（每次真机测试后必须逐项核对）

| 项 | 还原要求 |
| --- | --- |
| obs-websocket | 若测试期间开启，测试后改回 `server_enabled=false`（原值），端口与密码保持原样 |
| `global.ini` 的 `BrowserHWAccel` | 改回测试前的原值（当前本机原值为 `true`） |
| 场景集合 | 只保留 owner 原有场景与输入；临时场景与临时源必须删除（`--probe` 自动删除） |
| 推流 / 录制 | 测试期间保持关闭（`GetStreamStatus.outputActive=false`、`GetRecordStatus.outputActive=false`） |

---

## 4. 证据文档

- [P3-02-obs-local-closure-verification.md](./evidence/P3-02-obs-local-closure-verification.md) —— OBS 本地闭环实测证据、硬件加速缺陷对照表、音频链路与未验证项。
- [OWNER-CHECKLIST-OBS-AUDIO.md](./OWNER-CHECKLIST-OBS-AUDIO.md) —— 转交 owner 的一页最小操作清单（硬件加速 / obs-websocket 密码 / 音频二选一 + 还原方式）。
- 工具源码与单测：[tools/obs-selfcheck/](../tools/obs-selfcheck/)。
