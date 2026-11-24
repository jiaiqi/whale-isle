# Changelog

本项目的所有显著变更将记录在本文件。
格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [Unreleased] — 2026-11-24

### Added（T-M6-55 ~ T-M6-59：桌宠全字段运行、AI 直连出图、星露谷大脑进化、CLI 钩子向导、OBS 挂件收口）

- **T-M6-55 自定义角色全字段真运行**：新增 `greeting-schedule.ts`（6 时段 + 8 节日：公历元旦/万圣/圣诞/国庆，农历春节初一到初七/元宵/端午/中秋，内置 2025–2035 农历表零联网），按「角色 id + 日期 + 键」持久化去重；首见优先节日姿态 → 时段姿态 → 缺图回退每日问候。`custom:pose-config` 增发 `idleActions/glyph/apps`；ambient 空闲链按权重混播自定义立绘与内置氛围池；`#glyph-layer` 在 reading/searching 时渲染 3–5 个代码符号飘字（省电自动关闭）。主进程新增 macOS 3s 前台应用只读监听（`frontAppWatcher` + `matchCharacterForApp`，含随包 CrossPet apps），偏好 `followFrontApp` 默认关闭、关闭后严格保持手选角色。小本子/成就优先读自定义 `milestones`（`{h}` 替换当前小时）与 `notebook.notes/sign`。验收台新增 `acceptance:carousel`（主进程 1.5s 节拍）与 `acceptance:guides`，桌宠窗叠加 90% 身高虚线框 + 97% 脚底基线 + 姿态角标，停止/关闭弹窗自动回 idle。
- **T-M6-56 创作中心 AI 直连出图**：新增 `image-gen-client.ts`（OpenAI Images `generations/edits` 兼容 `gpt-image-1`/`dall-e-3` 与中转站，解析 b64_json/临时 url；Gemini Native `generateContent` + `responseModalities:["IMAGE"]` 解析 inlineData；单张 60s 超时、Key 全程脱敏）与 `image-gen-drafts.ts`（草稿目录防穿越、参考图校验 ≤20MB、并发 ≤2、done 文件收集）。`creator-host` 新增 `creator:image-gen-providers / generate-batch / regenerate-one / commit-draft`，实时 `creator:gen-progress` 推 data URL，草稿确认后直接复用 `importImages` 流水线（抠像 → 90% 脚底 → blink 贴回 → avatar/portrait → 热重载）。创作中心 A/B 页签新增供应商/模型选择、参考图、实时网格（queued/generating/done/failed + 重画）与「确认入库并后处理」；无 Key 时如实提示并可一键跳转「模型服务商」。
- **T-M6-57 星露谷大脑进化与联机同步**：`teamContext()` 明确 objectiveDone 完成判据（动作仍要执行，回执成功才算完成）；`LlmPlanner` 记录未确认的完成声明，`AutodriveRunner` 动作成功后广播 `目标已完成：…` 并结束目标，失败则撤回声明继续推进。新增 `state-hints.ts`（无鱼竿/商店 09:00-17:00 打烊/空位 ≤2/list_chests 摘要，≤240 字）注入每轮 user prompt。新增 `objective` 事件作为目标生命周期单点事实源；`autodrive:objective-status / clear-objective` IPC；游戏共玩事件流 4 种徽标（大脑决策/规则兜底/主人插队/目标推进中）、目标条与一键取消；联机 Agent 事件带 agentId 广播，Coop 共享同一 LlmPlanner 生命周期与 3 连败熔断。
- **T-M6-58 8 家 CLI 钩子一键安装**：新增 `work-follow-installer.ts`：Claude Code / Gemini CLI / Cursor 标准 JSON 钩子幂等合并（`.whale-isle.bak` 备份、坏 JSON/未知格式拒绝写入、卸载仅移除鲸屿条目），其余 5 家诚实标注「手动模式」并给可复制命令；钩子脚本同步到 `userData/work-follow/hook.mjs`（打包 `Resources/hooks`），脚本支持 stdin JSON（session_id/tool_name/hook_event_name）。`work-follow:self-test` 写入受控事件并验证轮询消费 ≤1.5s；工坊 Tab 4 新增 8 家状态卡片与安装/卸载/复制/自检。
- **T-M6-59 OBS 挂件收口**：`/obs` 复用中文化工具/状态词表（钓鱼/制作/已完成/失败），支持 `?layout=compact|card&theme=dark|light`，状态卡顶栏显示 `/api/state.characterName` 当前角色；中控台增加布局/主题选择并实时拼接带 token 的源地址。新增 `iteration.e2e.spec.ts` 覆盖创作中心生图入口、验收台参考线/轮播、CLI 探测与自检、OBS 中文化参数与目标条不伪造。重打 `release/鲸屿 Whale Isle-0.2.0-dev.1-arm64.dmg`（2,373,955,045 B），挂载校验 `Resources/hooks/work-follow-hook.mjs` 与 `Resources/pet-packs/`（1.9G）完整、无 `.temp*.dmg` 残留；全仓 1124 tests / 分支 90.2% / Electron E2E 12/12 / `verify:gate` 7 过。

### Fixed（T-M6-54：逐行审计 P0/P1 真实缺陷，2026-11-24）

- **创作中心白底抠像（P0）**：`keyWhiteBackground` 先检测四角透明（已是透明图直接跳过，保留 alpha），再用**从四边出发的连通洪水填充**删除背景，只删与边缘连通的白，绝不全局删白——白色衣服、眼白、白龙等封闭区域完整保留；`creator-host` 抠像后改为 `fromRaw(raw).resize(...)`，去底结果真正进入输出的 90% 脚底对齐 WebP（旧实现直接缩放原图，抠像结果被丢弃）。
- **夜间睡衣工作跟随（P0）**：`onSessionIdle` / `onAgentPose` / `onCrown` 统一走 `matchPetViewForCharacter`，同时匹配 `session.characterId` 与 `nightOutfit(characterId)`（22:00–07:00 只开睡衣变体也能命中）。
- **星露谷多步目标生命周期（P0）**：`resetDailyStateIfNeeded` 跨日清空 `objective`（首次决策初始化不算跨日）；`MAX_OBJECTIVE_ROUNDS=15` 上限；决策 JSON 支持 `objectiveDone:true` 主动完成；`AutodriveRunner.clearObjective()` + `autodrive-host` 在**新单步原子指令**或用户说「算了/取消目标/不用了」时清空旧目标并广播回执，避免旧目标跨日/被替换后继续驱动；删除未使用的 `stuckConsulted/failStreak/avoidTools` 死字段。
- **自定义角色交互（P0/P1）**：`custom:pose-config` 下发 `fx`/`egg`；pet-stage 右键/「戳一下」优先 `pokePose`（pose-skin `playPose`，缺图回退 `rage_spray`），`fx` 经 `normalizePoseEffect`/`mergePoseEffects` 并入 PoseSkinRenderer（新增 bubbles/celebrate/victory/priceDown/priceUp SVG 动效），`egg:true` 的自定义角色被点中同样逃跑；`summonEgg` 把 userData `egg:true` 自定义角色与 CrossPet `egg-*` 合并随机挑选。
- **回归证据**：`pose-effects` 4/4（含别名/脏值/默认映射保留）、`pet-control-host` 6/6（睡衣命中 + 自定义彩蛋）、`custom-character` 7/7（egg 标记）、`image-pipeline` 10/10（透明跳过/封闭白保留/浅色衣服保留）、planner 目标生命周期 4 例、autodrive `clearObjective`、chat-directive 取消语 12 例；全仓 **1021 tests / 分支 90.17%**，`pnpm verify:gate` **7 过 / 0 跳过**，Electron E2E **11/11**。

### Added（全量素材随包 + 桌宠工坊 / 语音中心重构）

- **`assets/pet-packs/` 全量素材直入（T-M6-45）**：新增 `pnpm sync:pet-packs`（GitHub tree 枚举 + 8 并发 + 按字节数断点续传 + 失败重试 + `SYNC-MANIFEST.json`）。实拉 aboutme-pets 2,624 文件 / 1,894 MiB（9 包 · 1,050 精灵图 · 480 条 `.m4a`）、crosspet 946 文件 / 87 MiB（8 基础 + 7 皮肤 + 15 彩蛋 + 8 套手写字体）、上首软糖体.ttf；二次运行 0 下载 / 3,571 跳过。`apps/desktop-host/package.json` 增 `extraResources: assets/pet-packs → Resources/pet-packs`（不进 asar/dist）。
- **`whale-pet://` 只读协议**：主进程 `resolvePetPacksDir()`（打包态 `Resources/pet-packs`、开发态仓库 `assets/pet-packs`）+ `protocol.registerSchemesAsPrivileged`（standard/secure/supportFetchAPI/stream）+ 严格穿越校验（编码 `%2e%2e`/`%2f`、反斜杠、空段、非白名单扩展名 → 403；缺失 → 404；非 GET → 405），音频走 `net.fetch(file://)` 支持 Range。9 包 manifest/角色由 `buildAboutmePackArtifacts()` 统一生成（与 userData 导入共用同一套槽位/音轨规则），注册表合并随包角色（同名 userData 包不再重复）。
- **桌宠工坊（T-M6-46）**：侧栏精简为 4 组（桌宠工坊 / 语音中心 / 游戏共玩 / 联机协作 / OBS 挂件 / Harness / 模型服务商 / 扩展与权限），`pet-stage-panel` 升级为四页签外壳：舞台与互动、动作预览与素材库（640×360 12fps Canvas 逐帧播放器、Space/←→/↑↓、进度条、`.m4a` 随帧 seek、MediaRecorder 导出 WebM、推到桌宠试播、全量动作/11 槽位/CrossPet 皮肤彩蛋实时搜索）、小本子与友谊、跨 AI 跟随与接口；顶部 9 角色 + 皮肤快切条。`pets-panel.tsx` 退役。
- **语音中心（T-M6-46）**：9 角色声线绑定条 + 5×5 试听按所选角色绑定（`voice:character-bind` → `userData/voice-bindings.json`，主进程 `resolveVoiceId` 覆盖优先）；如实展示 mcode/say/未适配后端、动作原声 ducking 开关与 live 抢麦锁状态；高阶情感/RVC 精调随 `characterId` 切换。
- **联机一键启动向导（T-M6-47）**：Terraria 本地服参数数组启动（`-port/-world/-worldname/-noupnp/-autocreate`）+ `terraria-bridge.tmod` 探测 + 每 AI `bridge-port.txt` + 客户端 `-join` 尝试；DST `cluster_token.txt` 0600 落盘（校验 Klei 字符集、不回显/不写日志）、`Master/modoverrides.lua` 写受控 UserID 与同源 pair_token、专用服 + 单 Sidecar :18100（`ELECTRON_RUN_AS_NODE`）；向导三步显示真实落盘/构建状态。
- **9 角色平权收口（T-M6-48 切片）**：未登记角色使用中性人设与中性短评，不再继承小鲸的「大肥鱼」雷区与口吻。

### Added（批次 3-4：CrossPet 社交 / 跨 AI 跟随 / 对外驱动口）

- **CrossPet 姿势渲染（T-M6-48）**：契约新增 `PetRendererType='pose-skin'` 与 `PetCharacter.skins`；`PoseSkinRenderer` 以「姿势图 = 1 帧 clip」接入 `RendererHost`（交叉淡入 + Q 弹），`pose-effects` 提供 6 类 SVG 头顶动效；`pet-packs` 把 30 个 CrossPet 角色目录（8 基础 + 7 换装 + 15 `egg-*` 彩蛋）转成角色与 manifest，`character.json.lines` 原样供气泡使用；夜间 22:00–07:00 自动换睡衣，`egg-*` 被点击即逃跑关窗。
- **多宠社交（T-M6-48）**：`PetWindowManager` 新增 `collisions()`（重叠 >12% 才触发，2 秒去抖）、`assemble()`（底部排排站）、`dismissAll()`；主进程 `pet:summon / assemble / dismiss / egg-summon`；两只桌宠相撞互 Q 弹 + 吐槽。
- **友谊与「我们的小本子」（T-M6-48）**：`FriendshipStore`（Electron/Node 内置 `node:sqlite`）实现 10 颗心 / 1/4 填充 / 每日上限 15 / 4 档关系；摸头/戳/协作/完成共同目标/互聊涨分；留言、互聊记录与一键隐私擦除；`friendship-host` 提供闲时互聊（角色预置模板，经全局语音锁串行播报并写入 memory-graph）、久坐/喝水提醒（60/45 分钟，23:00–07:00 与睡眠免打扰）与每日首次见面问候；桌宠工坊 Tab 3 接入 8 套 CrossPet 手写字体、统计、成就与留言板。
- **跨 AI 工作跟随（T-M6-49）**：`work-follow-host` 只读 source/session/工具名/模型名，支持 single（主宠随活跃 AI 换装）与 multi（每个 AI 各来一只），单会话工具调用 ≥8 自动戴皇冠；ACP Harness 事件直接镜像，本机 CLI 用 `tools/hooks/work-follow-hook.mjs` 追加 `userData/work-follow/events.jsonl`（坏行跳过、按偏移增量）；Tab 4 实时任务卡与事件流。
- **对外本机驱动口（T-M6-49）**：WebUI 新增 `GET /api/pet/:agentId/state`、`POST /say`（睡觉态 409，`wake:true` 叫醒）、`POST /action`（500ms–60s）；入参过 `PetApiSayRequest / PetApiActionRequest` Zod 契约，设备 token 鉴权；`plugin-kit` 的插件上下文在清单声明 `{resource:'pet:control',policy:'allow'}` 时注入 `petApi.state/say/action`。
- **9 角色平权收口**：未登记角色使用中性人设与中性短评，不再继承小鲸的「大肥鱼」雷区与口吻。

### Fixed（2026-11-24 真机：没鱼竿 → fish 无限失败卡死 / 指令只回复不办事）

- **连败退回规则日程不再复读同一动作**：`LlmPlanner` 检测到同一工具连续两次失败时，旧实现直接 `fallback.decide()`，但 `RulePlanner` 不知道失败原因（`observeReceipt` 未转发），按日程在 07:10 继续 `fish` → 事件流无限刷屏、游戏时间冻结（真机截图：`第1年夏2日 07:10 · Beach` 循环数十条「钓鱼赚米！」）。现在：
  - `LlmPlanner.observeReceipt` 把回执转发给规则兜底；
  - `RulePlanner` 记录**所有工具**的失败（环境级失败「没有鱼竿/没有工具/材料不够」一次即避开，普通失败连续两次避开，成功解除），钓鱼阶段绕开 `fish` 转采集，采集/清地也失败则 `wait` 明确求助；
  - 连败触发 `cooledTools` 后**仍由 LLM 决策**：每轮 user prompt 注入「今天已冷却的动作 + 最近失败原因 + 换方案提示（`list_chests`/`take_items`/FishShop 买鱼竿/采集/农活/下矿）」，不再用 `if (repeated) return fallback` 硬切绕过大脑；
  - 所有 `fallback.decide` 出口统一走 `fallbackDecision`：兜底动作若已在冷却中 → 改 `wait` 求助，真实兜底在 intent 标注「规则兜底」，事件流可区分大脑与离线兜底。
- **规则侧鱼竿前置检查**：`hasFishingRod()` 认「鱼竿/钓竿/Rod」；背包段明确没有鱼竿（或 fish 已连败冷却）时，`RulePlanner` 的 fishing 阶段直接转采集，不盲目调用 fish；`observeReceipt` 扩展为**所有非生存类工具**连败 ≥2 当日跳过（`SURVIVAL_TOOLS` 的吃饭/睡觉/赶路/界面仍可重试）。
- **编排器全局防刷屏熔断**：相同 `(tool + FAILED summary)` 连续 ≥3 次且 `gameClock` 未推进 → 发 watchdog 并暂停 30s，任何规划器/兜底都失效时的最后一道网。
- **聊天多步目标落地**：`chat-directive` 解析协议扩展为两种形态——单步原子动作（`tool/args`）与多步目标（`tool:"" + objective + firstTool/firstArgs`），toolDoc 补 `list_chests`；`chat:say` 接到 objective 时注入 ack、自动拉起自驾、`submitObjective` 持续驱动 LlmPlanner，有首步则同时 `submitDirective` 立即执行，并广播 `chat_order` 让中控台可见；`teamContext()` 修复单机 objective 被空黑板短路的问题（「主人当前目标」每轮独立注入）。
- **指令解析失败不再静默**：`chat:say` 的指令解析异常此前被空 `catch` 吞掉，用户只收到回话、游戏里毫无动静。现在记录原因、事件流广播「指令解析失败（未接单）」，并在回话 system 里要求如实说明，不假装接单。
- **下单失败回灌**：主人刚下的单执行失败时，除原回执外补一条 `chat_order FAILED` 事件与气泡语音（「主人，X 没办成……原因」），不再只看到一句「好嘞」。

