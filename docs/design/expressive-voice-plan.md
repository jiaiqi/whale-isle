# 桌宠「说话」的表现力语音链路 — 方案（item 10）

> 状态：**方案，未实现**。本文不含已落地的代码，不含已下载的权重，不含已安装的包。
> 撰写：2026-11-26。所有「实测」均标注机器与命令来源；所有「估算」明确写估算；未跑过的绝不算已满足。
> owner 已定口径（不可在本方案里被悄悄改掉）：**自托管优先、装了就能用、不依赖外部账号与网络；商业 API 只作兜底；音色为原创设计，不克隆 owner、不沿用现有「小鲸」音色；目标是情绪与表现力。**

---

## 0. 一句话结论

自托管表现力语音在本机 **可行，但要付两笔账**：一是磁盘（引擎运行时 ~1.9 GB + 权重 ~4.1 GB，首装约 6 GB），二是延迟（同机 GPT-SoVITS 实测 RTF≈0.39，CosyVoice 2 未测，目标 ≤0.35，达不到就走降级而不是硬吹）。

选型结论：**CosyVoice 2（0.5B，Apache-2.0）作为自托管主力**，IndexTTS2 因许可是 bilibili 自定义协议暂列实验、需法务过；F5-TTS 权重 CC-BY-NC-4.0 直接排除；GPT-SoVITS 只作「本机已装、可立刻出声」的开发期基线，不作产品默认。

一周内就能听见差异的路径 **不需要下载任何新权重**（详见 §7）：把现在返回正弦波 stub 的 `/tts/emotion` 换成真引擎，并把「表演脚本层」跑通。

---

## 1. 现状盘点（这些是读代码与跑命令得到的，不是推测）

| 项 | 真实状态 | 来源 |
| --- | --- | --- |
| 产品链路的本地语音 | `services/audio-ai-worker` 的 `/tts/emotion` 由 `EmotionTtsRouter` 处理，默认 `StubLocalBackend` / `StubCloudBackend` **都是正弦波合成**（按情绪改基频），**不是人声** | `services/audio-ai-worker/tts_engine/emotion_router.py` |
| 宿主侧情绪路由 | 5 档枚举 `sweet_normal / tsundere_refuse / rage_spray / lazy_yawn / happy_rice`，已贯通 persona → 语音 → 动作 → 口型 | `packages/shared-protocol/src/index.ts:30`、`packages/persona-brain/src/think.ts:120`、`apps/desktop-host/src/renderer/pet-stage/tts-router.ts:21` |
| 宿主侧 Provider | `local-audio-worker` 只是 HTTP 客户端，`supportsEmotion: true` 恒为 true（连 stub 也报 true） | `packages/voice-runtime/src/providers.ts:288` |
| 合成缓存键 | `${preferredProvider}|${voiceRef}|${emotion}|${styleMode}|${speed}|${text}`，**不含引擎版本与音色包版本** | `packages/voice-runtime/src/providers.ts:478` |
| 本机已有真引擎 | GPT-SoVITS 实例在 `127.0.0.1:9880` 监听，权重 `gsv-v2final-pretrained` 实测 **1.2 GB**，仓库 commit `6d51ffc`（2026-11-12）；参考音频只有 1 组 `genki_ref.wav`（4.11 s / 44.1 kHz / 立体声，来源未在 NOTICES 登记） | `lsof`/`du`、`docs/v2/evidence/O5-isolated-venv-toolchain-plan.md` |
| 本机已有 CosyVoice 代码 | `/Users/jiaqi/Documents/vibe/CosyVoice` commit `074ca6d`（2026-05-26），LICENSE = Apache-2.0，`.venv` 实测 **1.9 GB**（Python 3.10.20 + torch 2.7.0）；**`pretrained_models/` 实测 0 B**，`third_party/Matcha-TTS` 子模块为空 | `git log`、`du`、`ls` |
| HF 缓存里的 CosyVoice3 | 只有前端资源（`campplus.onnx`、分词器等）共 **4.0 MB**，LLM/flow 权重未下 | `du -sh ~/.cache/huggingface/hub/models--FunAudioLLM--Fun-CosyVoice3-0.5B-2512` |
| 机器 | Mac mini **Apple M4 / 10 核 / 32 GB / macOS 27.2.1 / 空闲 1.3 TiB** | `sysctl`、`df` |
| 唯一真实性能锚点 | GPT-SoVITS 同机推理 **1.01 s** 产出 **2580 ms** 音频（`[REAL-DEVICE]`）→ **RTF ≈ 0.39** | `docs/v2/evidence/P3-performance-stage-verification.md:149` |

