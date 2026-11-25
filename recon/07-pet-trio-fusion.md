# 三上游桌宠项目融合分析 · v2（recon/07）

> 日期：2026-11-24 ｜ 仓库：whale-isle（ai-vtuber-workbench）
> 方法说明：原计划 4 个子代理并行深挖，全部因模型服务配额失败（subagent_account_limited），本报告由主代理直读完成。
> 一手阅读：三仓顶层结构、LICENSE 全文、CHANGELOG/FEATURES/README、样例数据（character.json / manifest.json / actions.json / pets.json）、接入层文件清单、本仓融合面代码；沿用了本会话前六份 recon 的一手结论。
> **未逐行审计**：crosspet 14 个集成实现与 34 个角色 JSON 全量、dsh-pet 646 个 TS 源文件、aboutme-pets 全部 1040 动作。凡只读到 README/CHANGELOG 层的结论均在文中标注「（CHANGELOG 层）」等来源层级；待证项见 §6。

---

## 0. 一句话结论

主线维持上一轮判断——**打磨「桌宠陪伴主循环」**，但定义升级为三支柱：
**① 对话-语音-气泡闭环（dsh-pet 蓝本）× ② 状态跟随与关系成长（crosspet 蓝本）× ③ 素材广度与自制链（aboutme-pets 蓝本）**。
三个上游恰好与本仓三条渲染路径一一对应，它们的功能各占陪伴体验的一层；融合工作 90% 落在这条线的延长线上。而融合的瓶颈不在素材，在主循环自身的可靠性缺口（语音终态不闭合、主进程零测试覆盖）——先修出口，再灌内容。

---

## 1. 许可证事实（第一件要做的事：修台账）

### 1.1 crosspet（v1.4.1，2026-11-24）

| 对象 | 许可 | 证据 |
| --- | --- | --- |
| 源代码（app/integrations/tools/tests） | **MIT**（Copyright (c) 2026 lokicorvus and CrossPet contributors） | 根 `LICENSE`，尾注明确「The MIT License above covers the source code only」 |
| 角色立绘/设定/生图提示词（`characters/`、`docs/prompts/`、`docs/images/`） | **CC BY-NC-SA 4.0**（署名、非商用、相同方式共享） | `characters/LICENSE.md`，含原作者署名表：DeepSeek 原型「溟月」@上善无形、女仆鲸鱼娘「大肥鱼」@ZipZipPipe、GPT/GLM/千问/Kimi/豆包/Grok 立绘 @ZipZipPipe 等 |
| 台词文本（character.json `lines`、egg 剧本、小本子文案） | 随 `characters/` 目录 → CC BY-NC-SA 4.0 | 同上（`characters/` 目录整体授权） |

判定：**代码可移植（保留版权头）；立绘/台词/提示词 NC-SA，本仓 D5 本地自用豁免下可用，商用前清洗。**

### 1.2 dsh-pet（HEAD 2026-11-17，仅 1 个新提交）

| 对象 | 许可 | 证据 |
| --- | --- | --- |
| 代码（src/scripts/tools） | **MIT** | 根 `LICENSE`（REFERENCE-dsh-pet.md 2026-11-15 原文核实；本轮未复读全文，列待证） |
| 「大肥鱼」114 个 webm | **CC BY-NC-SA 4.0**（形象原型溟月 @上善无形，女仆鲸鱼娘设计 @ZipZipPipe，B 站声明禁商用） | THIRD_PARTY_NOTICES.md:44/64/65（本仓已按 `DEV_ONLY_NON_COMMERCIAL` 入库） |
| prompts/（绿幕提示词）、scripts/（素材链脚本） | 按 MIT 处置（随代码仓库分发），开工移植前复读 LICENSE 全文确认无二段例外 | 列待证 |

11-15 之后仅 1 提交（fb38ce6 fix(memory)）→ `docs/REFERENCE-dsh-pet.md` 的结论**仍然成立**，无新增功能需要吸收。

### 1.3 aboutme-pets（HEAD 2026-11-19）⚠ 本仓台账有错误

