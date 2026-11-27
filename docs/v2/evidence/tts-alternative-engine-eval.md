# 替代引擎速评：macOS 本机可商用自托管 TTS（2026-11-27）

> 目标只有一个：在 Apple Silicon 本机找到「能用 + 有情绪 + 权重可商用」的自托管 TTS；找不到就如实写找不到。
> 本单**只出速评报告，不写任何生产接入代码**；接入是下一单，等 owner 看完报告再批。
> 证据等级：本机真实推理 = `[REAL-DEVICE]`；仅读许可/文档未跑 = `[DOC-ONLY]`；听感一律**未做**（AI 不能替人听）。

---

## 0. 结论（先说结果）

**本机没有找到「四项硬指标全过」的自托管 TTS。** 具体地说：

- **许可 + 实时都过的**：Kokoro-82M-v1.1-zh（Apache-2.0，RTF 0.33）、MeloTTS-zh（MIT，RTF 0.24）。
  但两者都是**固定音色、没有情绪控制**（Melo 只有一个成年女声；Kokoro 只能从预置 sid 里挑，情绪只能靠标点），
  且都不支持参考音频克隆 —— 与小鲸「原创音色 + 五档表演」的需求不匹配。
- **有情绪 + 能克隆 + 许可干净的**：Chatterbox Multilingual（MIT，`exaggeration` 情绪旋钮 + 零样本克隆 + 中文），
  但本机实测 **稳态 RTF 2.98–4.87**（M4 / MPS / fp32；首条含预热 12.4，CPU 后端 4.83），4–5 秒音频要等 13–18 秒（夸张档 9 秒音频要等 33 秒），**实时硬门槛直接出局**。
- **许可就出局的**（只能内部试听，不许进包、不许进产品路径）：Spark-TTS（权重 CC-BY-NC-SA-4.0）、F5-TTS（权重 CC-BY-NC-4.0）、
  ZipVoice（权重 CC-BY-NC，前序已实测 RTF 0.475）、IndexTTS2（bilibili 自定义许可）、Fish Speech（Fish Audio 社区许可，商用有条件）、
  GPT-SoVITS（HF 卡片标 MIT，但预训练权重来源需逐文件核实，按工单口径维持开发期基线）。
- **CosyVoice2 的 ONNX/CoreML 移植**：ONNX 模块权重与上游同为 Apache-2.0，C++ 运行时 MIT，但
  ① 预转换 GGUF 只提供 **CosyVoice3**，CosyVoice2 要自己转换；② macOS 需要额外配 llama.cpp 的 GGML 1.x 动态库；
  ③ 上游 CosyVoice2 本机 CPU 已实测 RTF 2.42。**判定：移植存在但未成熟，本轮未实测，不作为近期路径。**

**排名与推荐度**

| # | 候选 | 许可 | 实时 | 中文/儿童 | 情绪 | 锁定 | 综合推荐 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | **Kokoro-82M-v1.1-zh** | ✅ Apache-2.0（代码+权重） | ✅ RTF 0.33（贴线） | 中文可懂；sid 41 F0 346Hz，儿童感**待听** | ❌ 无情绪控制 | ✅ 固定 sid，余弦最低 0.992 | **仅当接受固定音色时可用**；不适合小鲸 |
| 2 | **MeloTTS-zh** | ✅ MIT（代码+权重） | ✅ RTF 0.24 | 可懂；成年女声 F0 ~230Hz | ❌ 无 | ✅ 0.901 | 速度基线；音色与表演都不匹配 |
| 3 | **Chatterbox Multilingual** | ✅ MIT（代码+权重） | ❌ **RTF 2.98–4.87**（首条预热 12.4；CPU 4.83） | 中文支持（`language_id="zh"`），儿童感待听 | ✅ `exaggeration` 可调（待听） | 未测（判据 2 已出局） | **许可与能力对味，速度一票否决** |
| 4 | CosyVoice2（上游） | ✅ Apache-2.0 | ❌ RTF 2.42（前序实测） | 中文好 | ✅ 指令/参考 | 已实测可用 | 速度一票否决 |
| 5 | CosyVoice2 ONNX / C++ 移植 | ✅（ONNX 权重 Apache-2.0，运行时 MIT） | 未实测 | — | — | — | 移植未成熟（只预转换 CosyVoice3） |
| — | Spark-TTS / F5-TTS / ZipVoice / IndexTTS2 / Fish Speech / GPT-SoVITS | ❌ | — | — | — | — | **出局**（许可），只允许内部试听 |

