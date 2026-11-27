# 声音工坊 2.0：音色设计、音色克隆与表演中心重设计方案

> 分支：`feat/voice-studio-redesign`（独立 Git Worktree）  
> 日期：2026-11-27  
> 视觉基线：[ADR-003](../v2/adr/ADR-003-uiux-tidepaper-primary-and-themes.md) / [DESIGN-SYSTEM.md](../v2/DESIGN-SYSTEM.md)（潮汐纸 Tidepaper v3.1 + 多主题兼容）  
> 架构锚点：[Blueprint 05](../v2/blueprint/05-角色人格声音与表演系统.md) / [VOICE-PERSONA-xiaojing.md](../v2/VOICE-PERSONA-xiaojing.md) / [ADR-005](../v2/adr/ADR-005-singing-and-stage-technology-route.md)

---

## 1. 问题诊断：现有声音模块的五大痛点

通过对现有 5 个语音视图文件（`voice-center-panel.tsx`、`voice-design-lab.tsx`、`voice-workshop-panel.tsx`、`voice-panel.tsx`、`voice-studio-panel.tsx`）及主进程 `v2-kernel-host.ts`、`voice-workshop.ts`、`voice-host.ts` 的全量审计，当前体验存在以下结构性问题：

1. **信息架构严重碎片化（同功能四处散落）**：
   - 「音色设计」同时出现在首屏 `声线来源 → 设计声线`、Tab 2 `音色设计`、Tab 4 `音色工坊` 以及 Tab 3 弹窗 `AI 描述捏声线` 四个入口，心智冲突。
   - 顶部长达两屏的 6 组工程诊断/凭据区块（9 角色条 + 3 张后端状态卡 + 引擎档位 + 声线库 + 三张声线来源卡 + 4 张密码输入框）在所有页签上方常驻堆叠，真正的创作工作台被压在首屏 1200px 以下。
2. **音色克隆缺少完整闭环与合规护栏**：
   - 现有克隆仅是一个隐藏在配置盒里的「选择 wav / 试听 / 设为声线」三按钮卡片；无拖拽导入、无多格式前端转码、无麦克风录制、无波形可视化与片段裁剪、无真实声学质检（时长/响度/削波/底噪）、无声音权属授权声明，且克隆结果无法进入版本时间线与一致性质检体系。
3. **音色设计存在「漂移陷阱」与对比缺失**：
   - 旧 `VoiceDesignLab` 允许直接把纯 `mimo-tts-voicedesign` 设为默认声线，与实测结论（同描述 ×10 说话人余弦最低 `0.4145`，必须「设计出候选 → 选定 → VoiceClone 定格锁死」）自相矛盾。
   - 候选列表缺少真实音频波形、播放进度条、A/B 并排对比与持久化恢复（切页或重开后候选不可见）。
4. **未接入 Tidepaper v3.1 视觉规范与既有 V2 能力**：
   - 缺少 `PageHead` 衬线页头与纸面层次，工坊充斥 `9.5px`/`10px` 挤占排版与内部研发术语（如 `item 10 本机实测`）。
   - 主进程已具备的 `AudioMixer` 多轨输出路由（桌面 vs OBS）、`lipFrames` 实时口型包络、`LicenseBadge` 许可徽章、`voiceSpeak` 桌宠真机发声未在语音中心形成闭环联动。
5. **说话（TTS）与唱歌（SVS/SVC）边界不够直观**：
   - 需与 `ADR-005` 及现有「点歌台」对齐，明确区分角色日常对话声线（TTS/VoiceClone）与独立唱歌管线（SVS/SVC/RVC）。

---

## 2. 行业成熟方案对标与吸收矩阵

