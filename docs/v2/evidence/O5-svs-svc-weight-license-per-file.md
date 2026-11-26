# SVS / SVC 权重许可逐文件核实（2026-11-26，item 5）

> 性质：**外部资料核实**，未下载任何权重、未购买、未注册、未接受任何在线协议，也未上传任何声音。
> 方法：只读 HuggingFace API / 文件树、GitHub `raw` LICENSE 原文、releases API、模型卡与官方许可页。
> 这份文档用来**纠正**此前 `O5-svs-svc-backend-research.md` 里「RVC HF 权重仓 MIT」「HF 权重 MIT」这类泛化表述——那些说法把「代码许可」错当成「权重许可」，不能作为下载依据。

## 0. 三条方法论前提（影响全部判断）

1. **HF 仓库 401 不等于「需要登录」**：实测 gated 仓 `meta-llama/Llama-2-7b-hf` 返回 200，故 401 表示仓库不存在/已私有。据此 `openvpi/params`、`openvpi/DiffSinger`、`openvpi/vocoders`、`yxlllc/RMVPE`、`wenet-e2e/opencpop` 在 HF 上**均不存在**。
2. **HF 的 `license:` tag 是上传者自填、平台不校验**，只能当「上传者声明」，不能当法律事实。
3. **许可状态三态**（本文统一用）：
   - **(a)** 仓库有明确 LICENSE 且覆盖权重 → 可依据该条款使用；
   - **(b)** 无 LICENSE、条款冲突、或权重不在声明范围内 → **许可不明，默认不可用**（既不可商用，也不可直接当"非商用验证"依据）；
   - **(c)** 明确非商用（CC BY-NC-SA / CC BY-NC-ND）→ 只能在非商用边界内用，且要接受附加条件。

## 1. 逐文件许可表

### 1.1 SVC（音色转换）—— RVC 官方权重仓

仓库 <https://huggingface.co/lj1995/VoiceConversionWebUI>（提交 `e6d0c1a17da07c33557852f9dfa2bd44cc75737d`，2026-08-01）

**关键事实**：仓库根目录有一个中文名许可文件 `使用需遵守的协议-LICENSE.txt`（2150 B），它才是约束权重的文件；README 只有 21 字节的 `license: mit`。该文件正文：

```
MIT License
Copyright (c) 2022 lj1995
本软件仅供研究使用，使用软件者、传播软件导出的声音者自负全责。如不认可该条款，
则不能使用/引用软件包内所有代码和文件。
```

其后是标准 MIT 正文与第三方清单（ContentVec MIT、VITS MIT、HiFiGAN MIT、gradio Apache-2.0、ffmpeg LGPLv3、UVR5 MIT、audio-slicer MIT）。

| 对象 | 位置 | 许可状态 | 非商用验证 | 商用 |
| --- | --- | --- | --- | --- |
| `pretrained_v0/*.pth`（12 个 v1 底模） | `/tree/main/pretrained_v0` | (b) 冲突 → 研究用途 | 可（内部研究/验证，须留存该 LICENSE） | **否** |
| `pretrained/*.pth`（另 12 个） | `/tree/main/pretrained` | (b) 同上 | 可（研究） | **否** |
| `pretrained_v2/*.pth`（12 个 v2 底模，含 f0 版本） | `/tree/main/pretrained_v2` | (b) 同上 | 可（研究） | **否** |
| `hubert_base.pt` | `/resolve/main/hubert_base.pt`（189 MB） | (a) 本仓声明覆盖；上游 HuBERT Apache-2.0 | 可 | 建议直接用上游 HuBERT |
| `rmvpe.pt` / `rmvpe.onnx` | `/resolve/main/rmvpe.pt`（181 MB） | (b) 上游 `yxlllc/RMVPE` 无 LICENSE | 谨慎 | **否** |
| `uvr5_weights/*.pth`（7 个分离模型） | `/tree/main/uvr5_weights` | (b) LICENSE 只列 UVR **代码** MIT，未列权重 | 谨慎 | **否** |
| `pymss_weights/*.ckpt`（4 个，319–456 MB） | `/tree/main/pymss_weights` | (b) 不在第三方清单内 | 否 | **否** |
| `weights/白菜357k.pt` | `/resolve/main/weights/白菜357k.pt` | (b) 来源不明 | 否 | **否** |
| `config.py` 默认 `weights\洛天依v3.pt` | `/raw/main/config.py` | 声音人格权风险 | 否 | **否** |