**推论**：现在桌宠「说话」听起来是正弦波。这不是音色问题，是**根本没有接引擎**。所以「表现力」的第一步不是换更大的模型，而是把真引擎接上并把表演层做出来。

---

## 2. 问题一：引擎选型

### 2.1 许可（先过红线，再谈音质）

许可事实于 2026-11-26 通过 HF API `/api/models/<id>` 与仓库 LICENSE 原文核对：

| 引擎 | 代码许可 | 权重许可 | 商用再分发 | 判定 |
| --- | --- | --- | --- | --- |
| **CosyVoice 2（0.5B）** | Apache-2.0（仓库 LICENSE 原文） | **apache-2.0**（HF `license: apache-2.0`） | 可，保留 NOTICE/版权头 | ✅ **可作产品默认** |
| CosyVoice 3（Fun-CosyVoice3-0.5B-2512） | 同上 | **apache-2.0** | 可 | ✅ 可，但体积更大（见 2.2） |
| **IndexTTS2** | `index-tts` 仓库 LICENSE = **bilibili Model Use License Agreement**（自定义、需接受、有再分发义务；除非商用外不得用于改进其他 AI 模型） | HF **无 license 元数据** | **需法务逐条判** | ⚠️ 实验，不进默认链路 |
| **F5-TTS** | MIT | **cc-by-nc-4.0**（HF `license: cc-by-nc-4.0`） | 不可商用 | ❌ 排除 |
| **GPT-SoVITS** | MIT | HF 权重**无 license 元数据** | 不明 | ⚠️ 仅开发期基线，不作产品默认 |

> 结论一句话：**许可干净的只有 CosyVoice 系（Apache-2.0）**。这条不是音质比较，是红线比较——F5-TTS 再好也不能进产品，IndexTTS2 再好也要先有法务结论。

### 2.2 体积（HF API `blobs=true` 的精确字节，不是估算）

| 模型 | 全量 | 最小运行集（去掉可选文件） |
| --- | --- | --- |
| CosyVoice2-0.5B | 4.86 GB | **≈ 4.07 GB**（`llm.pt` 2023.3 + `CosyVoice-BlankEN/model.safetensors` 988.1 + `speech_tokenizer_v2.onnx` 496.1 + `flow.pt` 450.6 + `hift.pt` 83.4 + `campplus.onnx` 28.3 + 配置 ~4.3 MB）<br>可省：`flow.decoder.estimator.fp32.onnx` 286.3 + `speech_tokenizer_v2.batch.onnx` 496.1 |
| Fun-CosyVoice3-0.5B-2512 | 9.75 GB | **≈ 5.43 GB**（`llm.pt` 2024.7 + `llm.rl.pt` 二选一 + `flow.pt` 1329.1 + `speech_tokenizer_v3.onnx` 969.5 + `CosyVoice-BlankEN` 988.1 + `hift.pt` 83.2 + `campplus.onnx` 28.3）<br>全量里 `llm.pt` 与 `llm.rl.pt` 各 2024.7，通常只需其一 |
| IndexTTS-2 | 5.90 GB | ≈ 5.87 GB（`gpt.pth` 3484.7 + `s2mel.pth` 1202.2 + `qwen0.6bemo4-merge` 1192.1 + tokenizer 11.4） |
| F5-TTS | 6.74 GB（含 5 个变体） | 单模型 1.35 GB |
| GPT-SoVITS v2final | 本机实测 **1.2 GB** | 同左（已在本机） |

再加上引擎运行时（Python + torch + onnxruntime + 依赖，参照本机 CosyVoice `.venv` 实测 **1.9 GB**）：

> **首装总账 ≈ 6.0 GB**（运行时 1.9 + CosyVoice2 权重 4.07）。这是「自托管 + 装了就能用 + 不依赖账号」的物理价格，无法在两全其美的前提下压低。

### 2.3 中文自然度与情绪控制方式

| 引擎 | 中文自然度 | 情绪控制方式 | 离线 | 说明 |
| --- | --- | --- | --- | --- |
| CosyVoice 2 | 社区普遍评价高（**未做本机 A/B**） | ① zero-shot 参考音频克隆；② **自然语言 instruct**（「用撒娇的语气，稍微快一点」）；③ 同一说话人跨情绪靠换参考音频 | 全离线 | instruct 方式对「情绪强度」这种连续量最友好，正好对上我们的表演层 |
| CosyVoice 3 | 口径上更强（18 方言、更细粒度情感与非语言标记） | 同 2，且支持更多标记 | 全离线 | 体积 +1.36 GB，且本地仓库版本（2026-05 的 `074ca6d`）是否已完全支持 3 需实测 |
| IndexTTS2 | 口碑强，中文韵律好 | 情绪参考音频 + 时长控制 | 全离线 | 许可卡住，先不选 |
| F5-TTS | 尚可，长句偶有漂移 | 主要靠参考音频，instruct 能力弱 | 全离线 | NC 权重，排除 |
| GPT-SoVITS | 中文可用，情绪靠「每情绪一段参考音频」 | 5 段参考音频 + 停顿配置 | 全离线 | 已在本机，作为基线与一周内可听差异的载体 |

