# 内部开发预览构建验证 · `e4019f3` → `0.2.0-dev.2`

> **交付口径（owner 拍板）**：本版是**内部开发预览**——只保证「能装、能跑」；商用素材清源这轮推后。
> 本文件只记录本轮实际执行过、可复跑的证据；未执行的项在 §7 如实列出，不用开发态或单测代替安装态结论。

- **冻结发布 SHA**：`e4019f3eb6355461afb65249d3b129ec4e88e868`（开始前重新 `git fetch`，`origin/feat/whale-isle-v2` 仍指向该 SHA，未漂移）
- **工作分支**：`preview-build-e4019f3`（工作区初始停在祖先提交 `f1ce271`，已 fast-forward 到冻结 SHA）
- **分支合并说明**：开工后基分支又合入 `de43e3a`（PR #14，`V2-P4-01`），与本单文档产生 `CHANGELOG.md` 冲突；为让 PR 可合入，将 `de43e3a` 合入本分支并保留双方条目。**DMG 与全部安装态证据仍出自冻结 SHA `e4019f3`**，不含 `de43e3a` 的 `V2-P4-01` 代码；合并提交只解决文档冲突，不改变产物口径。
- **构建主机**：macOS Darwin 27.2.0 / arm64 / Apple Swift 6.4.2 / Xcode 26.4.2 / Node 26.13.1 / pnpm 12.16.1
- **构建时间**：2026-11-27 16:05–16:06 CST（`electron-builder` 打包窗口）
- **版本**：`0.2.0-dev.2`（根 `package.json` 与 `apps/desktop-host/package.json` 同步；与 11-24 的 `0.2.0-dev.1` 明确区分）

---

## 1. 产物与哈希

| 项 | 值 |
| --- | --- |
| DMG | `release/鲸屿 Whale Isle-0.2.0-dev.2-arm64.dmg` |
| DMG 字节数 | `2,322,093,040` bytes |
| DMG SHA-256 | `1f87e71bb8e0f3a53324b38c658a5174f4f24032513fe2e56ffbce8550a44360` |
| 挂载卷名 | `鲸屿 Whale Isle 0.2.0-dev.2-arm64` |
| 包内版本 | `CFBundleShortVersionString = 0.2.0-dev.2`；`CFBundleVersion = 0.2.0-dev.2`；`CFBundleIdentifier = com.whaleisle.desktop` |
| 安装副本 | `~/Applications/鲸屿 Whale Isle Preview.app`（`ditto` 自 `release/mac-arm64/鲸屿 Whale Isle.app`，约 2.3 GB） |
| 打包命令 | `pnpm --filter @workbench/desktop-host package` |

DMG 已实际挂载、核对包内版本与 helper 哈希、并在挂载卷上直接执行音频 helper `probe`（见 §4），随后 `hdiutil detach` 卸载。

---

## 2. 原生 helper 随包（本单最重要的一项）

### 2.1 问题与修复

原实现只从 `appPath` 向上查找仓库 `tools/native/*.swift` 并调用 `swiftc` 现编。脱离仓库安装后：

- OS 输入不可用（`source_not_found`）；
- 音频回退 `afplay`，`realPlayhead=false`；
- 若用户机器没装 Xcode CLT，开发态也无法编译。

本轮改为**预编译产物随包 + 源码编译仅作开发态回退**：

| 层 | 行为 |
| --- | --- |
| 安装态 | 从 `Contents/Resources/native/darwin-<arch>/` 读取预编译二进制，校验 `sha256.json` 与可执行位；不读仓库、不调 `swiftc` |
| 开发态 | 随包目录不存在 → 继续原有 `tools/native/*.swift` + 源码 SHA-256 缓存 + `swiftc` 编译回退 |
| fail-closed | 随包目录存在但二进制缺失 / 清单缺失或损坏 / 哈希不符 / 不可执行 → 直接报不可用，**不回退源码编译、不冒充成功** |
| 打包前 | `electron-builder` 的 `beforePack` 钩子再次校验产物，缺任何一项直接中断打包并给出人话原因 |