| 参考平台 / 生态 | 成熟模式与核心优势 | 本次吸收到鲸屿的设计落点 | 明确不照搬（及原因） |
| :--- | :--- | :--- | :--- |
| **ElevenLabs Voice Lab** | 清晰的「My Voices / Voice Design / Instant Voice Cloning」三柱架构；多候选同步生成 + 显式额度消耗提示；上传音频质量检测提示；克隆前声音权属确认（Consent Gate） | 统一「声线库与版本」总览 + 独立「音色设计」与「音色克隆」工作室；每次生成/试戴/体检明确标示消耗合成次数；克隆强制勾选声音权属与来源留档 | 不做服务端 Voice Captcha 活体核验（本地桌面架构无云端账号体系，改为本地强制权属声明 + SHA-256 留痕） |
| **Fish Audio Studio** | 面向资产的声线卡片管理；~10s 极速 Instant Clone 引导 + 录音朗读脚本；多任务统一复用同一声线资产 | 克隆台内置 3 套中文朗读提词卡 + 5–12s 黄金区间提示；声线卡片直接作为全软件（对话/游戏/直播）单点资产 | 不内置 GPL/非商用权重下载器（遵循许可证洁癖） |
| **MiniMax Audio / Speech Studio** | 自然语言音色描述画布 + 输入框下方一键插入内联音效标签（如 `(sighs)`）；音色参数与风格实时试听 | 音色设计配方拨盘 + 自然语言描述器 + 试戴/表演台内置一键内联标签芯片（严格限定已验证的 `(sighs deeply)` / `(pauses for a moment)` / `(cough)` 且提示每句最多 1 个） | 不做虚假滑块（MiMo 无独立 pitch 参数且实测音高无法区分情绪，绝不伪造无效滑块） |
| **Volcengine 豆包语音工作台** | 严格解耦「声音身份 Voice Identity」与「情感表达风格 Acoustic Style」，避免换情绪等于换人 | 固化「单一参考干声锁死音色 + 风格指令/标签控制五档情绪」路径；严禁按情绪切换不同来源参考音频 | 不做单句多轨混 BGM 生成（鲸屿由独立 `AudioMixer` 多轨管理） |
| **Cartesia Sonic / Hume Octave** | 交互式真实波形检查与拖拽定位、A/B 并排盲听对比、延迟与稳定性指标诚实可视化 | 浏览器端 Web Audio 真实解码 PCM 绘制交互波形与裁剪选区；支持候选 A/B 并排固定对比；CAM++ 一致性可视化仪表条（标注 `0.70 / 0.80 / 0.85` 阈值） | 不伪造流式首包数字（MiMo 当前为非流式 wav，如实标注 `非流式`） |

---

## 3. 重新设计后的信息架构（IA）与页面布局

保留侧栏单一入口 `角色 / 声音与表演`（`tab = 'voice'`），用 **1 个紧凑页头状态栏 + 5 个职责纯粹的工作台页签** 取代旧版两屏堆叠：

### 3.1 顶部统一页头（Tidepaper `PageHead` + 紧凑在场条）
- **标题区**：眉标 `VOICE IDENTITY & CLONING STUDIO` + 衬线 `声音与表演` + 简明定位说明。
- **右侧快捷操作**：
  - 当前配置角色切换条（紧凑药丸条，支持 9 角色独立切换与绑定感知，保持 `[data-voice-char]`）。
  - 实时抢麦锁状态胶囊（空闲 / 正在发言）+「让桌宠试说」快捷按钮。
- **单行实时状态 Meta 条**（替代原 3 张状态卡 + 2 屏配置墙）：
  - 当前生效声线名称 & 定格来源
  - 当前推理引擎 & 真实探针状态（`[data-voice-backend]`）
  - 最近一致性质检结果（`锁得稳` / `偶尔飘` / `未体检`）
  - `<LicenseBadge />` 许可边界徽章
  - 会话合成计数（`本次会话 N 次 · MiMo 限免`）+ 快捷跳转「引擎与凭据」

### 3.2 五大专注工作台页签

