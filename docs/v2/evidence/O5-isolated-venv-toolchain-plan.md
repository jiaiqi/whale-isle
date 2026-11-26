# O5 歌声栈：隔离目录 + 隔离 venv 工具链方案与许可核实（item 5，2026-11-26）

> 关联工单：`V2-P3-01`（O5 歌声栈，状态 `IMPLEMENTED_UNVERIFIED`，见 `docs/v2/ROADMAP.md:145` 与 `docs/v2/CURRENT.md:22`）。
> 上游依据文档：[`O5-svs-svc-backend-research.md`](./O5-svs-svc-backend-research.md)（后端选型）、[`O5-svs-svc-weight-license-per-file.md`](./O5-svs-svc-weight-license-per-file.md)（逐文件权重许可）。本文不重复其结论，只回答一件事：**怎么在本机新建一个与 owner 既有 TTS 环境完全隔离、可一键回滚的可运行歌声栈后端目录**，并把该方案里每一件东西的许可核实清楚。
> 本文**未安装、未下载、未删除任何东西**；所有命令均未实机执行（已逐条标注）。

## 0. 证据分级声明

| 标记 | 含义 | 本文中的例子 |
| --- | --- | --- |
| `[REAL-DEVICE]` | 2026-11-26 在本机实际探测到的（进程、文件、包体积、版本号） | §1 全部；§3 体积锚点 |
| `[REFERENCE]` | 本次通过 GitHub API / PyPI / 官方文档在线核实的原文 | §4 许可核实表（每条注明核实方式） |
| 未实机执行 | 方案性命令，只给出写法与验收判据，未在本机跑过 | §2、§6 的全部命令 |
| 未核实 | 标注了依据不足的推断 | 个别 wheel/权重体积区间 |

禁止口径：本文任何地方不得被转述成「歌声栈已装好/已实测可唱」——**没有**。

---

## 1. 本机现状盘点（只读）`[REAL-DEVICE]`

### 1.1 既有 TTS / 歌声相关环境（全部只读探测，未触碰）

| 项 | 位置 | 实测事实 | 边界 |
| --- | --- | --- | --- |
| GPT-SoVITS 代码仓 | `/Users/jiaqi/Documents/vibe/GPT-SoVITS` | 含 `api.py`、`api_v2.py`、`webui.py`、`GPT_SoVITS/`；`GPT_SoVITS/pretrained_models` 实测 1.2 GB | 只读 |
| GPT-SoVITS venv | `/Users/jiaqi/Documents/vibe/GPT-SoVITS/.venv` | Python **3.10.20**（uv 托管解释器，`pyvenv.cfg: home = ~/.local/share/uv/python/cpython-3.10-macos-aarch64-none/bin`），实测 **1.6 GB**；关键包：torch 2.7.0、transformers 4.57.6、librosa 0.10.2、soundfile 0.14.0、numpy 1.26.4、fastapi 0.162.5 | **严禁写入/升级/删除** |
| GPT-SoVITS 运行实例 | `127.0.0.1:9880` | 当前正在监听：PID 6768，命令行 `.venv/bin/python api_v2.py -a 127.0.0.1 -p 9880 -c GPT_SoVITS/configs/tts_infer.yaml`（`lsof` + `ps` 实测） | 不重启、不改配置 |
| CosyVoice 代码仓 + venv | `/Users/jiaqi/Documents/vibe/CosyVoice` | `.venv`：Python **3.10.20**（同为 uv 托管），实测 **1.9 GB**；含 torch 2.7.0、onnxruntime 1.23.2、modelscope 1.40.3、librosa 0.11.0、soundfile 0.14.0；`pretrained_models/` 实测 0 B（空） | 只读 |
| sing-worker venv（本仓库） | `services/sing-worker/.venv` | Python **3.13.14**（`/Library/Frameworks/Python.framework` 的 python.org 版，经 `python3 -m venv` 创建，`pyvenv.cfg` 实测），**46 MB**；包：fastapi 0.165.0、uvicorn 0.54.0、httpx 0.28.1、pydantic 2.14.4、pytest 9.2.0 等（`uv pip list` 实测 25 项） | 属本仓库工单产物，歌声后端不得复用它（它是转发层，不含推理依赖） |
| audio-ai-worker | `services/audio-ai-worker/` | **无 `.venv`**；lint/test 走 `uv run --with …` 临时环境（见根 `package.json` 的 `py:ruff` / `py:mypy` / `py:test` 脚本） | 同上 |

### 1.2 两个 Python service 的启动方式与端口（读代码）

| 服务 | 启动方式 | 默认端口 | 依据 |
| --- | --- | --- | --- |
| `sing-worker` | `python -m uvicorn app:app --host 127.0.0.1 --port <PORT>`；`app.py:252-253` 读 `WHALE_SING_WORKER_HOST`/`WHALE_SING_WORKER_PORT` | **18880** | `services/sing-worker/app.py:252-253`；当前**正在监听** 127.0.0.1:18880（PID 12791，`Python -m uvicorn app:app --host 127.0.0.1 --port 18880`，`lsof`+`ps` 实测） |
| `sing-worker` 被谁消费 | Electron 侧经环境变量 `WHALE_SING_WORKER`（如 `http://127.0.0.1:18880`）注入 `SingEngine.workerEndpoint` | — | `apps/desktop-host/src/main/v2-kernel-host.ts:405-408` |
| `audio-ai-worker` | FastAPI app；`__main__` 入口未在 `app.py` 内硬编码端口（文件中未见 `uvicorn.run`） | **18770**（Electron 侧默认） | `apps/desktop-host/src/main/v2-kernel-host.ts:487`：`process.env.WHALE_AUDIO_WORKER ?? 'http://127.0.0.1:18770'`；当前 18770 **未监听**（`lsof` 实测为空） |
| `sing-worker` 后端探测 | 读 `WHALE_SING_SVS_ENDPOINT` / `WHALE_SING_SVC_ENDPOINT` / `WHALE_SING_TTS_ENDPOINT`，并以权重 SHA-256 指纹作为 `neuralVerified` 唯一证据 | — | `services/sing-worker/app.py:28-41, 92-129` |