**给 owner 的一句话**：如果必须「本机 + 可商用 + 有情绪 + 克隆」，本轮结论是**没有**。
能接受「固定音色、无情绪」就先上 Kokoro（最快、许可最干净）；要保留情绪与克隆，继续走商业 API（MiMo）才是当前唯一达标路径。

---

## 1. 预注册判据（派单原文，跑之前写死，跑完不改）

1. **硬门槛·许可**：代码与权重都能商用/再分发（NC、无许可元数据、自定义限制一律出局，只能内部试听）。
2. **硬门槛·本机实时**：RTF P50 ≤ 0.35（同一台机同一口径；超了如实写出局）。
3. **中文 + 儿童女声适配**：八九岁声线，样本要听得出不是成年女声。
4. **情绪可控**：指令 / 参考 / 标签任一种能产生可听差别的语气（调皮/撒娇/傲娇至少两档分得开）。
5. **音色锁定**：参考克隆一致性（CAM++ 最低余弦 ≥0.75）或固定 seed/嵌入可复现。

过 1+2 才进听感对比；3/4/5 每项给「过 / 有条件过 / 不过」+ 证据。

**口径**：RTF = 合成墙钟时间 / 音频时长；离线模型「首包 = 整句」（不存在流式首包）；4 线程 CPU（ONNX 三件）或 MPS（Chatterbox）；
每条文本跑 1–2 次，报 P50 与最慢；内存取进程峰值 RSS；冷启动 = 模型加载 + 首句（分开记）。

---

## 2. 候选与许可事实（逐项给链接；权重许可单独看，不与代码许可混为一谈）

| 候选 | 代码许可 | 权重许可 | 依据（本轮实际读取） | 判定 |
| --- | --- | --- | --- | --- |
| **Kokoro-82M-v1.1-zh** | Apache-2.0 | **Apache-2.0** | GitHub `hexgrad/kokoro` license API；HF `hexgrad/Kokoro-82M-v1.1-zh` cardData `license: apache-2.0` | ✅ 过 |
| **MeloTTS** | MIT | **MIT** | GitHub `myshell-ai/MeloTTS` license API；HF `myshell-ai/MeloTTS-Chinese` `license: mit` | ✅ 过 |
| **Piper（zh_CN-huayan）** | MIT | **Unknown** | `rhasspy/piper-voices` 的 `zh/zh_CN/huayan/medium/MODEL_CARD` 原文：`Dataset ... License: Unknown` | ❌ 出局（权重数据集许可未知） |
| **Chatterbox Multilingual** | MIT | **MIT** | GitHub `resemble-ai/chatterbox` license API；HF `ResembleAI/chatterbox` `license: mit`；README 明列 `Chinese (zh)` | ✅ 过 |
| **CosyVoice2-0.5B** | Apache-2.0 | **Apache-2.0** | HF `FunAudioLLM/CosyVoice2-0.5B` `license: apache-2.0`（仓库重定向后 license API 仍为 Apache-2.0） | ✅ 过（但实时不过，见 §3.4） |
| **CosyVoice2 ONNX 移植** | MIT（`Lourdle/cosyvoice.cpp`） | Apache-2.0（`Lourdle/CosyVoice2-0.5B_ONNX`） | 两个 HF/GitHub 许可字段如上；转换仓库 `CosyVoiceForOnnx` license 字段为 `NOASSERTION` | ⚠️ 权重干净、转换脚本许可待核 |
| **Spark-TTS** | Apache-2.0 | **CC-BY-NC-SA-4.0** | HF `SparkAudio/Spark-TTS-0.5B` `license: cc-by-nc-sa-4.0` | ❌ 出局 |
| **F5-TTS** | MIT | **CC-BY-NC-4.0** | HF `SWivid/F5-TTS` `license: cc-by-nc-4.0` | ❌ 出局 |
| **ZipVoice** | Apache-2.0 | **CC-BY-NC**（Emilia 数据约束，前序已核实） | 见 `TTS-local-engine-benchmark-verification.md` §11 | ❌ 出局（已做过内部验证） |
| **IndexTTS2** | **bilibili 自定义许可** | 同左（覆盖“模型权重与最终代码”） | `index-tts/index-tts` LICENSE 原文：`bilibili Model Use License Agreement`；含 MAU >1 亿 / 年营收 >10 亿元需单独授权、禁止用输出改进其它商业 AI 模型等条款 | ❌ 出局（自定义限制） |
| **Fish Speech** | **Fish Audio 社区许可** | 同左 | `fishaudio/fish-speech` LICENSE 原文：`FISH AUDIO COMMUNITY LICENSE AGREEMENT Version 1.0`；商用仅限年营收低于阈值，托管服务需单独书面授权 | ❌ 出局（自定义限制） |
| **GPT-SoVITS** | MIT | HF 卡片标 **MIT**（`lj1995/GPT-SoVITS`），但预训练权重含多来源组件，未逐文件核实 | license API + HF cardData | ⚠️ 维持「开发期基线」，不进产品路径 |
| **Orpheus-TTS** | Apache-2.0 | Apache-2.0（`canopylabs/orpheus-3b-0.1-ft`），中文为 **research release**（`canopylabs/3b-zh-ft-research_release`） | license API + HF collection | ⚠️ 3B LLM，未实测；研究版中文权重许可需单独核 |
| **OuteTTS** | Apache-2.0 | Apache-2.0 | license API | ⚠️ 英文为主，未实测 |