### Fixed（T-M6-51：批次 1-4 审计缺陷）

- **定向投递参数序**：删除 `PetWindowManager.send(channel, agentId, payload)` 双字符串入口，统一 `sendAgent(agentId, channel, payload)` 与 `broadcast`；修复 bump / summoned / crown / wake / say / preview 全部被写反后静默丢弃的问题。
- **CrossPet 透明穿透**：`<img>`（pose-skin）补齐 alpha 采样（object-fit contain 几何）与缩放同步，皮肤/彩蛋可正常点击、拖拽、摸头、右键与逃跑。
- **单宠换装**：工作跟随不再 `dismissAll(null)` 销毁 default 主窗；改为只关其他 AI 窗并在 default 原地换角色（保留 `/api/pet/default/*` 与自驾目标），含夜间睡衣解析。
- **工作跟随完整性**：ACP `session-started/permission/exit` 共用缓存 sessionId；modelName 优先映射角色；single 模式 tool 命中新角色也换装；multi 60s 闲置先告别再退场。
- **其它**：CrossPet `portrait/avatar/portrait-card` 不进入动作槽；`whale-pet://` 显式 `Content-Type`；右键「叫她出来」二级面板期间保持交互；FrameCanvas 按真实帧尺寸绘制；工作跟随监听器可退订；非星露谷 planner systemPrompt 惰性读取当前角色名；拆分 `pet-control-host` / `coop-launch-host` / `acp-session-cache`。

### Added（T-M6-53：创作中心与姿态验收台）

- **自定义角色深度协议**：`PetCustomCharacter` 契约兼容 CrossPet `character.json`（name/accent/apps/greeting/lines/glyph/idleActions/pokePose/correctedPose/longThink/fx/outfit/aura/host/skin/egg）并扩展 `reactTo`、`milestones`、`notebook`；`userData/pet-characters/<id>/` 目录加载、克隆内置、改名（本机 settings，升级不丢）、零重启热重载（右键「重新载入」/创作中心保存）。
- **reactTo 代演**：命中来源或 modelName 的自定义角色优先代演工作状态、多会话与庆祝；姿态缺失按 compact→writing、asking→listening、其余→idle 回退；correctedPose（出错 3 分钟内再次对话一次性触发）与 longThink（decision 后 N 秒切 deepthink）。
- **创作中心**：三页签（角色/皮肤生图提示词编译器、5 态彩蛋提示词 + 主脑台词生成、拖入建角）；11/5/5/社区梗姿态批次；主进程图像后处理（白底抠像、90% 身高脚底对齐、idle-blink 仅闭眼贴回、avatar 192×192、portrait-card 256×384、WebP 编码）。
- **姿态验收台**：暂停真实事件、12 场景直接驱动真实桌宠窗口、缺失姿态回退检查、1.5s 全姿态轮播 + 90% 参考线、脱敏 Markdown 报告（零对话正文/路径/密钥）、桌宠 Option+右键直达。

### Fixed（T-M6-50：动作库按角色/形象分库，对齐 aboutme-pets 线上实现）

- **动作库不再混包**：逐行分析上游 `preview.json` 播放器后，按「每角色自己的 categories + `idleAnimationId` + `totalActions`」重建 Tab 2：切角色即整套动作库替换、清空搜索、自动播该角色待机动作；默认只显示当前角色（claude 166 / dsh 101 …），「全部 9 包」仍可显式切换。
- **逐动作帧元数据**：`PetStudioAction` 增加 `frameWidth/frameHeight/rows`，`PetStudioPack` 增加 `idleClipId`；播放器与 WebM 导出使用每个动作自己的尺寸与 fps，不再假定全局 640×360。
- **声画同步改为上游同款**：音轨 fetch 成 blob + 隐藏 `<audio>`，**音频作为时钟**（帧号 = `floor(currentTime×fps)`），blob 就绪前冻结动画；暂停/恢复与音频同步，拖动/逐帧会 seek 音频；按 category 折叠分组，搜索只作用于当前角色。

### Changed

- `docs/THIRD_PARTY_NOTICES.md` 登记 `assets/pet-packs/` 三类素材（aboutme-pets MIT、crosspet CC BY-NC-SA 4.0、上首软糖体字体待核实），统一 `DEV_ONLY_NON_COMMERCIAL`；`license-scanner` 跳过 `assets/pet-packs` 二进制树。
- `.gitignore` 忽略 `assets/pet-packs/*` 二进制（保留 README 与 SYNC-MANIFEST）；1.85 GiB 素材只在本机与安装包中存在。

## [Unreleased] — 2026-11-23

### Added

- **联机协作大厅（T-M6-39）**：新增 TeamGoal / TeamAssignment / TeamBlackboardSnapshot / TeamCommsMessage 四契约（`pnpm gen:contracts` 61 契约）；`TeamBlackboard` 提供区域软锁（TTL/续租/过期）、版本化快照与 ≤300 字 Prompt 摘要；`HuddleOrchestrator` 严格 2–3 轮、自动协商 5 分钟冷却、单场 12,000 token 预算，超预算或 LLM 异常降级为本地规则分工；CoopHost 为每个 AI 独立绑定 persona/voice/planner（复用主 Gateway 与饭碗），新增端点可视化增删改、`@单人` P0 定向、`@全队` 重议、求助区域交接与三栏大厅（目标 / 群聊 / 黑板）。验证：TeamBlackboard 7、Huddle 10、CoopHost IPC 5、团队上下文注入 2、Electron UI E2E 7/7；真实双 AI 联机与听感待真机。
- **多桌宠同屏多开 + 全局抢麦（T-M6-38）**：`PetWindowManager` 按 `agentId` 管理透明窗，独立坐标/缩放/锁定持久化到 `pet-window-prefs.json`，新窗 +220px 错位，默认 `default` 保持旧单窗兼容；桌宠 hash URL 携带 agentId/characterId，动作/气泡/状态事件按 agentId 过滤；语音输出租约上提主进程，按角色注册表解析 voiceId，`coop:speaker` 广播 speaking/idle 驱动发言/倾听动作。验证：窗口管理 5、语音串行 5、Electron E2E 多窗开关 7/7。
- **DST 同 sidecar 多 Agent 路由（T-M6-40）**：`agentId` 贯穿通用动作请求、DST `/state`、`/act`、`/cancel`、sidecar 每玩家快照/pending/cancel 槽与 Mod 多受控 UserID tick；单玩家/`default` 向后兼容。验证：dst-adapter 12/12、sidecar 10/10（快照/动作/cancel 隔离）；真实 DST 多玩家待人类。

### Added（协作可用性收口，T-M6-41）

- **DST 逻辑玩家 ID 可视化**：`McpEndpoint.routingId` 贯穿契约/CoopHost/DST adapter；UI 可填 Klei UserID，DST 空值直接拒绝接管，避免同 sidecar 读错角色。
- **自动求助**：真实状态事件补充 health/freeSlots；体力 <15%、生命 <30% 或背包满持续 30 秒自动发 `need_help` 并尝试交接给空闲队友，3 分钟抑制抖动；成员卡新增人工求助按钮。
- **真实目标进度**：`TeamGoalMetric.source` 支持 `team_money` / `shared_wood`；金币来自 Stardew 共享钱包，公共木材用 `list_chests item=木材` 仅统计箱子并排除背包；目标编辑支持金币/木材 target。
- **E2E 兼容修复**：旧 `prefsSet` 位置写入手动同步到 `PetWindowManager` 的 default 窗口偏好，修复重启恢复 E2E；按窗口实际状态比对，不再依赖全局值是否变化。

### Added（T-M6-41 / T-M6-42，2026-11-24）

- **aboutme-pets 九角色包与 SpritesheetRenderer**：新增精灵图契约字段（sprite/meta/audio）、帧裁切与零黑帧切换、动作原声及 `coop:speaker` 下 duck 至 15%；Node 导入器支持 9 包、并发 6、断点跳过、进度事件、11 语义槽位 + ambientPool、角色 persona/专属 voiceId/语速音高；角色包商店接入舞台与协作页，素材只落 userData。许可证台账登记 hunmer/aboutme-pets + lokicorvus/crosspet（CC BY-NC-SA 4.0）。
- **联机一键启动**：新增 `coop-launcher`，星露谷可生成隔离 Mods profile（普通 Mod 符号链接、BWF 独立拷贝、改写 McpPort/ShowHud）并以参数数组启动；协作页新增可折叠三游戏向导和自动端口分配。Terraria/DST 当前只做本机路径探测，不伪造启动成功。
- **角色专属口癖**：`character-persona` 增加按 characterId 的专属雷区响应，小鲸保留原 persona-brain 规则。

### Added（T-M6-44，2026-11-24）

- **九角色功能平权**：`pets:manifest` 读取当前角色真实 manifest；自驾提示/回执短评/声线按角色动态；指令解析角色名动态；10 套完整 `PetPersonaConfig` 全部经 `persona-brain` 加载并具备 P0 `rage_spray`；舞台按 renderer 自动切换 WebM/精灵图；声音工坊按角色保存；Coop 角色优先级去特权。
- **桌面防打扰**：贴边 45% 收起与 10s 回缩/事件探出、Alt 临时 0.35 透明度+穿透、全屏应用自动隐藏、`Control+Alt+P` 暂藏/唤回、闲置 30s 省电。
- **无焦点 Alt 穿透与拖离贴边**：主进程以全局鼠标坐标 + macOS CGEventSource / Windows GetAsyncKeyState 轮询判定悬停 Alt，直接 setOpacity(0.35)/setIgnoreMouseEvents，不依赖窗口焦点；拖离边缘新增 clearDock，只清贴边记忆、不弹回旧位置。
- **按角色恢复音色包**：voice-studio 新增 load-pack，切换角色时加载该角色已保存的五档情感参数与 SVC 参数。
- **副桌宠身份与平滑探出**：pet-stage 使用本窗 agentId 执行 dock/undock；`pet:poke-line(agentId)` 按窗口角色返回专属台词；`undock` 改为 smoothstep 逐帧 setBounds。E2E 覆盖副窗 dock/poke。
- **全屏按屏判定与双击弹弓**：`detectFullscreenForDisplay` 输入桌宠 display bounds + 可见全屏窗口 bounds，多屏只隐藏被覆盖的屏；E2E 复用同一函数。双击改为 drag-throw 阻尼弹簧位移，先弹射再精确回原点，并保留 Q 弹形变。
- **九角色平权与专属戳一戳**：`pets:manifest` 与 `speak` 共用 `selectedCharacterManifest` / `voiceSceneForCharacter` seam，9 个 aboutme 角色逐项断言 manifest、characterId、speakerName、voiceId、语速音高；右键戳触发角色专属吐槽。
- **气泡语音回执状态机**：新增纯 `bubble-lifecycle`（waiting/speaking/muted/hidden）：speaking 中不收起、语音完成即收、失败/超时/中断保留文字并显示静音角标、60s 兜底；`VoiceHost` 通过 `pet:speech-result` 广播 lease 终态，pet-stage 按 agentId 消费。
- **交互与声学手感**：摸头哄好、右键戳、甩晕四级、双击 Q 弹、S/右键安静睡眠；气泡等待 `coop:speaker` 完成回执、60s 兜底与静音角标；精灵音轨 duck 15%。

### Fixed

- **星露谷真机卡死（BWF 120s 自暂停 → 时钟冻结死锁）**：日志实锤 BWF 因「MCP 客户端 120 秒没有动作」暂停游戏；旧 watchdog 在当前无在途动作时 `cancel()` 直接返回、根本没发 `cancel_action`，却每 2 秒重复声称已兜底，形成永不进入 planner 的死循环。修复：无在途也真实发送 cancel；90 秒无变更动作自动发游戏原生 keepalive（星露谷 `wait minutes=1`）阻止自暂停；4 分钟冻结时 cancel + 最小恢复动作，恢复失败才交还 planner，并重置 stale 计时避免刷屏。补 3 项回归测试；`ActionLock.cancel` 仍以「是否有在途动作被取消」为返回值，保持旧语义。**当前运行实例仍是旧主进程，需重启 Electron 后生效。**

## [0.2.0-dev.1] — 2026-11-23

首个可复现开发基线：Electron 45.4.1 + Zod 4.6.7（audit 0 high/0 critical）、契约原生 JSON Schema 生成、三游戏代码闭环（泰拉瑞亚/DST 真机待验收）、OBS `/obs` 只读挂件、自治质量指标、CI + soak + 7 项本地门禁、服务商面板拆分、全项目审计收口（见 ROADMAP T-M6-27~35）。

### Added