含义：**新歌声栈后端不新增 Electron 消费面**，只要起在 `WHALE_SING_SVS_ENDPOINT` / `WHALE_SING_SVC_ENDPOINT` 指向的地址并返回约定 JSON（含 `audioBase64`），`sing-worker` 即可如实上报/转发（`app.py:192-206`）。

### 1.3 macOS 侧已有音频工具 `[REAL-DEVICE]`

| 工具 | 路径 | 实测版本/状态 | 许可影响 |
| --- | --- | --- | --- |
| `ffmpeg` | `/opt/homebrew/bin/ffmpeg` | 9.0.1；`ffmpeg -buildconf` 实测含 `--enable-gpl --enable-libx264` → **该二进制是 GPLv3 构建**（`ffmpeg -L` 实测输出 GPL v3 文本） | 见 §4 第 3 项：子进程调用可用；再分发需注意 GPL |
| `sox` | — | **不存在**（`which sox` 无结果） | 方案不得假设有 sox |
| `afplay` | `/usr/bin/afplay` | macOS 自带；已作为播放头回退路径在用（`apps/desktop-host/src/main/native-audio-player.ts`，回退时如实标 `realPlayhead=false`） | Apple 系统工具，无引入问题 |
| `demucs` | — | **不存在**（`which demucs` 无结果） | 需新装到隔离 venv |

### 1.4 解释器与缓存现状 `[REAL-DEVICE]`

- 本机可用 Python：`/Library/Frameworks/Python.framework` 3.13.14；`~/.local/bin/python3.11`；`/opt/homebrew/bin/python3.12`（arm64）；`/usr/local/bin` 下一组 Intel（x86_64）3.12/3.13/3.13t；`/usr/bin/python3`（Xcode CLT）。
- `uv`：`/Users/jiaqi/.local/bin/uv`，版本 **0.11.17**（实测）；uv 已托管的 CPython：`~/.local/share/uv/python/` 下有 `cpython-3.10.20-macos-aarch64-none` 与 `cpython-3.11.15-macos-aarch64-none`。
- 共享缓存：`~/.cache/huggingface` 实测 **11 GB**（含 `models--FunAudioLLM--Fun-CosyVoice3-0.5B-2512`、`models--lpkpaco--Bocchi-The-Rock-GPT-SoVITS-Models` 等）；`~/.cache/uv` 实测 **5.9 GB**；`~/.cache/torch` **不存在**。
- 磁盘：`/` 实测可用 **1.4 TiB**（`df -h`），空间不构成约束。
- Electron `userDataDir` 实测存在：`~/Library/Application Support/Whale Isle`（`apps/desktop-host/package.json` `productName: "鲸屿"` / `"鲸屿 Whale Isle"`；目录名以实际运行产物为准，开发态未再核实）。

### 1.5 边界声明（不可违背）

> **owner 既有环境红线**：`/Users/jiaqi/Documents/vibe/GPT-SoVITS/`（含 `.venv` 与正在 9880 端口运行的实例）、`/Users/jiaqi/Documents/vibe/CosyVoice/`（含 `.venv`）、`services/sing-worker/.venv` **一律只读**——不安装、不升级、不删除、不 `pip install` 进去、不改其 `pyvenv.cfg`、不复用其 site-packages 做 `--system-site-packages`。新歌声栈的一切（解释器引用除外）必须落在 §2 的新目录里。uv 托管的解释器缓存（`~/.local/share/uv/python/`）是 uv 的**全局共享只读资产**，新 venv 通过 `uv venv --python 3.11` 链接它不算触碰 owner 环境（GPT-SoVITS 用的是 3.10，本方案用 3.11，二者 venv 互相独立）。

---

## 2. 隔离目录与 venv 方案（未实机执行）

### 2.1 目录布局

以 Electron `userDataDir` 为根（本机即 `~/Library/Application Support/Whale Isle`，见 §1.4；开发期也可显式传 `--user-data-dir` 覆盖，本文用 `<userDataDir>` 指代）：

```
<userDataDir>/singing-stack/
├── rvc/                          # 后端 1：SVC（音色转换，RVC 推理侧）
│   ├── venv/                     # 独立 venv（uv 创建，Python 3.11）
│   ├── models/                   # 权重：hubert_base.pt、fcpe、RVC 底模(研究)、目标音色(待授权)
│   ├── cache/                    # 隔离缓存根（见 2.3 环境变量注入）
│   │   ├── uv/                   # UV_CACHE_DIR
│   │   ├── huggingface/          # HF_HOME
│   │   └── torch/                # TORCH_HOME（torch.hub / demucs 模型下载落点）
│   └── logs/
├── demucs/                       # 后端 0（可选）：人声/伴奏分离
│   └── （同上 venv/models/cache/logs 结构；也可与 rvc 合并为一个 venv，见 2.4 取舍）
└── LOCKED.md                     # 锁定依赖清单 + 权重 SHA-256 + 许可文件副本的归档说明
```

设计要点：