> **说明**：许可字段是从 GitHub license API 与 HF `cardData` 现读的；GitHub 的 `NOASSERTION` 我已打开 LICENSE 原文核对（IndexTTS2 / Fish Speech 均为自定义协议，不是 OSI 许可）。

### 2.1 许可原文摘录（逐条，只摘与本项目判断相关的句子）

- **IndexTTS2**（<https://github.com/index-tts/index-tts/blob/main/LICENSE>）：标题即 `bilibili Model Use License Agreement`；
  2.2 条：产品月活 > 1 亿或上一自然年营收 > 10 亿元人民币须「request a separated license」；
  另有一条：`You may not Use the bilibili indextts2 or any Derivative Work to improve any AI model, except for ... non-commercial AI models.`
- **Fish Speech**（<https://github.com/fishaudio/fish-speech/blob/main/LICENSE>）：标题 `FISH AUDIO COMMUNITY LICENSE AGREEMENT Version 1.0`；
  原文：`This Agreement is intended to allow, free of charge, research and non-commercial uses ... and, as set out in Section III, limited uses for a Commercial Purpose by Licensees whose Annual Revenue is less than the Revenue Threshold. Any other use ... and any Hosted Service, requires a separate written license agreement from Fish Audio.`
- **Piper zh_CN-huayan**（<https://huggingface.co/rhasspy/piper-voices/raw/main/zh/zh_CN/huayan/medium/MODEL_CARD>）：`## Dataset` → `License: Unknown`。
- **Spark-TTS-0.5B**：HF `cardData.license = "cc-by-nc-sa-4.0"`（模型卡 <https://huggingface.co/SparkAudio/Spark-TTS-0.5B>）。
- **F5-TTS**：HF `cardData.license = "cc-by-nc-4.0"`（<https://huggingface.co/SWivid/F5-TTS>）。
- **Kokoro-82M-v1.1-zh**：HF `license: apache-2.0`（<https://huggingface.co/hexgrad/Kokoro-82M-v1.1-zh>）；代码仓库 <https://github.com/hexgrad/kokoro/blob/main/LICENSE> Apache-2.0。
- **MeloTTS**：<https://github.com/myshell-ai/MeloTTS/blob/main/LICENSE> MIT；HF `myshell-ai/MeloTTS-Chinese` `license: mit`。
- **Chatterbox**：<https://github.com/resemble-ai/chatterbox/blob/master/LICENSE> MIT；HF `ResembleAI/chatterbox` `license: mit`；
  README 语言列表含 `Chinese (zh)`，并有专用中文包 `ResembleAI/Chatterbox-Multilingual-zh-cmn`。
