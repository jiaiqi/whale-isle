# 本机 TTS 自托管实测：CosyVoice2-0.5B 在 Apple Silicon 上的真实表现

> 工单：item 10（表现力语音）阶段 2 · 日期：2026-11-26 / 27 · 证据等级：**`[REAL-DEVICE]`**
> 权重：CosyVoice2-0.5B，`FunAudioLLM/CosyVoice2-0.5B`，revision `eec1ae6c79877dbd9379285cf8789c9e0879293d`，
> 安装于 `~/Library/Application Support/WhaleIsle/engines/cosyvoice2/0.5b-eec1ae6c/`（14 文件 / 4,073,955,371 B，sha256 与 HF LFS 元数据逐条核对一致）。
> 方案背景见 [docs/design/expressive-voice-plan.md](../../design/expressive-voice-plan.md)。门槛沿用方案 §4。

---

## 0. 结论（先说结果）

> **本机自托管不可用：RTF 中位数 2.42、P95 4.23，一句话（约 7 秒音频）要等 17–43 秒才出声；首包中位数 11.3 秒。
> 三种后端（CPU fp32 / MPS fp32 / MPS + fp16）没有一个跑进 0.35，也没有一个能支撑对话级交互。**

按方案 §5.5 处置：**默认档切商业 API；本地引擎保留为可选离线档**（权重不删），UI 必须标注体感代价。

这不是「参数没调好」，也不是「配置不对」——上游 CosyVoice 在非 CUDA 设备上把 fp16 / JIT / TensorRT / vLLM **硬编码关死**（`cosyvoice/cli/cosyvoice.py:161`），macOS 官方只支持 CPU fp32 一条路。

---

## 1. 测法与口径

- 语料：30 条中文句子（8–25 字，产品口吻），5 个产品情绪各跑一遍 → **150 条**。句子与情绪指令见 `/tmp/cvbench/bench.py`（随证据留档于仓库外）。
- 调用：`CosyVoice2.inference_instruct2(text, 情绪指令, asset/zero_shot_prompt.wav, stream=True)`——用 instruct 模式表达 5 个产品情绪，参考音频驱动音色。
- 计时：`time.perf_counter()` 包住整个生成器；**首包** = 调用到第一个 chunk yield；**总耗时** = 全部 chunk 收完；**RTF** = 总耗时 / 音频时长。
- 「流式首包」单独报，不当整句耗时——两者都给了，没有拿首包冒充整句。
- 内存：`resource.getrusage(RUSAGE_SELF).ru_maxrss`（macOS 单位为字节，已换算 GB），进程级峰值。
- 全程 `nice -n 10`，未改任何上游代码；只通过外部注入设备做 MPS 对照。

---

## 2. A 组：CPU fp32（上游默认路径）

### 2.1 整体分布（150 条）

| 指标 | P50 | P95 | 最慢 | 均值 |
| --- | --- | --- | --- | --- |
| RTF | **2.423** | **4.225** | **5.601** | 2.664 |
| 首包（ms） | 11,345 | 20,052 | 35,085 | — |
| 整句耗时（ms） | 17,765 | 31,247 | 43,017 | — |
| 音频时长（s） | 7.4 | — | — | 合计 1,102.7 s |

**低于 0.35 的样本数：0 / 150。**

### 2.2 按情绪

| 情绪 | n | RTF P50 | RTF P95 | RTF 最慢 | 首包 P50(ms) | 整句 P50(ms) | 整句 P95(ms) | 音频 P50(s) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| sweet_normal | 30 | 3.069 | 4.861 | 5.061 | 13,694 | 20,442 | 33,181 | 6.94 |
| tsundere_refuse | 30 | 2.471 | 3.547 | 5.601 | 12,029 | 18,307 | 27,237 | 7.28 |
| rage_spray | 30 | 2.292 | 3.188 | 4.009 | 10,891 | 17,615 | 31,535 | 7.98 |
| lazy_yawn | 30 | 2.175 | 2.828 | 2.883 | 10,822 | 16,799 | 25,688 | 7.82 |
| happy_rice | 30 | 2.224 | 3.361 | 4.052 | 10,181 | 16,280 | 24,715 | 7.40 |