- **与既有 TTS 完全分离**：不共用 `services/sing-worker/.venv`（那是转发层，不含 torch）；不共用 GPT-SoVITS/CosyVoice 的任何目录。
- **缓存也隔离**：默认情况下 uv/pip 会写 `~/.cache/uv`、torch.hub 会写 `~/.cache/torch`、HF 会写 `~/.cache/huggingface`。为了让「删一个目录 = 完全回滚」，启动该 venv 里任何 Python 进程前注入（未实机执行）：
  ```bash
  export UV_CACHE_DIR="<userDataDir>/singing-stack/rvc/cache/uv"
  export HF_HOME="<userDataDir>/singing-stack/rvc/cache/huggingface"
  export TORCH_HOME="<userDataDir>/singing-stack/rvc/cache/torch"
  export XDG_CACHE_HOME="<userDataDir>/singing-stack/rvc/cache"   # 兜底，拦其他写 ~/.cache 的工具
  ```
  代价：放弃与本机既有 11 GB HF 缓存 / 5.9 GB uv 缓存的复用，需重新下载一遍。可接受（磁盘 1.4 TiB 可用）。**反过来绝不能做**的事：把既有 HF 缓存目录软链进隔离区——那会把 owner 缓存变成新栈的依赖，违反隔离目标。
- **logs/ 独立**：后端 stdout/stderr 落盘到隔离区，便于「证据归档」与排障，不污染系统日志。

### 2.2 Python 版本与 venv 创建

- **选 Python 3.11**（不选 3.13，不选 3.10）：
  - RVC 推理侧依赖链（`torch`、`torchaudio`、`librosa`、`faiss-cpu` 等）在 3.11 上有成熟 arm64 wheel；3.13 对部分科学计算包仍偏新（`faiss-cpu` 在 3.13 的 arm64 wheel 可得性未核实，标为风险）；3.10 虽与 GPT-SoVITS 一致但本文方案刻意与它错开，便于在 `ps`/`lsof` 输出里一眼区分两套环境。
  - 本机已有 uv 托管的 `cpython-3.11.15-macos-aarch64-none`（§1.4），`uv venv --python 3.11` 会直接链接它，**不需要新下载解释器**（该行为为 uv 文档语义，未实机执行）。
- **创建方式：`uv venv`**（本机 uv 0.11.17 实测可用），不用 `python -m venv`——理由：uv 创建 venv 后默认**不带 pip**、装包走 `uv pip`，确定性更好且天然避免误用系统 pip 污染全局；与仓库现有 `uv run --with …` 工具链一致（根 `package.json` 已有 `py:ruff` 等先例）。
  ```bash
  # 未实机执行
  uv venv --python 3.11 "<userDataDir>/singing-stack/rvc/venv"
  ```

### 2.3 依赖锁定策略

- **必需集**（SVC 推理最小集，版本以锁定文件为准，以下为建议区间而非已验证组合）：
  `torch`（macOS arm64 wheel，§3 实测 2.7.0 可装）、`torchaudio`、`numpy`、`scipy`、`soundfile`、`librosa`、`faiss-cpu`（RVC `.index` 检索需要）、`onnxruntime`（可选，做 ONNX 推理路径时用）。
- **可选集**：`demucs`（分离，代码 MIT）、`transformers`（若要按 HF 格式加载 HuBERT/ContentVec；若走 RVC 自带 `fairseq` 加载链则另需 `fairseq`，其 macOS arm64 兼容性未核实，标为风险）。
- **锁定流程**（未实机执行）：
  1. 在隔离区写 `requirements.in`（只列顶层包名与兼容区间）；
  2. `uv pip compile requirements.in -o requirements.lock`（`uv pip compile` 生成带哈希的锁文件是 uv 的标准能力，具体输出格式未实机验证）；
  3. `uv pip install --python <venv>/bin/python -r requirements.lock`；
  4. `requirements.lock` 与所有权重 SHA-256、`LICENSE-*` 副本一起归档进 `LOCKED.md` 指向的位置，满足 `AGENTS.md` Gate 2 的许可证扫描与可复现要求。
- **显式不装**：RMVPE（无 LICENSE，见 §4）、`openvpi/vocoders` 代码（AGPL-3.0）、任何 AGPL 的 RVC macOS 分支（`audiohacking/RVC-MacOS`、`RTCK-DEV/RVC-WebUI-MacOS-app`，见 `O5-svs-svc-weight-license-per-file.md` §1.4）、so-vits-svc 全线（§4 第 6 项）。

### 2.4 单 venv 还是双 venv 的取舍

Demucs 与 RVC 推理侧依赖高度重叠（torch/torchaudio），**建议先单 venv**（`singing-stack/rvc/venv` 同时承担 demucs），仅当出现真实版本冲突（例如 demucs 与 RVC 对 `torchaudio` 版本的硬约束冲突，当前未发现证据）再拆成 §2.1 所示双 venv。拆分时每个 backend 子目录自含 venv/models/cache/logs，回滚粒度不变。

---

## 3. 体积与回滚

### 3.1 体积估算（实测锚点 + 条件式区间）

实测锚点（`[REAL-DEVICE]`，来自 GPT-SoVITS venv `site-packages` 的 `du -sm`，Python 3.10 环境，仅作数量级参考）：