### 2.4 选型决定

- **产品默认：CosyVoice 2（0.5B）**。理由按权重排序：许可干净（Apache-2.0 代码+权重）> 情绪可用自然语言连续控制（对上表演层）> 体积在可接受区（4.07 GB 最小集）> 有流式能力（首包优化空间）。
- **不选 CosyVoice 3 作首发**：多 1.36 GB，收益（方言/更细情绪）对单桌宠短期不是瓶颈；留作 v2 升级路径。
- **不选 IndexTTS2**：许可未过法务，不允许拿「效果更好」去交换许可风险。
- **排除 F5-TTS**：NC 权重，触碰 AGENTS.md 素材非商用红线同款问题。
- **GPT-SoVITS 定位**：① 开发期基线（已装、可立即出声）；② 性能对照锚点；**不作产品默认**——因为权重许可元数据缺失，装进发行包等于把未知许可带进分发。

> 诚实标注：以上「自然度」判断来自公开评测与社区口碑，**本机没有做过盲听对比**。真正定稿前必须先跑一次盲听（见 §4.5），否则就是拿别人的耳朵替 owner 决定。

---

## 3. 问题二：没有真人捐赠者，怎么造一个原创音色

目标：一个**不指向任何可识别真人**、可商用、可长期保持一致的中文女声音色，且能承载 5 档情绪。

### 3.1 两条可行路线（都不需要 owner 出声）

**路线 A：本地随机说话人嵌入（完全离线，零账号）**
- 做法：用 CosyVoice 的 zero-shot 能力，**随机采样一个 speaker embedding**（不来自任何真人录音），用 instruct 描述音色，生成候选；再把最好的一条**冻结成参考音频**。
- 优点：不碰任何外部服务，契合「不依赖外部账号」。
- 风险：随机嵌入的音质/稳定性不可控，可能出「塑料感」；且**无法预先证明它不像某个真人**（只能事后人工确认 + 收到主张即换）。
- 成本：0 元，纯本地算力。

**路线 B：一次性云端音色设计（需要一次账号与费用，之后全离线）**
- 做法：用支持 voice design 的商业 TTS（如 MiniMax speech 系列的 voice design、ElevenLabs Voice Design）用自然语言描述生成候选音色，导出参考音频，之后**推理全部在本地**，不再联网。
- 优点：候选质量与可控性明显更好；商用条款可查（必须逐条确认「输出可商用」且「可作为克隆参考」）。
- 风险：违背「不依赖外部账号」的字面表述——**但只发生在设计期一次**，运行期仍然纯离线。这条需要 owner 明确点头。
- 成本：一次调用费用 + 一次账号。

> **这是本方案唯一一个需要 owner 在两条路线里选的地方**（见 §9 决策 3）。我不替 owner 选，因为一条是「完全离线但音色可能一般」，另一条是「一次外部依赖换明显更好的音色」。

### 3.2 候选生成与筛选管线（路线 A/B 通用）

1. **描述词定稿**（写死进仓库，作为音色档案的一部分）：
   - 年龄段：青年女声（听感 18–22）
   - 音色：中高音区、略带气声、明亮但不尖锐
   - 语速基线：偏快（0.95–1.05 倍标准）
   - 口音：普通话，无方言色彩
   - 性格投射：元气、嘴甜、被惹到会炸毛
   - 明确排除：萝莉音过度、播音腔、御姐低音、任何真人模仿
2. **候选数量**：3 组描述微调 × 4 个随机种子 = **12 条候选**（每条 3–5 s 试听 + 1 条长句 15 s 测稳定性）。
3. **筛选判据**（每条打分 1–5，owner 或指定听者单人打分即可，不搞委员会）：
   - 可爱度 / 辨识度（能不能一听就记住）
   - 中文自然度（有无机械感、字间粘连）
   - 长句稳定性（15 s 不漂、不破音、不突然变调）
   - 情绪可塑性（同一音色换成「炸毛」和「困倦」还像同一个人吗）
4. **收敛**：12 → 3（综合分前 3）→ 每条做 5 情绪 × 8 句压力试听 → **定 1 条**。
5. **冻结**：把定稿候选录成 **6–10 s 参考干声**（单声道、32 kHz 或 44.1 kHz、无背景音、无混响），并逐字转写 `refText`（空 `refText` 会触发内部 ASR，实测约 40 s 卡顿，契约里已强制非空）。