数据层：RVC README 原文写「底模使用接近50小时的开源高质量 VCTK 训练集训练，无版权方面的顾虑」；VCTK 已独立核实为 **CC BY 4.0**。

### 1.2 底模镜像与音高/内容编码器

| 对象 | URL | 许可原文要点 | 状态 |
| --- | --- | --- | --- |
| `licyk/rvc-model`（结构最规范的镜像仓） | <https://huggingface.co/licyk/rvc-model> | `manifest.json` 自述 `"license": "MIT with the RVC authors' research-use clause (LICENSE-RVC.txt)"`，逐文件带 sha256 与 origin；其 `LICENSE-RVC.txt` 与上游中文 LICENSE **逐字节相同** | (b) 继承研究条款 |
| └ `crepe/full.pth`、`crepe/tiny.pth` | `.../resolve/main/crepe/full.pth` | `LICENSE-CREPE.txt`：MIT（© 2020 Max Morrison），**覆盖权重** | **(a) 可商用** |
| └ `fcpe/fcpe_c_v001.pt` | `.../resolve/main/fcpe/fcpe_c_v001.pt` | `LICENSE-FCPE.txt`：MIT（© 2023 CN_ChiTu），**覆盖权重** | **(a) 可商用** |
| `facebook/hubert-base-ls960` | <https://huggingface.co/facebook/hubert-base-ls960> | 模型卡 `license: apache-2.0`，覆盖 `pytorch_model.bin` | **(a) 可商用** |
| `lengyue233/content-vec-best` | <https://huggingface.co/lengyue233/content-vec-best> | tag `license: mit`，但上游 ContentVec 权重经 IBM Box 分发且**无许可声明**（代码仓 MIT） | (b) 冲突 |
| `yxlllc/RMVPE` | <https://github.com/yxlllc/RMVPE> | **仓库无 LICENSE**；release `230917` 含 `rmvpe.zip`(340 MB)，无许可说明；README 自述训练数据含 **M4Singer**（CC BY-NC-SA） | **(b) 许可不明 + 数据 NC，默认不可用** |
| `CNChTu/FCPE` | <https://github.com/CNChTu/FCPE> | MIT（1065 B），权重随 PyPI `torchfcpe` 分发 | **(a) 可商用** |
| `maxrmorrison/torchcrepe` | <https://github.com/maxrmorrison/torchcrepe> | MIT（1090 B），`assets/full.pth`/`tiny.pth` | **(a) 可商用** |
| `ddPn08/rvc_pretrained` / `rvc-webui-models` / `rvc-768-models` | HF | **无 license tag** | (b) |

### 1.3 SVS（歌声合成）