| 对象 | 真实许可 | 证据 |
| --- | --- | --- |
| `pets/dsh`、`pets/dsh1`（dsh 血统两包） | 包内带 `LICENSE-code.txt`/`LICENSE-assets.txt`，**文本为 MIT（Copyright PC2005-cloud）**；但上游 README 明言「上游两份 LICENSE 均为代码 MIT，**不覆盖素材限制；素材禁止商用**」，且底层形象权（溟月/ZipZipPipe）本身是非商用声明 | 随包 `pets/dsh/LICENSE-*.txt`（已读全文）；上游 `README.md:40-41` |
| 其余 7 包（gpt/claude/gemini/qwen/glm/grok/kimi） | **无任何 LICENSE 文件**；README 声明基础立绘来自 crosspet（CC BY-NC-SA 4.0），动作/音轨由仓库作者生成，petpack 转换「不改变本仓库 CC BY-NC-SA 4.0 授权：禁止商用、公开使用须署名本仓库」 | 上游 `README.md:47-48、:117`；`find` 全克隆仅 4 个包内 LICENSE + TVM 子目录 LICENSE；`git log --all -- LICENSE` 从未有过根 LICENSE |
| 仓库代码（index.html 播放器、convert 脚本、make_petpack.py） | **无许可证** → 只借思想、不抄码 | 无 LICENSE；README 未声明代码许可 |
| `Transparent-Video-Maker/` | **MIT**（第三方依赖 ffmpeg GPL v3 / rembg MIT） | 上游 `README.md:105`、`Transparent-Video-Maker/LICENSE` |

**台账错误**：`docs/THIRD_PARTY_NOTICES.md:41`（「MIT（每套包内 LICENSE-assets.txt / LICENSE-code.txt，Copyright (c) 2026 PC2005-cloud）」）、`:43`、`:68`（「素材虽 MIT」）与事实不符——只有 2/9 包有 LICENSE 文件且那两包的素材限制被上游 README 明文保留；「Copyright PC2005-cloud」是 dsh-pet 作者，被错误安到 hunmer 的仓库上。
**处置**：D5 本地自用豁免下 9 包全部可用（scope 标记 `DEV_ONLY_NON_COMMERCIAL` 本来就正确），但许可列必须改写为上表口径；dsh/dsh1 两包即便有包内 MIT 文本，也按非商用处置（包内文本洗白不了形象权）。

---

## 2. 三个上游分别是什么、最强资产是什么

### 2.1 crosspet —— 「跟着你用的 AI 演戏」的机制与内容重仓

- 形态：C#（Windows WebView2）/ Swift（macOS）/ web 三宿主 + 14 个 AI 接入面。宿主层对本仓（Electron）**不适用，只吸收机制与内容**。
- 接入面（`integrations/`）：claude-code（hooks.json + mod 插件 `register.ts`）、codex、deepseek（dsh-plugin-crosspet）、gemini/antigravity、cursor（python bridge）、qwen、grok、hermes、opencode（V2 插件）、trae、workbuddy、ccgui、通用 `crosspet-hook.py`。
- 状态→姿态映射：`integrations/crosspet-hook.py:27` `BIG_JOB_TOOLS = 8`（一轮 ≥8 次工具 = 大活），`:876` 结束时 `proud` 否则 `happy`；`register.ts:254` aborted→surprised、出错→oops。
- 角色包（`characters/`，34 目录 = 17 正编/皮肤 + 17 egg-*）：每角色 ~60 张姿态 webp（含 8 个 `fest_*` 节日、`edge_left/right_peek` 贴边探头、`busy_left/right`、`dizzy`、`coaxed`、`compact`、`delegating`…）+ `character.json`（字段：`name/accent/apps/greeting/lines{idle,listening,thinking,reading,writing,running,…}/glyph/idleActions/correctedPose/fx`）。
- 关系成长内容（CHANGELOG 1.3.9→1.4.1，信息密度极高）：多桌宠按 AI 客户端各一只、集合/解散/叫出来；「她们的友谊」（每对 10 心、四档、friendship.json）；每对台词三档 6+ 段、带真实数字、8 分钟冷却；小本子两页（第一页统计+批注随轮数变化+落款随时间/日期成就变化；第二页「朋友们的留言」按天留页、回溯 60 天、每对四档 4+ 条）；迷你小帮手（1.4.1，Q 版自己跟随 + 好朋友互送，`tools/mini_art.py/mini_cut.py/mini_sheet.py` 素材链）；久坐/喝水提醒（默认关、干活时等、夜静音、藏 5 分钟算起身）；「让开」Alt/Ctrl 按住半透明穿透；性格皮肤独立口吻；气泡停留按字数 12–20 秒、下一只等上一句再接话；CLI 额度显示（Claude/GPT/Gemini 5h/周、Codex 重置语义）。
- 素材链：`art/`（生图规则/任务/姿态/角色）+ `docs/prompts/` 生图提示词（CC BY-NC-SA）。
- 测试：`tests/` 30+ 文件（额度探测、彩蛋、cards、companions、break reminders…）。