`sweet_normal` 明显最慢（P50 3.07 vs 其余 2.2–2.5）：它是每组第一条要跑的，叠加了长时运行下的热降频/内存压力。这个偏置如实保留，没有剔除。

### 2.3 冷启动拆解（进程启动 → 第一句出声）

| 阶段 | 耗时 | 说明 |
| --- | --- | --- |
| 进程启动 + Python 导入（torch / onnxruntime / diffusers…） | ≈15.0 s | 子进程从 `Popen` 到脚本执行 |
| 权重加载（`llm.pt` 2.0 GB + `flow.pt` 0.45 GB + `hift.pt` 83 MB + 两个 onnx） | 6.57 s | 含 4 GB 权重映射，加载峰值 RSS **4.19 GB** |
| 首句流式首包 | 8.54 s | **无预热**，含首次前向的一次性初始化 |
| **合计：进程启动 → 第一句音频** | **30.56 s** | 首句整句 18.39 s（音频 6.60 s，RTF 2.79） |

稳态峰值 RSS **4.63 GB**（低于 6 GB 门槛，内存不是瓶颈，速度才是）。

---

## 3. B / C 组：换后端有没有用

先确认实际后端（不是声称的）：

- 上游 `cosyvoice/cli/model.py:36`：`self.device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')`，macOS 上恒为 CPU。
- 上游 `cosyvoice/cli/cosyvoice.py:161`：非 CUDA 时把 `load_jit / load_trt / load_vllm / fp16` 全部改回 `False`，并打 warning。
- MPS 由脚本**外部注入**（`cv.model.device = mps` + 三个子模块 `.to('mps')`），不改上游代码；fp16 用 `torch.autocast('mps', dtype=torch.float16)` 这条正道，不改模型 dtype。
- 打印出的实际设备：`mps:0 / dtype=torch.float32`（权重仍 fp32，计算走 autocast）。

同为 30 句 × sweet_normal（与 A 组同句集）：

| 组 | 实际后端 | RTF P50 | RTF P95 | RTF 最慢 | 首包 P50(ms) | 整句 P50(ms) | 峰值 RSS |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A | CPU fp32 | 3.069 | 4.861 | 5.061 | 13,694 | 20,442 | 4.63 GB |
| B | MPS fp32 | 2.551 | 3.242 | 5.266 | 10,972 | 16,759 | 4.61 GB |
| C | MPS + fp16 autocast | 2.801 | 3.309 | 3.780 | 12,269 | 18,673 | 5.76 GB |

**读法**：MPS 比 CPU 快约 17%，fp16 autocast 反而比 MPS fp32 慢约 10% 且多吃 1.1 GB 内存（autocast 的 dtype 转换开销在 0.5B 这个量级上盖过了算力收益）。**三者是同数量级，没有一个接近 0.35。**

MPS 没有出现算子不支持或回退到 CPU 的情况（全程未开 `PYTORCH_ENABLE_MPS_FALLBACK`，也没有抛 `NotImplementedError`）。

### 3.1 数值稳定性（速度达标也不能牺牲音质）

同一句 × 3（`sweet_normal`，同参考音频），逐条统计 NaN / Inf / 峰值 / 削波比例 / RMS / 相邻样本差分标准差（差分标准差异常大 = 爆音或撕裂）：

| 句 | 后端 | NaN | Inf | 峰值 | 削波比(>0.99) | RMS | 差分 std | 时长(s) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | CPU fp32 | 0 | 0 | 0.6032 | 0.0 | 0.0540 | 0.0159 | 6.48 |
| 2 | CPU fp32 | 0 | 0 | 0.7398 | 0.0 | 0.0647 | 0.0177 | 6.00 |
| 3 | CPU fp32 | 0 | 0 | 0.4910 | 0.0 | 0.0567 | 0.0156 | 5.72 |
| 1 | MPS fp32 | 0 | 0 | 0.4168 | 0.0 | 0.0432 | 0.0129 | 7.36 |
| 2 | MPS fp32 | 0 | 0 | 0.5903 | 0.0 | 0.0485 | 0.0142 | 5.28 |
| 3 | MPS fp32 | 0 | 0 | 0.5607 | 0.0 | 0.0571 | 0.0161 | 5.68 |
| 1 | MPS fp16 | 0 | 0 | 0.4140 | 0.0 | 0.0451 | 0.0133 | 7.08 |
| 2 | MPS fp16 | 0 | 0 | 0.7568 | 0.0 | 0.0778 | 0.0224 | 5.84 |
| 3 | MPS fp16 | 0 | 0 | 0.6541 | 0.0 | 0.0609 | 0.0177 | 5.56 |