- **直播最小链路（T-M6-37，T-M6-31 切片二）**：`live-stream-hub` 接入主进程，弹幕/事件经 Zod 契约 → 防封护栏 → 注意力分档/去重 → 批次，落到 OBS 页实时事件流、插件总线与 P0 语音短评；新增 `live:ingest` / `live:replay` / `live:snapshot` IPC 与确定性样本回放。验证：live-host 4/4、Electron E2E 6/6。**未接线**：真实 dyhub、常客账本落盘、点歌执行链、OBS 图层；回放标为 `[SIMULATION]`，不是真机直播证据。
- **外部插件生产链路（T-M6-36，T-M6-31 切片一）**：`userData/plugins/<id>/{manifest.json,index.mjs}` 发现真实 dsh 插件，清单过 Zod、id 与目录名一致、符号链接越界拦截；`vault://*`（密钥单咽喉）与 `shell://*`（审批 UI 未接线）装载期硬拒；dsh 工具默认 ask 策略，需 `pluginApprove` 会话授权；setup 崩溃回滚、工具异常隔离、禁用注销工具/订阅。中控台插件页显示真实外部插件、工具与错误；新增 `docs/PLUGINS.md` 与可复制示例 `docs/examples/plugins/hello-whale/`。验证：plugin-host 6/6、Electron E2E 5/5（真实动态 import → 启用 → 工具调用）。**注意**：插件在主进程运行，Policy 不是 JS 沙箱，只装载用户本机可信代码。
- **自治质量指标（T-M6-35，审计 Phase 2 切片）**：`packages/game-bridge-mcp/metrics.ts` 从真实事件流派生有效回执率、失败/错误率、重复动作率、动作覆盖面与最长同工具连击；口径明确（TIMEOUT 不计成功也不计失败、`think` 不算动作、编排器汇总回执排除、空集显示「—」不伪造 0%/100%）。星露谷与泰拉瑞亚面板新增「自治质量（本会话）」卡；渲染层通过 `@workbench/game-bridge-mcp/metrics` 子路径导入，避免把适配器副作用打进前端包。验证：metrics 8/8（分支 100%）、Electron UI E2E 4/4。
- **OBS 只读透明挂件 `/obs`（T-M6-34，T-M6-31 首个最小真实链路）**：内嵌 WebUI 新增 `GET /obs`——透明底、`STAGE_PROTOCOL=1`、token 鉴权、`obs-readonly` 声明；页面通过 `/ws` 订阅动作/回执并回放最近 20 条，只读、无任何指令/审批入口。中控台 OBS 页改为「复制 OBS 源地址」（含本机 token，提示勿外传），文案从「18765 接线中」改为真实的 18780 `/obs`。验证：webui-server 23/23、Electron UI E2E 4/4（真实内嵌服务 401/200 与协议标记）。投票/歌词/点歌层仍未接线，OBS 叠加观感待真机。
- **语音后端如实展示（T-M6-33，审计发现）**：新增 `voice:backend` 只读探测与顶栏标识——`mcode` 角色音色链不额外标注，`say` 兜底显示「· say」，非 macOS 显示「· 未适配」，title 展示具体链路说明。此前界面只有「语音开/关」，容易让用户误以为始终在用角色 TTS。验证：探测单测 4/4、Electron UI E2E 断言 `data-voice-backend` 三态；真实听感与 Windows 适配仍待真机。
- **CI 与仿真长时浸泡（T-M6-29 部分）**：新增 `.github/workflows/ci.yml`（ubuntu：typecheck / depcruise / 单测排除 Electron E2E / ruff+mypy+pytest；macOS：完整 `pnpm verify:gate` + Electron `desktop.e2e`/`ui.e2e`，不注入 secrets、不跑真实游戏）；新增 `pnpm soak:autodrive [分钟]`（`tools/scripts/soak-autodrive.mjs`），在本地星露谷仿真器上按 autodrive 节奏长跑，统计 get_state 失败率、异常回执率与 RSS/heap 趋势，12 秒冒烟实测 445 轮 / 1335 事件 / 0 失败 / 0 异常回执。Gate 4 更名为「回环契约 E2E」并在脚本与 VERIFY 顶部写明它是测试内手工组合（假语音适配器 + `:memory:` SQLite），**不是**生产端到端。CI 尚未在远端实际跑过，如实记录。
- **多游戏/多端点事件与指令隔离（T-M6-27，P0 正确性）**：autodrive 事件现在强制携带 `sessionId / gameId / generation`，联机 agent 池事件另带 `agentId + sessionId`；渲染层与桌宠只消费当前会话事件，旧 generation、异 sessionId、异 gameId 与联机端点事件一律丢弃，切换游戏后不再出现「星露谷页显示泰拉瑞亚动作」或旧回执污染语音/记忆。P0 指令新增可选 `expectedSessionId`，主进程拒绝来自已切换会话的迟到指令（不误发到新游戏），省略时保持旧调用兼容。验证：会话过滤纯函数 6 项、双 runner 并发隔离 1 项、runner 会话标识 2 项、Electron E2E 1 项（状态含会话标识 + 过期指令被拒绝），相关包单测 223 项全绿。仍属 `[E2E-HOST]`/`[SIMULATION]`，真实多游戏并发仍待真机。
- **三游戏共玩页统一与连接引导（T-M6-25）**：游戏共玩页三个游戏（星露谷 / 泰拉瑞亚 / 饥荒 DST）共用同一套区块——连接引导条、当前动作、目标链、执行记录与回执、实时指标、快捷插队、默认折叠的高级诊断；主进程新增只读探活（星露谷 18080/mcp `get_state`、泰拉瑞亚 18090/health、DST 18100/health），按 `online / reachable / offline` 三态如实呈现，连不上时给出人类可执行的启动指引（载入存档、装模组、配 `cluster_token`），**不会把未连接粉饰成已连接**；「重新探测」按钮真实往返 IPC。DST 面板补齐状态 IPC 注入（此前恒为「未接线」），技术文案收敛为口语，技术细节与许可证结论收进折叠诊断。验证：探活单测 11/11（fetch 全注入零网络）、Electron UI E2E 1/1、`pnpm verify:gate` 5 过 / 0 跳过 / 0 待接线；未连接真实游戏。
- **全局游戏共玩壳层（T-M6-24）**：侧栏将星露谷、泰拉瑞亚、DST 与 Mod 管理归并到「游戏共玩」入口，并迁移旧路由；品牌区与桌宠舞台共享角色选择，顶栏游戏选择与自动驾驶启停共用实际运行状态，主脑显示当前绑定模型短名及缺 Key 回落入口。修正深浅主题语义文字/绿色 token，并加入最低 4.5:1 的对比度断言。验证：desktop-host 构建通过、Electron UI E2E 1/1、`pnpm verify:gate` 5 过 / 0 跳过 / 0 待接线；未连接真实游戏。
- **桌宠多显示器安全定位（T-M6-23）**：移植 dsh-pet MIT 多屏矩形区域几何；拖拽/甩抛按屏幕工作区夹紧整窗，记录真实 Electron `displayId`，启动时按该屏恢复，屏幕拔除后回落最近可用屏。新增几何边界单测和 Electron 重启恢复 E2E；未复制素材。验证：几何单测 5/5、desktop-host 构建通过、Electron E2E 1/1、`pnpm verify:gate` 5 过 / 0 跳过 / 0 待接线。

### Changed

- **英文产品名统一为 Whale Isle**：README/AGENTS/SPEC/PRODUCT-DESIGN 中的旧代号 `ai-vtuber-workbench` 与「AI VTuber Workbench」统一改为 **Whale Isle**（仓库 slug 为 `whale-isle`）；根包名改为 `whale-isle`，Terraria/DST 模组 author 元数据改为 Whale Isle，设计稿示例路径同步；`User-Agent` 改为 `Whale-Isle/1.0`，`APP_ID` 与 electron-builder appId 对齐为 `com.whaleisle.desktop`。**冻结存储键保留**：IndexedDB `ai-vtuber-director`、`whaleisle-` revision 前缀、`@workbench/*` 包作用域与路径字段不改，避免用户配置/协议身份漂移（已在代码注释说明）。
- **修复干净环境构建（GitHub CI 首跑发现）**：`apps/desktop-host` 的 `tsc -b` 只引用了 4 个包，而渲染层还从 `@workbench/local-store/dexie`、`@workbench/model-gateway/presets`、`@workbench/game-bridge-mcp/metrics` 等 **subpath** 导入；这些包未在项目引用中，干净 checkout（无 dist）时子路径类型不可解析。已补齐 11 个 project references，并为 `agent-harness / game-bridge-mcp / live-stream-hub / local-store / memory-graph / model-gateway / plugin-kit` 打开 `composite`；删除全部 dist + tsbuildinfo 后 `desktop-host build`、`verify:gate` 7 项、Electron E2E 6 项均通过。
- **服务商面板职责拆分（T-M6-26）**：`providers-panel.tsx` 从 **1779 行**降至 **921 行**容器，详情、模型列表、槽位/默认模型、侧栏、自定义+导入弹窗（合并）、公共 UI 拆入 `renderer/director/providers/`（另有 catalog 类型与纯函数模块；合计 8 个业务文件）；全部 state、Dexie 与 bridge 副作用仍由容器持有，40 种 `data-*` 选择器与重构前逐项一致。验证：typecheck、depcruise（379 模块 0 违规）、desktop-host build、Electron UI E2E 4/4。
- **本地门禁补齐依赖漏洞与 DST Lua 校验（T-M6-29 收尾）**：`pnpm verify:gate` 的 Gate 2 新增 `pnpm audit --audit-level high`（离线/超时 SKIP，CI 强制执行）与 `luac -p mods/dst-bridge/**/*.lua`（缺 luac 时 SKIP，CI 安装 lua5.4 强制）；本地门禁现为 **7 项检查**，本机实测 5 个 Lua 文件语法通过、audit 0 high/0 critical。C# 构建仍依赖 tModLoader 程序集，留真机环境执行。
- **依赖安全升级（T-M6-30）**：Electron **38.8.6 → 45.4.1**，清除全部 Electron / extract-zip 高危告警；45 取消 postinstall，改为首次 `require('electron')` 懒下载，Electron E2E 统一加 `--use-mock-keychain`（避免 macOS 新二进制的钥匙串授权框同步阻塞启动，CI 同样适用）。Zod **3.25.76 → 4.6.7** 全仓统一，移除 `zod-to-json-schema`，契约生成器改用原生 `z.toJSONSchema`（保留默认值/required 语义与 `additionalProperties:false`，剥离 `.int()` safe-int 与 `.uuid()` 冗余 pattern，二次生成幂等）。修复 Zod 4 语义差异：`z.record(enum)` → `z.partialRecord`（套餐仍可只绑定部分槽位）、`PauseConfig.default({})` → `.prefault({})`（嵌套默认仍生效）。`pnpm audit --audit-level high` 接入 CI 与新增 `pnpm audit:high`。验证：`pnpm verify:gate` 5 过 / 0 跳过、744 tests、分支 90.12%、py:check 37、Electron E2E 4/4；37 份 schema 语义零丢失，Pydantic 仅 3 处等价类名变化。残留：Electron 45 的 `safeStorage` 同步 API 已弃用（功能正常），待后续迁移 async 版。
- **服务商变体路由修复（T-M6-32，审计发现）**：`resolveEndpoint()` 原只按 Region+Plan 匹配，而 OpenCode Go/Console 的 OpenAI 与 Anthropic 变体共享这两个字段，导致永远命中首个 OpenAI 变体、UI 的「Anthropic」胶囊实际不生效。现按 `provider.protocol` 收窄候选并透传到网关请求 URL/请求头；供应商面板 `toConfig()` 把选中变体协议写入契约字段；App 冷启动同时还原变体 Region/Plan（修复同协议不同胶囊的供应商冷启动退回默认项）。验证：model-gateway 70/70（变体矩阵 + `x-api-key` 断言）、depcruise 0 违规、typecheck 通过。
- **修两游戏适配器在打包产物里被 tree-shaking 掉（M7 遗留，随 T-M6-25 连接引导暴露）**：`packages/game-bridge-mcp/package.json` 标注的 `sideEffects: false` 让 esbuild 把 index.ts 中「靠副作用导入自注册」的泰拉瑞亚 / DST 适配器整包裁掉，真机表现为「未注册的游戏适配器：dst（已注册：stardew）」——两游戏在打包版里既无法驾驶也拿不到状态。已改为 `sideEffects: true` 并在包内写明原因；本仓开发态（未打包、走 dist 直连）不受影响，所以此前一直未暴露。
- **多游戏自驾宿主热切换与打包收口（T-M7-03 补充，2026-11-22）**：每轮聊天读取当前角色提示和游戏名，雷区路径调用 `persona-brain` 反射钩子，`say()` 返回剥离 `<think>` 后的可见文本；各 `GameAdapter` 可提供专属规则规划器/攻略主题，切换时等待旧 runner 与在途动作闭合后重建规划器并更新记忆日键。攻略和 persona fixture 加入安装包；将由 esbuild 打入渲染产物的纯前端依赖移入 `devDependencies`。macOS arm64 DMG 从 303,129,628 bytes 降至 297,394,499 bytes（约 −1.89%）；`pnpm verify:gate` 5 过 / 0 跳过 / 0 待接线，分支覆盖率 90.14%。真实三游戏热切换仍待 `[REAL-DEVICE]` 验收；本机没有 Developer ID，构建跳过代码签名。
- **独立安装包首次落地并真机安装（T-M6-05，2026-11-22 用户指令「把最新安装包打包安装」）**：`apps/desktop-host/package.json` 接入 electron-builder 26.18（macOS dmg arm64 + Win nsis x64 配置、`pnpm package` 脚本、`asar:true`、`npmRebuild:false`）；最新代码（含 M7 两游戏）打出 `release/鲸屿 Whale Isle-0.1.0-arm64.dmg`（289MB），装入 `/Applications/鲸屿 Whale Isle.app`（513MB）并启动成功（进程树 + WebUI 18780 token 401 实证）。本地无 Developer ID 签名，安装后须 `xattr -dr com.apple.quarantine`；体积超出原 <200MB 目标、首启向导未做，如实记录。
- **M7 多游戏扩展合流完成：AI 全自动玩泰拉瑞亚 + 饥荒 DST（2026-11-22）**：
  - **共享地基**：`shared-protocol` 12 域桥接契约（通用请求/受理/四态回执/轮询/探活 + Terraria/DST 快照·回执·配置 + 两个新规划槽）；`game-bridge-mcp` 的 `GameAdapter` seam（星露谷原样包装、双泳道 adapter 自注册）；宿主按 `gameId` 选择 adapter/角色槽位/聊天指令档案/记忆日键；中控台三游戏导航与独立面板。
  - **泰拉瑞亚泳道**：`terraria-simulator`（5 剧本 + 11 it）、`terraria-adapter`（17 it + 零 token 规则兜底）、`mods/terraria-bridge/`（C# tML：HttpListener 18090 / 帧级 SetControls / NavLite 物理预测寻路 / 生存反射 / F8 接管 / 思考冻结）、`terraria-panel.tsx`、`REFERENCE-terrariablind.md`。
  - **饥荒 DST 泳道**：`dst-simulator`（5 剧本 + 9 it）、`dst-adapter`（11 it）、`mods/dst-bridge/`（Lua 服务器侧权威 + Klei 653007 localhost QueryServer tick + unsafedata 降级）、`services/dst-bridge-sidecar/`（双面 HTTP 18100 + 本地专用服 stdin 托管 + token 校验，含 10 it）、`dst-panel.tsx`、`REFERENCE-dst-ai-companion.md`。
  - **门禁与诚实口径**：`pnpm verify:gate` 5 过 / 0 跳过（699 tests，分支 90.13%）；sidecar spec 纳入根 vitest 与 tsc project、补 6 类分支收口测试；修复 4 处既有计时抖动（harness 150ms 握手、autodrive 60ms、E2E 10s 冷启动、仿真器在飞窗口）。**C# 模组已用 GitHub Release tML v2026.09.3.1 程序集编译通过并打包成 .tmod 落入 Mods 目录、Lua 5.5.1 `luac -p` 语法已过、DST 专用服已装 + sidecar 三端点冒烟通过；两游戏仍无真机证据**（tML 加载 / DST cluster_token 配本地服由人类验收，见 VERIFY 右栏）；沙盒证据全部标注 `[SIMULATION]`。许可证：MIT 蓝本仅思想吸收未复制源码，GPL/无许可证项目红线登记见 THIRD_PARTY_NOTICES。
- **T-M7-02 GameAdapter 多游戏 seam（2026-11-22，M7 共享地基）**：`packages/game-bridge-mcp/src/adapter.ts` 新增 `GameAdapter` 接口 + `GameAdapterRegistry`（默认注册星露谷工厂）+ `StardewAdapter`（原样包装 `BwfMcpClient`，真机链路行为零变化）；`AutodriveRunner` 第三参数可注入 adapter，ping / 不可达提示 / get_state 解析 / 卡死时钟 / 长动作超时 / 回执分类全部走钩子（默认仍为星露谷原逻辑，`BWF MCP 不可达（18080）` 文案与 78 工具白名单不动）；`ActionLock` 传输改结构化 `GameBridgeTransport`，超时表与 `cancel_action` 工具名可注入；`mcp-client.ts` 零改动。门禁：星露谷 106 项现有 spec 全量回归通过 + adapter 6 项新测（**假新游戏 adapter 驱动同一 runner** 实证：JSON 状态经 parseState 进入事件流、classifyReceipt 与 ping/不可达提示全部走钩子、JSON 时钟也能刷新卡死哨兵），全量 629 tests、adapter.ts 覆盖率 lines 96.66% / branches 100% / functions 90.9% / statements 100%。
- **M7 多游戏扩展立项：AI 全自动玩泰拉瑞亚 + 饥荒 DST（2026-11-22 用户指令；T-M7-01 契约先行已落地）**：
  - **可行性结论（双网络调研代理，许可证逐仓打开 LICENSE 核实）**：两款均可行且各有 MIT 全链路先例——泰拉瑞亚 = `Reisenbug/TerraBlind`（模组内 HTTP + 动作回执三段式 accepted→status→outcome + 世界事实终止判据 + SurvivalReflex 生存反射 + receding-horizon 物理预测寻路；B 站大师模式 Boss 无伤演示，实现开源）；饥荒 DST = `fruitstarzero/Don-t-Starve-Together-AI-Companion`（服务器侧权威 mod + 本机 Node HTTP 桥 + 2s QueryServer tick 全链路），IPC 只押 Klei 官方 653007 通道（`TheSim:QueryServer` 允许 localhost、`io.open` 允许写 `unsafedata/*.json`、专用服 `-allow_ioopenwrite_sandbox_escape`；2025-01 的 651414 曾收紧沙盒，勿用 io 直写/第三方 URL）。GPL 红线核实：TShock/TSAPI/HEROsMod/TerraNoneBridge/dst-admin-go 一行不进仓；无许可证项目（Journey-Together/Insight(RecEx)/ActionQueue/TCR/DontStarveAI 等）仅参考思想。
  - **T-M7-01 落地**：shared-protocol 新增 12 域——通用 `GameBridgeReceiptStatus/ActionRequest/ActionAccepted/Receipt/ActionStatus/Health`（统一桥接协议：每游戏模组内 HTTP，`GET /state · POST /act · GET /action_status · POST /cancel · GET /health`；星露谷 BWF 18080 原样不动，**18760 中心 WS 网关设计稿正式搁置**）+ `TerrariaStateSnapshot/ActionReceipt/BridgeConfig`（tML 模组 18090）+ `DstStateSnapshot/ActionReceipt/BridgeConfig`（sidecar 18100）+ `WorkbenchRoleSlot` 增 `TERRARIA_GAME_PLANNER`/`DST_GAME_PLANNER`（director 槽位默认表同步补键）；`pnpm gen:contracts` 50 契约 0 冲突、`pnpm py:check` 全绿（ruff / mypy --strict / 37 pytest）、契约单测 27 过（gameId 字面量互斥、非法 season/TIMEOUT 态拒绝、接管语义快照）。M7 双泳道治理（每泳道各一激活工单）已写入 ROADMAP 头部铁律。
