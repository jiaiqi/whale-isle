# Changelog

本项目的所有显著变更将记录在本文件。
格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本遵循 [SemVer](https://semver.org/lang/zh-CN/)。

### Changed

- **星露谷自治·状态感知升级 T-M6-14（2026-11-22 用户 goal）**：规划器从「只看钟点和背包」升级到「看天气/血线/生日/节日」——①`parseGameState` 新增 `weather/health/healthMax/birthday/festival`（真机格式实证，限定「今日：」行解析防误匹配）；②`festival` 入白名单 + 冷却豁免，**节日单日一次性状态机**（BWF 提示行解析入场窗口 → enter→greet→start→leave 兜底，对话框打开先 dialogue，绝不盲试）；③**雨天免浇**（雨/雪天跳过 water_crops，双规划器 + 提示词）；④**生命 <30% 撤退护栏**（先吃回血、没吃的回家，先于日程）；⑤提示词补「节日按提示做/村民生日优先送礼」引导。单测 +9（game-bridge 98 it）；真机：春20 撞上「全【留着】死锁」（为未解锁收集包过早预留全部鱼）→ watchdog 如实亮灯 → 主人 `eat 沙丁鱼 force` 指令解除 → 决策流恢复；`verify:gate` 5 过 / 600 tests / 分支 92.29%。待真机：春24 花舞节链 + 雨天清晨免浇（监视器已挂）。
- **星露谷自治打磨·第二轮 T-M6-12：决策循环防抖（2026-11-22 用户 goal，真机 transcript 实证驱动）**：真机 transcript 抓到同一冻结分钟 dialogue×191 / place_item×96 / trash_item×59 / donate_bundles×29 四大死循环 → ①移植 BWF Agent 规则第 4 条「同一失败动作不重复超过两次」为**单日失败预算/冷却**（按「我上一条下发动作」逐条结算——旧实现从定长缓冲区数总数做 delta，饱和后恒 0，96 次同坐标复读的根因；place_item 允许 6 个相邻格跨轮轮换，不复读同一坐标）；②**dialogue 效果核验**（Junimo 思想）：同一界面文本连续 8 次推进不变 → skip_event → close_menu → wait 求主人接管（正常多页剧情文本在变不误伤——真机玛妮剧情 7 推进+选项+起名干净走完、法师剧情 16 页后按「剧情还在放没对话框」规则跳出）；③donate_bundles 失败 → 按回执提示自动 `bundle_info` 查缺料（当天一次）→ 预算耗尽冷却不空转；④**真纠错重问**：坏输出/越权/冷却工具把原始输出+具体原因追加进对话再问（旧实现只是原样重发，大概率得到同样的坏输出）；⑤**省略快照跨日误判修复**（真机新抓）：BWF wait 后「（和上次一样，省略）」时钟行缺失 → day 回落 1 → 单日冷却被清空（春19 第三次捐空转根因）→ 时钟缺失时沿用日锚。单测 42 项（+7 防抖回归）；真机 2 游戏日自驾：23:00 作息+跨日结算正常、watchdog 亮灯不空转；`verify:gate` 5 过 / 591 tests / 分支 92.3%。
- **品牌升级：鲸屿 / Whale Isle（2026-11-22 用户指令）**：
  - **命名与图标**：应用名定为「鲸屿」——鲸是桌面上陪你玩的小鲸，屿是承载她的桌面小岛；英文名 `Whale Isle`，标语「一座住在桌面上的鲸屿」。新图标为深空 squircle 上的蓝鲸侧身像（女仆扇贝头带 + 蝴蝶结 + 水花 + 星海底座），母版 SVG 导出 `icon.icns` / `icon.ico` / 16–1024 PNG 全套；`whale-isle-mark.svg` 与中控台/ WebUI 复用同一尾鳍 + 头带视觉语言。
  - **品牌单点事实源**：新增 `src/shared/brand.ts`（`APP_NAME/APP_NAME_EN/APP_TAGLINE/APP_DATA_DIR/BRAND_ASSETS`）；主进程窗口标题、About 面板、Dock 图标、中控台侧栏、`director/index.html` 标题/favicon、WebUI 标题与内联 logo、`package.json productName`、README 全部改为鲸屿，构建时 `assets/brand → dist/renderer/brand` 随包分发。
  - **数据与凭据迁移**：userData 从通用 `Electron` 一次性「薄迁移」到 `Whale Isle`（只拷 provider-vault / meter / memory / stardew-mods / IndexedDB / Local Storage，不覆盖已有文件、不动 `e2e-profile`，marker 幂等）；真实 key 在新目录用同一 Electron safeStorage 解密成功，Brain 启动无报错。
  - **macOS safeStorage 坑（实测）**：Keychain 服务名是「`<app name> Safe Storage`」，`app.setName('鲸屿')` 后旧密文**无法解密**；因此开发态 macOS 保留 `Electron` 作为 Keychain 身份（菜单栏 dev 仍显示 Electron），窗口/侧栏/Dock/About 显式用鲸屿；打包后 `productName` 为鲸屿，Keychain 自然切换。另为解密失败加 fail-closed try/catch（UI 显示未配置、绝不崩主进程或回落明文）。
  - **验收**：CDP 断言 `title=鲸屿 · 中控台`、侧栏 `鲸屿` + tagline tooltip + favicon 路径；WebUI `鲸屿 WebUI · 远程中控` + logo；`pnpm verify:gate` 5 过 / 0 跳过。
- **设计稿 v3「曜石」（apple-ui-design 三原则：Clarity/Deference/Depth）**：iOS 系统色板（#0A84FF 主 accent + 系统语义色）、true-black 分层底（避开死黑）、**光影七层系统**（ambient 环境光斑慢漂移 / 玻璃卡 blur30+内高光 / 发丝分隔线 / 双层柔影 / Sheen 文本光泽 / 状态光晕）、SF Pro+PingFang 节奏、pill 按钮（980px）+ hover scale 1.02、连续曲率圆角 8/12/16/20；tokens 变量名保持兼容（全部页面自动继承质感），shell-chat 全面精修、其余 6 页注入 ambient 光影层；深浅双主题（#f5f5f7 Apple 浅灰对等实现）。功能结构沿 v2 已确认的 7 页（Shell+聊天/Harness/插件管理/星露谷/供应商/桌宠/OBS），插件化信息架构保证新功能融洽插入。
- **设计稿 v2 重做（ui-ux-pro-max 工作流，决策 D4/D9/D10）**：`design/` 全套升级——设计系统由 skill 数据库生成（Modern Dark 开发者工具风格、密度 8/10、Expo.out/spring 动效规格）；run-green 主操作色（#22C55E，"code dark + run green"）替代蓝紫 AI 味（v3 中绿转为纯运行/成功语义色）；lucide SVG 全量替换 emoji（本地 vendor/lucide.min.js，UI 零 emoji）；深/浅双主题完整 token（shell.js 持久切换）；7 页结构确立并经 Chrome headless 深浅双主题截图验证。
- **产品功能设计 v2（定位升级）**：[docs/PRODUCT-DESIGN.md](docs/PRODUCT-DESIGN.md) 重写——从「AI VTuber 工作台」升级为**通用个人 AI 工作台**（用户决策 D6~D10）：桌宠/直播/星露谷等全部收编为**可开关插件**；插件系统对齐 dsh（Cordis 插件树/defineTool/三层约定）+ 兼容层规划；新增 **ACP Harness 层**（参考 pingdotgg/t3code，MIT 68.5k★，已克隆分析：providers-acp/线程/远程审批，`dsh --profile acp` 直连）；技术栈选型（React 19 + Tailwind v4 + zustand + motion + **lucide-react 图标** + Electron + WebUI 双形态 + Vite 评估）；主题系统（深/浅/跟随+主题色）；ROADMAP 新增 M6 批次 4 工单（Shell+插件内核 / ACP Harness / dsh 兼容层 / WebUI），原 T-M5-03 并入 T-M6-01、T-M5-07 并入 T-M6-02。

### Changed

- **默认启用 LLM 大脑（用户指令）**：`autodrive-host` 的 `brainMode` 默认 `'llm'` 且 `runner` 初始 planner 直接注入 `LlmPlanner`（DeepSeek key 就绪即用）；key 未配置时自动回落规则日程并在顶栏显示。真机验证：启动即 `{"mode":"llm","llmReady":true}`、顶栏按钮「LLM 大脑」、决策流 `planner=llm-xiaojing`；规则日程仍可一键切回。

### Fixed

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

- **OpenCode Go 400 `MissingSessionID`（用户真机粘贴 key 后报错）**：按官方 Go API 规范补齐必需头 `x-opencode-session: ses_<stable>`（同一会话×槽位恒定，供路由与 Prompt Cache）+ 客户端 `User-Agent: xiaojing-workbench/1.0`；Base URL 迁移到 canonical `https://opencode.ai/inference/go/openai/v1` 与 `/anthropic/v1`；模型发现改走协议无关根 `https://opencode.ai/inference/go/v1/models`。真机验证：连接检测 1.5s 通过、拉取 5 个模型、网关真实回话 2.1s 并记账 `providerId=opencode-go/modelId=deepseek-v4.1-flash/426 tokens`。
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