**读法**：

- **无 NaN、无 Inf、无削波**（9 条样本、峰值最高 0.757，远未触顶）。数值上没有崩溃或爆音。
- 三种后端产出的波形量级一致（RMS 0.043–0.078，差分 std 0.013–0.022），**没有哪一档出现可测量的失真**。
- 逐条 wav 已留存（`stab-{cpu,mps,fp16}-{0,1,2}.wav`，仓库外），可人工听查。
- **但样本只有 3 条/后端**，只能证明「没崩、没爆」，**不能证明听感质量**——听感属人类真机验收项，本报告不下结论。

---

### 3.2 卸载链路实测（`--remove` 无残留）
要求是「真跑一次 `--remove`，证明无残留 + 产品读出未安装」。owner 同时要求「本地引擎保留为可选离线档」，二者靠**在独立沙盒根目录上真跑**来同时满足：正式安装目录（4 GB）不动，卸载行为在真实文件系统上完整验证一遍。

**第一次真跑就抓到一个缺陷**：文件删光了，却留下两层空目录。根因在 `tools/scripts/fetch-engine.mjs` 的 `remove()`——清空目录用的 `rm(dir, { recursive: false })` 对目录会抛 `ERR_FS_EISDIR`，又被 `.catch(() => undefined)` 静默吞掉。**「删干净」原本是假的**（文件零残留，但目录壳留着）。

修复：`rm` → `rmdir`（`rmdir` 只删空目录，非空报 `ENOTEMPTY`，正是这里要的语义），并新增 `listLeftovers()`：清单之外的文件不删（不能凭 guess 删用户数据），但**必须如实报告残留**，不让「删干净」的结论掩盖它。同时补了 6 条回归单测（`tools/scripts/fetch-engine.spec.ts`），已验证在旧实现下第 1 条**确实变红**。

修复后重跑（沙盒根 `/tmp/cvbench/remove-sandbox2`，初始 15 个文件）：

```
$ node tools/scripts/fetch-engine.mjs --remove --dest /tmp/cvbench/remove-sandbox2
✓ 已删除 14 个文件与 installed.json（/tmp/cvbench/remove-sandbox2/cosyvoice2/0.5b-eec1ae6c）
```

| 检查项 | 结果 |
| --- | --- |
| 剩余**文件**数 | **0** |
| 剩余**目录** | **0**（`cosyvoice2/` 与版本目录一并删净；只剩沙盒根目录本身） |
| 剩余占用 | **0 B** |
| 二次 `--remove` | `无需删除：… 不存在或没有 installed.json`，exit 0（幂等，不报错） |
| 随后 `--check` | `✗ 未安装：缺少 …/installed.json`，exit 1（正确拒绝宣称已装） |
| 产品侧 `resolveLocalEngine()` 读数 | `installed: false, reason: "no_marker", detail: "未找到 installed.json（…）"` —— **产品确实读成「未安装」** |
| 正式安装目录 | **未受影响**：resolver 仍读出 `installed: true`（4 GB 保留作可选离线档） |

---

### 3.3 权重不入库核验

| 检查 | 结果 |
| --- | --- |
| `git ls-files` 中最大文件 | `apps/desktop-host/assets/brand/icon.icns` 1.31 MB —— **没有任何权重** |
| 仓库工作区内 `*.pt` / `*.onnx` / `*.safetensors` | **0 个** |
| 权重实际位置 | `~/Library/Application Support/WhaleIsle/engines/cosyvoice2/0.5b-eec1ae6c/`（用户数据目录） |
| venv / 缓存 | 全部在仓库外的 `~/Documents/vibe/CosyVoice/.venv` 与 `/tmp/cvbench/`，**未进 repo、未进 git index** |