### 2.2 产物清单

构建命令：`node apps/desktop-host/scripts/build-native-helpers.mjs`（`pnpm --filter @workbench/desktop-host build:native-helpers`），`swiftc -O -target arm64-apple-macos12.0`。

| 文件 | 字节数 | SHA-256 |
| --- | --- | --- |
| `native/darwin-arm64/whale-input-helper` | `90,912` | `4febb544cffa87bfac35d8ff9ec2e1e5e8a41ba1019707f4c08039e7c9fccf25` |
| `native/darwin-arm64/whale-audio-helper` | `95,920` | `68e50fc9e0ebdb156d13761b4735d91da9a7c653d53e595e63b71debd846cae9` |
| `native/darwin-arm64/sha256.json` | `187` | 清单内容与上表一致 |

`file` 实测两者均为 `Mach-O 64-bit executable arm64`；`codesign -dv` 显示 `adhoc, linker-signed`（Swift 链接器自动 ad-hoc 签名，非伪造身份）。

### 2.3 运行时接线

- `apps/desktop-host/src/main/native-helper-bundle.ts`：统一解析 / 校验随包 helper；`fatal` 语义阻止静默回退。
- `native-input-helper.ts` / `native-audio-player.ts`：先查随包，再走源码编译；返回 `origin: 'prebuilt' | 'compiled' | 'cache'`。
- `v2-kernel-host.ts`：安装态传 `process.resourcesPath`，开发态传 `null`；启动日志打印 helper 来源或不可用原因。
- `index.ts`：新增 `WHALE_USER_DATA_DIR`（仅接受绝对路径）用于安装态验收与多实例隔离，不迁移旧数据、不碰默认目录。

---

## 3. 安装态验收（独立目录 + 独立 userData）

### 3.1 隔离边界

| 约束 | 实测 |
| --- | --- |
| 不动 `/Applications/鲸屿 Whale Isle.app`（0.1.0 旧包） | mtime 仍为 `2026-11-22 22:27:53`，未修改 |
| 不杀 owner 正在跑的客户端 | 客户端 `Electron` PID `68462` 仍监听 `127.0.0.1:18780` |
| 独立 userData | `WHALE_USER_DATA_DIR=/tmp/whale-preview-userdata`；启动后该目录生成 Chromium/IndexedDB 数据，**未创建 `native/` 缓存目录**（说明走的是随包 prebuilt，而不是源码编译缓存） |
| 端口冲突 | 预览实例启动时 `[webui] 端口 18780 被占用，回退随机端口` → `http://127.0.0.1:57086/...`，未抢占 owner 端口 |

### 3.2 启动与窗口（`[E2E-HOST]`）

用 `playwright-core` 的 `_electron.launch` 直接启动**安装副本**（`~/Applications/鲸屿 Whale Isle Preview.app/Contents/MacOS/鲸屿 Whale Isle`），环境变量 `WHALE_USER_DATA_DIR=/tmp/whale-preview-userdata`、`WHALE_DISABLE_INPUT_MONITOR=1`（避免接管本机物理输入监听）。

实测窗口（`windows.json` 原始记录）：

| # | URL | 标题 | 内尺寸 |
| --- | --- | --- | --- |
| 0 | `.../app.asar/dist/renderer/director/index.html` | `鲸屿 · 中控台` | `1360 × 860` |
| 1 | `.../dist/renderer/pet-stage/index.html#/pet-stage?...characterId=blue-whale-maid` | （桌宠窗） | `400 × 284` |
| 2 | `.../dist/renderer/pet-stage/index.html#/pet-stage?...characterId=crosspet-claude` | （桌宠窗） | `400 × 284` |

截图（本机 `artifacts/preview-build-e4019f3/`，gitignored）：

- `director.png`：中控台完整渲染（侧栏、生命中枢、对话、星露谷启动入口、模型与饭碗等）。
- `pet-blue-whale-maid.png`：小鲸透明桌宠窗渲染。
- `pet-crosspet-claude-bubble.png`：CrossPet Claude 角色渲染，**气泡「下午的阳光好舒服」正常显示**（证明随包 pet-packs 与气泡系统在安装态可用）。