- **CosyVoice2**：HF `FunAudioLLM/CosyVoice2-0.5B` `license: apache-2.0`；ONNX 模块 `Lourdle/CosyVoice2-0.5B_ONNX` `license: apache-2.0`；C++ 运行时 `Lourdle/cosyvoice.cpp` MIT；转换仓库 `Lourdle/CosyVoiceForOnnx` license 字段 `NOASSERTION`。

### 2.2 每个候选的硬伤（一句话，按「能不能用」直说）

| 候选 | 硬伤 |
| --- | --- |
| Kokoro-82M-v1.1-zh | 固定音色库、**没有任何情绪参数**、不支持克隆；包内没有 sid→音色名映射；中文前端直接丢弃 `——`/`～`；RTF 0.33 只是贴线 |
| MeloTTS-zh | **只有一个成年女声**（F0 ~230Hz）、无情绪、无克隆 |
| Chatterbox Multilingual | **速度慢 9–14 倍**（RTF 2.98–4.87）；首次生成有 `forcing EOS` 对齐告警；`chatterbox-tts==0.1.7` 还依赖 `pkg_resources`（setuptools<81）；README 的 V3 用法与 PyPI 版签名不一致 |
| CosyVoice2（上游） | RTF 2.42（CPU），一票否决 |
| CosyVoice2 ONNX / C++ 移植 | 只预转换 **CosyVoice3**；macOS 要自配 llama.cpp 的 GGML 1.x；转换仓库许可字段 `NOASSERTION`；未见 CosyVoice2 的 CoreML 导出 |
| Spark-TTS | 权重 CC-BY-NC-SA-4.0，**不可商用** |
| F5-TTS | 权重 CC-BY-NC-4.0，**不可商用** |
| ZipVoice | 权重 CC-BY-NC，**不可商用**（前序已实测 RTF 0.475） |
| IndexTTS2 | 自定义许可 + 用户量/营收阈值 + 禁止用输出改进其它商业模型 |
| Fish Speech | 社区许可，商用限营收阈值，托管需单独授权 |
| GPT-SoVITS | 代码 MIT，但预训练权重含第三方来源未逐文件核实 → 只能开发期基线 |
| Piper zh_CN | 训练数据许可 Unknown |
| Orpheus / OuteTTS | 3B LLM/英文为主，本轮未跑；中文研究版权重许可需单独核 |

---

## 3. 本机实测（Apple M4 / macOS 26.2 / 4 线程 CPU 或 MPS）

### 3.0 下载清单（权重不进 git，全部放 `/tmp/engine-eval/`）

| 文件 | URL | 字节 | 校验 |
| --- | --- | --- | --- |
| `kokoro-multi-lang-v1_1.tar.bz2` | `https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_1.tar.bz2` | 364,855,331 | sha256 `c48644f8a9f87db7f912f966965e3efb564b826ebc63fbf20b6cc5dbbcb33b8e` |
| `vits-melo-tts-zh_en.tar.bz2` | `.../tts-models/vits-melo-tts-zh_en.tar.bz2` | 167,006,755 | sha256 `e58351ed7149f290a54534538badd4077cdbe6fddc964b24d0bee870415d1514` |
| `sherpa-onnx-paraformer-zh-small-2024-03-09.tar.bz2`（ASR 回环用） | `.../asr-models/sherpa-onnx-paraformer-zh-small-2024-03-09.tar.bz2` | 77,920,048 | tar 解包后 `model.int8.onnx` 可用 |
| Chatterbox Multilingual（HF `ResembleAI/chatterbox`，6 个文件：`t3_mtl23ls_v2` 2.14GB / `s3gen` 1.06GB / tokenizer / ve） | `https://huggingface.co/ResembleAI/chatterbox` | 约 3.2 GB | HF blob etag（下载器自带）；`chatterbox-tts==0.1.7`（PyPI，MIT） |
| CosyVoice2 ONNX 模块（**未下载**，见 §3.5） | `https://huggingface.co/Lourdle/CosyVoice2-0.5B_ONNX` | 1.75 GB（flow+hift） | 未下载 |