---

## 4. 替代引擎速评（不实测，给判断依据）

结论前置：**这条路走不通之后，值得先试的是 ZipVoice，其次是接受固定音色的 Kokoro；CosyVoice 的 ONNX/CoreML 移植与 F5-TTS 都不解决本机延迟。**

| 候选 | 关键事实 | 中文表现力 | 参考音驱动 | 判断 |
| --- | --- | --- | --- | --- |
| **ZipVoice**（k2-fsa） | 非自回归 flow-matching；代码 Apache-2.0，**权重 CC-BY-NC**（受 Emilia 数据约束）；**sherpa-onnx 已收录**，有现成 ONNX 推理路径 | 卡片标注 English + Chinese，中文表现力未实测 | **支持零样本克隆** | **最值得先试**：NAR + 小模型 + ONNX，CPU 上有机会比 0.5B 的 AR CosyVoice2 快一个量级；障碍是权重非商用、中文听感未知 |
| **F5-TTS**（SWivid） | Diffusion Transformer + flow matching（非逐 token AR）；代码 MIT，**权重 CC-BY-NC-4.0**；零样本克隆需参考音频 + 其文本（不给文本会走 ASR，额外吃显存） | 支持（Emilia-ZH-EN、WenetSpeech4TTS 训练） | 支持 | 质量与音色自由度好，但仍是扩散式多步推理，**不解决 CPU 延迟**；权重非商用，商用需另找授权 |
| **Kokoro-82M-v1.1-zh** | 82M，StyleTTS2 架构，**Apache-2.0**，100 个中文音色 | 中文可用，但表现力来自预置音色而非情绪指令 | **不支持**参考音克隆 | 速度会是最快的，但**音色是固定音色库、无情绪控制**，与我们「原创音色 + 五情绪表演」的需求不匹配，除非接受从 100 个音色里挑一个 |
| **sherpa-onnx 生态** | 支持 VITS / Matcha / Piper / Kokoro / ZipVoice / KittenTTS 等，**不含 CosyVoice** | 取决于所选模型 | 取决于所选模型 | 价值是「同一套 ONNX Runtime 部署壳」，换模型不改集成层；若 ZipVoice 路线成立，它是最省事的落地壳 |
| **CosyVoice 的 ONNX / CoreML 移植** | 官方仓库无 ONNX / CoreML 导出；上游对非 CUDA 硬编码 CPU | — | — | 要转 0.5B 的 AR LLM + flow + vocoder 三段，工程量大、算子覆盖存疑，**不作为近期路径** |
| **商业 API**（方案默认档） | 已在 `voice-runtime` 里接通 | 强 | 视供应商 | **本机结论下的默认档** |

---

## 5. 处置：本地引擎保留为可选离线档

- **不删 4 GB 权重**：离线可用本身有价值，只是不当默认。
- UI 必须标注体感代价（按本机实测填）：一句话（约 7 秒音频）**要等 16–43 秒**；首包 **10–35 秒**；冷启动首句 **30 秒**。
- 回退顺序沿用 `packages/voice-runtime/src/local-engine.ts` 的 `planVoiceFallback()`：`commercial_api` → `system_tts` → `local_engine`（`degraded` 标记 + 原因），本地引擎在商业 API 不可用时才兜底。

---

## 6. 证据等级与局限