### 2.2 dsh-pet —— 「怎么把话说好、把声出对」的机制重仓（MIT）

- 六大功能（FEATURES.md，全部有代码对应，本仓吸收程度见 §3.2）：余额六档展示（每 20% 一档、三种触发、每宠开关）；碎碎念与对话（每宠人设、四种入图、表情包回复、记忆窗口、天气城市环境行）；语音（edge TTS + ASR + **气泡等语音/单端出声/失败静音喇叭**三原则 + 合成/识别可插槽）；工作状态六档联动（工具具体化台词：`git push`→「该推上去了吧，我来」、清单优先）；待办清单（自绘日历、提醒密度阶梯 24h→12h→4h→1h→20m→5m、逾期 30min/6h）；睡觉（三段接力、完全安静、说梦话、多套睡姿候选）。
- 素材：114 个 640×360 VP9-alpha webm + `assets/sound` + `assets/memes`（本仓**未同步**后两者）。
- DIY 全链（MIT，**本仓最大可移植增量**）：`prompts/` 3 份配方（10 秒动作/睡觉三段/系统图标）→ 绿幕视频 → `scripts/chroma_step02.py` HSV 自动抠像（PR 手工抠像可覆盖）→ `watermark_step01.py` → webm；睡觉三段帧连续性硬规则（入睡尾帧=循环首帧=醒来首帧）；`openapi.yaml` 25 个本机端点契约（含 `/pose/report`、`/playback/{id}/report` 回执上报语义）。

### 2.3 aboutme-pets —— 素材广度与转换链（素材 CC BY-NC-SA，工具 MIT）

- 9 包 1040 动作（VP8X alpha 640×360 精灵图，统一 12fps）+ 480 m4a 音轨；音轨覆盖极不均：gemini 96 / glm 97 / grok 106 / kimi 105 / qwen 66 条 vs claude 8 / dsh1 2 条（README 表）。
- manifest schema：`animations[]{id,name,category,sources.webp,spritesheet{frameWidth,frameHeight,columns,rows,frameCount,fps},facing}`，`category` 12 分类（待机/移动/玩耍/日常起居/吃喝/运动健身/才艺表演/手工节日/工作职业/娱乐休闲/情绪反应/换装造型）。
- 运行时亮点：**音画同步时钟**——有音轨的动作以 `audio.currentTime` 驱动帧号（`index.html:518` `frame = Math.floor(audio.currentTime * fps) % frameCount`），无音轨才用 rAF 计时。
- 转换链：`convert_video_pet_spritesheet.py`（webm→精灵图，单 WebP ≤1.5MB 上限）、`spritesheet_to_video_pet.py`（精灵图→透明 VP9 webm，yuva420p）、`scripts/make_petpack.py`（转 dsh-pet petpack，其动画池映射表：待机/拖拽/点击/移动/余额档/碎碎念/工作状态/睡觉三段/对话表演）、`Transparent-Video-Maker/`（绿幕/纯色抠像 + rembg AI 抠像，MIT，可直移）。

---

## 3. 融合状态矩阵（类别级）

### 3.1 crosspet → 本仓

**已融合**（证据）：
| crosspet 功能 | 本仓落点 |
| --- | --- |
| 静态立绘 + `<img>` 淡入渲染 | `packages/pet-renderer/src/pose-skin.ts`（pose-skin 路径）+ 姿态头顶动效 `pose-effects.ts` |
| character.json（lines/fx/greeting/fest_*） | `apps/desktop-host/src/main/pet-packs.ts:304-416`（readCrossPetPoseProfile / readCrossPetCharacters lines Map） |
| egg-* 五段彩蛋 | `pet-packs.ts:236` readCrossPetEggScripts → `egg-theater.ts`（pop→pretend→caught/escape→bye） |
| 每角色手写字体（8 woff2） | `notebook-fonts.ts`；随包 `app/web/fonts/notebook/`（sync-pet-packs.mjs:49） |
| 友谊规则 | `packages/local-store/src/friendship.ts`（自述「移植 CrossPet friendship.js 规则」，DAILY_CAP=15、HEARTS_MAX=10、四档） |
| 久坐/喝水提醒 | `break-reminders.ts` + index.ts 60s 定时器 |
| 「让开」Alt 穿透 | `global-alt-peek.ts`（50ms 轮询） |
| 集合/解散/叫出来 | `pet-control-host.ts` |
| 节日/时段问候 | `pet-renderer/festivals.ts` + `greeting-schedule.ts` |
| 按前台应用匹配角色 | `front-app-watcher.ts` + `custom-character.ts` matchCharacterForApp（≈ character.json `apps` 字段） |
| CLI 工作跟随 hook | `work-follow-hook.mjs`（9 来源）+ `work-follow-installer.ts`（写三家配置）≈ crosspet 14 接入面的子集 |