| 组件 | 实测安装体积 | 备注 |
| --- | --- | --- |
| torch 2.7.0（macOS arm64） | **335 MB** | 对应 PyPI wheel `torch-2.7.0-cp3xx-none-macosx_11_0_arm64.whl` 下载 69 MB（PyPI 元数据实测） |
| torchaudio | 6 MB | 最新 wheel `torchaudio-2.11.1-py3-none-macosx_14_0_arm64.whl` 约 1 MB（PyPI 元数据实测） |
| numpy | 50 MB | 1.26.4 |
| scipy | 84 MB | — |
| onnxruntime | 64 MB | 1.23.2（在 CosyVoice venv 实测存在） |
| soundfile（含内嵌 libsndfile dylib） | ~1 MB（Python 侧） | soundfile 0.14 wheel 内嵌 libsndfile，整体数 MB 量级 |
| transformers | 58 MB | 4.57.6 |
| librosa | 2 MB（本体） | 但其依赖链含 numba/llvmlite（未在本机实测体积，估 50–120 MB 区间，未核实） |

下载侧/权重侧（`[REFERENCE]` 或未核实）：

| 项 | 体积 | 依据 |
| --- | --- | --- |
| venv 骨架（Python 3.11 链接 uv 托管解释器） | 20–50 MB | sing-worker venv（含 fastapi 全家）实测 46 MB，纯骨架应更小 |
| HuBERT `hubert_base.pt` | 189 MB | `O5-svs-svc-weight-license-per-file.md` §1.1（已核实） |
| FCPE `fcpe_c_v001.pt` | 数 MB–20 MB | 未核实（小模型，量级估计） |
| CREPE `full.pth` | ~85 MB | 社区常见值，未核实 |
| RVC v2 底模 `f0G40k.pth` + `f0D40k.pth` | 合计约 150–250 MB | 未核实（RVC 底模为 G/D 成对分发；逐文件大小未本次核实） |
| RVC 推理代码（MIT 分支，如 `qingbo1011/RVC-WebUI-MacOS` 或 Applio） | 10–50 MB | 代码仓量级估计，未核实 |
| demucs 代码 | ~1 MB | PyPI 实测 wheel/tarball（`demucs-4.1.0-py3-none-any.whl` <1 MB） |
| demucs 模型（`htdemucs` 单模型 / `htdemucs_ft` 四模型 bag） | 约 80 MB / 约 1 GB | 社区常见值，未核实；按需二选一 |
| faiss-cpu | 20–50 MB | 未核实（量级估计） |

**合计区间**：

- **必需最小集**（SVC 连通性验证：venv + torch/torchaudio/numpy/scipy/soundfile/faiss-cpu + HuBERT + FCPE + RVC 代码 + 研究用途底模）：约 **0.9–1.2 GB**。
- **加可选**（demucs + htdemucs 模型 + CREPE full + onnxruntime）：约 **1.2–2.0 GB**。
- **极端可选**（`htdemucs_ft` 四模型 bag + transformers + librosa 全链）：上探至 **~3 GB**。
- 对照磁盘 1.4 TiB 可用（实测），空间不是约束；约束是许可（§4/§5），不是字节。

### 3.2 回滚方案（一键恢复原状）

由于 §2 把 **venv、models、cache（含 UV_CACHE_DIR/HF_HOME/TORCH_HOME/XDG_CACHE_HOME 全部内指）、logs** 都收敛在 `<userDataDir>/singing-stack/` 一个目录里：

```bash
# 未实机执行；执行前先确认没有进程占用（lsof + kill 后再删）
rm -rf "<userDataDir>/singing-stack"
```

- 删除后系统应当回到的状态，逐项验收：
  1. `/Users/jiaqi/Documents/vibe/GPT-SoVITS/.venv` 与 9880 端口实例**不受影响**（本来就零接触）；
  2. `~/.cache/huggingface`（11 GB）、`~/.cache/uv`（5.9 GB）**字节数与删除前一致**——若方案正确，新栈从未写过这两个目录；回滚验收时先 `du -sh` 记录基线再比对（未实机执行）；
  3. `~/.cache/torch` 当前不存在；回滚后仍应不存在（若出现，说明某进程绕过了 TORCH_HOME 注入，属方案缺陷需记录）；
  4. uv 托管解释器 `~/.local/share/uv/python/cpython-3.11.15-…` 是 uv 全局资产，**不在回滚范围**（它先于本方案存在，删除它会破坏其他使用 uv 的项目）。
- CPU/Metal 侧无持久缓存需要清理：torch MPS 无磁盘着色器缓存约定路径（未核实，按「无」处理）；macOS 的 `afplay`/AVAudioPlayer 均不写用户级缓存（未核实，低风险项）。

---

## 4. 逐项许可核实表（`[REFERENCE]`，核实日期 2026-11-26）

证据强度定义：**高** = 官方仓库 LICENSE/官方文档原文（本次在线核实）；**中** = PyPI 元数据/官方 README 声明；**低** = 二手资料（本表无低强度项；凡未本次复验的沿用既有证据文档并注明）。