- **TypeSafe Jev（jevmodel.org）接入（2026-11-22 用户指令「看下这个网站的 jev 怎么接入」+ 示例 key/请求体）**：
  - **API 实证**（真实 key 全量探针）：`POST https://jevmodel.org/v1/systemone`，认证 `Bearer`；请求 `{state, model, questions: {id: {type: choice|noul|score, instructions, criteria}}}`（criteria 对象=标签→描述、数组=有序刻度）；**响应** `{model: "jev-1.14.0", answers: {id: {choice/noul/score, probabilities, confidence, legend}}, usage: {input_tokens, output_tokens}}`——choice 返回具名答案+全分布、noul 直接给 true 概率、score 给浮点刻度+图例；定价：登录送 10 万输入 token、¥49 起 1500 万永不过期、成功按输入 token 扣费输出免费（重试建议带 Idempotency-Key）。
  - **落地**：新增 `typesafe-jev` 服务商预设（jev-latest/jev-1.14.0/jev-1.13.0，全决策协议 `toolCalling=false`）；**System One 端点注册表化**（jevmodel.org 官方直连 + OpenCode Console 中继双路由），探针请求体升级为 TypeSafe 规范形状（type/instructions/criteria）；**纯决策服务商的「保存并检测」自动改走原生决策探针**（不再误报「没有 chat 模型」）；官方 1024px 标志入库（jevmodel.org favicon 声明位）；获取 Key ↗ 直达 `/zh/dashboard/`（白名单加 jevmodel.org）；模型全标「决策 S1」、不进聊天槽位下拉。
  - **真机验证（用户提供示例 key）**：四题示例一次拿到全部响应形状（choice「技术」confidence 1 + noul 0.96 + score 0.97 带 legend + usage 609/88）；UI 端到端——粘贴 Key →「保存并检测」**已连接（决策探针 jev-latest）· 1357ms**；行测 `jev-latest ✓ 1422ms / jev-1.13.0 ✓ 1530ms / jev-1.14.0 ✗ HTTP 402`（该 key 免费档覆盖 latest 与 1.13，最新版 1.14 需付费，如实显示）。CDP 回归 **31/31**（含 TS-Jev 渲染/无 key 行测如实报错）。
- **默认模型自动挑选 + jev 能力落位 + 查余额（2026-11-22 用户指令三件套）**：
  - **自动挑选**：逐模型测试结果**持久化**（`override.tested`，刷新/换服务商不丢），槽位下拉新增「**自动挑选**」选项 + 默认模型页「**一键智能分配**」；评分=延迟打底 + 推理 +500（主脑/规划器）+ 免费 +300 + **弹幕快反槽 `typesafe/jev-router` +1000**（TypeSafe Jev 决策路由的本职，jev 能力落位）+ 视觉槽硬性 vision + 决策协议（jev-1.13 系）不进聊天槽；批量测试完成/应用挂载时自动重解析；**空池不破坏既有绑定**只提示；auto 标记存独立 Dexie 键（`slotAutoFlags`），主进程与 App 启动路径零改动（永远只见具体绑定）。
  - **查余额（Magpie keybalance 思想）**：`providers:check-balance` 主进程持 Key 请求各厂商**公开余额 API**（真实 key 探明 schema）：OpenRouter `$1.00 剩余 / 上限 $1.00（周限额）`、DeepSeek `CNY 76.62`、OpenCode Go `配额：5h 窗已用 56% · 本周 68% · 本月 34%（带重置时刻）`、SiliconFlow user/info；「查余额」按钮 + 余额胶囊持久化（`override.balance`）；OpenAI/Anthropic/MiniMax/火山方舟无公开余额 API 如实提示。**坑位**：余额响应必须先 `JSON.parse` 完整再截断展示——截断后 parse 会把大响应变 null（OpenRouter /key 实测踩过）。
  - **一致性修复**：`commitProvider` 展开基准改 `overridesRef.current`——逐模型测试 `persistTested` 高频写 overrides，用渲染闭包里的旧态展开会互相冲掉；测试写入不打 `brainApplyConfig`（58 个模型批量也零主进程噪音）。
  - **验收**：CDP **29/29**（测试结果跨刷新持久 ✓、空池自动分配保留默认绑定 ✓、决策 jev-1.13 排除/聊天 jev-router 可选 ✓、假 key 余额查询如实 401 ✓、旧批全保）；**真实 key 正路径全过**——jev-router 行测 5649ms ✓ → 主脑「自动挑选 → jev-router」落地 → DeepSeek ¥76.62 余额胶囊显示；全仓 502/502 + typecheck/depcruise 全绿。jev 原生 System One 决策适配已立项 **T-M6-14**（弹幕快反打分/自驾归因等判断点从 chat 切到原生 choice/noul，设计先行待用户确认判断点清单）。
- **OpenRouter 上架 Jev：`typesafe/jev-router` 入预设（2026-11-22 用户指令「jev 模型用 openrouter 试一下」）**：OpenRouter 目录 476 个模型中 TypeSafe 系仅此一个——Jev Router（跑在 Jev System One 上的路由模型，聊天形态暴露、1M 上下文、动态计费无免费版；原生 jev-latest 未以独立聊天模型上架）。**用户真实 key 实测三连绿**：直接探针 1820ms ✓、「保存并检测」首选 jev-router 通过（1434ms，442 模型拉齐）✓、行内测试点 ✓ 1112ms——**无需等 System One 适配即可把槽位绑到 `openrouter/typesafe/jev-router`**；顺带证实用户 OpenRouter 账户有余额、第一轮报错确系旧代码失效预设 ID 的 404（已修）。预设置顶 + 推理/视觉标记 + spec 同步（23/23）。
- **模型逐个测试 + 一键批量测试（2026-11-22 用户指令，Magpie「Test models」交互）**：模型列表每行新增「测试」按钮与行内状态点（`✓ 延迟ms` / `✗ HTTP 码`，悬浮看错误原文）；头部「测试模型」按钮**4 并发**批量测当前服务商全部**开启**的模型，进度实时显示（`停止 done/total` 再点即停）、>50 个先确认防误点大清单；**决策协议模型（jev 系）自动改走 System One 探针**（`/inference/systemone/v1/systemone` 最小 noul 问题，请求体形状经无 key schema 校验实证）而不是必失败的 /chat/completions；顺手修真 bug：**本地引擎（Ollama 等 loopback）免 Key 测试**——原 vault 对无 key 服务商一律报「尚未保存 API Key」，Ollama 模型测试从未可用，现 loopback 端点跳过凭据要求。真实 key 复验（vault 拷贝隔离实例）：jev-1.13-free 探针 **422 upstream 不可用**（与免费 chat 同被锁第三方客户端）、jev-1.13 **402 可充值解锁**、opencode-go `hy4-flash-free` **1688ms 再次回话成功**（用户唯一免费口子坐实）。CDP 回归 **27/27**（单模型测试→✗HTTP 401 行状态、批量 3/3 状态齐全+按钮恢复、本地免 Key 路径错误为连接层而非 key 层、旧批 23 项全保）+ 全仓 502/502 + depcruise 全绿。**排序补充（同日用户指令「开启的模型放在最前面」）**：模型列表开启项排最前、停用项沉底（组内保持原相对顺序，与侧栏「已关闭」沉降同哲学），CDP 33/33（停用沉底/恢复回前排实证）。
- **供应商页 v5.5：Magpie 交互 + 官方图标 + OpenCode Console/原 Zen（2026-11-22 用户指令）**：
  - **OpenCode Zen 实证落地**（调研发现 **Zen 已更名 OpenCode Console**，旧 `/inference/zen/*` 全 404）：新增 `opencode-zen` 预设（OpenAI `/inference/openai/v1` + Anthropic `/inference/anthropic/v1` 双变体、PAY_AS_YOU_GO）；模型发现走协议无关根 `/inference/v1/models`（105 模型，免费档 12 个含决策模型 **`jev-1.13-free`**/付费 `jev-1.13`）；`provider-vault` 端点分流重构——**会话头只对 Go 路径（`/inference/go`）生效**（原 `isOpenCodeUrl` 会误给 Console 加 `x-opencode-session`）；jev 系标 `toolCalling=false` + 面板「决策 S1」能力位，**不进聊天槽位下拉、无「设为主脑」**（System One 决策协议不吃 /chat/completions，待专用适配工单接弹幕快反决策槽），测试模型自动避开 decision 类；备注如实告知「免费档 chat 官方仅保证 OpenCode 客户端内可用，第三方可能 403（FreeUsageLimitError 原文显示）」。
  - **官方图标**（用户指令：网上搜集、禁止生成/随便用）：9 家 logo 从各家官网 favicon 与 GitHub 官方组织头像收集（`file` 校验真实图像、76KB，`assets/brand/providers/` 随构建拷贝）——OpenRouter/DeepSeek/SiliconFlow/OpenAI/Anthropic/MiniMax/火山方舟/OpenCode/Ollama；OpenAI favicon 的 `prefers-color-scheme` 固定为白底黑标（跟 OS 走会隐身）；GPT-SoVITS 无商标级官方标识，保留 lucide 图标不硬凑；台账登记商标指称性使用。渲染 logo 优先、lucide 兜底、白底小卡深浅主题可读。
  - **Magpie 交互采纳**（调研源码逐行实证）：①「获取 Key ↗」直达各厂商控制台——`providers:open-external` IPC，主进程 https+主机白名单校验后 `shell.openExternal`（防渲染层被攻破后钓鱼）；②智能粘贴——自定义对话框 Base URL 支持粘 `curl`/`export OPENAI_BASE_URL|ANTHROPIC_BASE_URL`/带端点后缀裸 URL 自动填 URL+协议+isFullUrl，Key 输入自动剥 `Bearer ` 前缀；③「已关闭」折叠子区——停用服务商沉底不与启用项混排；④详情副行 `host · N 模型 · 状态`。
  - **顺手修真 bug**：`syncBrain` 失败分支也会异步覆盖「保存并检测」结果条（真机实证：多内置商缺 Key 时红色「主脑回落规则」盖掉检测结果）→ 成功/失败都改 toast；坑位实录：**desktop-host 渲染层解析 `@workbench/model-gateway/presets` 走包的 dist 构建产物**，改 presets 后必须 `pnpm --filter model-gateway build` 再重建 desktop-host，否则新预设静默缺席。
  - **验收**：单测 model-gateway 57/57（+zen 预设/端点/决策位断言）+ 全仓 502/502（排除并行会话在制 T-M6-12 包）；真机 CDP **20/20**：logo 10/10 实际加载、zen 面板（名称/副行/备注/获取 Key/大图 logo）、jev 决策 S1 位 + 无设为主脑 + 不进槽位下拉、假 Key 三态不被热更新覆盖、已关闭折叠区往返、外链白名单拒绝路径、curl/环境变量智能粘贴、全开全关/搜索/刷新持久。**待人类**：zen 粘真实 `oc_sk_` key 实测免费档是否放行第三方客户端（403 时会如实显示）、jev System One 适配工单排期。
- **品牌升级：鲸屿 / Whale Isle（2026-11-22 用户指令）**：
  - **命名与图标**：应用名定为「鲸屿」——鲸是桌面上陪你玩的小鲸，屿是承载她的桌面小岛；英文名 `Whale Isle`，标语「一座住在桌面上的鲸屿」。新图标为深空 squircle 上的蓝鲸侧身像（女仆扇贝头带 + 蝴蝶结 + 水花 + 星海底座），母版 SVG 导出 `icon.icns` / `icon.ico` / 16–1024 PNG 全套；`whale-isle-mark.svg` 与中控台/ WebUI 复用同一尾鳍 + 头带视觉语言。
  - **品牌单点事实源**：新增 `src/shared/brand.ts`（`APP_NAME/APP_NAME_EN/APP_TAGLINE/APP_DATA_DIR/BRAND_ASSETS`）；主进程窗口标题、About 面板、Dock 图标、中控台侧栏、`director/index.html` 标题/favicon、WebUI 标题与内联 logo、`package.json productName`、README 全部改为鲸屿，构建时 `assets/brand → dist/renderer/brand` 随包分发。
  - **数据与凭据迁移**：userData 从通用 `Electron` 一次性「薄迁移」到 `Whale Isle`（只拷 provider-vault / meter / memory / stardew-mods / IndexedDB / Local Storage，不覆盖已有文件、不动 `e2e-profile`，marker 幂等）；真实 key 在新目录用同一 Electron safeStorage 解密成功，Brain 启动无报错。
  - **macOS safeStorage 坑（实测）**：Keychain 服务名是「`<app name> Safe Storage`」，`app.setName('鲸屿')` 后旧密文**无法解密**；因此开发态 macOS 保留 `Electron` 作为 Keychain 身份（菜单栏 dev 仍显示 Electron），窗口/侧栏/Dock/About 显式用鲸屿；打包后 `productName` 为鲸屿，Keychain 自然切换。另为解密失败加 fail-closed try/catch（UI 显示未配置、绝不崩主进程或回落明文）。
  - **验收**：CDP 断言 `title=鲸屿 · 中控台`、侧栏 `鲸屿` + tagline tooltip + favicon 路径；WebUI `鲸屿 WebUI · 远程中控` + logo；`pnpm verify:gate` 5 过 / 0 跳过。
- **设计稿 v3「曜石」（apple-ui-design 三原则：Clarity/Deference/Depth）**：iOS 系统色板（#0A84FF 主 accent + 系统语义色）、true-black 分层底（避开死黑）、**光影七层系统**（ambient 环境光斑慢漂移 / 玻璃卡 blur30+内高光 / 发丝分隔线 / 双层柔影 / Sheen 文本光泽 / 状态光晕）、SF Pro+PingFang 节奏、pill 按钮（980px）+ hover scale 1.02、连续曲率圆角 8/12/16/20；tokens 变量名保持兼容（全部页面自动继承质感），shell-chat 全面精修、其余 6 页注入 ambient 光影层；深浅双主题（#f5f5f7 Apple 浅灰对等实现）。功能结构沿 v2 已确认的 7 页（Shell+聊天/Harness/插件管理/星露谷/供应商/桌宠/OBS），插件化信息架构保证新功能融洽插入。
- **设计稿 v2 重做（ui-ux-pro-max 工作流，决策 D4/D9/D10）**：`design/` 全套升级——设计系统由 skill 数据库生成（Modern Dark 开发者工具风格、密度 8/10、Expo.out/spring 动效规格）；run-green 主操作色（#22C55E，"code dark + run green"）替代蓝紫 AI 味（v3 中绿转为纯运行/成功语义色）；lucide SVG 全量替换 emoji（本地 vendor/lucide.min.js，UI 零 emoji）；深/浅双主题完整 token（shell.js 持久切换）；7 页结构确立并经 Chrome headless 深浅双主题截图验证。
- **产品功能设计 v2（定位升级）**：[docs/PRODUCT-DESIGN.md](docs/PRODUCT-DESIGN.md) 重写——从「Whale Isle 工作台」升级为**通用个人 AI 工作台**（用户决策 D6~D10）：桌宠/直播/星露谷等全部收编为**可开关插件**；插件系统对齐 dsh（Cordis 插件树/defineTool/三层约定）+ 兼容层规划；新增 **ACP Harness 层**（参考 pingdotgg/t3code，MIT 68.5k★，已克隆分析：providers-acp/线程/远程审批，`dsh --profile acp` 直连）；技术栈选型（React 19 + Tailwind v4 + zustand + motion + **lucide-react 图标** + Electron + WebUI 双形态 + Vite 评估）；主题系统（深/浅/跟随+主题色）；ROADMAP 新增 M6 批次 4 工单（Shell+插件内核 / ACP Harness / dsh 兼容层 / WebUI），原 T-M5-03 并入 T-M6-01、T-M5-07 并入 T-M6-02。

### Changed

- **默认启用 LLM 大脑（用户指令）**：`autodrive-host` 的 `brainMode` 默认 `'llm'` 且 `runner` 初始 planner 直接注入 `LlmPlanner`（DeepSeek key 就绪即用）；key 未配置时自动回落规则日程并在顶栏显示。真机验证：启动即 `{"mode":"llm","llmReady":true}`、顶栏按钮「LLM 大脑」、决策流 `planner=llm-xiaojing`；规则日程仍可一键切回。