### 3.1 Kokoro-82M-v1.1-zh（sherpa-onnx，sid 41）

- 模型：`model.onnx` 325.6 MB；目录 418 MB；加载 **1.31 s**；峰值 RSS **944 MB**。
- 文本：同一句三种标点（中性 / 调皮 `！——` / 撒娇 `～`）。**注意**：sherpa-onnx 的 Kokoro 前端把 `——`、`～` 判为 OOV 直接丢弃（日志逐条可查），所以「情绪差异」只剩标点被吃掉后的时长差。

| 文本 | 音频 s | RMS dBFS | F0 中位 Hz | 墙钟 ms | RTF |
| --- | --- | --- | --- | --- | --- |
| 中性 | 4.19 | −25.3 | 347.8 | 1322 / 1387 | 0.316 / 0.331 |
| 调皮 | 3.20 | −25.4 | 320.0 | 1067 / 1081 | 0.334 / 0.338 |
| 撒娇 | 4.16 | −25.3 | 345.3 | 1377 / 1326 | 0.331 / 0.319 |

- **RTF P50 ≈ 0.331，最慢 0.338** → 实时门槛「过（贴线）」。
- **情绪**：无任何情绪控制参数；三档 F0 320–348Hz、RMS 完全相同 → **不过**（差异只是标点/时长，不是语气）。
- **锁定**：固定 sid ×5 次，CAM++ 两两余弦均值 **0.9945** / 最低 **0.9920** → **过**（固定嵌入，天然可复现）。
- **中文可懂度**（Paraformer 回环）：三档都识别为「主人你回来了今天有没有想我呀」——`啦` 被识别成 `了`，字面 1 字差异，可懂。
- **儿童感**：sid 41 是 60 个 sid 里 F0 最高的一档（346Hz，小鲸 07 参考 406.8Hz），**客观量上接近，听感未做**。
- **音色库映射**：包内 `voices.bin` 只有嵌入矩阵，没有名字表（README 只链 HF），**sid→音色名的对应本机无法确认**——这是可用性硬伤（owner 选音色时不知道 41 号是谁）。

### 3.2 MeloTTS-zh（sherpa-onnx，单女声 sid 0）

- 模型：`model.onnx` 170.4 MB；目录 196 MB；加载 **0.95 s**；峰值 RSS **465 MB**。
- 同样三种标点；Melo 前端也丢弃 `—`、`～`（日志可查）。

| 文本 | 音频 s | RMS dBFS | F0 中位 Hz | 墙钟 ms | RTF |
| --- | --- | --- | --- | --- | --- |
| 中性 | 2.73 | −31.2 | 231.5 | 619 / 537 | 0.221 / 0.230 |
| 调皮 | 2.43 | −31.2 | 221.1 | 537 / 609 | 0.221 / 0.263 |
| 撒娇 | 2.32 | −30.7 | 228.5 | 619 / 609 | 0.267 / 0.263 |

- **RTF P50 ≈ 0.24** → 过；**情绪**：无参数、F0 221–232Hz 三档几乎不动 → 不过；**锁定** ×5 最低 **0.9010** → 过。
- **儿童感**：F0 ~230Hz，成年女声，**不过**（本机没有儿童音色可选）。
- **中文可懂度**：三档均逐字正确（「主人你回来啦今天有没有想我呀」）。

### 3.3 Chatterbox Multilingual（PyTorch 2.6 / MPS，`chatterbox-tts==0.1.7`）

