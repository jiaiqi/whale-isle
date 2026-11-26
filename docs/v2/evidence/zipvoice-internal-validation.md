# ZipVoice-Distill 内部验证：能不能跑通 / 中文能不能听 / CPU 上 RTF 多少

> **`[INTERNAL-VALIDATION-NONCOMMERCIAL]`**
> 工单：item 10（表现力语音）后续 · 日期：2026-11-27 · 证据等级：**`[REAL-DEVICE]`（仅指本机真实 CPU 推理；不构成产品可用性结论）**
> 授权：owner 2026-11-27 明确批准「ZipVoice 内部验证」，**前提是权重不进仓库、不进主安装包**。
> 关联：[TTS-local-engine-benchmark-verification.md](./TTS-local-engine-benchmark-verification.md)（CosyVoice2 本机实测，本文的对照基线）。

---

## 0. 许可红线（先读这一节）

| 对象 | 许可 | 后果 |
| --- | --- | --- |
| `sherpa-onnx`（推理运行时代码） | Apache-2.0 | 可用，保留 NOTICE 与署名 |
| ZipVoice 上游代码（`k2-fsa/ZipVoice`） | Apache-2.0 | 可用 |
| **ZipVoice 预训练权重** | **CC-BY-NC**（训练数据 Emilia 自带非商用限制） | **禁止商用、禁止随产品分发** |
| 本机下载的 int8 权重包（GitHub `k2-fsa/sherpa-onnx` release `tts-models` 资产） | 同上游权重，CC-BY-NC | 同上 |

因此本次验证的所有产物一律打 `[INTERNAL-VALIDATION-NONCOMMERCIAL]`：

- **权重不在仓库里**：解压在 `/tmp/zipvoice-probe/`，`git status` 干净，仓库无任何模型二进制。
- **产物在 `artifacts/tts-ab/zipvoice-internal-noncommercial/`**，而 `artifacts/` 在 `.gitignore:38` 被忽略，不入库、不随包。
- **本文档是唯一入库物**，且只记录指标与结论，不夹带权重。
- 若将来要走商用，必须换掉 CC-BY-NC 权重（自训或换商用许可模型），不能「先用着再说」。

---

## 1. 结论（先说结果）

> **能跑通、中文能听懂、CPU 上快得多——15 句中 11 句被中文 ASR 逐字还原（字级近似错率中位数 0.000 / 均值 0.023），
> RTF 中位数 0.475（P95 0.543，最慢 0.642），一句话 1.2–2.9 秒出声，冷启动 0.61 秒，峰值内存 678 MB。
> 对标本机 CosyVoice2-0.5B 的 RTF 中位数 2.42（一句话 17–43 秒、冷启动 30.6 秒、4.63 GB），差距约 5 倍时延、7 倍内存。**

但要同时记住三点，别把这份结果当成「可以直接上产品」：

1. **权重 CC-BY-NC，不能商用、不能随包**——这条压倒其他一切结论。
2. **它没有情绪控制能力**：本文的「5 种情绪」只是语料分组标签，不是给模型的情绪指令；ZipVoice-Distill 这套输入里没有 instruct/emotion 通道。
3. **离接入产品还差一层**：现有 `services/audio-ai-worker` 走的是 CosyVoice / GPT-SoVITS 那套 HTTP 后端，没有 onnxruntime 路径；`fetch-engine.mjs` 也还不支持这种「压缩包 + 多文件」的下载形态（见 §6）。

---

## 2. 测法与口径

- **引擎**：`sherpa-onnx` 2.0.3（PyPI，Python 3.11，macOS arm64），`provider="cpu"`、`num_threads=4`、`num_steps=4`。
- **模型**：`sherpa-onnx-zipvoice-distill-int8-zh-en-emilia`
  - 来源：GitHub `k2-fsa/sherpa-onnx` release 资产 `tts-models`（压缩包 109,162,785 B）+ `vocoder-models` 的 `vocos_24khz.onnx`（54,157,409 B）
  - 解压后体积分布：`decoder.int8.onnx` 124,657,100 B · `encoder.int8.onnx` 5,570,211 B · `vocos_24khz.onnx` 54,157,409 B · `lexicon.txt` 1,727,147 B · `espeak-ng-data` 18 MB · 合计约 **204 MB**
  - 对照 CosyVoice2-0.5B：14 文件 / **4,073,955,371 B**