### Fixed

- **背包满就整理、没箱子就造（T-M6-10 第三批真机，用户指令「别让我介入」）**：真机聊天「钓你个头，背包满了，先造箱子把用不上的放进箱子」却仍被下发 `tidy_backpack` 并继续钓鱼。修复五处闭环：① 聊天关键词把「造/做/合成 + 箱」提到泛化「背包满→tidy」之前，真机事件流 `decision planner=remote craft`（`chat_order craft`）；② LLM 工具参数归一化——`item: ["湿透的报纸"]` / JSON 字符串 / `{name}` 对象统一压成标量，避免网关校验失败；③ `hasChestItem` 认中文「**宝箱**」（此前只认「箱子/Chest」，包里有箱仍判「没箱子」去砍树）；④ 包里有箱时不再攒木，先摆箱：允许 0 空位摆放（摆下即腾一格），不在农场先 `travel_to Farm`，摆完 `chestPlaced` 置位；⑤ 无箱攒木改走文字地图 `findNearestTree → use_tool {tool:'axe',x,y,times:10}` 定向砍树，并修正「行首数字是绝对 y、不能再加 origin.y」的换算 bug（对照真机树坐标 (74,9) 实证）；`clear_area` 回执「没有可以清理」时农场改道森林只试一次，森林也空才放弃，不再 33 次空转。真机验证：`place_item 宝箱 (70,15)` → COMPLETED，`tidy_backpack purpose=fish` → COMPLETED（存 22 件、空位 1→23，如实提示工具已存入箱子）。验证：llm-planner 75/75、planner-rescue 12/12、全仓 791 tests 通过、分支 90.28%。**限制**：本轮 mock keychain 重启后 vault 无法解密，LLM 大脑真机路径未复跑，需正常钥匙串或重新粘贴 Key。
- **中文界面与人话回执（2026-11-23 用户反馈）**：① 回执不再显示原始 JSON——BWF 会把它收到的参数原样回显，`失败：背包里没有“["\u6E7F\u900F\u7684\u62A5\u7EB8"]”` 现在清洗为「背包里没有“湿透的报纸”」；数组/对象 map 均转成「a、b、c」，非法 JSON 保持原样不猜。② 英文工具名补中文、英文留在括号里：`先 craft Chest（50 木材）` → `先制作宝箱（craft Chest）（50 木材）`，`place_item` → `摆放物品（place_item）`（幂等，不套娃）。③ 参数键对齐 BWF schema：LLM 发 `{"items":[...]}` / `{"items":{"湿透的报纸":1}}` 给 `ship_items` 时自动收窄成 `item: "湿透的报纸"`，`craft` 的 `item` 归一为 `recipe`，`take_items` 数组合并为逗号串——从源头避免 BWF 回显整段 JSON。④ 中控台当前动作/回执时间线/聊天事件流显示中文工具名与中文状态（`FAILED` → `失败`），未知工具原样显示。⑤ 规划器提示词要求 `intent` 用中文，工具/配方英文名放括号。验证：adapter 12/12、llm-planner 77/77、全仓 798 tests、分支 90.09%。**未覆盖**：LLM 真实输出仍需钥匙串恢复后复验；OBS `/obs` 挂件仍显示英文工具名（只读技术图层）。
- **满包无箱子死循环（T-M6-10 真机 2026-11-23）**：真实存档春21 08:30、背包空位 0、全是【留着】收集包材料、农场无箱子时，规则模式反复执行 `tidy_backpack` 并 15 次 FAILED，游戏时间冻结（BWF `McpFreezeTime`）形成空转。修复：`Planner.observeReceipt` 回执反馈 + `RulePlanner` 有界救援阶梯（可出货→`donate_bundles`→有箱才 tidy 且只试一次→`wait` 求助，绝不重复同一工具）；`wait` 相同原因只发一次 watchdog/cycle-end。真机新增高价值出路：识别「背包扩到 N 格：Ng」与 `[BuyBackpack]` 坐标，钱够时自动去皮埃尔 `interact` 并 `dialogue choice 0` 购买（真机实测 12→24 格、2890→890g），扩容后自驾恢复 `travel_to COMPLETED → fish`、时钟 09:00→10:10、watchdog 0。验证：planner-rescue 8/8、autodrive 55/55。**第二批真机**又抓到 `AutoDriveRunner.start()` 并发重入导致双循环共用 ActionLock（fish 互斥 ERROR 33 条），已加重入锁并复验：扩容后 travel_to/fish/ship_items 全 COMPLETED、0 ERROR / 0 watchdog，19:00 睡觉→春22 06:00 换日→出货→钓鱼持续正常。**注意**：本轮用 `--use-mock-keychain` 启动，`brainMode=rule`，LLM 大脑路径未真机覆盖。
- **全功能真机回归修复（2026-11-22，用户指令「把所有功能都测试一遍」）**：
  - **浅色主题 legacy 面板黑块**：供应商/Harness/动作库仍在用 `bg-slate-900` 等深色写死类 → 浅色下把 `--color-slate-*` 色阶整体翻转（截图复验白卡）。
  - **饭碗/记忆 badge 不刷新**：回执扣米与换日日记不是推送式 → 15s 轮询 `rice:status`/`memory:stats`。
  - **`get_state` 省略背包段被误判**：BWF 对未变化段落会省略，`freeSlots` 回落 12 导致「满包」被当成「有空位」→ 双规划器记住上次解析值。
  - **贵重物拒扔导致救援卡死**：BWF 拒绝扔能卖 300g 的家具并建议扔鱼饵 → 记录 `rejectedTrash` 并新增鱼饵/种子兜底阶梯；等待态不再抢先触发。
  - **外部启动自驾按钮不刷新**：事件流收到 state/decision/receipt 即置 running。
  - **聊天 Markdown 行距过大**：气泡容器 `white-space: pre-wrap` 与列表块叠加 → 移除。
  - 记忆页 `lastDay` 回落最新日记、窄窗口统计条/按钮溢出、图谱 zoomToFit；桌宠舞台空状态改为「等待游戏状态…」。

- **工作台 UI v4「曜石 · 演进版」还原（用户指令：按最新设计稿更新，优先开源库）**：
  - **设计系统**：`design-tokens.css` 与 `design/tokens.css` 逐行同步（v4 深浅色板/玻璃卡/seg-tabs/switch/range/动效）；移除全局 `*` 重置（unlayered CSS 会压过 Tailwind utilities，导致全站 padding 失效的坑已修）。
  - **Shell**：244px 分组插件侧栏（交互中枢/声形与舞台/游戏与直播/平台与底层，动态 badge 与自动驾驶运行点）+ 顶栏面包屑/⌘K 搜索/语音/大脑/自驾/主题切换 + 饭碗 footer（进度条+投喂 5k）+ 聊天页 304px 右栏（get_state/动作时间线/快捷 P0/记忆与攻略上下文）。
  - **开源库优先**：`cmdk` 1.1（⌘K 命令面板，Radix Dialog 随包）、`sonner` 2.0（toast）、`react-markdown` 10 + `remark-gfm` 4（聊天 Markdown）、`react-force-graph-2d` 1.29（记忆力导向图谱）——不再手写命令面板/键盘导航/解析器/力导向布局。
  - **新页面**：**记忆图谱与日记**（真实 `memory:graph`/`memory:pin` IPC：92 节点/202 边/日记全文/检索命中高亮/钉住/隐私擦除）、**OBS 透明挂件**（5 图层开关 + 520px 棋盘格预演 + 真实饭碗/气泡 + STAGE_PROTOCOL 接线中标注）、**插件与权限策略**（9 插件热开关即时过滤侧栏、Policy 单咽喉与六大扩展点只读表）；`voice` 合并音色库+声音工坊（seg-tabs）、`pet` 合并透明舞台+动作库（真实 manifest 待机视频/双轨气泡/语音设置/今日目标）、星露谷三栏、聊天 Markdown+slash 浮层。全站移除彩色 emoji。
  - **契约**：新增 `MemoryNodeView/MemoryEdgeView/MemoryGraphView`（36 域跨语言重生成）。窗口默认 1360×860（min 1120×700）以承载 v4 三栏。
- **契约/后端补记**（并行批遗留）：`MemoryGraphView` 只读快照 + `memory:pin`；`autodrive-host` 暴露 `say/subscribe/getBrainMode` 供 WebUI 复用。

- **T-M5-18 背包容量自愈（用户指令「现在好像处理不了背包满了」）**：研读 BWF `GameActions.Tidy.cs`（tidy/store 依赖农场箱子，无箱必失败）与 feiyuos-stardew-ai-farmer `LESSONS.md`（满包 craft 会掉地上、任务物品绝对保留、白名单卖货）后重写救援策略——**确定性救援阶梯**：tidy（purpose 按时段）→ ship_items（排除法 + 值钱线索排序，工具/种子/肥料/鱼饵/炸弹/花束/吊坠/家具/【留着】任务物品不卖）→ eat（跳过任务鱼）→ trash（真垃圾）→ store → 任意非必需品；失败才降级，腾出空位即归零，全失败退化为 wait 不空转；被 BWF 拒绝的单品（家具/任务鱼/名字带 xN）自动记住换下一个。真机三段实证：`tidy FAILED(无箱子)` → `ship_items 沙丁鱼 COMPLETED 180g` → `travel_to Beach` → `fish`；另修复 `cleanItemName`（去 `xN`/品质词）与 RulePlanner 满包直接出货。
- **T-M6-06 星露谷 Mod 管理（用户指令「我还希望能管理星露谷的 mod」）**：契约新增 5 域（StardewModInfo/Snapshot/ToggleRequest/OpResult/Config → 33 域跨语言重生成）+ `packages/stardew-mods`（SMAPI manifest 注释/尾逗号容错、损坏 manifest 可见、目录扫描、`.disabled` 启停、解压目录安装重名 -2、三平台 Mods 路径猜测；48 it，分支 95.9%）+ 主进程 `mods-host`（配置落 userData、系统解压 zip 安装、打开目录）+ Shell 新增「Mod 管理」页（目录候选切换/列表开关/安装 ZIP/刷新）。真机：自动探测 Steam Mods 目录并列出 3 个真实 Mod（含 BWF 1.1.27），SaveBackup 启停往返成功。
- **对话控 AI（中文自然语言指令）**：Shell 聊天里直接说「先去海滩钓鱼吧」「先把多余的东西放到出货箱」即可插队——关键词直译（去海滩/农场/镇上/矿洞、钓鱼、整理背包、睡觉、浇水）优先，未命中再走 LLM 指令解析（白名单校验）；插队决策事件标记 `planner=remote`（中控台显示 P0 插队）。真机验证：关键词 → `decision remote travel_to 主人指令：去海滩`。

- **三票并行批 ✅（用户指令「分三个子 agent 一起做」，2026-11-22）**：
  - **T-M5-05 弹幕注意力中枢 `packages/live-stream-hub`**（dsh-livestream 思想重写，零依赖）：三级注意力调度（按**说话人数** 7/8/29/30 分档，τ 90/40/20s e^(-age/τ) 衰减，档位名额 4/2/1，刷屏单人不升档）+ 同观众 15s 合并（≤5 段）/礼物 3s 连击/进场 2.5s 聚拢（>20 人折叠）+ 300s 超龄清理/512 队列上限；防封护栏（block→频控 20 条/分→mask→warn 四级，UTF-16 安全截断 200 + 孤立代理对清洗）；事件中枢（契约 safeParse→护栏→4000 LRU 去重→150ms 批次 flush→订阅多播，单订阅者异常隔离）。**46 it 全绿（分支 92.5%）**；风暴集成复核：5 观众 100 条/秒不升档、频控丢 200 条、平台违禁 3/3 拦截、30 位说话人→busy、同 eventId 去重。
  - **T-M6-03 dsh 插件兼容层 `packages/plugin-kit`**（Cordis 语义，本包四维 100%）：manifest Zod Schema（7 扩展点/permissions/dshCompatible）、`defineTool`（zod 入参校验 + `{ok:false}` 异常包装）、`ToolRegistry`（重名拒绝/按插件批量注销）、事件总线（`domain:*` 通配/once/监听隔离）、`PluginHost`（register 即启用、父子树 disable 级联、LIFO 副作用回收、setup 崩溃回滚+errors 记账）、`adaptDshPlugin`（结构化最小面，未声明 schema 的外来工具默认 ask 审批）。**33 it 全绿**。
  - **T-M6-04 WebUI 形态（`webui-server` + `src/webui`）**：仅回环 `127.0.0.1:18780`、启动生成 device token（`?token=`/Bearer 双校验，无 token 401）、`/api/state`（运行态/大脑/记忆/语音 + 总线事件）、`/api/command`（复用 Shell 同款小鲸回话：人设+记忆+雷区反射+发声）、`/api/approve`（远程 ACP 审批直连 `resolvePermission`）、`/ws` 事件推送、`/renderer/*` 静态资源（路径穿越防护）；`WebUIClient` 指数退避自动重连。**62 it 全绿（本目录四维 100%）**；真机 curl/WS/指令/审批全通。`ws` 用 `createRequire` 延迟加载，避免 esbuild ESM 打包 `require('events')` 崩主进程。
- **真机自驾护栏（2026-11-22 真机抓到死循环后修复）**：`parseGameState` 新增 `背包空位` 解析；Rule/Llm 双规划器空位 0 → 确定性 `tidy_backpack`（不烧 token）；整理连续失败 → `ship_items`（从背包段解析可出货物品，跳过工具与「留着」任务物品）/无物可出 → `store_items`；同工具连续两次失败 → 换规则日程。真机复验：`tidy_backpack FAILED`（农场无箱子）→ `ship_items COMPLETED 2 个 小嘴鲈鱼 ≈125g` → 恢复钓鱼，死循环消失。长动作表补 `travel_to/interact/give_gift/tidy_backpack/store_items`，消除 30s 假超时。
- **中控台聊天体验（codex 式）**：`chat_reply/reflex_spray` 从绿色「COMPLETED 回执卡」改为**左对齐头像对话泡**（雷区反射带「炸毛反射 · 0 token」标签）；主进程事件环形缓冲（≤200 + 单调 `seq`）+ `autodrive:status` 水合，**刷新中控台不再丢对话**（真机刷新后立即渲染 18 条历史）；`autodrive-host` 暴露 `say/subscribe/getBrainMode`，WebUI 复用同一总线。

- **设计稿 v3 差异补齐 + T-M5-04 ✅ 记忆图谱（接续完善）**：
  - **UI 差异补齐**：聊天流新增**紫云朵内心戏卡**（violet dashed 渐变，设计稿 L2）；用户消息改独立右对齐蓝渐变气泡（设计稿 .bub.me）；桌宠双轨气泡换 v3 材质（think=紫云朵 dashed+小圆点尾巴 / dialog=深空玻璃+蓝边+内高光）并**接线 autodrive 事件**（decision.intent→云朵 12s 自动收、chat_reply/reflex→对话泡 10s）；修复回话重复插卡（只信主进程广播）。
  - **packages/memory-graph**（feiyuos-memory-graph MIT 思想重写，零外部依赖 D14）：`MemoryStore`（JSONL append-only+内存 Map/邻接表+墓碑压实 30% 阈值+半衰期 30 天/宽限 7 天/0.2 剪枝+pinned 永存+**正文消毒**剔路径/内部 id/密钥——修复 `skip_event` 被误掩码的正则误伤）；`retrieve`（中文 2-gram 词法召回→沿边 2 跳图扩展→加权 0.5 相似+0.3 重要+0.2 新近+0.3 钉住→topN，只召回 event/summary）+ `formatMemoryContext`（≤600 字 Token 预算）。
  - **主进程 `memory-host`**：回执自动入图谱（event+temporal 边，翻车事件重要度更高）；**换日自动写日记**（`春16日 日记：完成 N 项，翻车 M 次…`）；聊天问句检索注入 LLM system（「回答时自然使用记忆，不要编造」）；`memory:query/diary/stats/wipe` IPC。
  - **真机验收**：60s 自动驾驶 → 13 节点 15 边（lastDay 春16日）；检索「钓鱼」7 条命中；**聊天「你刚才都做了些什么」→ 小鲸答「刚才在春16日跟威利聊钓鱼的事，对话都推进好啦。米粒都差点饿没了呢～」**（记忆驱动+傲娇人设）；293 tests 全绿 + 门禁 4 道。