- 加载 **9.3 s**（首次还含 3.2GB 权重下载，不计入）；峰值 RSS 见 manifest。
- 首条（中性、`exaggeration=0.5`）：音频 4.12s，墙钟 **51.0 s** → **RTF 12.4**（含首次图编译/预热）。
- 预热后（同进程后续条目，MPS）：RTF **2.98 – 4.87**（中性 14.8s/4.80s、16.0s/5.36s；调皮 12.3s/3.08s、13.6s/3.72s、17.7s/5.28s、33.1s/9.08s；撒娇 27.9s/5.72s）。
- **CPU 后端对照**（同一句、`exaggeration=0.5`）：墙钟 21.4s / 音频 4.44s → **RTF 4.83**，比 MPS 更慢 → **不是后端选错，是模型本身重**。
- **实时硬门槛不过**：稳态比门槛 0.35 慢 9–14 倍，也比上游 CosyVoice2 CPU 的 2.42 慢。
- 同批日志出现 `forcing EOS token, long_tail=True` 警告（首个 clip），说明对齐尾部也不稳。
- **旁证（不进听感对比，只说明能力真实存在）**：克隆自 07 参考，F0 中位 **369–393Hz**（三家里最接近 07 的 406.8Hz）；
  `exaggeration` 0.5→1.0 把调皮句从 3.08s 拉到 9.08s；Paraformer 回环可懂（「主人你回来了今天有没有想我呀」，啦→了）。
- 结论：许可、中文、克隆、情绪旋钮都对味，但**本机速度一票否决**；不进入听感对比（判据要求先过 1+2）。

> 说明：`exaggeration` 旋钮确实存在（`generate(..., exaggeration=0.5)`，默认 0.5），但因为实时门槛先出局，本轮没有把 6 个情绪档跑完，避免把时间花在已淘汰的候选上。

### 3.4 CosyVoice2（上游，引用前序实测，不重跑）

- 前序证据（同一台机、同一口径）：CPU fp32 **RTF P50 2.423 / P95 4.225**，首包 P50 11.3 s，冷启动 30.56 s。
- 结论：许可 ✅、中文/情绪 ✅、**实时 ❌**。本轮不重跑。

### 3.5 CosyVoice2 的 ONNX / CoreML 移植成熟度（`[DOC-ONLY]`，未跑）

| 项目 | 事实 | 成熟度判断 |
| --- | --- | --- |
| `Lourdle/CosyVoiceForOnnx` | 把 flow / hift 改成可导出 ONNX；预转换权重在 HF `Lourdle/CosyVoice2-0.5B_ONNX`（Apache-2.0，1.75GB，只含 flow+hift，LLM/tokenizer 仍取官方） | 能用但要自己拼官方仓库 + 非标准运行时，**转换仓库 license 字段为 NOASSERTION** |
| `Lourdle/cosyvoice.cpp` | MIT，C++/GGML 移植，提供 macOS arm64 预编译（v0.2.1，2026-11-15，14.7MB）；但**预转换 GGUF 只提供 CosyVoice3**（`Fun-CosyVoice3-0.5B-2512-GGUF`，Apache-2.0），CosyVoice2 要自己转换；macOS 还要另配 llama.cpp 的 **GGML 1.x** 动态库（含 `GGML_OP_PAD` beg padding 补丁） | **未成熟**：文档自己写明「非官方、请先看后端测试状态」，CosyVoice2 无现成 GGUF |
| CoreML 专用移植 | 未找到 CosyVoice2 的 CoreML 导出；仅 `tetherto/qvac-fabric-speech.cpp` 对 **CosyVoice3** 提供 `-DTTS_CPP_COREML=ON` 导出链 | **不存在**（对 CosyVoice2） |

---

## 4. 出局清单（许可）

| 候选 | 出局原因 | 是否允许内部试听 |
| --- | --- | --- |
| Spark-TTS 0.5B | 权重 CC-BY-NC-SA-4.0 | 可以（`[INTERNAL-VALIDATION-NONCOMMERCIAL]`，不进包、不进产品路径） |
| F5-TTS | 权重 CC-BY-NC-4.0 | 可以（同上） |
| ZipVoice | 权重 CC-BY-NC；前序已实测 RTF 0.475 | 可以（已做过内部验证） |
| IndexTTS2 | bilibili 自定义许可（含用户量/营收阈值、禁止用输出改进其它商业 AI 模型） | 仅内部试听，且须逐条遵守其条款 |
| Fish Speech | Fish Audio 社区许可（商用限营收阈值；托管需单独授权） | 仅内部试听 |
| GPT-SoVITS | 代码 MIT，权重含第三方来源未逐文件核实 | 开发期基线（沿用本仓既有口径） |
| Piper zh_CN | 语音权重训练数据 `License: Unknown` | 仅内部试听 |

> 以上**一律不进安装包、不进产品路径**；本单也没有下载它们的权重。