| 对象 | 核实结果 | 状态 |
| --- | --- | --- |
| `openvpi/params`（此前以为存放官方声学模型） | **HF 上不存在**：API 401、`?author=openvpi` 返回 `[]`、GitHub 组织无此仓、Wayback 无快照 | **无法核实**（前提不成立） |
| DiffSinger 代码仓 `openvpi/DiffSinger` | **Apache-2.0**（11,342 B）——只覆盖代码 | (a) 代码可商用 |
| DiffSinger 官方声学 checkpoint（GitHub Releases） | 5 个含资产的 release（v1.4.0 `1215_opencpop_ds1000_fix_label_nomidi.zip` 732 MB；v1.7.0 两个 736 MB；v2.1.0 `rmvpe.zip` 340 MB）正文扫描 `licen|commercial|CC BY` → **0 命中** | **(b) 权重许可未声明** |
| 上述 checkpoint 训练数据 | 文件名即 `opencpop` → **OpenCpop（CC BY-NC-ND 4.0）** | 至少非商用，ND 使衍生关系存疑 |
| `openvpi/vocoders` 代码仓 | **AGPL-3.0**（34,523 B） | 禁入主线 |
| OpenVPI 声码器权重（nsf-hifigan-v1 / 2024.02 / 2025.02） | 官方许可页 <https://openvpi.github.io/vocoders/> 原文：weights are licensed under **CC BY-NC-SA 4.0**；2025.02 release 正文同 | **(c) 明确非商用 + 附加分发条件** |
| `openvpi/SingingVocoders` | 代码 MIT；release v1.0.0 沿用「original release page」条款 | (c) 同 CC BY-NC-SA |
| HF 镜像 `AEmotionStudio/openvpi-pc-nsf-hifigan-2025-02` | tag `cc-by-nc-sa-4.0`，附完整 LICENSE/NOTICE，声明与官方一致 | (c) 无冲突 |
| OpenCpop 数据集 | 官方页 <https://wenet-e2e.github.io/opencpop/liscense/>：「for non-commercial purposes under a **CC BY-NC-ND 4.0**」，商用须邮件申请 | **(c) 明确非商用 + ND** |
| HF 镜像 `cyjin-yl/GreendamOpencpop` | 三重冲突：front-matter `gpl-2.0`、正文 `CC BY-NC-ND 4.0`、附加「须获 Opencpop 团队授权」 | (b) 最严格口径 = 不可用 |
| M4Singer | `dataset_license.md`：「CC BY-NC-SA 4.0 (NonCommercial!)」 | (c) |
| VCTK / LibriTTS / LJSpeech | CC BY 4.0 / CC BY 4.0 / Public Domain | (a) |
| NNSVS / ENUNU 代码 | MIT | (a) 代码可商用 |
| NNSVS 官方预训练权重 | releases `v0.0.3/v0.1.0/v0.1.1` **assets 全为空** | **不存在官方权重** |

### 1.4 AGPL 分支排除（已核实原文）

| 仓库 | LICENSE | 处置 |
| --- | --- | --- |
| `audiohacking/RVC-MacOS` | **AGPL-3.0**（35,184 B，首行 `GNU AFFERO GENERAL PUBLIC LICENSE Version 3`） | 禁入主线 |
| `RTCK-DEV/RVC-WebUI-MacOS-app` | **AGPL-3.0**（同上大小） | 禁入主线 |
| `qingbo1011/RVC-WebUI-MacOS` | **MIT**（1,142 B，© 2023 liujing04 / 源文雨 / Ftps） | 可用（但底模仍受 1.1 约束） |
| `openvpi/vocoders`（代码） | **AGPL-3.0** | 禁入主线 |

### 1.5 附带：带明确许可的 RVC 目标音色仓

| 仓库 | 许可 | 判定 |
| --- | --- | --- |
| `ampixa/nepali-rvc-voices-v1` | `cc-by-4.0`：训练音频 `ai4bharat/indicvoices_r`（CC BY 4.0），推理走 Applio（MIT），说话人为伪匿名 ID，要求保留署名 | **(a) 四层链条完整（唯一一个）**——但只能当**许可洁净性验证样本**，不能当产品音色 |
| `Saisho-Utane/Saisho-Model-RVC` | `cc-by-4.0`，正文有强制署名条款，明确允许商用集成 | (a) 但声音归属仅凭账号自证 |
| `ArkanDash/rvc-genshin-impact` | tag `mit`，卡片自承「voice … belongs to Hoyoverse … ripped from the game」 | 权重 (a) / 声音 (b) → **整体不可用** |
| `TheOriginalBox/NTTS-AI-Voice-RVC` | `apache-2.0`，正文仅「just an experiment」 | (b) 声明不可信 |