**未融合/差距**（按价值排序）：
1. **小本子内容深度**（crosspet 1.4.0/1.4.1）：按天留页（有事才留、回溯 60 天）、第一页批注随轮数变化、落款随时间/日期成就变化、每对四档留言 4+ 条轮换、成就纪念日体系（认识 7/30/100/365 天、第 100/1000 轮、摸头 100 次）。本仓 T-M6-65 已有双页骨架，内容深度差一个量级。
2. **每对台词**：三档各 6+ 段、引用真实数字（今天谁干得多/被摸得多/认识几天）、冷却机制。本仓 friendship banter 每档 2 条级。
3. **气泡按字数停留 12–20 秒** + 多宠对话时下一只等上一句显示一会儿。本仓气泡 60s TTL 兜底 + speaker 串行，无按字数时长。
4. **BIG_JOB_TOOLS → proud**（crosspet-hook.py:876）：一轮 ≥8 工具结束演「得意」。本仓 work-follow 无。
5. **correctedPose（sorry）**：出错/被打断时道歉姿态。本仓有工作记仇、无道歉。
6. **迷你小帮手**（1.4.1）：Q 版跟随 + 好朋友互送（素材链 mini_*.py）。
7. **接入面缺口**：TRAE/OpenCode/CC GUI/WorkBuddy/Hermes 五个在 `work-follow-hook.mjs:19` 白名单外；CC GUI「一次接全部 CLI、认不出的模型由当前角色演」。
8. **CLI 额度显示**（tests/ 有 codex/antigravity 额度探测实现）：本仓 CLI 状态卡无额度。
9. **性格皮肤独立口吻**（1.4.0）：本仓换装皮肤共享台词。
10. **按会话内模型换角色**（DSH 中途换模型收尾、Claude Code 增强版走别家接口）：本仓按 CLI 来源定角色，粒度不到模型。

### 3.2 dsh-pet → 本仓

**已融合**：webm 双 video 零黑帧（`webm-renderer.ts`；上游印证「首尾相接/防黑帧」）；语音锁三原则（本仓主进程 `audio-lease.ts` 工程化更强：TTL 120s/P0 抢占/队列/跨窗广播）；余额分档（本仓 `riceLevelOf` 五档 vs 上游六档每 20%）；睡觉安静模式 + 梦话（pet-stage 整理循环）；多屏边界（`display-region.ts` 自述移植 `displays.ts` 子集）；114 webm 入库 + `gen-pet-manifest.mjs`。

**未融合/差距**：
1. **DIY 素材链**（价值最高、MIT 可直移）：prompts 3 份配方 + HSV 自动抠像 + 手工抠像覆盖 + 水印遮罩 + 睡觉三段帧连续性校验。本仓 creator-host/pixel-sprite-pipeline 面向 Stardew 像素，**没有透明视频链**。这是「一键替换商用素材」管线的自制半边。
2. **对话体验**（FEATURES §2）：四种入图（文件/截屏/拖拽/Ctrl+V）、表情包目录回复、每宠独立人设、记忆窗口（带几轮历史可视化）、天气城市环境行。本仓 chat 无图、人设全局单份、无表情包。
3. **ASR 听你说**（§3.6）：本仓零 ASR（audio-ai-worker 无识别端点；grep `asr|语音识别` 无命中）。上游留了「接自己的服务」槽。
4. **用户待办 + 提醒阶梯**（§5）：本仓只有健康提醒，无用户待办。
5. **assets/sound + assets/memes 未随包同步**（sync include 只拿字体）。
6. **sprite-sheet 路径的睡觉三段通用化**（config `animations.sleep` start/loop/end 多套候选）。
7. **余额「每宠单独开关」**。

### 3.3 aboutme-pets → 本仓