---

## 5. 未实测与局限（诚实清单）

- **听感全部未做**：3（儿童感）、4（情绪可听差别）两项的最终判定必须由 owner 试听；本报告只给客观量与路径。
- Chatterbox 只跑了 1 条就判出局（判据 1+2 是硬门槛，先过才听）；其余 11 条没跑，避免浪费。
- Orpheus / OuteTTS 只做许可与语言覆盖核对，**未下载未跑**（3B LLM，时间预算外）。
- CosyVoice2 移植未实测（§3.5 的理由）。
- Kokoro 的 sid→音色名映射未确认；「儿童感」只有 F0 证据。
- 所有 RTF 都是**离线整句**口径；没有测并发、长时稳定性、热降频。
- 试听素材在 `artifacts/tts-ab/engine-eval/`（见 §6），本机 `/tmp/engine-eval/out/` 为原始产物。

## 6. 试听素材

| 目录 | 内容 |
| --- | --- |
| `artifacts/tts-ab/engine-eval/kokoro-sid41/` | 中性/调皮/撒娇各 2 条 |
| `artifacts/tts-ab/engine-eval/kokoro-sid41-lock/` | 固定 sid ×5（锁定验证） |
| `artifacts/tts-ab/engine-eval/melo/` | 中性/调皮/撒娇各 2 条 |
| `artifacts/tts-ab/engine-eval/melo-lock/` | 固定 sid ×5 |
| `artifacts/tts-ab/engine-eval/chatterbox/` | 中性 2 条（`exaggeration=0.5` / `1.0`），判出局后停跑 |
| 各目录 `manifest.json` | 逐条 RTF / 时长 / RSS / 参数 |

## 7. 下一步（等 owner 批）

1. **要情绪 + 克隆**：本机没有达标项 → 维持商业 API（MiMo）主线；若愿意等，可另立工单评估 CosyVoice3 GGUF（Apache-2.0，C++/Metal 预编译）在本机的 RTF，**但那是新模型、需要重新做音色与情绪验证**。
2. **能接受固定音色**：Kokoro-82M-v1.1-zh 是唯一「许可干净 + 实时达标」的选项；要先解决 sid→音色名映射与儿童感试听。
3. **不建议**：为了自托管去接 NC/自定义许可的权重（Spark-TTS / F5 / IndexTTS2 / Fish / GPT-SoVITS）——许可风险大于收益。

## 8. 复跑命令（权重与脚本都在本机 `/tmp/engine-eval/`，不入库）

```bash
# Kokoro（sherpa-onnx，sid 41；换 sid 即可试其它音色）
uv run --quiet --with sherpa-onnx --with numpy python -I harness/run_eval.py \
  --kind kokoro --model $K/model.onnx --voices $K/voices.bin --tokens $K/tokens.txt \
  --data-dir $K/espeak-ng-data --dict-dir $K/dict \
  --lexicon "$K/lexicon-us-en.txt,$K/lexicon-zh.txt" \
  --rule-fsts "$K/date-zh.fst,$K/number-zh.fst,$K/phone-zh.fst" --sid 41 --out out/kokoro-sid41

# MeloTTS
uv run --quiet --with sherpa-onnx --with numpy python -I harness/run_eval.py \
  --kind vits --model $M/model.onnx --tokens $M/tokens.txt --lexicon $M/lexicon.txt \
  --dict-dir $M/dict --rule-fsts "$M/date.fst,$M/number.fst,$M/phone.fst" --sid 0 --out out/melo

# Chatterbox（独立 venv，PyTorch 2.6 + chatterbox-tts 0.1.7；需 setuptools<81 才有 pkg_resources）
HF_HOME=/tmp/engine-eval/hf cb-venv/bin/python harness/run_chatterbox.py mps

# 客观量与锁定（仓库自带工具）
uv run --quiet --with numpy python -I tools/scripts/voice-stability.py <wav...>
uv run --quiet --with numpy --with sherpa-onnx python -I tools/scripts/speaker-cosine.py <wav...>
```

脚本副本：`artifacts/tts-ab/engine-eval/harness/`（本机留档，`artifacts/` 不入库）。