### 3.3 helper 就绪（`[REAL-DEVICE]`）

直接启动安装副本并抓主进程 stdout：

```text
[native-audio] helper 就绪（prebuilt）：/Users/jiaqi/Applications/鲸屿 Whale Isle Preview.app/Contents/Resources/native/darwin-arm64/whale-audio-helper
[social] 抖音只读驱动：cdp-real
[webui] 端口 18780 被占用，回退随机端口
```

同时从**安装副本**直接执行两个 helper（不经仓库、不经 Xcode）：

```text
$ .../Resources/native/darwin-arm64/whale-input-helper permission
granted            # exit 0

$ .../Resources/native/darwin-arm64/whale-audio-helper probe .../design_sweet_normal.wav
{"type":"probe","durationMs":4000}   # exit 0
```

DMG 挂载卷上的同一份 helper 也执行了 `probe`，输出一致（`durationMs=4000`，exit 0）。

### 3.4 签名与首次打开

- `codesign -dv`：`Signature=adhoc`、`flags=0x20002(adhoc,linker-signed)`、`Identifier=Electron`、`TeamIdentifier=not set`、`Sealed Resources=none`。
- `electron-builder` 日志明确：`skipped macOS application code signing`，原因是本机没有有效的 `Developer ID Application` 身份；**本轮没有申请、也没有伪造任何签名身份**。
- 本机直接构建的副本没有 `com.apple.quarantine` 扩展属性（只有 `com.apple.provenance`），因此可直接启动。
- 若把 DMG 传到其他机器后首次打开被 Gatekeeper 拦截，绕行方式：**右键 → 打开**，或 `xattr -d com.apple.quarantine "/Applications/鲸屿 Whale Isle Preview.app"`。这是内部预览包的预期代价，不代表已签名/已公证。

---

## 4. 包内资源盘点（只盘点，不清源）

> **本单不删除、不替换任何素材**；下表是下一版清源的输入。`DEV_ONLY_NON_COMMERCIAL` 项在商用前必须整包替换或取得授权。