| # | 组件 | 来源 URL | 核实到的版本/标识 | 许可证原文关键句 | 非商用验证 | 后续商用 | 证据强度 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `uv`（venv 工具） | <https://github.com/astral-sh/uv> | 仓库根含 `LICENSE-APACHE` 与 `LICENSE-MIT` 两个文件（本次 GitHub API 列举核实）；本机装 0.11.17 | 双许可 Apache-2.0 OR MIT | 可 | 可 | 高 |
| 2 | CPython 运行时 | <https://docs.python.org/3/license.html> | GitHub API 对该仓返回 NOASSERTION（因多段历史许可）；官方文档页为 PSF 许可 | PSF License Agreement（OSI 批准，类 BSD 的宽松许可） | 可 | 可 | 高（官方文档） |
| 3 | `ffmpeg` | <https://ffmpeg.org/legal.html> + 本机 `ffmpeg -buildconf` | 本机 9.0.1，构建含 `--enable-gpl --enable-libx264` | 官方页：「FFmpeg is licensed under the GNU LGPL version 2.1 or later. However … optional parts … covered by the GPL … If those parts get used the GPL applies to all of FFmpeg.」本机二进制即此情形（GPLv3） | 可（作为独立子进程调用，不链接、不修改，不构成衍生作品） | 可（同上）；**但若把该 GPL 构建二进制随产品再分发，须履行 GPLv3 义务（提供对应源码等）**；建议产品化时改用 LGPL-only 构建或声明「用户自备 ffmpeg」 | 高（官方页 + 本机构建配置实测） |
| 4 | Demucs | <https://github.com/facebookresearch/demucs> | GitHub API：MIT；README §License：「Demucs is released under the MIT license as found in the LICENSE file.」 | MIT 全文（代码）；预训练模型经 fbaipublicfiles 分发，README 未逐模型单独声明 | 可 | 可（代码）；权重随项目统一 MIT 声明对待，但建议留存 README 截图/副本备查 | 高（代码）；中（权重） |
| 5 | RVC 代码 | <https://github.com/RVC-Project/Retrieval-based-Voice-Conversion-WebUI> | GitHub API：MIT；LICENSE 原文头部 `MIT License / Copyright (c) 2023 liujing04 / 源文雨 / Ftps` | 标准 MIT 全文，**代码仓 LICENSE 内无「仅供研究」字样** | 可 | 可（仅指代码） | 高 |
| 5b | RVC 官方权重仓 | <https://huggingface.co/lj1995/VoiceConversionWebUI> | commit `e6d0c1a…`（2026-08-01，既有证据文档已核实）；根目录 `使用需遵守的协议-LICENSE.txt` | 「MIT License … **本软件仅供研究使用**，使用软件者、传播软件导出的声音者自负全责。如不认可该条款，则不能使用/引用软件包内所有代码和文件。」README 的 21 字节 `license: mit` **不能**覆盖该条款 | 可（仅限内部研究/连通性验证，且必须留存该 LICENSE 副本） | **否**（需作者书面澄清或自训底模，见 §5） | 高（LICENSE 原文，见既有证据文档 §1.1） |
| 6 | so-vits-svc | 原始仓 <https://github.com/innnky/so-vits-svc-32k>；社区仓 <https://github.com/svc-develop-team/so-vits-svc> | 原始仓：GitHub API 未识别到 LICENSE（本次核实）→ 默认保留所有权利；社区仓：AGPL-3.0（GitHub API + README badge 指向 `4.1-Stable/LICENSE`，本次核实） | 任务假设「MIT?」**不成立**：一条线无许可证，一条线 AGPL-3.0 | 不可用（无许可即默认不可复制） | 否（AGPL 传染性 + 无许可） | 高 |
| 7 | HuBERT（内容/特征提取器） | <https://huggingface.co/facebook/hubert-base-ls960> | HF API tags 含 `license:apache-2.0`（本次核实）；权重 `pytorch_model.bin` 189 MB | 模型卡 Apache-2.0，覆盖权重 | 可 | 可 | 高 |
| 8 | ContentVec | 代码 <https://github.com/auspicious3000/contentvec> | GitHub API：MIT（本次核实）；权重经 IBM Box 分发且**无许可声明**（既有证据文档 §1.2 核实） | 代码 MIT；权重无许可文本 | 代码可；权重谨慎/默认不可用 | 代码可；权重否（可整体用 HuBERT 替代规避） | 高（代码）；中（权重：无许可即不可用，非「证实禁止」） |
| 9 | RMVPE（音高提取） | <https://github.com/yxlllc/RMVPE>、<https://github.com/Dream-High/RMVPE> | 仓库**无 LICENSE 文件**（既有证据文档 §1.2 核实；本次 GitHub API 复验因 rate limit 未完成，标注） | 无 LICENSE + 训练数据含 M4Singer（CC BY-NC-SA） | 默认不可用 | 否 | 中（沿用既有核实，本次未复验） |
| 10 | FCPE（音高提取） | <https://github.com/CNChTu/FCPE> + <https://pypi.org/project/torchfcpe/> | PyPI `torchfcpe` license 字段 MIT（本次核实）；`licyk/rvc-model` 仓 `LICENSE-FCPE.txt` MIT（© 2023 CN_ChiTu）**覆盖权重**（既有证据文档核实） | MIT，且权重有逐文件 LICENSE 副本 | 可 | 可 | 高 |
| 11 | CREPE（音高提取） | <https://github.com/maxrmorrison/torchcrepe> | PyPI `torchcrepe` license 字段 MIT（本次核实）；`licyk/rvc-model` 仓 `LICENSE-CREPE.txt` MIT（© 2020 Max Morrison）**覆盖权重**（既有证据文档核实） | MIT，覆盖权重 | 可 | 可 | 高 |
| 12 | `torch` | <https://github.com/pytorch/pytorch/blob/main/LICENSE> | 最新 PyPI 2.15.0（元数据）；本方案建议装 macOS arm64 稳定版（2.7.0 在本机 GPT-SoVITS venv 实测可运行） | LICENSE 含「Redistribution and use in source and binary forms …」与「NEITHER THE NAME …」条款 = BSD-3-Clause 文本（GitHub 因多版权头识别为 NOASSERTION，本次核实原文命中 BSD 关键句） | 可 | 可；注意仓库捆绑大量 `third_party/` 组件（各自 BSD/MIT/Apache，分发时保留 `third_party` 声明） | 高（LICENSE 原文） |
| 13 | `torchaudio` | <https://github.com/pytorch/audio> | GitHub API：BSD-2-Clause（本次核实）；PyPI classifier BSD License | BSD-2-Clause 全文 | 可 | 可 | 高 |
| 14 | `onnxruntime` | <https://pypi.org/project/onnxruntime/> | PyPI license 字段 `MIT License`（本次核实，版本 1.32.0 元数据） | MIT | 可 | 可 | 中（PyPI 元数据；官方仓库同为 MIT，未本次复验） |
| 15 | `soundfile`（Py 包）/ `libsndfile`（内嵌 C 库） | <https://pypi.org/project/soundfile/> / <https://github.com/libsndfile/libsndfile> | PyPI `soundfile` 0.14.0 license 字段 `BSD 3-Clause License`（本次核实）；GitHub API 对 libsndfile 返回 **LGPL-2.1**（本次核实） | soundfile：BSD-3；libsndfile：LGPL-2.1 | 可 | 可；LGPL-2.1 的合规要点：以动态库形式随 wheel 分发、不修改 libsndfile 源码、保留其许可声明副本、允许用户替换该动态库——wheel 内嵌 dylib 的常规使用满足前两条，第三条由归档 `LOCKED.md` 负责 | 高（官方仓库） |