- **T-M5-17 ✅ 声音工坊 Voice Studio 全栈落地（契约→后端→UI→测试四件套）**：
  - **契约**（shared-protocol +4 域 → 28 域跨语言重生成）：`PauseConfig`（dsh-gpt-sovits 气口停顿 340/150/460 三档）；`TtsEmotionTuningParams`（5 情绪锚点独立 refText 必填+speed/temperature/topP/topK/pauseConfig/前置音效）；`SvcSingingTuningParams`（dsh-voice-studio RVC 调参：升降调 ±12 半音/indexRate 0.75/气声保护 0.33/人声伴奏混音电平）；`VoiceDesignRequest`（三路径：云端捏声/本地切片/权重导入强制 licenseScope）。
  - **后端**（`services/audio-ai-worker/voice_studio.py` +5 端点 FastAPI 子路由）：`/design`（内置「大肥鱼傲娇蓝鲸女仆」等提示词模板 → stub 生成+prompt 归档+试听 b64）；`/slice-extract`（Demucs 互斥+内存 <4GB 422 降级+确定性 3-8s 切片+ASR 草稿）；`/audition-tts`（**refText 空值 400 拦截 + autoFill 草稿兜底**——防内部 ASR 40s 卡顿；skipCache 实时渲染）；`/audition-svc`（**ResourceMutex：先挂 TTS→RVC→恢复**（mutexTrace 断言）+低内存 422+resourcesLow）；`/save-pack`（五锚点+RVC 原子写 `voice_matrix.json` + 热重载钩子；重复锚点/空 refText 拒绝）。
  - **UI**（`voice-studio-panel.tsx` Shell 第 7 页签「声音工坊」）：顶部音色卡（licenseScope+MPS 徽章）+「生成/提取新音色」三模式弹窗（AI 捏声线/上传切片/导入权重）；左侧 5 情绪调音台（refText 编辑+语速/表现力滑块+三档停顿数字框+快捷台词胶囊+试听按钮）；右侧 RVC 实验室（5 滑块+女声微调 +2/男转女 +12 快捷预设+副歌试听）；底部吸底栏（还原/保存到桌宠人设热重载通知）。
  - **测试**：pytest `test_voice_studio.py` 13 项（参数 100% 往返一致/空 refText 拦截+autoFill/互斥锁 trace/低内存降级/重复锚点拒绝/确定性切片）+ TS `voice-studio-contracts.spec.ts` 10 项（契约双侧对齐）；mypy --strict 零错（torch optional 检测 sys.modules 化）；278 tests 全绿。
- **工作台 UI 还原设计稿 v3「曜石」+ 音色库页（用户指令）**：director 全量重构——Tailwind 调色板整体映射 iOS 系统色（slate→近黑玻璃、sky→#0A84FF、emerald→#30D158 等，既有面板自动继承设计语言）+ `design-tokens.css`（光影七层/玻璃卡/pill/ambient 光斑/stagger 动效）+ lucide-react 图标体系（UI 零 emoji）+ 左侧插件导航（六面板路由：聊天/星露谷/动作库/音色库/Harness/供应商）+ 顶栏三态按钮（语音开/LLM 大脑/自动驾驶）。**音色库页**：5 候选音色卡（俏皮萌妹/嗲嗲学妹/清脆少女/傲娇大小姐/倔强朋友）× 五档情感试听（25 按钮，音高/语速参数标注）——点试听即合成播放，点「使用此音色」写 voiceId 全场景生效（聊天/播报/内心戏）。voice-host 新增 `voice:catalog`/`voice:audition` IPC。E2E：音色页 5 卡 25 试听按钮/切换持久/真机试听播放；全部门禁 4 道全绿。
- **D11 定稿音色 ✅「俏皮萌妹」五档情感语音（用户确认音色，mcode-tools 合成链）**：voice-host 接 `mcode-tools connector batch_text_to_audio`（voice_id `qiaopi_mengmei`，voice-preset.json 用户定稿五档）——**daily 软萌小女仆**（347Hz/happy/句尾上扬 2.6 半音）｜bright 俏皮上扬（+4 半音）｜**tsundere 傲娇炸毛**（480Hz/angry/speed1.6——雷区反射专属）｜**sleepy 慵懒气声**（193Hz/volume0.45——内心戏心声专属）｜surprised 惊喜元气。**D11 场景矩阵直接映射**：正式台词→daily、内心戏→sleepy 气声、P0 雷区→tsundere 炸毛；聊天 LLM 回话自动发声；合成失败回落 say 变调链（三层保底）。E2E 四段真机验收全过（daily 台词/sleepy 心声/tsundere 反射/LLM 回话「没看到我在浇水吗」傲娇语气同步播出）。技术修复：ESM require→静态 import、sp 别名清理。
- **D11 语音第一版 ✅（macOS say 引擎，零外部依赖 D14）**：`voice-host.ts`——正式台词正常语速 / **内心戏心声语速 0.82 + 省略号前置**（低语感）/ **P0 雷区反射 1.15× 语速并打断在播**（单端不变式）；同文本 8s 节流；队列串行。**接线**：chat:say 回话自动发声（LLM 回话→婷婷音色真机出声）；autodrive 回执短评（UNCERTAIN→「都怪石头突然长出来的！」心虚甩锅 / 钓鱼成功→「本鱼的手感是天赋！」）；Shell 顶栏语音开关+试听按钮。修复：voice:speak 双注册 → DI 重构（main 统一创建/注册一次，autodrive 注入使用）。Windows SAPI 留 T-M6-05 平台适配。E2E 六项真机全过（say 子进程实跑验证）。
- **T-M6-01 完整版 ✅ LLM 大脑真机闭环（聊天回话 + LLM 决策玩游戏）**：`LlmPlanner`（game-bridge-mcp）——get_state + 回执上下文 + **guide-forager 攻略检索注入**（按状态线索挑专题 ≤1200 字）→ model-gateway（vault safeStorage 解密 DeepSeek key → DELUXE 套餐六槽位绑定）→ JSON 决策协议（宽松提取 + **75 工具白名单越权拦截** + 坏输出重问一次 → **RulePlanner 兜底，大脑掉线自动驾驶不停摆**）；菜单态确定性绕过 LLM（不烧 token）。主进程 `planner:switch`（规则/LLM 热切换）+ `guides:load`（7 专题注入）+ **`chat:say` 聊天回话**（「大肥鱼」雷区反射 0-token 直出 → persona 傲娇人设主脑回话）。Shell 顶栏大脑切换按钮 + 聊天流渲染回话。**真机验收**：小鲸真 DeepSeek 回话（"防风草长得可好了，都冒两片叶子了～记得给我加餐哦"人设满分）；LLM 决策铁证——**看到背包满自己决定「吃海草腾一格，不然鱼没地方放」**（原创造，规则引擎无此文案）；切换+攻略注入 7 专题 ✓。修复：guides 相对路径 4 级（dist/main→仓库根）。
- **T-M5-15 ✅ guide-forager 攻略采集器（D15 全链路真机闭环）**：`tools/guide-forager`——MediaWiki API（parse wikitext）→ 清洗管线（模板折叠/链接展开/加粗列表时序修复/表格降噪/标题层级——清洗坑：列表正则会误伤 `**加粗**` 行首，必须列表先于加粗）→ 主题归档 markdown（frontmatter 来源署名 + sha1 去重）→ **BWF get_guide 直通**（导出 Mod guide/ 七专题：钓鱼/采矿/节日/结婚/沙漠/姜岛/农场类型）；真机验收：**游戏内 get_guide 钓鱼 返回刚抓的 wiki 最新攻略**（重启游戏重载生效）；wiki 拦 Node fetch(403) → CLI 走 curl 子进程；courtesyDelay 限速。单测 9 项（离线 fixture 全路径：清洗断言/去重/薄页跳过/错误透传/容错/双页混合）。
- **D16 饭碗档位联动（适当时机触发补全）**：autodrive 回执扣米（30 粒/回执模拟计量，真实计量待 T-M5-04 token_ledger）→ 档位边沿广播（hungry/starving/full/fed_buff）→ 桌宠档位动作（RICE_LEVEL_ACTION_MAP）；`rice:feed` 投喂 IPC（Shell/directorBridge.riceFeed）→ fed_buff。E2E 真机：投喂 90000 粒 → full 档 → happy_maid 池动作真实切换 ✓。
- **T-M6-02 ✅ ACP Harness 层 + T-M5-16 ✅ 动作库预览与情绪全映射（D16）**（2026-11-21 深夜）：
  - **agent-harness 包**：ACP v1 客户端（stdio JSON-RPC 双向、initialize/session/prompt/permission 流、鉴权错误 auth-required 事件、pending 清理、行协议 banner 容错）；providers 注册表（真机探测：gemini --acp 原生 ✓ / dsh --profile acp ✓ / claude-agent-acp 预留）；HarnessManager 全生命周期；**acp-simulator**（测试脚手架假 agent：流式 update/权限请求/审批回填）。真机验收：gemini + dsh 双握手 ✓、dsh 真实会话创建 ✓（API key 失效如实透传）；Shell 第 4 页签 Harness（providers 卡/对话流/审批卡 YNA）；协议实测修正（dsh 要求显式 jsonrpc 字段）。
  - **D16 动作库**：emotion-map 三层映射表（情绪五档/游戏回执七类/饭碗五档 → 语义槽位）+ classifyAutodriveReceipt；**playClip 单条零黑帧播放 API**（ambient 池条目不在槽位也可播，加载失败保留旧画面）；Shell 动作库页（11 槽位卡+77 氛围池分类网格+点击预览→桌宠窗即播 6s 回 idle）；pet-stage ambient 空闲随机链（30s→pickAmbient→6s）；**素材零闲置审计单测**（114 clips 槽位∪池全覆盖+无重复挂载）。E2E：11 槽位+77 池渲染、槽位预览（鲸尾拍地）、ambient 单条预览（放风筝.webm 即播）全真机通过。修复：ESM __dirname、预览视图切换复位。
  - **D15 攻略采集 guide-forager**：PRODUCT-DESIGN §2.10 设计 + ROADMAP T-M5-15 工单（wiki MediaWiki API/小黑盒→主题归档→BWF get_guide/LLM 检索/技能卡三路注入）。
  - 工程修复：better-sqlite3 ABI 双 node 环境断裂（PATH node26 vs pnpm node24）→ prebuild-install 对齐 pnpm 测试链 137；v8 覆盖率抖动确认（连跑两次 exit=0）。
- **T-M5-01 ✅ + T-M5-02 ✅ + T-M6-01 最小版 ✅ 端到端真机打通（2026-11-21 晚）**：
  - **素材**（T-M5-01）：dsh-pet 114 个 VP9-alpha webm（55MB）入库 `packages/pet-renderer/assets/blue-whale-maid/`（D14 随包分发）；契约扩展 `ambientPool`（77 条随机氛围池）跨语言重生成；`gen:pet-manifest` 生成器（11 语义槽位全覆盖 + sleep 循环段 + 池空兜底 `pickAmbient`）；manifest-asset.spec 3 项门禁。
  - **game-bridge-mcp 包**（T-M5-02）：`mcp-client`（SSE/JSON 双解析 + JSON 前缀括号平衡解析器 + 超时≠失败语义 + 长动作 10min 分层超时）；`action-lock`（单在途互斥 + stats + cancel 幂等清锁）；`StuckSentinel`（4min 游戏时间冻结→卡死哨兵，时钟可注入）；`RulePlanner` 确定性日程（morning-mail→farm-work→fishing→forage→homeward，体力<8% 强制睡觉防晕倒，菜单优先处理）；`autodrive` 编排器（get_state→哨兵→P0 插队→执行→回执多播，**不可解析状态/网络错误按 watchdog 处理而非盲跑**，错误详情透传修复，maxCycles 死循环防护）。
  - **宿主接线**：main `autodrive-host`（事件 webContents.send 单源多播到两窗 + autodrive:start/stop/directive/status IPC）；preload `directorBridge` 扩展（含 onAutodriveEvent 中继）；pet-stage 真形象加载（manifest 相对路径改写 + 114 webm 随包拷贝到 dist/renderer/pet-stage/assets）+ **autodrive 事件驱动动作映射**（UNCERTAIN→clumsy_panic / FAILED→rage_spray / 钓鱼收获→happy_maid / 决策→game_focus / state→thought 气泡）。
  - **Shell 三页签**（T-M6-01 最小版）：聊天（autodrive 事件流卡片化 + 启停按钮 + `/goto /fish /sleep /stop /forage` 指令 P0 插队）｜星露谷监控（get_state 摘要 + 回执统计 + 时间线）｜供应商配置（T-dir-01 全量迁移 providers-panel.tsx）；E2E 适配页签导航后全绿。
  - **真机端到端验证**：游戏重启后 BWF MCP bind → load_save 读档（泡泡湾 春16 06:00）→ Shell 点「启动自动驾驶」→ **小鲸真实接管游戏**：read_mail 7 封（COMPLETED）→ water_crops 浇水（COMPLETED）→ travel_to Beach 去钓鱼，游戏时间 06:00→06:50；`/fish 5` P0 插队 ✓；桌宠窗渲染真形象（待机呼吸.webm + DEV 水印 + 事件驱动切换动作）✓；监控页 15 条真实回执 ✓；`verify:gate` 4 道全绿（覆盖率攻坚：新增 game-bridge-mcp 20+ 用例至分支 90%+）。
- **D13 形象与直播增强**（用户 2026-11-21 补充）：PRODUCT-DESIGN 新增 §2.6 小鲸日记（SessionEvent→换日归纳→图谱入库，聊天可问"昨天做了什么"只答有据）/ §2.7 形象工坊（AI 生视频→绿幕→normalize→manifest 注册→试穿，精灵图逆向导入）/ §2.8 直播感知与点歌（进房模糊解析+翻旧账问候、tid 防双计、**送礼插队点歌**[小+1位/中+3位/大置顶]、歌单管理、违禁拦截/同曲冷却/限额）/ §2.9 方案方补充功能（远程互动、日记面板、弹幕抽奖、多形象轮换）；ROADMAP 新增 **T-M5-13 形象工坊**、**T-M5-14 小鲸日记面板**，扩展 T-M5-04（观众双写/日记/提炼）与 T-M5-08（歌单+插队+防呆）；ARCHITECTURE 新增 **ADR-7**（日志=证据链与记忆=可检索摘要职责分离，双路订阅）。
- **D11/D12 桌宠语音与状态气泡设计**（用户 2026-11-21 补充）：PRODUCT-DESIGN 新增 §2.4 语音场景矩阵（正式台词/内心戏发声[默认关，-30%音量+0.9x语速+排队制]/P0 反射/甩锅/碎碎念/播报级，六类触发点+节流护栏 8s/20s/30min）与 §2.5 状态气泡组（动作状态条常驻/今日目标卡折叠/事件弹泡 3.5s 收起/回执 ticker/直播简化/夜间呼吸条）；ARCHITECTURE 新增 **ADR-6**（语音 voice.ts 与气泡 status-bubble.ts 为 pet 插件独立总线订阅模块，非编排器内部件）；ROADMAP T-M5-02/T-M6-01 工单补充对应范围；pet-stage.html 设计稿重写为完整演示（三开关语音面板/心声云朵/台词弹泡+TTS 波形/脚下状态条/目标卡展开态/场景矩阵六卡）。
- **docs/ARCHITECTURE.md 架构师方案 v1**（定稿待用户确认）：C4 两级视图（系统上下文/容器拓扑：main 内嵌 WebUI Server + ACP Client + PluginHost）；**8 条 ADR**（WebUI 内嵌、渲染层总线单向流、PluginHost=@cordisjs/core 最大兼容 dsh、ACP v1 先行 v2 渐进、electron-rebuild 管线解 ABI、三层插件结构 main/renderer/shared）；插件系统技术规格（manifest/defineTool/六扩展点/policy 单咽喉/审批三键/审计链）；数据所有权矩阵（Dexie/SQLite/JSONL 各司）；单源多播数据流不变式；三轨并行开发计划（素材/Shell/游戏轨道 + 合流端到端验收）与风险登记册 R1~R8。

## [Unreleased] - 2026-11-21（第二轮）

### Fixed