| 包内路径 | 内容 / 数量 | 来源 | 许可证 / 标记 |
| --- | --- | --- | --- |
| `Contents/Resources/pet-packs/aboutme-pets/` | 2,624 文件 / 1.9 GB（1,050 webp + 480 m4a + 1,060 json + 26 md + 8 txt） | `hunmer/aboutme-pets` @ main（`pnpm sync:pet-packs`） | **CC BY-NC-SA 4.0**（上游 README 声明；仅 `pets/dsh`、`pets/dsh1` 包内带 MIT 文本且不覆盖素材限制）；`DEV_ONLY_NON_COMMERCIAL` |
| `Contents/Resources/pet-packs/crosspet/` | 946 文件 / 89 MB（907 webp + 30 json + 8 woff2 + 1 md） | `lokicorvus/crosspet` @ main | **CC BY-NC-SA 4.0**（`characters/LICENSE.md`；署名上善无形 / ZipZipPipe 等）；`DEV_ONLY_NON_COMMERCIAL` |
| `Contents/Resources/pet-packs/fonts/上首软糖体.ttf` | 1 文件 / 3.9 MB | `PC2005-cloud/dsh-pet` 仓库内 | 字体本体许可未单独声明；`DEV_ONLY_NON_COMMERCIAL` |
| `Contents/Resources/guide-forager/` | 12 篇 Markdown / 148 KB | Stardew Valley Wiki（MediaWiki API，frontmatter 含 `source` + `contentSha1`） | **CC BY-NC-SA 3.0**（随 wiki 声明；frontmatter 写明「本地自用缓存，公开分发前须清除或获授权」）；`DEV_ONLY_NON_COMMERCIAL` |
| `Contents/Resources/voice/xiaojing-07-tiancui-yuanqi.wav` | 1 文件 / 245,804 B | 自产文本 + 小米 MiMo `mimo-v2.5-tts-voicedesign` | `DEV_ONLY_NON_COMMERCIAL`（上游限免、无商用条款；商用前须换有明确商用授权的 TTS 重做） |
| `Contents/Resources/app.asar` → `packages/pet-renderer/assets/blue-whale-maid/` | 114 个 VP9-alpha webm（asar 内 webm 计数含重复路径，共 228 条） | `PC2005-cloud/dsh-pet` / `luckui/dsh-livestream` | **CC BY-NC-SA 4.0**（形象原型溟月 @上善无形；女仆鲸鱼娘设计 @ZipZipPipe）；manifest `licenseScope=DEV_ONLY_NON_COMMERCIAL` |
| `Contents/Resources/app.asar` → `packages/pet-renderer/assets/voice-refs/genki_ref.wav` | 1 文件 / 725,804 B | 来源未在 `THIRD_PARTY_NOTICES.md` 登记（`docs/design/expressive-voice-plan.md` 已标 R4 风险） | **⚠️ 未登记**；仅作开发态参考，商用前必须撤出或登记授权 |
| `Contents/Resources/app.asar` → `dist/renderer/illustrations/` | 13 个 webp（6 组 light/dark + 定妆样张） | OpenAI `image_gen`（模型 ID 未向调用方提供），角色身份参考小鲸 WebM | 小鲸衍生图按 **CC BY-NC-SA 4.0**；`DEV_ONLY_NON_COMMERCIAL` |
| `Contents/Resources/app.asar` → `dist/renderer/brand/` | 图标、托盘图、10 枚供应商 logo | 项目自制 + 各供应商官网/GitHub 官方头像 | 供应商 logo 为**商标权属各公司**，仅指称性使用（`PROVIDER_IDENTIFICATION_ONLY`）；其余项目自制 |
| `Contents/Resources/app.asar` → `dist/renderer/pet-stage/fonts/` | 3 个 woff2（Long Cang / ZCOOL KuaiLe / ZCOOL XiaoWei） | `google/fonts/ofl/*` | **SIL OFL 1.1**（`COMMERCIAL_ALLOWED`；全文归档 `docs/licenses/`） |
| `Contents/Resources/native/darwin-arm64/` | 2 个预编译 helper + sha256 清单 / 192 KB | 本仓 `tools/native/*.swift` 编译产物 | 项目自有代码（MIT） |
| `Contents/Resources/mods/WhaleIsleAvatar/` | `WhaleIsleAvatar.dll` + `manifest.json` + `README.md` / 36 KB | 本仓 `mods/stardew-avatar-sync` | 项目自有代码（MIT） |
| `Contents/Resources/hooks/work-follow-hook.mjs` | 1 文件 / 4 KB | 本仓 `tools/hooks` | 项目自有代码（MIT） |
| `Contents/Resources/persona/blue-whale-maid.json` | 1 文件 / 4 KB | 本仓 `packages/shared-protocol/fixtures` | 项目自有内容 |
| `Contents/Resources/LICENSE.electron.txt`、`LICENSES.chromium.html` | Electron / Chromium 许可证全文 | Electron 45.4.1 | MIT / Chromium 第三方许可证集合 |

> 备注：`aboutme-pets` 包内 `README.md` 仍写「MIT」，与 2026-11-24 复核后的 `THIRD_PARTY_NOTICES.md` 口径（CC BY-NC-SA 4.0）不一致；本轮只记录，不改上游文件。

---

## 5. 安装态 vs 开发态能力差异表

> 口径：安装态指 `~/Applications/鲸屿 Whale Isle Preview.app` + 独立 userData；开发态指仓库内 `pnpm --filter @workbench/desktop-host start`。**未实测的项不写成可用**。