- **音色参考**：模型自带 `test_wavs/news-female.wav`（24 kHz，6.84 s）与其转写文本，`generate(text, prompt_text, prompt_samples, 24000, speed=1.0, num_steps=4)`。
- **语料**：15 条中文句子，按产品 5 个情绪分组、每组 3 句（`sweet_normal` / `tsundere_refuse` / `rage_spray` / `lazy_yawn` / `happy_rice`）。**分组只用于对照 CosyVoice2 的语料口径，不是情绪条件输入**。
- **计时**：`time.perf_counter()` 包住 `generate()`；RTF = 墙钟 / 音频时长；冷启动单独计时（构造 `OfflineTts`，含权重加载）。
- **内存**：`resource.getrusage(RUSAGE_SELF).ru_maxrss`，进程级峰值。
- **可懂度代理**：全部产物送中文 Paraformer（`sherpa-onnx-paraformer-zh-small-2024-03-09`）回环识别，比对参考文本。
  - 错率口径是 **`1 - difflib.SequenceMatcher.ratio()`**（去标点后的字级近似），**不是严格 CER 公式**；只作「能不能听懂」的粗代理，不等于人耳听感。
- 全程未改上游代码、未做任何参数搜索；单次运行，无重复取平均（除标注的冷启动复测）。

---

## 3. 逐句结果

| # | 语料组 | RTF | 墙钟 | 音频时长 | 字级近似错率 | 削波样本 | NaN |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | sweet_normal | 0.475 | 2.19 s | 4.62 s | 0.053 | 0 | 0 |
| 2 | sweet_normal | 0.444 | 1.28 s | 2.88 s | 0.000 | 0 | 0 |
| 3 | sweet_normal | 0.518 | 1.69 s | 3.26 s | 0.000 | 0 | 0 |
| 4 | tsundere_refuse | 0.480 | 2.23 s | 4.64 s | 0.027 | 4 | 0 |
| 5 | tsundere_refuse | 0.382 | 1.48 s | 3.88 s | 0.000 | 0 | 0 |
| 6 | tsundere_refuse | 0.537 | 1.81 s | 3.37 s | 0.000 | 0 | 0 |
| 7 | rage_spray | 0.448 | 1.95 s | 4.36 s | 0.125 | 0 | 0 |
| 8 | rage_spray | 0.286 | 1.22 s | 4.27 s | 0.000 | 0 | 0 |
| 9 | rage_spray | 0.436 | 1.91 s | 4.37 s | 0.000 | 0 | 0 |
| 10 | lazy_yawn | 0.642 | 2.88 s | 4.49 s | 0.133 | 0 | 0 |
| 11 | lazy_yawn | 0.421 | 2.07 s | 4.92 s | 0.000 | 5 | 0 |
| 12 | lazy_yawn | 0.486 | 2.20 s | 4.53 s | 0.000 | 0 | 0 |
| 13 | happy_rice | 0.457 | 2.27 s | 4.97 s | 0.000 | 2 | 0 |
| 14 | happy_rice | 0.506 | 2.06 s | 4.07 s | 0.000 | 0 | 0 |
| 15 | happy_rice | 0.543 | 1.55 s | 2.85 s | 0.000 | 0 | 0 |

错掉的 4 句（都只错 1–3 个字，且错在语气词/拟声词上，不是整句糊掉）：

| # | 参考 | ASR 回读 |
| --- | --- | --- |
| 1 | 主人，今天也辛苦啦，我给你倒杯热茶好不好呀。 | 主人今天也辛苦了我给你倒杯热茶好不好呀 |
| 4 | 哼，本鱼才没有偷懒，只是刚好在思考人生而已。 | 本鱼才没有偷懒只是刚好在思考人生而已 |
| 7 | 噗——再说我大肥鱼，我就把水喷到你脸上！ | 扑在说我大肥鱼我就把水喷到你脸上 |
| 10 | 唔……好困啊，能不能让我再睡五分钟嘛。 | 五好困啊能不能让我再睡五分钟吗 |

第 4 句的错来自参考里那个孤立的「哼」被吞掉；第 7、10 句是拟声词（「噗——」「唔……」）在 ASR 侧被改写，且这两句本身就带破折号/省略号，属于最难的一档。**这里不替它辩护，也不外推**——15 句样本量小，只能说明「字面内容基本可懂」。

---

## 4. 汇总与对拍

### 4.1 本次汇总（n=15）

| 指标 | 值 |
| --- | --- |
| RTF | P50 **0.475** · P95 **0.543** · 最慢 0.642 · 最快 0.286 |
| 整句墙钟 | P50 **1.95 s** · 均值 1.92 s · 最慢 2.88 s |
| 冷启动（构造 `OfflineTts`，含权重加载） | **0.61 s** |
| 峰值 RSS | 加载后 433 MB → 跑完 2 句后 **678 MB** |
| NaN 样本 | 0 |
| 削波样本（\|x\| > 0.999） | 15 句合计 11 个样本点（最多一句 5 个），幅度峰 0.98 左右 |
| 字级近似错率 | P50 **0.000** · 均值 **0.023** · 完全一致 11/15 |

### 4.2 对标本机 CosyVoice2-0.5B（同一台机器，同一批 5 情绪语料口径外）