补充（不属于本表但必须随方案走）：RVC 目标音色权重的**声音人格权**层，任何开源许可证都解决不了，沿用 `O5-svs-svc-weight-license-per-file.md` §2 第 4 行与 §5 的结论——只有 `ampixa/nepali-rvc-voices-v1`（CC BY 4.0）可充当**许可洁净性验证样本**，不得作为产品音色。

---

## 5. 诚实结论与需 owner 提供的授权材料

### 5.1 当前没有许可清晰可用路径的组件（如实列出）

| 组件 | 现状 | 结论 |
| --- | --- | --- |
| RVC 官方底模（G/D 成对） | 「MIT + 仅供研究使用」混合条款（§4 第 5b 项） | **只能做内部研究/连通性验证**；任何对外产物（含直播录像、演示视频里的声音）不得使用该底模输出，除非取得 §5.2 第 2 项材料 |
| 中文产品音色（RVC `.pth`） | 公开渠道无一许可+人格权双清晰（既有证据文档 §5「暂无符合项」） | **无现成可用路径**；禁止把任何角色音色、来源不明音色包装成可用 |
| ContentVec 权重 | IBM Box 分发、无许可文本 | 无可用路径；**用 HuBERT（Apache-2.0）整体规避** |
| RMVPE 权重 | 无 LICENSE + 数据含 M4Singer（NC-SA） | 无可用路径；**用 FCPE/CREPE（均 MIT 覆盖权重）规避** |
| DiffSinger 官方声学 checkpoint（SVS 侧） | 权重许可未声明 + 训练于 OpenCpop（CC BY-NC-ND） | 无可用路径；SVS 侧商用须自训（既有证据文档 §4.2） |
| OpenVPI 声码器权重 | CC BY-NC-SA 4.0 + 附加分发条件 | 不可进本方案的自动下载/打包管线 |
| so-vits-svc 全线 | 原始仓无 LICENSE、社区仓 AGPL-3.0（§4 第 6 项，本次新增核实） | 排除，不作为任何路径 |

**明确可干净使用的组合**（许可链条完整）：RVC **推理代码**（MIT）+ HuBERT（Apache-2.0）+ FCPE/CREPE（MIT，含权重 LICENSE 副本）+ Demucs（MIT，人声分离）+ `ampixa` CC BY 4.0 音色（仅洁净性验证样本）+ 研究用途 RVC 底模（仅内部连通性验证，留存 LICENSE 副本）。除此之外不要往下装。

### 5.2 需 owner 提供的书面授权材料（缺一不可）

1. **中文声源书面授权书**（自录或签约歌手）：须明示三项用途——「可用于商用直播」「可用于训练衍生声学模型」「可用于 TTS/SVS/SVC 合成与再分发」，并写明授权人身份与日期。没有它，§5.1 的音色行永远停在「暂无符合项」。
2. **RVC 底模超出研究用途的书面依据**（二选一）：(a) 上游作者（lj1995 / RVC-Project）对「MIT 与仅供研究条款冲突时如何解释」的书面澄清或补充授权邮件；(b) 放弃官方底模，立项用 VCTK（CC BY 4.0）或授权自录语料重训底模（属新工单，非本方案范围）。
3. 若未来启用 DiffSinger SVS 官方 checkpoint：需 OpenVPI 对 checkpoint 权重许可的书面声明（当前 release 正文零 license 信息），否则同样只能自训。
4. 若确需 ContentVec 权重：需 auspicious3000 对权重许可的书面说明（用 HuBERT 规避则不需要）。

**禁止包装**：不得把「没有独立许可的检查点」（DiffSinger checkpoint、ContentVec 权重、RMVPE）以「先下载下来验证一下」的名义落盘进隔离目录——§2 的 `models/` 只允许放 §4 表中判定为「可」或「研究用途可（留存 LICENSE）」的文件。

---

## 6. 最小执行顺序与验收判据（全部未实机执行）

> 目标：在 `<userDataDir>/singing-stack/rvc/` 下得到「RVC 推理代码 + 干净特征/音高权重 + 研究用途底模」的可 import 环境，并证明隔离与回滚成立。以下每步给出验收判据；任一步失败即停止并记录，不绕过。

**步骤 0：建立基线与目录骨架**
- 命令（示意）：先 `du -sh ~/.cache/huggingface ~/.cache/uv` 记录基线；再 `mkdir -p "<userDataDir>/singing-stack/rvc"/{models,cache/uv,cache/huggingface,cache/torch,logs}`。
- 验收：基线数字被记录到证据文档；目录树与 §2.1 一致。