| 能力 | 开发态 | 安装态（本轮实测） | 证据等级 / 备注 |
| --- | --- | --- | --- |
| 应用启动 / 中控台 | 可用 | **可用**：director 窗 1360×860 正常渲染 | `[E2E-HOST]` + 截图 |
| 桌宠 / Bubble | 可用 | **可用**：小鲸与 CrossPet 两个 pet-stage 窗启动，CrossPet 气泡正常显示 | `[E2E-HOST]` + 截图 |
| 音频真实播放头（`whale-audio-helper`） | 可用（源码编译 / 缓存） | **helper 就绪已证**：启动日志 `origin=prebuilt`，路径在 `Contents/Resources/native/`；直接 `probe` 返回真实时长 | `[REAL-DEVICE]` helper 级；**未在本轮播放歌曲/TTS**，端到端播放头仍待播放验收 |
| OS 输入注入（`whale-input-helper`） | 可用（需 `WHALE_ENABLE_OS_INPUT=1` + 辅助功能权限 + Xcode CLT） | **helper 可执行已证**：安装副本 `permission` → `granted`，exit 0；**未开启** `WHALE_ENABLE_OS_INPUT=1`，未做端到端注入（避免接管本机输入） | `[REAL-DEVICE]` helper 级；端到端注入未测 |
| 星露谷启动器 | 可用（依赖本机游戏 + SMAPI + BWF Mod） | 入口与按钮存在（截图）；**未启动真实游戏** | 未测；需 owner 真机执行 |
| 抖音只读 | 可用（`cdp-real`，需 Chrome/Edge + 登录） | 启动日志显示 `[social] 抖音只读驱动：cdp-real`；**未打开抖音、未登录、未读任何内容** | 仅驱动选择；真实只读未测 |
| OBS overlay | 可用（需 OBS + obs-websocket） | **未验证** | 未测；需 OBS 真机场景 |
| WebUI | 默认 18780 | 18780 被 owner 客户端占用 → 回退 `127.0.0.1:57086` | `[REAL-DEVICE]` 日志 |
| 原生 helper 依赖 Xcode CLT | 需要（源码编译回退） | **不需要**：随包二进制直接执行 | `[REAL-DEVICE]` |
| 原生 helper 依赖仓库目录 | 需要 | **不需要**：从 `Contents/Resources/native/` 读取 | `[REAL-DEVICE]` |

---

## 6. 参考仓能力域对照（打包 / 安装 / helper）

| 参考仓 | 能力域 | 复用 / 重写 / 拒绝 | 结论 |
| --- | --- | --- | --- |
| `dsh-desktop-petbox`（MIT，纯 JS Electron） | 桌宠舞台、Live2D 参数单出口、mood/gaze/interact 纯函数 | **复用**：无（未复制代码）；**重写**：无；**拒绝**：其「`electron .` 直接跑源码、无打包与原生 helper 产物」的交付模型 | 它的强项在舞台表现层，不解决「脱离仓库安装后原生 helper 仍可用」；本轮不引入其代码 |
| `feiyuos-pc-body`（Python 胶水层） | PC 身体控制、鱼鳍安全模板、看门狗 | **复用**：仅安全模板思想（灾难黑名单 / 审计 / 急刹）；**重写**：无；**拒绝**：Python 进程 + 外部脚本的部署形态 | 与 Electron 宿主 + Swift helper 的架构不同；本轮不引入其代码 |

**决策声明**：本轮采用「Swift helper 预编译 + `extraResources` 随包 + sha256 清单 + fail-closed 校验」；不采用「运行时现编」或「把二进制塞进 asar」；验证路径是安装副本直接执行 helper + 安装态启动日志；失败回退是开发态源码编译，且随包产物损坏时直接报不可用而不是静默降级。

---

## 7. 未验证 / 明确不在本单范围