| 指标 | ZipVoice-Distill int8（本次） | CosyVoice2-0.5B（已有实测） |
| --- | --- | --- |
| RTF P50 | **0.475** | 2.423 |
| RTF P95 | **0.543** | 4.225 |
| 一句话墙钟 | **1.2–2.9 s** | 17.8 s P50 / 43 s 最慢 |
| 冷启动首句 | **0.61 s** | 30.56 s |
| 峰值内存 | **678 MB** | 4.63 GB |
| 模型体积 | **约 204 MB** | 4.07 GB |
| 情绪控制 | **无**（无 instruct 通道） | 有（`inference_instruct2`） |
| 权重许可 | **CC-BY-NC（不可商用）** | Apache-2.0（权重需另核） |

> 这张表只说明「同样在本机 CPU 上，ZipVoice 快得多、小得多」，**不说明它更适合做产品**——最后两行的「没有情绪控制」「权重不可商用」是硬约束。
> 两者语料口径不同（CosyVoice2 是 30 句 × 5 情绪 = 150 条，本次是 15 条），因此 RTF 对比看量级，不看小数位。

---

## 5. 客观音质项（不下听感结论）

- 幅度峰 0.82–0.98，RMS 0.14–0.16，无静音/爆音段，无 NaN。
- 削波仅 11 个样本点，分布在第 4/11/13 句，量级不足以构成爆音（未做听感确认，只报数值）。
- 音频采样率由 vocoder 决定（24 kHz），与现有 `audio-ai-worker` 输出一致，接播放链路无需重采样。
- **人耳是否「像人」、是否有电流感/机械感——未判定，本报告不下这个结论。** 15 条 wav 已留档供 owner 自己听。

---

## 6. 未实测与已知缺口（不许拿它冒充已接入）

| 项 | 状态 | 事实 |
| --- | --- | --- |
| 走 `fetch-engine.mjs` 按需下载到用户数据目录 | **未跑通** | `tools/scripts/fetch-engine.mjs` 目前只支持 `https://huggingface.co/<repoId>/resolve/<revision>/<path>` 的**单文件**下载，没有压缩包解压能力；而这份权重是 GitHub release 的 `.tar.bz2` + 另一个 release 的 vocoder 文件。本次是在 `/tmp/zipvoice-probe/` 手工解压跑的，**没有经过产品的按需下载路径**。要接入必须先扩 `fetch-engine.mjs`（archive + 多来源），那是另一个工单。 |
| 接入 `services/audio-ai-worker` | **未做** | 该服务只有 CosyVoice / GPT-SoVITS 的 HTTP 后端抽象，没有 onnxruntime 推理路径。接入等于新增一套后端类型 + 生命周期管理（模型常驻/卸载），不在本次范围。 |
| 情绪表达 | **不具备** | 模型输入只有 text + 音色参考，没有 instruct。产品要的 5 情绪（嘴甜/傲娇/喷水/打哈欠/干饭）它做不到；要做到只能靠文本改写或换模型。 |
| 音色克隆质量 / 跨说话人稳定性 | **未测** | 只用了一组参考音频（`news-female.wav`），没有测多音色、没有测参考音频时长敏感性。 |
| 长句 / 多句连读 | **未测** | 最长一句 4.97 s 音频、33 字，`max_num_sentences=1`。 |
| Windows x64 | **未测** | 只在本机 macOS arm64 上跑过。 |
| 人耳听感 | **未做** | 见 §5。 |

---

## 7. 复跑方式

产物与脚本留档在 `artifacts/tts-ab/zipvoice-internal-noncommercial/`（`artifacts/` 被 gitignore，不入库）：

| 文件 | 内容 |
| --- | --- |
| `out-<n>-<tag>.wav` | 15 条产物（24 kHz 单声道 16-bit） |
| `bench.jsonl` | 逐句字符数 / 音频时长 / 墙钟 / RTF / 幅度峰 / RMS / NaN / 削波 |
| `asr.out` | 逐句 ASR 回读与字级近似错率 + 汇总行 |
| `cold.out` | 冷启动与内存峰值复测输出 |
| `measure_cold.py` | 冷启动/RSS 复测脚本（配置与 bench 完全一致） |

复跑前提：手工把权重解压到 `/tmp/zipvoice-probe/sherpa-onnx-zipvoice-distill-int8-zh-en-emilia/`，
再 `uv run --with sherpa-onnx --with numpy python -I measure_cold.py`。

---

## 8. 证据等级声明

- `[REAL-DEVICE]` 仅覆盖：**本机真实 CPU 推理、真实 wav 落盘、真实 ASR 回环**。
- **不覆盖**：产品下载/安装路径、Worker 服务接入、Electron 播放、人耳听感、Windows、商用可行性。
- 权重为 **CC-BY-NC**，本报告与全部产物仅作内部验证，**不得商用、不得随产品分发**。