### 3.3 一致性怎么保证

- **单一锚点**：所有情绪都由**同一条冻结参考**派生，绝不「一个情绪一条不同来源的音频」——那正是跨情绪听起来换人的根因。
- **确定性参数**：`temperature`/`topP`/`topK` 在音色包里写死（契约 `TtsEmotionTuningParamsSchema` 已有这三个字段）。
- **版本 + 哈希**：音色包带 `voicePackId` + `refAudioSha256`；任何替换参考音频都是**新版本号**，不允许原地覆盖。
- **回归测试**：每次改音色包，把固定的 20 句语料合成一遍，算说话人嵌入余弦相似度（`campplus.onnx` 就在 CosyVoice 权重里）与 F0 区间漂移；**余弦 < 0.9 或 F0 中位数漂移 > 15% 判为不一致，禁止发布**。

### 3.4 权利链（这块必须写进 NOTICES）

- 参考音频**不是**来自任何真人录制 → 在资产清单标注 `licenseScope: COMMERCIAL_READY` 的同时，附**来源记录**：生成方式（路线 A 随机嵌入 / 路线 B 哪家服务的哪个型号）、生成日期、描述词、种子、服务条款快照链接与关键条款摘录。
- 路线 B 必须确认两件事，缺一不可：① 输出音频可商用；② 输出音频**可作为第三方 TTS 的克隆参考**（很多服务只允许①不允许②）。
- 不做「1:N 声音检索规避」——成本不现实。改为流程约束：**若收到任何真人主张相似，立即换音色并发新版本**，旧版本保留可追溯。
- 中国法下声音参照肖像权保护（《民法典》第 1023 条），因此「像某个具体的人」是硬风险而不是审美问题；这也是为什么描述词里明确排除模仿类表述。

---

## 4. 问题三：本机可行性怎么测（M4 / 32 GB / macOS）

### 4.1 要测的指标与门槛

| 指标 | 定义 | 通过门槛 | 不通过怎么办 |
| --- | --- | --- | --- |
| 冷启动 | 进程起到第一次可推理 | ≤ 20 s | 引擎常驻预热（应用启动时后台加载），首启进度条如实显示 |
| 首包延迟 P50/P95 | 一句话（20–40 字）从请求到**首个音频字节** | P50 ≤ 600 ms / P95 ≤ 1000 ms | 走分句预取（已有 `synthesizeChunked`，lookahead=1）+ 常用短句缓存 |
| RTF | 推理耗时 ÷ 音频时长 | ≤ 0.35 | 0.35–0.6：可接受但标「偏慢」，关闭长句；> 0.6：**默认切商业 API**，本地只做离线兜底 |
| 峰值内存 | 合成期 RSS | ≤ 6 GB | 降 batch / 用 onnx 版 flow；仍超则判定本机不合适 |
| 长句稳定性 | 200 字连续 5 次 | 不 OOM、不漂音 | 强制分句上限（如 60 字/句） |
| 5 情绪可用性 | 5 档各 10 句 | 人工盲听可分辨 ≥ 4 档 | 情绪档位合并或换参考音频策略 |

### 4.2 测法（可复现，命令行级）

新增 `tools/scripts/measure-tts-latency.mts`（**本单不写**，只定规范）：
- 语料：30 句固定中文（8/20/40/80/200 字各 6 句），5 情绪各跑一轮。
- 每轮：冷启动 1 次（重启引擎进程）+ 热态 10 次，取 P50/P95。
- 计时用 `process.hrtime.bigint()`（与 `measure-lyrics-clock-drift.mts` 同款做法），不用 `Date.now()`。
- 输出 JSON：`{engine, version, voicePackId, coldStartMs, firstPacketMs:{p50,p95}, rtf, peakRssMb, failures[]}`，落到 `docs/v2/evidence/`。
- 判据写死在脚本里：任一门槛不过 → 退出码非 0，**不允许「跑完了就算过」**。

### 4.3 现有锚点能推到什么程度

同机 GPT-SoVITS 实测 **RTF ≈ 0.39**（1.01 s 推理 / 2.58 s 音频）。CosyVoice2-0.5B 参数量更小（LLM 主体 0.5B），**理论上不应更慢**，但有两个反方向因素：
- CosyVoice2 默认 fp32（`llm.pt` 2 GB），MPS 上 fp32 未必比 GPT-SoVITS 的路径快；
- 多一个 flow matching 阶段 + 声码器。