**步骤 1：下载许可干净的权重（只下 §4 判定为可/研究可的文件）**
- 清单与来源（沿用既有证据文档 §4.1）：HuBERT `pytorch_model.bin`（<https://huggingface.co/facebook/hubert-base-ls960>，Apache-2.0）；FCPE `fcpe_c_v001.pt` 与 CREPE `full.pth`（<https://huggingface.co/licyk/rvc-model>，各自 MIT LICENSE 副本**同目录留存**）；RVC v2 研究底模 `f0G40k.pth`/`f0D40k.pth`（同仓，**必须同时下载 `manifest.json` 与 `LICENSE-RVC.txt`**）。
- 验收判据：每个文件 `curl -fSL` 返回 200；`shasum -a 256 <file>` 与 `licyk/rvc-model` 的 `manifest.json` 中记录的 SHA-256 逐项匹配；`LICENSE-RVC.txt`、`LICENSE-FCPE.txt`、`LICENSE-CREPE.txt` 三个副本存在于 `models/licenses/`。

**步骤 2：创建隔离 venv 并锁定安装**
- 命令（示意）：
  ```bash
  export UV_CACHE_DIR="<userDataDir>/singing-stack/rvc/cache/uv"
  uv venv --python 3.11 "<userDataDir>/singing-stack/rvc/venv"
  uv pip compile requirements.in -o requirements.lock          # 在隔离区执行
  uv pip install --python "<userDataDir>/singing-stack/rvc/venv/bin/python" -r requirements.lock
  ```
- 验收判据：`requirements.lock` 生成且含哈希；`"<venv>/bin/python" -c "import sys; print(sys.prefix)"` 输出指向隔离目录（**不得**指向 GPT-SoVITS/CosyVoice）；`du -sh ~/.cache/uv` 与步骤 0 基线一致（证明缓存隔离生效）。

**步骤 3：推理栈自检**
- 命令（示意，在注入 `HF_HOME`/`TORCH_HOME` 后）：
  ```bash
  "<venv>/bin/python" -c "import torch; print(torch.__version__, torch.backends.mps.is_available())"
  "<venv>/bin/python" -c "import soundfile, numpy; print(soundfile.__libsndfile_version__)"
  "<venv>/bin/python" -c "import faiss; print(faiss.__version__)"
  ```
- 验收判据：三条均退出码 0；`mps.is_available()` 为 `True`（M4 本机）；`soundfile.__libsndfile_version__` 打印 1.x 版本号（同时证明内嵌 libsndfile 可加载）。
- 若装 demucs（可选）：`"<venv>/bin/python" -m demucs --version` 退出码 0，且 `ls ~/.cache/torch` 仍为空（模型应落在隔离 `TORCH_HOME`）。

**步骤 4：RVC 推理代码与权重指纹接线**
- 命令（示意）：在隔离区 `git clone --depth 1` MIT 分支（如 `qingbo1011/RVC-WebUI-MacOS`，或 Applio 推理侧），把 `models/` 里的底模路径写入 `sing-worker` 约定的环境变量：`WHALE_SING_SVC_MODEL_PATH` / `WHALE_SING_SVC_MODEL_SHA256`（SHA-256 取自步骤 1 的实测值）。
- 验收判据：`services/sing-worker` 重启后 `curl http://127.0.0.1:18880/sing/health` 返回中 `svc=true` 且 `backends[].detail` 无「权重指纹不匹配」（权重指纹逻辑见 `services/sing-worker/app.py:92-129`）；一次 `POST /sing/svc` 的返回体 `modelEvidence.verifiedBy == "weight_fingerprint"` 且 `neuralVerified == true`（仅研究用途标注下成立）。
- 注意：此步只证明**链路连通与指纹核对**，不构成「可唱歌」的产品证据；音色仍为研究底模或 CC BY 4.0 样本，见 §5.1。

**步骤 5：回滚演练**
- 命令（示意）：确认 `lsof +D "<userDataDir>/singing-stack"` 无占用后 `rm -rf "<userDataDir>/singing-stack"`。
- 验收判据：删除后（a）`lsof -nP -iTCP:9880` 仍显示 GPT-SoVITS 实例存活、其 `.venv` `du -sh` 仍为约 1.6 GB；（b）`~/.cache/huggingface` 与 `~/.cache/uv` 的 `du -sh` 与步骤 0 基线一致；（c）`~/.cache/torch` 不存在或被删除后不再生成；（d）`services/sing-worker/.venv` 未变化。四项全过才允许在证据文档里写「回滚已演练」，否则写明失败项与残留路径。

---

## 7. 本文仍存疑的项（如实列出）

1. `faiss-cpu`、`librosa`（numba/llvmlite 链）在 Python 3.11 / macOS arm64 的 wheel 可得性与体积——未核实（步骤 2 的 compile 阶段会暴露）。
2. RVC v2 底模逐文件精确大小——未核实（§3.1 给了区间）。
3. `fairseq`（RVC 部分加载链依赖）在 macOS arm64 的安装可行性——未核实；若失败，改用 Applio 推理侧或不依赖 fairseq 的加载路径。
4. demucs 模型（`htdemucs`/`htdemucs_ft`）的精确下载体积与权重许可逐文件文本——未核实（README 统一 MIT 声明，证据强度中）。
5. RMVPE 仓库许可的本次复验因 GitHub API rate limit 未完成——沿用既有证据文档结论（无 LICENSE），不影响「不可用」判定。

---

## 8. Dry-run 自检（2026-11-26 追加，`[REAL-DEVICE]` 仅限探测/解析，未安装任何包）