- **救援架构转向：判断归大脑，机制归护栏（2026-11-22 用户指令「不要把卡死写成机制，让 AI 判断该怎么做」）**：本会话三轮硬编码补丁（阶梯→造箱自救→全预留牺牲+攒木状态机）证明穷举现场是打地鼠——改为**救援问询**：卡死签名检测保持确定性（最近 ≥2 条环境级结构性失败「没有箱子/craft Chest/材料不够或背包满」），命中后先问大脑——`RESCUE_SYSTEM` 给优先级原则（无损捐赠/撤预留 > 可再生牺牲 > 不可逆丢弃）与工具事实（craft 满包拒且不耗材、木材≥50 直接造、不足先腾格去农场 `clear_area include_trees` 砍树），**动作顺序由大脑现场自定**；护栏照旧——白名单、单日失败预算冷却、重复防护（刚失败同工具仅同物品拦截）、真纠错重问一次、问询 token 如实计入饭碗；大脑不可用/两次坏输出回落原确定性阶梯（降级为离线兜底）。`repeated` 双败护栏如实接管解卡后的过渡（换规则日程不停摆）。llm-planner **59/59**（大脑驱动全链：结构双败→问询自选 donate→bundle_info→donate 冷却→吃预留鱼→砍树→421 确定性 craft→case 8 摆箱→chestPlaced；护栏用例：冷却拒绝重问/同工具换物品放行/白名单坏输出回落 donate；8 个阶梯分支测试改「大脑离线」stub 继续守住兜底路径）+ 全仓 **618/618** + depcruise 全绿，应用已重启带新逻辑。
- **修正 think 标签泄漏到桌宠气泡（2026-11-22 用户截图反馈）**：LLM 有时在 `decision.intent`/`receipt.summary` 里原样带出 `<think>内心戏</think>`，而桌宠云朵泡是纯文本渲染（`textContent`），导致标签直接显示给主人。根因：`persona-brain` 已有 `stripThink`（11 项单测含未闭合标签），但**生产事件链从未调用**。修复在主进程单源多播 `broadcast()` 处统一清洗所有用户可见文本字段（decision.intent / receipt.summary / watchdog.detail），桌宠气泡、中控台事件流、WebUI 订阅全部受益；`chat_reply` 的语音也改用清洗后的可见文本（不再朗读标签）。另顺手补齐其他会话在制半成品的两处编译遗漏：`pet-stage/main.ts` 饭碗刷新用了未定义的 `applyRice`/`riceBudget`（改走已有 `riceStatus()`+`riceBowlWidget.setRatio()`）、`drag-throw.spec.ts` 缺 `Bounds` 类型 import。全仓 tsc 零错误，think.spec 11/11。
- **满包死锁改为「造箱子自救」（2026-11-22 用户真机反馈「应该造箱子腾背包空间而不是卡死」）**：真机 transcript 实证卡死模式——春21日 06:10 起 `tidy_backpack`↔`store_items`↔`donate_bundles` 无箱死循环，BWF 失败回执两次明说「先 craft Chest（50 木材）」而背包里就有木材。根因链（BWF `GameActions.cs` 源码实证）：**BWF Craft 满包直接拒绝且不消耗材料**（「材料不够或背包满了」）——feiyu「满包合成掉地上」教训对 BWF 不适用，却导致救援阶梯 case 7 硬门槛 `freeSlots>0`，满包时永远走不到造箱。修复三件：① **case 7 满包造箱自救**——木材 ≥50 且无箱时，满包先 trash 整格低价值材料（新 `pickChestSacrifice`：BWF 官方建议的石料/泥土/纤维，绝不碰木材/工具/【留着】）腾一格 → BWF craft 放行 → 上方「顺手造/摆箱」分支自动接住 → 摆箱 → tidy/store 全恢复；② **case 1 出货保木材**——造箱计划激活时（无箱且木材 ≥50）ship 跳过木材（先卖别的腾格还能赚钱，木材卖了箱子永远造不出）；③ **421 分支去掉 craft 的农场位置门**（BWF craft 无地点要求，链条不因玩家位置断）。真机死循环成为四步确定性自救：卖石/扔石腾格 → craft → place → 恢复正常日程；连「只有工具+木材」的绝境仍保留 wait 求助（reason 提示造箱）。单测 54/54（含全链回归：ship 保木材→craft→place→chestPlaced 置位→恢复正常决策）+ game-bridge 101/101。
- **满包造箱自救·现场二修正（用户复测仍卡死；get_state 直读背包实证）**：背包真身是「木材仅 x22（<50——BWF 那句「先 craft Chest（50 木材）」是模板建议、没看存货）且**全部非工具物品被 BWF【留着：收集包】预留**（两条预留鱼/牡蛎/蚌/木材/石头），前修的牺牲格被 KEEP_TAG 全挡。完整解法：① 新 `pickRenewableReserved`——全预留绝境只在**可再生**预留物里挑牺牲（可食用鱼优先 force 吃还能回体力、海边采集 force 扔；**攒箱本钱木材/石头绝不碰**），且排在新 **step 12**——位于捐赠（case 10）与撤过早预留（case 11）**之后**（预留材料的无损出路优先穷尽；单测实证放 case 7 会抢跑吃掉本可捐赠的鱼）；② **chestGathering 攒木状态机**——木材不足时进攒木模式：牺牲腾格后主流程接管 `travel_to Farm → clear_area {include_trees:true}`（BWF ClearArea 源码：不带坐标清周身、'T' 树用斧头 25 下）→ wood≥50 → craft → place；clear_area 单日失败预算耗尽（农场没树）→ 放弃当天造箱回落常规救援。真机现场全链九跳单测：donate（无损优先）→ bundle_info → donate 失败预算冷却 → **eat 预留鱼 force** → clear_area 砍树 → craft → place → 回规则日常（repeated 双败护栏如实接管）。llm-planner 56/56 + 全仓 **615/615** 全绿。
- **Console（原 Zen）保存并检测报错根因定位 + 复制 Key（2026-11-22 用户真机反馈，真实 key 隔离实例复现）**：用户在 Zen 保存 key 后检测报错——用其 vault 拷贝在 PET_STAGE_E2E 隔离实例复现出完整真相：**免费档 chat 对第三方客户端返回 429 `FreeUsageLimitError`（官方策略：免费模型仅 OpenCode 客户端内可用）、付费档返回 402 `Insufficient balance`（账户无按量余额）**。修复：① 检测改**定向两探**——免费档一次 + 付费档一次（免费档全档同错连试无信息量；401 Key 级错误即止），失败时逐档如实汇总「big-pickle：HTTP 429 FreeUsageLimit…；glm-5.3：HTTP 402 Insufficient balance…」用户一眼看懂该充哪边；② 修上一批的分类 bug：免费档 chat ≠ 决策协议（原把 big-pickle 等免费模型标 toolCalling=false 被 UI 当成决策类踢出检测），改以 `/inference/v1/models` 的 `type`+`cost` **服务端元数据**分类（决策/免费/普通 chat 三种 pill；embedding/image/realtime/video 不再混入模型列表，清单从 105 净化为 chat+decision）；③ **复制 Key（用户指令）**：`providers:copy-key` 主进程解密直写系统剪贴板（`clipboard.writeText`），明文不回传渲染层、界面不显示；④ **发现 Go 订阅的免费通道**：`opencode-go` 端点的 **`hy4-flash-free` 不占 Go 配额**（真机 1396ms 回话成功），已加进预设开箱可见——这才是用户实际可用的免费模型（Console 免费档被官方锁客户端，绕不过也不伪装 UA 破限制）。真机：23/23 回归（含 `pbpaste` 端到端验证假 key 真实入剪贴板）+ 真实 key 复验（429/402 逐档展示、copy-key ok+掩码、go 清单 5 模型含 1 免费）。
- **OpenCode Go 400 `MissingSessionID`（用户真机粘贴 key 后报错）**：按官方 Go API 规范补齐必需头 `x-opencode-session: ses_<stable>`（同一会话×槽位恒定，供路由与 Prompt Cache）+ 客户端 `User-Agent: xiaojing-workbench/1.0`；Base URL 迁移到 canonical `https://opencode.ai/inference/go/openai/v1` 与 `/anthropic/v1`；模型发现改走协议无关根 `https://opencode.ai/inference/go/v1/models`。真机验证：连接检测 1.5s 通过、拉取 5 个模型、网关真实回话 2.1s 并记账 `providerId=opencode-go/modelId=deepseek-v4.1-flash/426 tokens`。
- **服务商保存后不显示已连接 + OpenRouter 检测误报保存失败（用户真机反馈）**：① 根因——内置服务商 `commitProvider` 落 Dexie 时漏存 `keyMask`（`configured` 是从它派生的），「保存并检测」刚成功就回退「未配置」，重开面板 Key 明明在 vault 里却显示没连 → 补存 `keyMask/testOk`，且水合时逐家对账主进程 vault 掩码（`providerKeyMask` IPC），历史脏 override 自动修复；② OpenRouter 报错根因——检测用预设模型 ID（如 `anthropic/claude-sonnet`）已下架 → 404 被误读成「保存 key 报错」→ 改为**先拉真实 `/models` 清单再挑清单内模型测连**（清单校验 Key + 新模型自动并入），检测失败时如实区分「凭据已加密保存（掩码）· 连通检测未通过：<HTTP 原因>」与保存失败，状态行三态（绿已连接/琥珀检测未通过/灰未配置）；③ `syncBrain` 成功回调改 toast：此前异步 `setNotice` 会把「保存并检测」结果条约 1s 后整个覆盖成绿色「主脑已热更新」——失败路径红条刚出现就被绿条盖住，是用户误读「报错」的直接帮凶；④ 模型列表补齐设计稿已画的**搜索框**与新增**一键全部开启/关闭**（作用于全部模型而非过滤结果，全关时同步清空相关角色绑定）。真机 CDP 回归 **12/12 断言过**：假 Key 保存 → 如实「凭据已加密保存（sk-t••••••••cdef）· 检测未通过 HTTP 401（DeepSeek 官方回 Authentication Fails）」→ **刷新后掩码与琥珀态仍保持（keyMask 持久化核心回归）**→ 结果条 2.5s 后不被热更新覆盖 → 全关 (0/3)/全开 (3/3) → 搜索 reasoner 命中 1 行/空态文案 → OpenCode Go 5 模型在列。`pnpm verify:gate`：Gate 1/2/4 过、全量单测 500/500 过（唯一红项 `llm-planner.spec` 为并行会话未完成的 T-M6-12 防抖改动，与本批无关）。
- **星露谷自治安全性（T-M6-10 续）**：系统提示升级为人类玩家准则（界面优先/批量工具/失败换法/【留着】红线/23:00 回家/update_notes/农场规划/花钱规划）；新增确定性作息护栏（23:00 必回家睡觉、体力 <8% 先吃→回家→睡，先于背包救援执行）。

- **星露谷自治打磨·第一轮（T-M6-10）**：
  - **剧情菜单**：`当前界面` 改多行解析；选择题按 0 基 `choice` 回答（修复「这是个选择题，请用 choice」无限 FAILED）；起名界面 `set_name 小鲸`；过场无对话框 → `skip_event`。
  - **背包只剩家具**：解析文字地图找最近空地 `place_item`；被挡自动换相邻格/采纳 BWF 建议坐标；6 次仍失败 → `trash_item force=true` 兜底。
  - **长期箱子方案**：农场空闲且木材 ≥50 → `craft Chest` → `place_item` 摆箱；只剩【留着】收集包材料 → `donate_bundles` 捐掉腾格。
  - **长动作超时**：`clear_area/till_area/plant_seeds/place_item/set_name` 纳入长动作（修复 clear_area 30s 假 TIMEOUT）。
  - 单测新增 15+：菜单多行、choice/set_name/skip、家具摆放/建议坐标/force 丢弃、造箱/摆箱/捐赠、空地解析、长动作表；game-bridge 81 it，分支 90.35%。

- **T-M6-09 模型与服务商 v5（2026-11-22 用户指令）**：
  - **取消三档干饭套餐**：UI 只保留单一当前生效配置（Dexie 写入 → `brain:apply-config` 热更新）；默认模型 Tab 六槽位从「已启用服务商 × 已启用模型」中选择，文本角色可一键跟随主脑。
  - **OpenCode Go 内置**：`opencode-go` OpenAI（`/zen/v1`）与 Anthropic（`/zen/anthropic/v1`）双变体 + 5 个预设模型；契约新增 provider/variant `protocol`，gateway 支持 Anthropic `/messages`（x-api-key + anthropic-version，无 Authorization）；sanitizer 增 `oc_sk_`/`or_sk_`。
  - **自定义服务商**：Dexie `customProviders` 持久化；名称/协议/BaseURL/isFullUrl/模型手动增删启停；删除时同步清理角色绑定；provider 总开关与绿点。
  - **Magpie / CC Switch 只读导入**：主进程 `provider-importer`（Magpie JSON、CC Switch SQLite 经 `sqlite3 -readonly`、JSON 导出/旧 config.json），预览仅服务商名/协议/BaseURL/模型数/掩码；apply 阶段主进程直接 safeStorage 加密写 vault；`skip`（默认，已有凭据不覆盖）/`overwrite`；SQLite 只读有 fixture mtime+sha256 断言。
  - **UI**：providers 页按 `design/providers.html` 重构为 Master-Detail（256px 目录 + 专注面板）+ 双 Tab + 导入弹窗 + 添加自定义弹窗；零 emoji；浅色主题同步。
  - 修复：license-scanner 误把 tsc `build/` 编译产物当源码扫描（跳过 build），Gate 2 恢复 0 违规。

- **P0 正确性收尾（2026-11-22 用户选定方向）**：
  - **套餐/槽位真正驱动运行时**：新增 `BrainRuntimeConfig` 契约（38 域）；App 启动与供应商页每次改套餐/槽位/激活模型 → `brain:apply-config` → 主进程用 vault 里对应供应商 key 重建 `ModelGateway`，`planner:status` 如实返回 `providers/missingKeys`；不再硬编码 DELUXE。UI 顶栏大脑状态跨面板同步（`wb:brain`）。
  - **真实 Token 饭碗**：`token-meter`（`userData/meter/`）消费 gateway `onUsage` 真实 usage → JSONL 流水（slot/provider/model/输入输出/latency/米粒）+ 日预算 500,000（1 粒米 = 1 Token），支持跨重启、跨日重置与投喂 bonus；删除「1 回执 = 30 粒」模拟扣米。真机：聊天 478 tokens → 499,522 并跨重启保持。
  - **Gate 4 回环 E2E 接线**：`apps/desktop-host/e2e/gate4-loopback.spec.ts`（live-stream-hub 收弹幕 → persona 0-token 喷水 → 单端语音锁 COMPLETED/active≤1 → SQLite 记仇账本 + 0 token 断言 + 600 米粒记账），`verify:gate` 现在 **5 过 / 0 待接线**。
  - **wait 可见化**：planner 返回 wait 时广播 `watchdog stuck`，中控台显示停滞原因，不再只有静默 cycle-end。
  - 物品名归一剥离 `（手持）`；BWF「没有能扔的…」拒绝文案纳入黑名单解析，避免救援空转。

- **产品功能设计 v1 定稿**（[docs/PRODUCT-DESIGN.md](docs/PRODUCT-DESIGN.md)，用户决策 D1~D5）：基于 21 个参考仓库的代码级深挖（克隆至 `~/Documents/vibe/reference-clones/`，5 个分析代理并行产出文件级结论），确定六大子系统升级方案——桌宠素材包（dsh-pet 114 alpha webm）、记忆图谱引擎移植（feiyuos-memory-graph）、星露谷自动驾驶（BWF 主线+守护脚本层+CheatBridge 开关）、聊天主界面（Codex 式，D3 最高优先）、三级注意力调度公式移植、鱼鳍安全模板；ROADMAP 新增 M5 批次 12 张工单（T-M5-01~12），当前激活 T-M5-01。
- **docs/REFERENCES.md §4 第二轮代码级复评**：21 仓库总表（定位/可移植点/素材清单，含素材 alpha 与否实测）；D5 用户豁免声明（本地自用可移植、须登记来源）。
- **全界面高保真交互设计稿**（`design/`，决策 D4）：6 页 HTML——`index.html`（设计语言总览：色板/排版/语义）+ `chat.html`（Codex 式聊天主界面：会话列表/think 折叠/工具卡片三态/审批卡 YNA//指令菜单/模拟流式）+ `stardew.html`（自动驾驶监控：动作互斥大卡/真实回执时间线/看门狗六宫格/CheatBridge 开关+审计流水/技能卡/ASCII 地图）+ `providers.html`（Magpie 单屏：套餐/六槽位/供应商卡升级版）+ `pet-stage.html`（桌宠舞台：双轨气泡/饭碗挂件/剪影点击分区/114 动作库网格分类筛选）+ `obs-overlay.html`（18765 挂件：投票板/歌词卡/双轨气泡/弹幕互动）。共享 `tokens.css` 设计 token（深空玻璃拟态）。Chrome headless 截图全页视觉验证通过；设计数据取自真机实测状态（春16日/体力98/竹鱼竿/鳀鱼完美）。