| 页签 ID | 标题 | 核心职责 | 与软件其他模块的联动 |
| :--- | :--- | :--- | :--- |
| `voices`（默认） | **声线库** | 当前生效声线大卡片（真波形试听、CAM++ 一致性仪表、许可与权属信息）+ 版本时间线（出厂 / AI 设计 / 真人克隆，支持切换、重命名、回退、删除、体检、导出 WAV）+ MiMo 官方 9 内置零漂移音色 + 多角色绑定概览 | 同步 `CharacterCore.voiceIdentity`、`userData/voice-workshop/`、`voice-bindings.json` |
| `workshop` | **音色设计** | 四步闭环引导：① 配方拨盘（年龄段/质感/语速/尾音）+ 快捷配方 + 自然语言描述；② 批量生成 2–8 条候选（含自定义预览句与单句 `optimize_text_preview` 快测）；③ 真实波形卡片 + **A/B 并排对比槽** + 4 情绪多句试戴（强度 A/B/C，默认 B）；④ 命名定格为 VoiceClone 固定声线 + 自动 CAM++ 体检 | 持久化候选列表（重启/切页不丢已付费音频）；定格即生效全场景对话与桌宠发声 |
| `clone` | **音色克隆** | 完整 Instant Voice Cloning 工作室：① **本地音频拖拽/上传**（支持 WAV/MP3/M4A/OGG/WebM，前端 Web Audio 真实转码 24kHz 单声道 16-bit PCM WAV）或 **麦克风实时录制**（真实电平表 + 3 套中文提词卡）；② **真实波形交互裁剪**（5–12s 黄金区间）+ **自动响度归一化 (-3 dBFS)** + **确定性声学质检**（时长 / 采样率 / RMS / Peak / 削波 / SNR 估算）；③ **强制声音权属与合规声明门禁**；④ 一键入库定格为 `uploaded` 声线版本，支持 4 情绪试戴与 CAM++ 体检 | 生成的克隆声线直接成为一等 `VoiceTimbreVersion`，并同步 `voice-clone-sample.wav` 与 `CharacterCore` |
| `studio` | **表演与精调** | 上半部：**5 情绪实时表演试听台**（情绪矩阵 + 强度 A/B/C + 内联标签快捷键 + 真实 `lipFrames` 口型 Viseme 时间轴 +「在此试听」/「让桌宠在桌面说出」+ 跳转点歌台提示）；下半部：角色 5×5 绑定试听与本地 Audio Worker / RVC 唱歌参数精调 | 联动 `pet-stage` 实时发声与气泡、口型 Viseme、RVC 唱歌配置与「点歌台」 |
| `engine` | **引擎与凭据** | 引擎档位（商业 API 默认 vs 离线档，原样展示 `OFFLINE_TIER_COST_TEXT`）+ 商业供应商路由（MiMo 三模型 / MiniMax / OpenAI / OpenRouter）+ 本地 Audio Worker 实时探针 + **`AudioMixer` 多轨混音/动作原声 Ducking/桌面与 OBS 输出设备路由** + 4 家加密钥匙串凭据管理 | 联动 `provider-vault` 加密钥匙串、`AudioMixer`、OBS 音频输出、`pet-desktop-prefs.json` |

---

## 4. 契约先行与诚实红线

1. **所有新增数据结构先落 `packages/shared-protocol/src/voice.ts`**（Zod 校验 + TypeScript 类型单点源）：
   - `VoiceCloneConsentSchema`（声音权属类型、授权来源、显式勾选时间戳）
   - `VoiceAudioQualitySchema`（真实 PCM 计算的时长、采样率、声道、位深、RMS dBFS、Peak dBFS、削波标记、估算 SNR、综合评级与建议）
   - `VoiceTimbreVersionSchema` 增量兼容字段（`referenceSha256`、`durationMs`、`licenseScope`、`consent`、`audioQuality`、`tags`）
   - 新增工坊操作契约：`VoiceWorkshopCloneCreateInputSchema`、`VoiceWorkshopRenameInputSchema`、`VoiceWorkshopDeleteInputSchema`、`VoiceWorkshopVersionAuditionInputSchema`