**已融合**：9/9 包导入器（`aboutme-pets.ts` ABOUTME_PACKS → userData/pet-characters）+ 随包直入（sync-pet-packs.mjs:42 include `pets/` 全量 → extraResources）；spritesheet-renderer canvas 逐帧 + 帧 JSON 回退；动作音轨 m4a + TTS duck 15%（`effectiveVolume`）；idle-mix 混播；patrol 用 `moving` 帧区间 + `facing` 镜像；动作播放器（fetch audioUrl）。

**未融合/差距**：
1. **音画同步时钟**：上游有音轨时以 `audio.currentTime` 驱动帧（index.html:518）；本仓 rAF 按 fps 走 + duck → 有音轨动作声画错位。小改动、高可见收益。
2. **category 语义未进氛围池**：导入链已携带 category（`aboutme-pets.ts:257`）、契约有字段，但 `ambient-filter.ts` 只用自有 5 类 + 关键词（:57 余额、:118 时节）。映射后场景过滤直接吃上游 12 分类。
3. **契约 JSON Schema 漂移**：`facing/moving/category` 在源码里、不在 `schema/*.json`（gen:contracts 未跑）——先清漂移。
4. **无音轨包降级**：claude 8 条 / dsh1 2 条音轨，说话类动作多半无声 → 按 pack 音轨覆盖率决定是否挂 audio 元素。
5. **make_petpack.py 的动画池映射表**（9 类）值得抄成 9 包统一槽位映射（现为 11 槽位+池的关键词匹配）。

---

## 4. 重新给出的结论

**主线不变、定义升级：「陪伴主循环 2.0」**（对话-语音-气泡闭环 × 状态跟随与关系成长 × 素材广度与自制链）。

1. 三个上游与本仓三条渲染路径一一对应（dsh-pet→webm、aboutme-pets→sprite-sheet、crosspet→pose-skin），它们的功能也各占陪伴体验的一层：dsh-pet 管「怎么把话说好、把声出对」，crosspet 管「跟着谁干活、和谁有什么关系」，aboutme-pets 管「有多少动作与声音可演」。**把这条线打磨到完美 = 把三个上游的精华各归其位**；游戏线/直播线与三上游交集很小，不是融合的主战场。
2. 融合的瓶颈不在素材量（素材已随包 2GB），在主循环可靠性：语音终态不闭合（`voice-host.ts:343/345/355` 三个早退分支不发终态 → 气泡挂 60s TTL）、主进程在覆盖率门禁外（vitest.config.mts:23）、两套语音锁并存。素材再多，气泡挂一分钟一样难看。
3. 「完美融合」的法律含义：D5 豁免下素材可全部随包，但**台账必须如实**（aboutme-pets 非 MIT），商用清洗线要真的存在——T-F 的 DIY 链就是它的自制半边。

---

## 5. 工单序列（每张 ≤8 文件）

| 序 | 工单 | 内容 | 关键文件 | 许可注记 |
| --- | --- | --- | --- | --- |
| 1 | **T-A 语音终态闭合** | 三个早退分支（节流 ok:true / 内心戏关 / 空台词）必发 `speech-result` 终态 | `voice-host.ts` + `voice-host.spec.ts` | 本仓自有 |
| 2 | **T-B 主循环测试** | 扩写 `autodrive-host.spec.ts`（注入假 gateway/voice/memory）+ `companion-loop.e2e.spec.ts` + coverage 纳入 main | `autodrive-host.spec.ts`、`vitest.config.mts`、新 e2e | 本仓自有 |
| 3 | **T-C 一致性清理** | 饭碗缓存折扣口径、RiceBowl 死代码去留、`pet:characters-changed` preload 中继、删渲染层 TTS 骨架 | `token-meter.ts`、`rice-bowl.ts`、`preload/index.ts`、`pet-stage/main.ts` | 本仓自有 |
| 4 | **T-D 台账与复评档案修正** | THIRD_PARTY_NOTICES aboutme 行改写（§1.3 口径）；新建 `REFERENCE-crosspet.md`、`REFERENCE-aboutme-pets.md`；REFERENCES.md 第二轮表补 crosspet 1.4.1；REFERENCE-dsh-pet 复评记录补一行 | 4 个 docs 文件 | 文档 |
| 5 | **T-E aboutme 收口** | `gen:contracts` 清 schema 漂移 + ambient-filter 吃上游 category + spritesheet 音画同步时钟 + 无音轨包降级 | `schema/*`（重生成）、`ambient-filter.ts`、`spritesheet-renderer.ts`、spec×2 | 思想参考（上游代码无许可） |
| 6 | **T-F DIY 素材链**（切 F1/F2） | F1：TVM(MIT) + dsh-pet chroma/prompts(MIT) → `tools/video-pet/` 转换链（绿幕→透明 webm→精灵图→角色包），含睡觉三段帧连续性校验；F2：creator-center UI 接线 | 新 `tools/video-pet/`、`creator-host.ts`、`aboutme-pets.ts` 扩展 | **MIT 直移，保留版权头** |
| 7 | **T-G crosspet 关系成长对齐**（切 G1/G2） | G1 机制：气泡按字数 12–20s、BIG_JOB_TOOLS→proud、correctedPose→sorry、每对台词冷却；G2 内容：台词/小本子文案批量移植 + 台账登记 | `bubble-lifecycle.ts`、`work-follow-host.ts`、`friendship-host.ts`、角色包文案 | 机制=思想；文案=CC BY-NC-SA 需登记 |
| 8 | **T-H 对话体验补齐**（可选） | 图片附件 + 表情包回复 + CLI 额度显示 + 用户待办 | `autodrive-host.ts`、`director` UI、新 host | 思想参考（dsh-pet MIT 可部分直移） |
| 9 | **T-I 迷你小帮手**（可选） | Q 版跟随 + 好朋友互送；依赖 mini 素材链 | 新 widgets + 素材 | CC BY-NC-SA 素材 |