- **真实音频播放端到端**：未播放歌曲或 TTS，只验证 helper 就绪与 `probe`。
- **OS 输入端到端注入**：未开启 `WHALE_ENABLE_OS_INPUT=1`，未申请/变更辅助功能授权，未注入任何事件。
- **真实星露谷启动**：未启动游戏、未加载 SMAPI/BWF Mod。
- **真实抖音只读**：未打开抖音、未登录、未读任何内容、未触碰验证码/风控。
- **OBS overlay**：未启动 OBS、未验证 18765 图层源。
- **真实开播 / 推流 / 平台写操作**：全部未做。
- **Windows x64 包**：未构建、未验证。
- **签名 / 公证**：未申请 Developer ID，未公证；本轮产物是 ad-hoc。
- **商用素材清源**：按 owner 口径推后；本单只留清单，不删除、不替换。
- **跨架构**：只构建并验证 `darwin-arm64`；`darwin-x64` 无产物。

已知非阻塞日志噪音：启动时可能出现 `Error occurred in handler for 'pet:sleep-status': No handler registered`，这是 `CURRENT.md` 已记录的既有启动竞态，与本单无关，本轮未修。

---

## 8. 门禁与测试

```text
$ pnpm verify:gate
✅ PASS  Gate 1 类型与边界          tsc -b 零错误 + dependency-cruiser 零违规
✅ PASS  Gate 1 类型与边界(Python)  ruff 全绿 + mypy --strict 通过
✅ PASS  Gate 1 打包护栏            desktop-host build 四入口通过
✅ PASS  Gate 2 许可证与密钥        license-scanner 352 文件 0 违规；0 密钥 / 0 UNLICENSED / 0 GPL
✅ PASS  Gate 2 依赖漏洞            pnpm audit high：0 high / 0 critical
✅ PASS  Gate 2 DST Lua 语法        luac -p：5 个 Lua 文件通过
✅ PASS  Gate 3 确定性单测          vitest 全绿 + pytest 全绿；卡死回归剧本 7 个
✅ PASS  Gate 4 回环契约 E2E        [SIMULATION] 0.5s < 15s
✅ verify:gate 通过：8 过 / 0 跳过 / 0 待接线
```

全量单测（`pnpm test`，含覆盖率）：

```text
Test Files  191 passed (191)
     Tests  2127 passed (2127)
Statements : 96.84% (14706/15185)
Branches   : 90.19% (10179/11285)
Functions  : 97.35% (2427/2493)
Lines      : 98.23% (13162/13398)
```

本轮新增/更新的 helper 单测：

- `native-helper-bundle.spec.ts`：随包布局、sha256 清单、缺文件 / 清单损坏 / 缺条目 / 哈希不符 / 不可执行 → fail-closed。
- `native-input-helper.spec.ts` / `native-audio-player.spec.ts`：prebuilt 优先、损坏时**不**回退源码编译。

---

## 9. 复跑命令

```bash
# 1) 从冻结 SHA 建分支（本工作区已就位）
git fetch origin
git checkout -B preview-build-e4019f3 e4019f3eb6355461afb65249d3b129ec4e88e868

# 2) 依赖与预编译 helper（需要 swiftc / Xcode CLT；失败会 fail-closed）
pnpm install --frozen-lockfile
pnpm --filter @workbench/desktop-host build:native-helpers

# 3) 随包素材（本机从已有副本同步；2 GB 级，gitignored）
pnpm sync:pet-packs   # 或从既有工作区 ditto assets/pet-packs

# 4) 打包
pnpm --filter @workbench/desktop-host package

# 5) 安装到独立目录并以独立 userData 启动
ditto "release/mac-arm64/鲸屿 Whale Isle.app" "$HOME/Applications/鲸屿 Whale Isle Preview.app"
WHALE_USER_DATA_DIR=/tmp/whale-preview-userdata \
  "$HOME/Applications/鲸屿 Whale Isle Preview.app/Contents/MacOS/鲸屿 Whale Isle"

# 6) 直接验证安装副本里的 helper
"$HOME/Applications/鲸屿 Whale Isle Preview.app/Contents/Resources/native/darwin-arm64/whale-input-helper" permission
"$HOME/Applications/鲸屿 Whale Isle Preview.app/Contents/Resources/native/darwin-arm64/whale-audio-helper" probe <some.wav>

# 7) 门禁
pnpm verify:gate
```