**重要观察**：HF 上带 `apache-2.0`/`cc-by-4.0` 的 RVC 角色音色有上百个（原神、Sonic 等），上传者对角色声音本无授权能力，**tag 覆盖不了声音人格权**。

## 2. 四层许可汇总结论

| 层级 | 结论 | 关键依据 |
| --- | --- | --- |
| 代码 | DiffSinger / SingingVocoders / DDSP-SVC / NNSVS / ENUNU / FCPE / torchcrepe / Applio 均 MIT 或 Apache-2.0；`openvpi/vocoders` 与两个 RVC-MacOS 分支 AGPL-3.0 必须排除；RVC 主仓是「MIT + 仅供研究」混合体 | Release/LICENSE 原文见上表 |
| 权重 | 干净可用的只有 **HuBERT(Apache-2.0)、FCPE(MIT)、CREPE(MIT)**；RVC 底模受研究条款；OpenVPI 声码器 CC BY-NC-SA；DiffSinger 声学模型**未声明**；RMVPE **无许可** | <https://openvpi.github.io/vocoders/>、<https://github.com/yxlllc/RMVPE/releases/tag/230917> |
| 数据 | VCTK/LibriTTS/LJSpeech 可用；**OpenCpop CC BY-NC-ND、M4Singer CC BY-NC-SA** → 训练过它们的派生权重至少非商用；OpenVPI 声码器用逐家私有授权数据，不可追溯 | OpenCpop 官方许可页、M4Singer `dataset_license.md` |
| 声音人格权 | 唯一没有任何开源许可证能解决的一层：公开角色音色均未获授权；RVC 官方 `config.py` 默认指向「洛天依v3.pt」；只有自录或书面授权声源可用 | <https://huggingface.co/lj1995/VoiceConversionWebUI/blob/main/config.py> |

## 3. 明确排除清单（13 项）

1. `audiohacking/RVC-MacOS` —— AGPL-3.0。
2. `RTCK-DEV/RVC-WebUI-MacOS-app` —— AGPL-3.0。
3. `openvpi/vocoders` 代码 —— AGPL-3.0。
4. OpenVPI 全部声码器权重 —— CC BY-NC-SA 4.0 + 附加分发条件。
5. DiffSinger 官方声学 checkpoint —— 权重许可未声明 + 训练于 OpenCpop(NC-ND)。
6. RMVPE 权重 —— 上游无 LICENSE + 数据含 M4Singer(NC-SA)。
7. `cyjin-yl/GreendamOpencpop` —— 三重冲突。
8. OpenCpop 原始数据集 —— CC BY-NC-ND 4.0，商用须邮件申请。
9. M4Singer —— CC BY-NC-SA 4.0。
10. `ddPn08/rvc_pretrained`、`ddPn08/rvc-webui-models`、`ddPn08/rvc-768-models` —— 无 LICENSE。
11. 一切游戏/动画角色 RVC 音色（含 `ArkanDash/rvc-genshin-impact`）—— 声音 IP 未授权。
12. `weights/白菜357k.pt`、`config.py` 默认 `洛天依v3.pt` —— 来源不明 / 角色音色。
13. `pymss_weights/*.ckpt`、`uvr5_weights/*.pth` —— 不在 LICENSE 第三方清单内。

## 4. 「已核实许可」的可执行下一步

### 4.1 许可干净、可立即下载的文件（按依赖顺序）