按 owner 指令「不执行安装，只做 dry-run 级别的检查」，对本方案的命令与回滚方法做了可复跑自检。全程在 `/tmp` 临时目录进行，结束后已删除并复核全局缓存基线。

### 8.1 前置探测复核（与 §1 一致，增量用新实测值）

| 项 | 实测 | 判定 |
| --- | --- | --- |
| uv | 0.11.17（aarch64） | 可用 |
| uv 托管解释器 | `cpython-3.11.15-macos-aarch64-none` 存在；`cpython-3.10.20` 存在 | `uv venv --python 3.11` 直接链接、不下载解释器 ✅（本次实测链接成功） |
| `~/.cache/huggingface` 基线 | **11 G** | 回滚复核锚点 |
| `~/.cache/uv` 基线 | **6.0 G**（§1 记的 5.9 GB 已漂移，以本次为准） | 回滚复核锚点 |
| `~/.cache/torch` | 不存在 | 与方案一致 |
| `<userDataDir>/singing-stack` | 不存在 | 干净起点，回滚=删一个目录成立 |
| 磁盘 | 1.4 TiB 可用 | 空间不是约束 |

### 8.2 venv 创建链路实测（隔离 env 注入下）

在注入 `UV_CACHE_DIR`/`HF_HOME`/`TORCH_HOME`/`XDG_CACHE_HOME` 全部指向临时目录后执行 `uv venv --python 3.11`：成功链接 uv 托管的 CPython 3.11.15，**未下载解释器**，临时 venv 已删除。证明 §2.2 的创建命令可复跑，且隔离注入生效（全局缓存基线零变化，见 8.4）。

### 8.3 依赖 dry-run 解析（`uv pip install --dry-run`，只解析元数据、未安装）

| 检查 | 结果 | 对方案的修正 |
| --- | --- | --- |
| 必需集 `torch==2.7.0 torchaudio numpy scipy soundfile librosa faiss-cpu demucs` @ py3.11 | **53 个包全部可解析**，含 `faiss-cpu==1.16.0`、`demucs==4.1.0`、`numba==0.68.1`、`llvmlite==0.50.0` | §7 第 1 项「faiss-cpu / librosa 链 wheel 可得性未核实」→ **已核实可解析** |
| torchaudio 不钉版本时 | 解析为 `torchaudio==2.11.0`（与 torch 2.7.0 **不同代**） | **方案修正：锁定文件必须显式钉 `torchaudio==2.7.0`**（同代钉法已验证可解析），否则静默装上不匹配的组合 |
| `faiss-cpu` @ py3.13 | 也可解析（`faiss-cpu==1.16.0` + `numpy==2.5.5`） | §2.2 把 3.13 标为「未核实风险」→ **已核实可解析**；但方案仍保持选 3.11（与 RVC 链成熟度对齐，且便于与 GPT-SoVITS 的 3.10 区分），3.13 只作为降级备选记录 |

### 8.4 回滚方法的 dry-run 演练（在临时目录层面）

1. dry-run 全程的所有缓存都落在临时目录（隔离 env 注入生效的实测证据）。
2. 删除临时目录后复核：`~/.cache/huggingface` 仍 11 G、`~/.cache/uv` 仍 6.0 G、`~/.cache/torch` 仍不存在。
3. 证明 §3.2 的「`du -sh` 基线比对」回滚验收方法**可复跑且成立**；正式安装后照此方法复核即可。

### 8.5 owner 决策清单（需要下载体积 / 版本，等 owner 决定何时装）

**代码与依赖（PyPI，装到隔离 venv）**：

| 项 | 版本（dry-run 解析结果） | 下载体积量级 | 依据 |
| --- | --- | --- | --- |
| venv 骨架 | CPython 3.11.15（本机已托管，**零下载**） | 20–50 MB 磁盘 | §8.2 实测 |
| torch | 2.7.0（钉） | wheel 69 MB 下载 / 335 MB 安装 | §3.1 实测锚点 |
| torchaudio | **2.7.0（钉，必须与 torch 同代）** | 约 1–6 MB | §8.3 修正 |
| numpy / scipy / soundfile | 解析值 2.4.6 / 1.17.1 / 0.14.0 | 合计约 135 MB 安装 | §3.1 锚点 + dry-run |
| librosa + numba/llvmlite | librosa 最新 + numba 0.68.1 | 约 50–120 MB 安装 | dry-run 已可解析 |
| faiss-cpu | 1.16.0 | 20–50 MB 安装 | dry-run 已可解析 |
| demucs（可选） | 4.1.0 | wheel <1 MB | §3.1 实测 |

**权重（下载到隔离 models/，许可状态见 §4，缺授权的一律不装）**：

| 项 | 体积 | 许可 | 状态 |
| --- | --- | --- | --- |
| HuBERT `hubert_base.pt` | 189 MB | MIT（已核实，含权重） | 可装 |
| FCPE `fcpe_c_v001.pt` | 数 MB–20 MB | MIT（已核实） | 可装 |
| CREPE `full.pth`（可选） | ~85 MB | MIT（已核实） | 可装 |
| RVC v2 底模 `f0G40k.pth`+`f0D40k.pth` | 合计约 150–250 MB | 研究用途标注 | 仅限研究用途，**不得商用分发** |
| demucs 模型（可选，`htdemucs`） | 约 80 MB | MIT | 可装 |
| 中文产品音色 `.pth` | — | **暂无符合项** | **不装**，等 owner 书面授权（§5.1 三用途缺一不可） |

**合计**：必需最小集约 **0.9–1.2 GB**；含可选集约 **1.2–2.0 GB**；磁盘 1.4 TiB 可用。约束是许可不是字节。