| 项 | 等级 / 状态 |
| --- | --- |
| 权重下载与 sha256 核对（14 文件） | `[REAL-DEVICE]`，已完成；HF 登记 sha256 的 6 个文件**逐一一致，0 个不一致** |
| CPU fp32 150 条分布 | `[REAL-DEVICE]`，本机实测 |
| MPS fp32 / MPS fp16 各 30 条 | `[REAL-DEVICE]`，但样本仅 30 条，且设备是**外部注入**、非上游支持路径 |
| 数值稳定性（每后端 3 条） | `[REAL-DEVICE]`，无 NaN/Inf/削波；**样本少，只证明「没崩没爆」，不证明听感** |
| 冷启动拆解 | `[REAL-DEVICE]`，进程启动 → 第一句出声 30.56 s |
| `--remove` 卸载链路 | `[REAL-DEVICE]`，沙盒根目录真跑，修复后文件/目录/占用全为 0；产品 resolver 读出 `installed:false` |
| 权重不入库核验 | `[REAL-DEVICE]`，`git ls-files` 无权重，repo 内 0 个 `.pt/.onnx/.safetensors` |
| 商业 API 对比听感 | **未做**（未接任何供应商 Key） |
| 长时稳定性（>1 小时连续合成、热降频） | **未做** |
| 其它引擎（ZipVoice / F5-TTS / Kokoro） | **未实测**，仅给判断依据 |
| 数值稳定性单元测试 | `[TYPE-ONLY]`（脚本行为有单测覆盖；波形质量本身无法自动化断言） |

---

## 7. 待办（本工单未做，需后续工单）

| # | 事项 | 说明 |
| --- | --- | --- |
| 1 | ✅ **默认档切商业 API** | 2026-11-27 已落地，见 §9.1 |
| 2 | ✅ **UI 标注体感代价** | 2026-11-27 已落地，见 §9.2 |
| 3 | ✅ **真实推理标记诚实化** | 2026-11-27 已落地，见 §9.3 |
| 4 | **ZipVoice 试跑** | owner 2026-11-27 批准「非商用权重可用于内部验证，不商用」；待做，产物须标 `[INTERNAL-VALIDATION-NONCOMMERCIAL]` |
| 5 | **听感验收** | 数值稳定性只覆盖「没崩没爆」，表现力与自然度必须由人类真机试听判定 |

---

## 8. 复跑方式

```
# 1) 装引擎（可复跑，权重不进 repo）
node tools/scripts/fetch-engine.mjs            # 下载 + 校验 + 原子安装
node tools/scripts/fetch-engine.mjs --check    # 逐文件校验
node tools/scripts/fetch-engine.mjs --remove   # 按 installed.json 精确删除

# 2) 基准（脚本随证据留档；依赖 owner 环境里的 CosyVoice 仓库与其 .venv）
.venv/bin/python bench.py --mode warm --out warm.jsonl     # A 组 150 条
.venv/bin/python bench.py --mode cold --out cold.json      # 冷启动
.venv/bin/python bench_backend.py --device mps --autocast fp16 --out mps-fp16.jsonl   # C 组
```

---

## 9. 收尾三件（2026-11-27 落地）

### 9.1 显式「本地引擎 = 可选离线档」开关

`planVoiceFallback()` 不再用「装没装」隐式决定优先级，改为接收显式档位 `tier`：

| 档位 | 首跳 | 其余 |
| --- | --- | --- |
| `commercial_default`（默认） | `commercial_api` | 本地引擎降为 `role: 'optional'`，再往后是系统 TTS |
| `offline_preferred` | `local_engine` | `commercial_api` → `system_tts` |

- 档位持久化在 `PetDesktopPrefsSchema.voiceEngineTier`（契约层），UI 开关写它、读它，随时可切回。
- 计划新增 `tierHonored`：所选档位的首选后端**没有**排在第一时置 `false`（例如选了离线档但本地引擎未安装），必须让 UI 把这句说出来，不许假装档位生效。
- `degraded` 语义保持不变（只有本地引擎本身为 `false`），避免把「商业档是默认」和「质量降级」两件事搅在一起。

### 9.2 UI 直接写体感代价

三个数字不再只活在证据文档里：`packages/shared-protocol/src/voice.ts` 导出
`OFFLINE_TIER_COST` 与 `OFFLINE_TIER_COST_TEXT =「一句话等 16–43 秒 / 首包 10–35 秒 / 冷启动首句 30 秒」`，
语音中心面板（`apps/desktop-host/src/renderer/director/voice-center-panel.tsx`）直接渲染这段原文，
UI 与本文档共用同一份常量，杜绝「文档写一套、界面写另一套」。

面板同时显示本地 Audio Worker 的**探针实测**结果（`v2VoiceProviders()`）：
`占位/降级` / `真实后端` / `未启动`，以及「情绪 TTS：支持 / 不支持（探针实测）」。