| 顺序 | 文件 | URL | 许可 |
| --- | --- | --- | --- |
| 1 | HuBERT 权重 | `https://huggingface.co/facebook/hubert-base-ls960/resolve/main/pytorch_model.bin` | Apache-2.0 |
| 2 | FCPE 音高权重 | `https://huggingface.co/licyk/rvc-model/resolve/main/fcpe/fcpe_c_v001.pt` | MIT |
| 3 | CREPE 音高权重 | `https://huggingface.co/licyk/rvc-model/resolve/main/crepe/full.pth` | MIT |
| 4 | RVC 底模（研究用途） | `https://huggingface.co/licyk/rvc-model/resolve/main/pretrained/v2/f0G40k.pth` | MIT + 研究条款（内部验证可接受，须留存 `LICENSE-RVC.txt`） |
| 5 | 目标音色（四层干净，仅作洁净性验证） | `https://huggingface.co/ampixa/nepali-rvc-voices-v1/resolve/main/voices/ne_rvc_f01/ne_rvc_f01_v1.pth` | CC BY 4.0（附同名 `.index`） |

使用 `licyk/rvc-model` 时**必须**同时保留其 `manifest.json`（含每个文件 sha256 与 origin）——这是目前唯一能一键证明「文件 + 版本 + 许可」的凭据。

**可跳过 RMVPE**：`f0_extractor` 改用 `fcpe` 即可让整条链路不触碰无许可权重。

**禁止**：把 `ampixa` 的尼泊尔语音色当产品上线素材；它只是许可洁净性验证样本。

### 4.2 商用 clean-room 必须自训/替换的项

| 项 | 现状 | 必须做 |
| --- | --- | --- |
| RVC 底模 G/D | MIT + 研究条款 | 用 VCTK（CC BY 4.0）或自录语料重训 |
| 内容编码器 | ContentVec 权重无许可 | 换 HuBERT（Apache-2.0）或自训 |
| 音高提取 | RMVPE 无许可 | 换 FCPE / CREPE（MIT） |
| 声码器 | OpenVPI 系列 CC BY-NC-SA | 用 MIT 的 HiFi-GAN 代码在自有数据上自训；**不得**打包或自动下载 OpenVPI 声码器 |
| SVS 声学模型 | DiffSinger 权重未声明 + Opencpop NC-ND | 用 DiffSinger 代码（Apache-2.0）+ 自有/授权语料自训 |
| 音色/声音 | 角色音色全部无授权 | 自录或签约歌手，签**明示商用 + 衍生模型**授权书 |

补充：DiffSinger **代码** Apache-2.0 可商用，只有权重与声码器是 NC —— 这一点常被误读成整栈 NC。

## 5. 「暂无符合项」的如实回答

**中文产品音色**：目前**没有任何一个许可明确、来源可核、可直接用于我们当前用途（中文桌宠直播唱歌）的现成音色权重**。原因不在权重条款，而在**声音人格权**：所有公开中文 RVC 音色要么是游戏/动画角色，要么来源不明。

**需 owner 提供的授权材料**（缺一不可）：

1. 一个**自录或书面授权**的中文声源：授权书须明示「可用于商用直播」「可用于训练衍生声学模型」「可用于 TTS/SVS/SVC 合成与再分发」三项，并写明授权人身份。
2. 若希望复用现成开源音色：由该音色的权利人出具上述三项书面授权（我们无法替 owner 判断其权利真实性）。
3. 若接受**非商用验证**：可使用 4.1 第 4、5 项做技术连通性验证，但必须在证据里标明「研究用途 / 许可洁净性样本，不可上线」，且不得出现在任何对外产物里。

## 6. 仍然未知 / 无法核实（11 项）