> 所以我的诚实预期是：**CosyVoice2 在 M4 上 RTF 落在 0.25–0.5 区间，首包 400–900 ms**。这是估算，不是结论。达不到 ≤0.35 时按 §4.1 的降级走，不硬撑。

### 4.4 如果真的跑不到接近实时

按顺序降级，每一档都对用户可见（`degraded` 标记，绝不静默）：

1. **分句流式**：边合成边播（首包只等第一句），体感延迟降到「第一句的时间」。
2. **缓存**：高频短句（问候、口头禅、回执话术）预合成进缓存，命中即 0 延迟——但**必须带引擎版本与音色包哈希**（见 §6.3），否则换音色后播旧音频。
3. **商业 API 兜底**：网络可用时优先用云端（首包通常 200–400 ms），本地只作离线兜底；这需要 owner 接受「联网 + 账号」，与「不依赖外部账号」冲突，**必须 owner 点头才能作为默认**。
4. **最后才是系统 TTS**（`macos-say` / `windows-sapi`），且必须打 `system_fallback` 标——现有契约已经这么做了，不许改口径。

### 4.5 盲听对比（定稿前的最后一道）

- 12 条候选 + CosyVoice2 定稿 + GPT-SoVITS 基线，随机顺序、去标识，owner 听 5 情绪各 2 句。
- 只问一个问题：「哪条像这个角色在说话」，不问「哪个模型好」。
- 目的不是选模型，是**验证 §2.4 的选型没选错**。如果 owner 盲听更偏好 IndexTTS2，那就去解法务，而不是改结论。

---

## 5. 问题四：打包与首次运行

### 5.1 放哪

| 平台 | 路径 |
| --- | --- |
| macOS | `~/Library/Application Support/WhaleIsle/engines/<engineId>/<version>/` |
| Windows | `%LOCALAPPDATA%\WhaleIsle\engines\<engineId>\<version>\` |

放用户数据目录而不是 app 包内，理由三条：① 应用升级不必重下 6 GB；② 不撑大安装包签名体积；③ 多版本可并存、可回滚（删目录即回滚）。

### 5.2 随包还是首下（这是「装了就能用」的核心矛盾）

| 方案 | 首装体积 | 是否真离线可用 | 代价 |
| --- | --- | --- | --- |
| A. 全部随包 | ~6 GB | 是 | 安装包巨大、每次更新都背着 6 GB、下载失败的容忍度差 |
| B. 全部首下 | ~200 MB | 装完还要等 6 GB | 不满足「装了就能用」的字面要求 |
| **C. 双包（推荐）** | 主包 ~200 MB + 可选「语音引擎包」~6 GB | 两者都装完 = 真离线 | 需要一条明确的引导路径 |

**推荐 C**，首启向导给三个选项，措辞直白：
1. 「下载语音引擎包（约 6.0 GB，一次性，之后完全离线）」← 默认推荐
2. 「我已经有引擎包」→ 选文件夹导入（校验哈希）
3. 「先跳过，用在线语音」→ 走商业 API（需联网与账号），状态栏常驻「本地语音未安装」

### 5.3 校验与完整性

- 仓库内只存 **`engine-manifest.json`**（`{file, bytes, sha256}` 列表），权重本体不进 Git。
- 下载后逐文件校验 sha256，任一不符 → 删除该文件并重试（最多 3 次）→ 仍失败则回退方案 3 并如实提示。
- 断点续传 + 单文件粒度，避免 4 GB 文件重下。
- **不自造签名体系**：manifest 放仓库里、走 release 资产 HTTPS，链路与代码同源，够用且不引入密钥管理负担。

### 5.4 离线验证

- 装完后把网卡断掉（或用防火墙阻断该进程出网）跑一遍 30 句合成，**必须全过**；这条写进验收，不靠「我觉得不联网」。

### 5.5 明确写死的回退触发条件

任一命中即回退到下一档，并在 UI 上标原因：

| 条件 | 回退到 |
| --- | --- |
| 磁盘空闲 < 8 GB | 拒绝下载，提示所需空间，走商业 API |
| 非 arm64 macOS / 非 x64 Windows | 走商业 API（不自研跨架构） |
| 下载 3 次校验失败 | 商业 API |
| 引擎进程 5 分钟内崩 3 次 | 商业 API + 上报本地错误 |
| RTF 实测 > 0.6 连续 10 句 | 商业 API（可在设置里强制「只用本地」） |
| 用户手动关闭本地引擎 | 商业 API |
| 商业 API 也不可用 | 系统 TTS（标 `system_fallback`） |

---

## 6. 问题五 + 六：表演脚本层与 voice-runtime 接入

### 6.1 为什么需要表演层

现在的链路是「文本 + 一个情绪标签 → 引擎」。这不叫表演力，只叫换音色。真正的表现力来自**句内的时间结构**：哪里停、停多久、哪个词重、语速怎么变、哪里换气、哪里有气口。

而这些**不能让程序写死**（ADR-002 D-103：禁止把策略写死成 if/else 规则树）。所以：**由模型产出表演指令，程序只做校验、钳制与执行**。

### 6.2 契约草案（`packages/shared-protocol/src/voice.ts` 增量，本单不落盘）

```ts
/** 非语言发声类型（引擎能做的气口/语气；做不了的由宿主插音效或忽略） */
export const SpeechBreathSchema = z.enum(['none', 'soft', 'sigh', 'laugh', 'tsk']);
export type SpeechBreath = z.infer<typeof SpeechBreathSchema>;