顺序：**A→B→C→D→E→F→G→(H/I)**。A/B/C 是「打磨到完美」本体；D 是合规地基（小而必须）；E/F/G 是「完美融合」的主体；H/I 按兴趣选做。

---

## 6. 待证项（本次未覆盖，如实声明）

1. dsh-pet 根 LICENSE 全文是否含「code only」尾注 → 决定 prompts/ 与 scripts/ 是否可整体直移。
2. crosspet 34 个角色目录逐包 lines/姿态数、17 个 egg 剧本台词全量（只抽读 claude/egg-deepseek）。
3. crosspet 14 个集成的实现细节（只读了文件清单与 crosspet-hook.py 两处关键行）。
4. aboutme 9 包逐包音轨覆盖实测（以 README 表为准，未逐包数）。
5. `importAboutmePets` 端到端导入验证（读到 category/facing 赋值行，未实际跑导入）。
6. 音画同步时钟改造后的实机听感（需真机）。
7. 子代理配额恢复后，可补四份逐仓深挖报告（07/08/09/10 号位空缺）。

## 7. 本次一手读取的证据清单

- crosspet：`LICENSE`（全文）、`characters/LICENSE.md`（全文）、`VERSION`、`CHANGELOG.md`（1.4.1/1.4.0/1.3.10/1.3.9 段）、`characters/` 35 项清单、`characters/claude/`（63 webp + character.json 全字段）、`characters/egg-deepseek/`（5 文件）、`integrations/` 14 目录文件清单、`tools/`/`docs/`/`art/`/`tests/` 清单、`crosspet-hook.py:27,876`、`register.ts:136,254`、`dsh-plugin-crosspet/lib/index.js:21,227`。
- dsh-pet：`FEATURES.md`（全文六节）、`MAKE-YOUR-OWN-PET.md`（前 45 行）、`openapi.yaml` 25 路径、`prompts/`/`video/`/`tools/` 清单、`dsh-pet/` 包结构（runtime/scripts/assets/src 五层）、webm 计数 114、`git log --since=2026-11-14`（仅 1 提交）。
- aboutme-pets：`README.md`（全文，含来源与许可节）、`pets.json`（头部）、`pets/gemini/`（100 webp + 96 m4a + manifest/actions 结构）、`index.html`（1027 行，音频时钟 :518）、`scripts/` 清单、LICENSE 文件全量定位（4 包内 + TVM）。
- 本仓：`assets/pet-packs/` 实际结构（aboutme-pets pets/ 全量、crosspet 907 webp）、`sync-pet-packs.mjs:38-56` include 规则、`pet-packs.ts:166,235-241,280,303-309,356,389-416`、`aboutme-pets.ts:88-90,247-275`、`ambient-filter.ts:14,57,118-122`、`THIRD_PARTY_NOTICES.md:40-44,64-70`、`voice-host.ts:343/345/355`、`vitest.config.mts:23`、`bubble-lifecycle.ts:5-25`。