## [Unreleased] - 2026-11-21

### Added

- **T-dir-01 ✅ Magpie 式模型供应商配置 + 客户端真机运行**（参考 [yetone/magpie](https://github.com/yetone/magpie)（MIT，39.6k★）单屏交互思想重写，未复制任何代码）：
  - 契约先行：`ModelProviderConfig` 新增 `activeModelId`（Magpie「一处配置供应商，处处选模型」），`gen:contracts` 跨语言重生成（JSON Schema 24 域 + Pydantic）。
  - 主进程 `provider-vault.ts`：API Key 经 Electron `safeStorage` 加密落盘 `userData/provider-vault.json`（明文只上行、永不下行，渲染进程只见掩码 `sk-1••••••••abcd`）；`providers:discover-models` 主进程 fetch OpenAI 兼容 `/models`；`providers:test-chat` 一次 `max_tokens=1` 真实请求验证 + 延迟回执。凭据库刻意避开 better-sqlite3（其 Node ABI 137 与 Electron ABI 139 无法同时服务 vitest 与 Electron 主进程，文件 KV 亦符合 AGENTS.md §1 的 SQLite 职责清单边界）。
  - preload 新增 `directorBridge`（saveProviderKey/providerKeyMask/discoverModels/testProviderChat）；director 窗口补挂 preload（此前无桥）。
  - director App 重构为 Magpie 单屏：9 张供应商卡（粘贴 Key → 加密保存 → 拉取模型 → 连接测试 → 选激活模型 + Region/Plan 胶囊切换端点）+ 六槽位绑定下拉（选项来自已发现模型，"providerId/modelId" 格式与干饭套餐契约一致）；状态合并 = 内置预设基底 + Dexie `providerOverrides` 覆盖层（重启持久）；套餐槽位绑定存 Dexie `diningProfiles`。E2E 选择器（`data-profile/data-active/data-binding/data-provider`）全兼容。
  - 构建修复：main bundle `external: ['electron','better-sqlite3']`（原生模块打进 ESM 会炸 Dynamic require）。
  - **E2E 稳定性修复**：`PET_STAGE_E2E=1` 时主进程 `app.setPath('userData', …/e2e-profile)`——开发实例与 E2E 并发共用 userData 会撞 IndexedDB LevelDB 锁（`Internal error opening backing store`）导致 director 白屏假死；隔离后 E2E 30s 超时 → 756ms 通过。
  - 真机验证：Electron 38 客户端启动，CDP DOM 验收（9 供应商卡 / 3 套餐胶囊 / 6 槽位下拉 / bridge 挂载）、IPC 链路实测（假 key 保存 → 掩码回读一致 → vault 文件只见密文 → 未存 key 拉模型报错不崩）；`pnpm verify:gate` 4 过全绿。

## [Unreleased] - 2026-11-15（第二轮）

### Added

- **T-M2-02 ✅ 情绪感知 TTS 混合路由**：契约先行（`TtsVoicePack`/`EmotionVoiceProfile`/`LipEnvelope`/`Viseme`/`TtsSynthesisResult` 进 shared-protocol，19→24 域，跨语言 JSON Schema + Pydantic 重生成）；Python `tts_engine/emotion_router.py`——情绪前缀解析（5 档）、参考音频匹配、本地 GPT-SoVITS 优先 + 云端降级（`degraded` 如实上报）、口型包络生成（viseme 序列 + 连续时间锚点 + 标点闭口停顿）、可插拔 `TtsBackend` 接口（真实 torch 推理后续接入，stub 同接口）；新增 `/tts/emotion` 与 `/tts/voice-pack` 端点；宿主侧 `tts-router.ts`——情绪→桌宠动作映射、参考音频选择、语音租约组装（ttl=时长+3000）、口型时间线采样，并接入 pet-stage 编排（语音锁 + 动作切换 + 口型驱动）。
- **T-M2-01 ✅ Python 音频 Sidecar 骨架与单端语音锁**（含覆盖率加固：全局分支 89.74% → 92.14%，补 13 项边界用例并删除 3 处契约不可达死分支）：`services/audio-ai-worker`（uv/Python 3.11 + FastAPI + WebSocket）——`/health` 硬件后端探测（mps/cuda/cpu，torch 可用时以其为准）、`/tts/synthesize` 确定性 WAV stub（同参同输出，供缓存语义）、`/ws/audio` JSON-RPC 通道（ping/speak + 四类错误码）；宿主侧 `AudioLeaseManager`——单端互斥（active≤1 不变式）、播放完成回执驱动生命周期、P0 抢占（INTERRUPTED_BY_P0）、TTL 强制释放（TTL_EXPIRED）、设备错误（AUDIO_DEVICE_ERROR）、队列 P0 优先+同级 FIFO、回执出站经 `AudioPlaybackReceiptSchema` 契约校验。
- **T-M1-05 ✅ 桌面舞台 UI 挂件与中控台模型配置页（M1 收官）**：pet-stage 双轨气泡（`<think>` 云朵半透明/正式对话，`computeBubbleLayout` 布局纯函数保证不重叠）+ 赛博饭碗挂件（15% 饥饿线 🥣 饿瘪态）；director 中控台——React 19 + Tailwind v4（esbuild 打包免 vite）三套餐胶囊一键切换写 Dexie `activeDiningProfile`（刷新持久恢复）、Magpie 六槽位绑定、CC Switch 风格供应商预设卡（Region/Plan 胶囊+掩码 Key）；E2E 真实 Electron 双窗口验证（几何不重叠+截图留证 artifacts/ + Dexie 键值+刷新恢复）。**M1 全部 5 张工单 DONE。**
- **T-M1-04 ✅ 「大肥鱼」三层人格引擎 persona-brain**：第 1 层系统提示模板填充（{name}/{title}/{owner}/{riceRatio}）；第 2 层 `<think>` 流式剥离（分块跨标签悬挂安全、未闭合兜底、跑题碎碎念 derailmentProbability）+ 情绪五档前缀解析（[傲娇反驳]→tsundere_refuse 等，供 T-M2-02 TTS 路由）；第 3 层雷区反射钩子（正则先行、命中即 `P0_INTERRUPT`、冷却窗口、加权预设台词直出 → 结构性不消耗主脑 Token；装载期正则编译防 ReDoS）；赛博饭碗经济（1粒米=1Token、15% 饥饿线 → hungry_lazy、下饭菜 Buff 过期/×2 热情/深度推理解锁）。
- **T-M1-03 ✅ 模型与供应商网关 model-gateway**：内置 9 家供应商预设（CC Switch 两步式思想重写：Region/Plan 胶囊 + Full URL 免拼接）；Magpie 思想 6 槽位绑定 + 干饭套餐切换（switchProfile 清粘性态）；粘性路由三策略（Prompt Cache 粘住 / 轮询 / 最快节点）；隐私脱敏（本机用户名/homeDir/绝对路径 POSIX+Windows/sk-/ghp_/AKIA/Bearer/明文 apiKey → `{{MASKED}}`，残留 0 断言）；429/5xx/401/403/网络错误 100ms 内静默 failover（400 请求级即抛）、回执仅由真实 HTTP 响应构建、usage 只记供应商实报字段（prompt/completion/prompt_cache_hit_tokens）。
- **T-M1-02 ✅ Electron 跨平台透明穿透宿主 desktop-host**：主进程（transparent/frameless/alwaysOnTop/skipTaskbar 透明桌宠窗 + passthrough/drag/screen IPC，坐标全 DIP 多屏合并 workArea 夹紧）；渲染层 pet-stage（WebmVideoRenderer 装配 + 50ms 离屏 1x1 Canvas alpha 采样状态机（仅翻转过 IPC）+ 拖拽测速→重力/边界反弹/落定冲击→Q 弹联动）；preload contextBridge（forceAlpha/onTestAlpha 测试钩子由 `PET_STAGE_E2E=1` 门控）；esbuild 构建编排（main ESM / preload CJS / stage IIFE）；playwright-core E2E 真实 Electron 验证（踩坑：透明后台窗 rAF 节流致 waitForFunction 假超时 → evaluate 轮询；`webContents.send` 仅 preload 可收 → 桥中继 CustomEvent）。
- **T-M1-01 ✅ 可插拔桌宠渲染引擎 pet-renderer**：契约先行——`PetAvatarManifest/PetAvatarClip` 进 shared-protocol（17→19 域，跨语言 Schema 重生成）；`IPetAvatarRenderer` 接口 + `WebmVideoRenderer`（双 video 交叉淡入零黑帧时序、脚底基准线 `computeFootlineLayout`、Q 弹 `squashAt` 阻尼振荡+体积守恒、`DEV_ONLY_NON_COMMERCIAL` 素材自动挂 [DEV-ASSET-ONLY] 水印徽标+署名）；`VideoFactory/RendererHost` 注入隔离 DOM（无头可测，真实 DOM 工厂归 T-M1-02 desktop-host）。
- **T-M0-04 ✅ AI 自测沙盒 mock-harness**：`stardew-mcp-simulator`（JSON-RPC 2.0 over WS，5 剧本确定性回放 + 动作互斥锁 + 0.1s 接管中止 + 回执出站契约校验）、`danmaku-storm-replay`（种子伪随机确定性生成、1000 条风暴 100% 过 NormalizedLiveEventSchema、雷区/点歌/Prompt 注入/连击/进房夹具）、`license-scanner.mjs`（台账+密钥+UNLICENSED+GPL-3.0 传染源，接管 Gate 2，自测 spec 对临时 fixture 实测报错）。
- **T-M0-03 ✅ 本地存储双引擎底座**：新增 `packages/local-store`——主进程 SQLite（`better-sqlite3` WAL：常客记仇/好感账本、Token 流水（1 粒米=1 Token 按槽位汇总）、点歌缓存索引、meta；`deleteViewer/wipeAllViewers/wipeAllData` 隐私一键擦除）+ 渲染进程 Dexie 配置库（`./dexie` 子路径隔离两端）；Gate 3 覆盖率 ≥90% 硬门槛生效（实测四维 100%）；新增 depcruise 规则 `local-store-runtime-only-storage`。
- **T-M0-02 ✅ 全局契约包与跨语言导出器**：`src/registry.ts` 契约注册表（17 域 + `CONTRACT_VERSION`）；`pnpm gen:contracts`（Zod → JSON Schema ×17 + workbench 合并视图 → Pydantic `protocol_models.py`，`$defs` 漂移即报错、`--use-annotated`/`--disable-timestamp` 确定性输出）；TS 契约单测 11 项 + Python 夹具回放 4 项（同一 fixture 双侧 probe）；Gate 3 接线（vitest + pytest）；Gate 1 增补 Python ruff + mypy --strict（生成物 assignment 豁免记录于 mypy.ini）。
- **T-M0-01 ✅ Monorepo 脚手架与架构边界锁**：`.dependency-cruiser.cjs` 六条机器边界规则（no-circular / shared-protocol 零依赖 / 运行时仅 zod / 渲染进程禁 SQLite / pet-renderer 禁跨层 / mock-harness 仅依赖契约）；`pnpm lint:deps` 接入 Gate 1；pre-commit 经 `core.hooksPath=.githooks` 强制 `verify:gate`。验证：临时探针（import `ws`）实测违规自动报错后恢复全绿。
- **9 份 `docs/REFERENCE-*.md` 复评档案**（基于 9 个真实仓库的第一轮复评：GitHub API 元数据 + LICENSE 原文 + README 全文 + 顶层结构，未逐行审计源码）：dsh-pet、dsh-stardew-blind-whale-farmer、dsh-douyin-agent（新增）、dsh-livestream（新增）、dsh-live-studio（新增）、dsh-live（新增，拉黑档案）、Dsh_douyin、dsh-video-storyboard、feiyu-os。
- 每份档案含：结论摘要 / 采用什么 / 不采用什么（为什么）/ 验证路径与回退 / 复评记录。

### Changed

- **docs/REFERENCES.md**：全部按真实仓库重写——许可证结论核实为：dsh-pet（代码 MIT / 大肥鱼形象与素材 CC BY-NC-SA 4.0）、BlindWhaleFarmer（**MIT**，原"待核实"解除）、dsh-douyin-agent（MIT）、dsh-video-storyboard（Apache-2.0）、dsh-livestream（代码 MIT / 素材 CC BY-NC-SA）、dsh-live-studio（MIT）、feiyu-os（代码 MIT / 文档 CC-BY-4.0）、Dsh_douyin（None + 内嵌 GPL-3.0 vendor）、dsh-live（None + 自述模拟指标）。
- **docs/THIRD_PARTY_NOTICES.md**：§2 按真实许可证重写；新增 `cortico-world-douyin-live`（GPL-3.0，⛔ 禁止 vendor 引入）条目；dyhub / CC Switch / Magpie / awesome-codex-pet 未提供仓库，保持"仅思想参考"。
- **AGENTS.md §2.2 许可证洁癖**：补充 GPL-3.0 传染红线、CC BY-NC-SA 4.0 素材精确化、Apache-2.0 NOTICE 要求。

### Security

- Gate 2 黑名单依据更新：`Dsh_douyin` / `dsh-live` 均确认 license=None；新增 GPL-3.0 传染禁令。

## [0.1.0] - 2026-11-15

### Added（项目奠基）

- **Monorepo 骨架**：pnpm workspace（`packages/*`、`apps/*`、`services/*`、`tools/*`）+ 严格 TS 基线（`strict` + `noUncheckedIndexedAccess`）；`mods/` 为 C# 不纳入 pnpm。
- **docs/SPEC.md**：《AI 桌宠与虚拟主播工作台》产品需求与技术架构总纲——4 项冻结决策（WS+JSON-RPC 2.0 总线 `18760` / Dexie+SQLite 双引擎 / OBS Browser Source `18765` 优先 / `uv` Python 3.11 硬件自适应）、六大模块详设、M0~M4 里程碑验收表。
- **AGENTS.md**：AI 自治开发最高宪章——五层铁笼（契约先行 / 仿真沙盒 / 四道门禁 / 防失忆工单流 / 运行时安全锁）、原子工单工作流、许可证硬性红线、主题复评速查表。
- **docs/ROADMAP.md**：M0~M4 共 20 张原子工单冻结清单，当前激活 `T-M0-01`；注明人工预置范围（T-M0-01 / T-M0-02 剩余工作）。
- **docs/VERIFY.md**：验收矩阵，强制分栏「Mock/沙盒已通过」与「待人类真机验收」。
- **docs/REFERENCES.md**：13 个开源参考项目清单、复评纪律与硬性红线（UNLICENSED 项目拉黑）。
- **docs/REFERENCE-*.md**：5 篇复评档案占位（dsh-pet / BlindWhaleFarmer / dsh-douyin / dsh-video-storyboard / feiyu-os）。
- **docs/THIRD_PARTY_NOTICES.md**：第三方许可证台账（含 dsh-pet 素材 `DEV_ONLY_NON_COMMERCIAL` 标记）。
- **packages/shared-protocol**：全局 Zod 契约初稿（桌宠渲染与语音锁 / 大肥鱼人格与赛博饭碗 / 模型网关与干饭套餐 / 星露谷 MCP 真实回执 / 直播事件总线五域）。
- **tools/scripts/verify-gate.mjs**：`pnpm verify:gate` 门禁编排器——Gate 1（tsc）与 Gate 2（许可证台账 + 密钥/禁源扫描）已接线，Gate 3/4 待 T-M0-03 / T-M0-04 接入。
- **Git 仓库初始化**（main 分支）。

### Security

- Gate 2 内置扫描：硬编码密钥特征（`sk-` / `ghp_` / `AKIA` / 明文 apiKey 赋值）与 UNLICENSED 项目源码痕迹（`fore-vip/dsh-live`、`newbeejmc/Dsh_douyin`）。