/** 一个表演片段：文本 + 怎么念它 */
export const SpeechSegmentSchema = z.object({
  text: z.string().min(1).max(200),
  /** 重音强度 0=平 1=明显加重（引擎不支持则由宿主做增益/时长微调，不支持就忽略并标 unsupported） */
  emphasis: z.number().min(0).max(1).default(0),
  /** 本段语速倍率（相对音色基线） */
  pace: z.number().min(0.6).max(1.6).default(1.0),
  /** 段前气口/语气 */
  breath: SpeechBreathSchema.default('none'),
  /** 段后停顿毫秒（0 表示按标点默认档位） */
  pauseAfterMs: z.number().int().min(0).max(3000).default(0),
});
export type SpeechSegment = z.output<typeof SpeechSegmentSchema>;

/** 整句的表演脚本 */
export const SpeechPerformanceSchema = z.object({
  emotion: z.enum(['sweet_normal', 'tsundere_refuse', 'rage_spray', 'lazy_yawn', 'happy_rice']),
  /** 情绪强度 0–1（连续量，替代「5 档就是 5 种力度」的粗粒度） */
  intensity: z.number().min(0).max(1).default(0.6),
  /** 整句语速基线 */
  pace: z.number().min(0.6).max(1.6).default(1.0),
  /** 整句音高偏移（半音），用于「上扬挑衅」「低落」这类微调 */
  pitchSemitones: z.number().min(-6).max(6).default(0),
  segments: z.array(SpeechSegmentSchema).min(1).max(20),
  /** 表演指令来源：模型产出 / 程序默认（诚实标注，不许把默认为默认包装成「模型决定」） */
  source: z.enum(['model', 'default']).default('default'),
});
export type SpeechPerformance = z.output<typeof SpeechPerformanceSchema>;
```

挂载点（都在现有结构上增量，不新造总线）：

- `packages/shared-protocol/src/index.ts` 的语音播放租约/气泡事件增加 `performance?: SpeechPerformance`（可选，缺省即旧行为）。
- `packages/persona-brain/src/think.ts`：现有 `parseEmotionPrefix()` 只解析句首 `[傲娇反驳]`。增量是**允许模型在同一段输出里附表演脚本**（例如经 `model-gateway` 的结构化输出字段返回），`parseEmotionPrefix` 的 5 档映射保留为**兜底**——模型没给脚本时用它，且 `source: 'default'`。
- `apps/desktop-host/src/renderer/pet-stage/tts-router.ts`：把 `SpeechPerformance` 展开成合成计划（见 6.4）。

### 6.3 缓存键必须改（现在的键是错的）

现状：`${preferredProvider}|${voiceRef}|${emotion}|${styleMode}|${speed}|${text}`

问题：换引擎、换音色包、加表演指令之后，**键不变 → 播旧音频**。

建议改为：

```
`${engineId}@${engineVersion}|${voicePackId}#${refAudioSha256}|${performanceHash}|${styleMode}|${text}`
```

其中 `performanceHash` = 对 `SpeechPerformance` 做稳定序列化后的短哈希（emotion/intensity/pace/pitch/segments 全量参与）。`speed` 合并进 `performance.pace`，不再单列。

同步要求：引擎升级、音色包换版本**必须**让键自然失配（而不是靠手动清缓存）。

### 6.4 引擎怎么消费表演脚本

| 表演要素 | CosyVoice 2 | GPT-SoVITS（基线） | 商业 API |
| --- | --- | --- | --- |
| emotion + intensity | 拼进 instruct 文本（「用明显生气的语气」/「语气略甜」） | 选 5 段参考音频之一（强度无法表达，只能选档） | 情绪标签/提示词 |
| pace | 段级语速参数或 instruct | `speed_factor` | 语速参数 |
| pauseAfterMs | **宿主侧插入静音**（最可靠，不依赖引擎） | 同左（复用现有 `PauseConfig` 三档 + 覆盖） | 同左 |
| emphasis | instruct 尽力；不支持则标 `unsupported` | 标点强化 + 轻微增益 | 尽力 |
| breath（soft/sigh/laugh） | 引擎标记或指令；不支持的用预录音效 | 预录音效 | 尽力 |
| pitchSemitones | 引擎参数或后处理变调 | 后处理变调 | 参数 |

**原则**：能在宿主侧确定性做到的（停顿、拼接、变调、音效）就不指望引擎；引擎做不到的**如实标 `unsupported`**，不假装做了。

### 6.5 接进 voice-runtime：新 Provider 还是复用 `local-audio-worker`

| 方案 | 优点 | 缺点 |
| --- | --- | --- |
| **A. 复用 `local-audio-worker`**（推荐） | 零协议破坏；Worker 本来就是重依赖隔离边界（Python/torch 不进 Electron）；现有 `/tts/emotion` 已是入口 | `supportsEmotion: true` 现在连 stub 都报 true，**必须补诚实字段** |
| B. 新增 `VoiceProviderKind`（如 `local-expressive-tts`） | 语义最清晰，路由可显式偏好 | 要动枚举 → UI 状态页、降级文案、全部 spec 一起改；换来的只是命名清晰 |

**选 A**，并补两个诚实字段（这是本方案唯一的契约破坏性改动，但方向是「更诚实」不是「更多功能」）：

```ts
// VoiceSynthesisOutput 增量
engine: z.object({
  id: z.string().min(1),            // 'cosyvoice2' | 'gpt-sovits' | 'stub'
  version: z.string().min(1),
  realInference: z.boolean(),       // stub 必须 false
  voicePackId: z.string().default(''),
  refAudioSha256: z.string().default(''),
}).optional(),
```

并把 `VoiceProviderStatus.supportsEmotion` 的来源改成**引擎自报**（stub 报 false），而不是硬编码 true。

### 6.6 降级链（每一跳都留痕）

```
本地表现力引擎（CosyVoice2，full directives）
  ↓ 引擎不可用 / RTF 超限