2. **绝不造假与合规硬锁**：
   - 波形与声学质检 100% 由真实音频 PCM 数据确定性计算（客户端 Web Audio + 主进程 WAV 解析双重兜底），不渲染随机动画假波形。
   - CAM++ 体检工具缺失时继续如实返回 `unavailable`，绝不编造相似度。
   - 克隆声线未勾选声音权属确认（或第三方授权未填来源）在前端与主进程 Zod 契约层双重拦截。
   - 出厂声线（`factory`：`07 甜脆·元气`）永远不可删除、不可覆盖；用户所有设计/克隆版本仅落本地 `userData/voice-workshop/`。
   - 离线档代价文案与 MiMo 候选声明严格引用 `OFFLINE_TIER_COST_TEXT` / `MIMO_TTS_CANDIDATE_NOTICE`。


---

## 10. V2.1 增量融合：生产真闭环、统一试听条与 AI 设计直选克隆（2026-11-27）

基于对评审稿 `whale-isle-voice-v2-spec.md` / `whale-isle-voice-v2.html` 的复评与用户补充需求，在保持 Tidepaper v3.1 纸面视觉体系和实测声学铁律（VoiceDesign 定格转 VoiceClone、CAM++ 真实余弦体检）不变的前提下，新增以下闭环能力：

1. **创作 → 生产发声真闭环**：
   - `VoiceHost` 生产播报接入 V2 `VoiceProviderRouter`，合成在全局播放租约外异步准备、拿到真实 WAV + `extractWavLipSyncFrames` 后才占播放锁并驱动桌宠实时口型。
   - 默认回退策略 `voiceCloudFallbackPolicy = 'subtitle_only'`（保留气泡字幕、明确报错，绝不静默退化回系统 `say`）；仅用户显式切换 `system_say` 才回落旧链。
   - `GlobalAudioLeaseManager` 区分 `purpose: 'speech' | 'preview'`：正式语音随时打断试听、试听绝不抢正式麦且不广播 `coop:speaker` 与气泡终态。
   - `VoiceProviderRouter` LRU 缓存按角色版本 + 参考音频 SHA-256 锚定，切换版本或撤销授权立即清空失效；新增真实短句连通性测试与 401/403/413/429 分级报错。
2. **多角色独立声线锁定与合规撤权闭环**：
   - 声线版本库与角色绑定解耦（`characterBindings: characterId → versionId`），点击卡片只选中到右侧上下文详情面板（Inspector），绑定需显式确认；正被角色锁定的声线禁止永久删除（可先解绑或软归档）。
   - 支持收藏、软归档、搜索与来源筛选；新增一键「撤销声音授权并清理本地参考与原始副本」，立即阻止后续合成并解绑相关角色。
   - 严格对齐 MiMo 参考样本 Base64 ≤ 10 MB 硬上限（约 7.5 MB 原始 WAV），并可选本地保留未裁剪原始副本供撤回重裁（仅裁剪后副本在合成时发往云端）。
3. **音色克隆直选 AI 音色设计产物（用户新增核心工作流）**：
   - 音色克隆台 Step ① 新增第三入口 **「从 AI 设计音色选取」**，直接列出本机 AI 音色设计候选与已定格 AI 音色，支持一键试听并载入到波形裁剪器与 4 项声学质检（裁剪气口/尾音 + `-3 dBFS` 归一 + 自动填充血缘与 `ai_synthetic` 权属说明）。
   - 音色设计台每条候选与声线库详情面板均提供 **「送克隆台精修」** 快捷入口；设计台同时补齐「从当前角色人设摘取声音描述（预览确认、不读聊天记录）」及逐条生成取消/仅重试失败项。
4. **全站统一吸底试听播放器与导演指令预览**：
   - 全声音工坊 5 个分页共享唯一 `StickyAuditionBar` 单实例音频控制器，彻底消除多卡片音频叠播。
   - 表演与精调页新增场景/强度/导演指导编辑及脱敏三段导演指令实时预览。