| # | 事项 | 为什么无法确认 | 该问谁 |
| --- | --- | --- | --- |
| 1 | `openvpi/params` 是否存在及其 LICENSE | HF 401、无 Wayback、GitHub 组织无此仓 | OpenVPI（issue / Discord） |
| 2 | DiffSinger 官方 checkpoint 权重许可 | 5 个 release 正文无 license，zip 内是否夹带 LICENSE 未下载无法验证 | OpenVPI |
| 3 | RMVPE 权重许可 | 仓库无 LICENSE，release 无说明 | yxlllc |
| 4 | ContentVec 权重（IBM Box）许可 | 只给 Box 链接，无许可文本 | auspicious3000 |
| 5 | RVC「仅供研究」与 MIT 正文冲突时谁优先 | 同一文件自相矛盾，属法律解释 | lj1995 / 法律顾问 |
| 6 | RVC 发行包内 demo 音色（guanguan/keruan/kiki/zhanzhan）声音权 | 包内无出处说明 | lj1995 |
| 7 | `uvr5_weights`、`pymss_weights` 独立许可 | 未列入第三方清单 | UVR5 / MSST 各模型作者 |
| 8 | `weights/白菜357k.pt` 来源 | 零说明 | lj1995 |
| 9 | `Saisho-Utane` 是否为该声音本人 | 仅凭账号名 | 直接联系账号 |
| 10 | HubertSoft（`bshall/hubert` release）权重许可 | 未展开核实 | bshall |
| 11 | OpenVPI「用该声码器合成商用作品不受许可约束」是否成立 | 作者单方面解释，与 CC 原文和页面附加条件自相矛盾 | 法律顾问 |

**最需要警惕的一句**：不要在 `docs/` 里把「OpenVPI 说输出可商用」写成结论。CC BY-NC-SA 约束的是权重，输出是否受限在法律上没有该页面声称的那种确定性；对一个要打包分发、自动下载模型的桌宠产品，这恰恰是最容易被挑战的地方。本项目按「**权重 NC / 输出存疑 / 商用走自训**」三档记录。

## 7. 主要来源

- RVC 官方权重仓 <https://huggingface.co/lj1995/VoiceConversionWebUI>；中文许可文件 <https://huggingface.co/lj1995/VoiceConversionWebUI/blob/main/%E4%BD%BF%E7%94%A8%E9%9C%80%E9%81%B5%E5%AE%88%E7%9A%84%E5%8D%8F%E8%AE%AE-LICENSE.txt>
- `licyk/rvc-model` <https://huggingface.co/licyk/rvc-model>
- DiffSinger <https://github.com/openvpi/DiffSinger>；v1.4.0 release <https://github.com/openvpi/DiffSinger/releases/tag/v1.4.0>
- OpenVPI Vocoders 许可页 <https://openvpi.github.io/vocoders/>；releases <https://github.com/openvpi/vocoders/releases>；SingingVocoders <https://github.com/openvpi/SingingVocoders>
- OpenCpop 官方许可页 <https://wenet-e2e.github.io/opencpop/liscense/>；镜像 <https://huggingface.co/datasets/cyjin-yl/GreendamOpencpop>
- M4Singer 数据许可 <https://github.com/M4Singer/M4Singer/blob/master/dataset_license.md>
- VCTK <https://datashare.ed.ac.uk/handle/10283/3443>；LibriTTS <https://www.openslr.org/60/>；LJSpeech <https://keithito.com/LJ-Speech-Dataset/>
- HuBERT <https://huggingface.co/facebook/hubert-base-ls960>；ContentVec <https://github.com/auspicious3000/contentvec>
- FCPE <https://github.com/CNChTu/FCPE>；torchcrepe <https://github.com/maxrmorrison/torchcrepe>；RMVPE <https://github.com/yxlllc/RMVPE>
- DDSP-SVC <https://github.com/yxlllc/DDSP-SVC>；Applio <https://github.com/IAHispano/Applio>
- RVC macOS 分支：AGPL <https://github.com/audiohacking/RVC-MacOS>、<https://github.com/RTCK-DEV/RVC-WebUI-MacOS-app>；MIT <https://github.com/qingbo1011/RVC-WebUI-MacOS>
- NNSVS <https://github.com/nnsvs/nnsvs>；ENUNU <https://github.com/nnsvs/ENUNU>
- 许可洁净音色样本 <https://huggingface.co/ampixa/nepali-rvc-voices-v1>；<https://huggingface.co/Saisho-Utane/Saisho-Model-RVC>；角色音色反例 <https://huggingface.co/ArkanDash/rvc-genshin-impact>