本地引擎降级模式（保留停顿与语速，丢 intensity/emphasis，标 degraded）
  ↓ 引擎崩溃 / 未安装
商业 API（只支持 emotion 标签，标 degradedFrom: 'local-audio-worker'）
  ↓ 无网 / 无账号
系统 TTS（quality: 'system_fallback'，UI 明确写「系统音色」）
```

现有 router 的 `degraded/degradedFrom` 机制已经够用，**不需要新机制**，只需要把上述顺序写进 provider 数组顺序 + `preferredProvider`。

### 6.7 情绪 5 档与引擎细粒度怎么对齐（不要偷偷扩枚举）

- 5 档是**产品枚举**，贯通 persona → 动作 → 口型 → UI，不允许为了「引擎支持更多」而扩。
- 细粒度通过 `intensity`（0–1 连续）+ `pace` + `pitchSemitones` 表达，**不新增第 6 档**。
- 若将来确要加档（如「害羞」），走契约变更 + 全链路评审，不在本方案里夹带。

---

## 7. 问题七：分阶段计划（一周内 vs 之后）

### 阶段 1：一周内能听见差异（**不需要下载任何新权重**）

关键洞察：现在产品链路放的是正弦波。所以最大的听感跃迁**不是换模型**，而是接上已经在本机的 GPT-SoVITS + 把表演层做出来。

| 天 | 做什么 | 交付 | 证据等级 |
| --- | --- | --- | --- |
| D1–D2 | `audio-ai-worker` 的 `/tts/emotion` 接真后端：本地优先调 `127.0.0.1:9880`（**只读调用，不动 owner 环境**），失败降级 stub 但**必须标 `realInference:false`** | 真中文语音替代正弦波 | `[E2E-HOST]` |
| D3 | 表演脚本契约落 `shared-protocol` + 宿主侧执行（停顿/语速/拼接/气口音效） | 同一句话能有「停一下再炸毛」的节奏 | 单测 + 沙盒 |
| D4 | 缓存键改造（含引擎版本与表演哈希） | 换引擎/换音色不再播旧音频 | 单测 |
| D5 | 诚实字段贯通（`engine.realInference`、`supportsEmotion` 自报）+ 状态页显示当前引擎 | 用户在 UI 上一眼看到「本地引擎 / stub / 云端」 | `[E2E-HOST]` |
| D6–D7 | 5 情绪参考音频凑齐（现有只有 1 组）——**用 GPT-SoVITS 的 instruct/切片能力从同一参考派生**，不引入新素材 | 5 档情绪可听分辨 | 人工试听（需 owner） |

> 阶段 1 的产出是「能听、有节奏、诚实」，但音色仍是**开发期基线**（来源不明 + 权重许可缺失），**不能进发行包**。这一点必须在 UI 或设置里写明。

### 阶段 2：CosyVoice 2 自托管（**需批准下载 ≈ 4.07 GB**）

- 建隔离环境（不复用、不写入 owner 的 `CosyVoice/.venv`，遵守 O5 红线）；补 `third_party/Matcha-TTS` 子模块（**也是一次网络下载，需一并批准**）。
- 落权重到 `~/Library/Application Support/WhaleIsle/engines/cosyvoice2/<version>/`，写 manifest + sha256。
- 跑 §4.2 的度量脚本，用真实数字填 §4.3 的估算位。
- 达成门槛后切默认引擎；达不到按 §4.4 降级并在文档里写清楚**没达到**。

### 阶段 3：原创音色（依赖 §9 决策 3）

- 12 候选 → 3 → 1，冻结参考 + 权利链记录 + 一致性回归。
- 5 情绪由同一参考派生，写进 `voice_matrix.json`（契约已存在）。

### 阶段 4：打磨（不承诺时间）

- 流式首包、情绪强度曲线、气口音效库、Windows CPU 路径验证。
- 歌声（SVS/SVC）**完全独立**，不在本方案内，避免又把 TTS 冒充唱歌。

---

## 8. 风险登记

| # | 风险 | 影响 | 缓解 |
| --- | --- | --- | --- |
| R1 | 首装 6 GB 与「装了就能用」冲突 | 用户流失/体验差 | 双包方案 + 明确体积提示 + 离线导入 |
| R2 | CosyVoice2 在 M4 上 RTF 可能 >0.35 | 说话卡顿 | 先测后定；分句流式；超 0.6 默认切商业 API |
| R3 | IndexTTS2 许可未过法务 | 可能错失更好音质 | 先法务后接；不在默认链路 |
| R4 | `genki_ref.wav` 来源未登记 | 发行包许可风险 | 阶段 1 明确标 DEV_ONLY；产品音色必须换成 §3 的原创参考 |
| R5 | 路线 B 音色设计服务条款不允许「再作克隆参考」 | 音色无法落到本地引擎 | 签约前逐条确认；不允许则走路线 A |
| R6 | 随机嵌入音色可能撞脸真人 | 法律风险 | 描述词排除模仿 + 收到主张即换版 |
| R7 | Windows 无 MPS，CPU 推理慢 3–5 倍 | 跨平台体验不一致 | 单独测；不达标就 Windows 默认商业 API |
| R8 | 5 档情绪是产品枚举，引擎更细 | 表达力被枚举卡住 | 用 intensity 连续量补，不扩枚举 |
| R9 | stub 长期冒充本地引擎 | **最危险的一条：用户以为在听角色，其实在听正弦波** | 阶段 1 D2 就修，`realInference` 字段强制 |

---

## 9. 需要 owner 拍板的三件事

1. **下载批准（阶段 2 前置）**：CosyVoice2-0.5B 最小集 **≈ 4.07 GB**（版本 `FunAudioLLM/CosyVoice2-0.5B`，HF 上 2026-11-26 的文件清单与字节数见 §2.2），另加 `third_party/Matcha-TTS` 子模块源码（约 1 MB 级）。落盘位置 `~/Library/Application Support/WhaleIsle/engines/cosyvoice2/<version>/`。**未获批准前不下载任何权重。**
   - 备选：CosyVoice3-0.5B 最小集 ≈ 5.43 GB（音色/方言更强，多 1.36 GB）。
2. **体积口径**：接受「首装约 6 GB（运行时 1.9 + 权重 4.07）」换完全离线自托管？还是默认商业 API、本地引擎作为可选包？（我推荐前者，但这是 owner 的钱包与耐心问题，不是技术问题。）
3. **原创音色走哪条路**：路线 A（本地随机嵌入，零账号、完全离线、音色上限较低）还是路线 B（一次性云端 voice design，需账号与费用、之后全离线、音色明显更好）？

---

## 10. 本方案的边界（说清楚没做什么）

- **没写一行实现代码**，没装包，没下权重。
- **没测过 CosyVoice2 在本机的任何性能**；§4.3 的数字是估算，标了估算。
- **没做盲听对比**；§2.3 的自然度评价来自公开资料，标了未实测。
- **没动**气泡相关文件、item 7 的 PR、商业 provider 链路、桌面端进程。
- 情绪 5 档枚举、`VoiceProviderKind` 枚举**均未修改**；契约改动只在草案里，等 owner 拍板后按「契约先行」流程落。