### 9.3 冒名修正与探针实测

| 位置 | 修前 | 修后 |
| --- | --- | --- |
| `emotion_router.py` `StubLocalBackend.name` | `"local-gpt-sovits"`（一个真实存在的本地 TTS 服务） | `"stub-sine-placeholder"` |
| `StubCloudBackend.name` | `"cloud-siliconflow"`（冒名真实云端服务） | `"stub-sine-placeholder-cloud"` |
| `FailingBackend.name` | `"local-gpt-sovits"` | `"stub-failing"` |
| 合成回执 | 无占位标记，调用方无从分辨 | 新增 `placeholder` / `placeholderReason`（写入 `TtsSynthesisResultSchema` 契约） |
| `/health` | 只有硬件后端，没有 TTS 能力 | 新增 `tts` 段：`mode` / `engine` / `supportsEmotion` / `detail` |
| `LocalAudioWorkerProvider.probe()` | 成功与失败两个分支都硬编码 `supportsEmotion: true` | 读 `/health.tts` 实测；旧版 Worker 未上报时按 `false` 处理；占位后端一律 `false` |

`supportsEmotion` 的探针是真跑出来的：`EmotionTtsRouter.probe_emotion_capability()` 用同一句文本、
两种情绪各合成一小段再比较字节——字节一样就说明后端根本不区分情绪。占位后端即使字节不同也报 `false`，
因为「正弦改基频」不叫情绪 TTS。

### 9.4 真机证据（本机真实进程 + 真实 HTTP）

启动真实 `uvicorn app:app`（127.0.0.1:18770，本机 macOS-27.2.1-arm64），不重启桌面端：

```json
// GET /health
{ "status": "ok", "backend": "mps",
  "tts": { "mode": "placeholder", "engine": "stub-sine-placeholder",
           "supportsEmotion": false,
           "detail": "占位后端 stub-sine-placeholder：确定性正弦占位波形…不是任何 TTS 模型产出的人声；不支持情绪 TTS" } }

// POST /tts/emotion {"text":"[傲娇反驳] 哼，本鱼才没有偷懒！"}
{ "backend": "stub-sine-placeholder", "degraded": false, "placeholder": true,
  "placeholderReason": "确定性正弦占位波形：用于打通链路与口型同步，不是任何 TTS 模型产出的人声",
  "durationMs": 2200, "format": "wav" }
```

宿主侧用**真实 HTTP**（非 mock fetch）打同一个进程：

```
probe(): { kind: 'local-audio-worker', available: true, degraded: true,
           supportsEmotion: false,
           detail: '… · stub-sine-placeholder · 占位后端…不支持情绪 TTS' }
synthesize(): { degraded: true, placeholder: true, durationMs: 2200, audioBytes: 105644 }
```

结论：调用本地后端拿到的是**明确标注为占位的波形**，而不是伪装成真实 TTS 的人声回执。

**证据等级**：`[REAL-DEVICE]` 仅限「本机真实 FastAPI 进程 + 真实 HTTP 往返」；
不包含 Electron 宿主内播放、不包含人耳听感判定，那两项仍未验收。

---

## 10. 商业 API 两家接入与听感对拍（2026-11-27，owner 批准两家都接）

### 10.1 已实测

| 项 | 证据 | 结论 |
| --- | --- | --- |
| 两家 provider 已进同一条路由 | `apps/desktop-host/src/main/v2-kernel-host.ts` 的 `VoiceProviderRouter` 同时注册 `MiniMaxTtsProvider`（`kernel.secrets.resolve('minimax')`）与 `CloudOpenAiTtsProvider`（`kernel.secrets.resolve('openai-tts')`），再挂本地 Worker 与系统 TTS | 两家都能被同一路由调度，按 `preferredProvider` 优先 |
| 默认档改为**显式选择**供应商 | `PetDesktopPrefsSchema.voiceCommercialProvider`（`minimax-tts` / `openai-compatible-tts`）+ `resolveCommercialTtsProvider()`：选中的那家可用就用它；不可用才回落另一家并置 `honored:false`、写明原因 | 不再由「谁配了 Key 谁上」隐式决定；5 例单测覆盖两家都可用 / 只一家可用 / 都不可用 / 本地 Worker 不算商业供应商 |
| UI 可选可试听 | 语音中心「语音引擎档位」卡片：两家的可用状态取自 `v2VoiceProviders()` 探针，切换即写 prefs；「试听一句」按当前选择调 `v2:voice-synthesize-preview` 并直接播放返回音频 | owner 可在界面里逐家试听对比 |
| 凭据库现状（只读巡检，未取明文） | 运行中的中控台走 `--use-mock-keychain`：`providerVaultStatus()` 返回 `backend=mock-keychain`、`vaultFile=provider-vault.mock-keychain.json`，minimax / openai / openai-tts 全部 `missing` | **这个实例本来就看不到任何真实 Key**，不能拿它跑对拍 |

真实凭据库 `~/Library/Application Support/Whale Isle/provider-vault.json`（v2 格式）里现有的 8 条：
`deepseek-official`、`minimax`、`opencode-go`、`openrouter`、`custom-1795343797653`、`opencode-zen`、`typesafe-jev`、`kimi-moonshot`。

### 10.2 未实测（阻塞项，逐项写清）

| 项 | 状态 | 缺什么 |
| --- | --- | --- |
| MiniMax 听感对拍 | **未实测** | 库里**有** `minimax` 条目（`identity=Electron`，2026-11-26T01:19:42Z 写入），但本次能连上的中控台实例是 mock-keychain 模式，读不到；需要用**不带 `--use-mock-keychain`** 的正常启动方式，在凭据设置页确认 `minimax` 状态为 `loaded`（若显示 `identity-mismatch` 则重存一次） |
| OpenAI 兼容 TTS | **未实测** | 主进程读的是 `kernel.secrets.resolve('openai-tts')`；vault 里**没有** `openai-tts`，也没有 `openai` 条目 → 缺的是 **`openai-tts` 这一个 providerId 的 API Key**（外加它要用的 baseUrl/model，若走非官方端点） |
| 20 句 × 5 情绪对拍产物 | **未产出** | 需要上面两家至少各一把可用的 Key；脚本会按 `artifacts/tts-ab/<provider>/<emotion>-<n>.wav` + `manifest.json` 落盘 |
| 人耳听感结论 | **未做** | owner 自己听；本报告只给客观项 |

### 10.3 商业档 vs 离线档的耗时对照（现有数据）

| 档位 | 一句话（约 7 秒音频）总耗时 | 首包 | 冷启动首句 |
| --- | --- | --- | --- |
| 本地离线档（CosyVoice2-0.5B，本机实测 n=150） | P50 17.8s / P95 27.1s / max 43s | P50 11.3s | 30.6s |
| 商业 API（MiniMax / OpenAI） | **未实测**（缺 Key） | **未实测** | 不适用（无本地冷启动） |

这张表的右两行是空的，原因就是 10.2 的缺 Key——不是没测，是测不了，不许拿估算值填。

---

## 11. 另一条路：ZipVoice-Distill 内部验证（2026-11-27，`[INTERNAL-VALIDATION-NONCOMMERCIAL]`）

CosyVoice2 在本机不可用，不等于「本地引擎这条路彻底死了」。同机另跑一条 onnx 路线，结论见
[zipvoice-internal-validation.md](./zipvoice-internal-validation.md)：
RTF P50 **0.475** / 一句话 **1.2–2.9 秒** / 冷启动 **0.61 秒** / **678 MB**，中文 ASR 回环 11/15 逐字一致。

但**它不能拿来替代本文档的处置结论**，原因三条：

- 权重 **CC-BY-NC**（Emilia 训练数据），不可商用、不可随产品分包——这条单独就否掉了产品化。
- **没有情绪 instruct 通道**，产品要的 5 情绪它做不到。
- 还没接产品那条路：`fetch-engine.mjs` 只能下 HF 单文件、无压缩包解压；`audio-ai-worker` 没有 onnxruntime 后端。

所以本文档 §5 的处置（默认商业 API、本地引擎留作可选离线档）**保持不变**。
