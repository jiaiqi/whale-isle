# 真正 SVS / SVC 可部署候选与本机条件核实（item 5 调研，2026-11-26）

> 性质：**外部资料核实 + 本机条件盘点**，不是推理实测。未下载权重、未购买、未注册、未接受任何在线协议、未上传任何声音。
> 本机：Mac mini M4（10 核）/ 32GB 统一内存 / 1.4TB 可用；Python 3.13（无 torch）；ffmpeg 9.0.1。
> 适用：`V2-P3-01` 点歌台与唱歌链路。**GPT-SoVITS 是 TTS，不是 SVS/SVC，不得冒充**（既有结论不变）。

## 1. 候选对比

| 类别 | 候选 | 输入 | macOS M4 兼容性 | 许可要点 | 结论 |
| --- | --- | --- | --- | --- | --- |
| SVS | **OpenVPI DiffSinger + OpenUtau** | 乐谱（MIDI/USTX）+ 歌词/音素 | OpenUtau 有 `osx-arm64.dmg`（0.1.576），默认 CPU 渲染，CoreML 可选；DiffSinger 需 macOS 11+ | 代码 DiffSinger Apache-2.0、OpenUtau MIT、MakeDiffSinger BSD-3、SingingVocoders MIT；官方 OpenCpop 检查点与社区声码器权重非商用 | **首选可部署**；商用需自训声库与声码器 |
| SVS | NNSVS（+ ENUNU） | HTS full-context / MusicXML + 歌词 | 官方支持 macOS；训练以 CUDA/CPU 为主，MPS 未确认 | 代码 MIT；**无官方预训练权重**；ENUNU 声库逐角色条款 | 备选，需自训 |
| SVC | **RVC** | 源演唱干声 + `.pth` + `.index` | 上游仅 Windows/Linux，macOS 靠社区分支 | 代码 MIT；HF 权重仓 MIT；底模 VCTK CC BY 4.0；HuBERT Apache-2.0 | **首选可部署**；macOS 需选 MIT 分支，音色必须授权 |
| SVC | DDSP-SVC | 源演唱 WAV + `.pt` | README 仅 Windows/Linux | 代码 MIT；默认声码器 CC BY-NC-SA 4.0；RMVPE 来源未闭合 | 备选，轻量 |
| 排除 | GPT-SoVITS | 文本 + 参考音 | 已实测 | 仅 TTS/音色克隆 | 不得当 SVS/SVC |
| 排除 | so-vits-svc（AGPL-3.0，已归档）、Seed-VC（GPL-3.0，已归档）、`openvpi/vocoders` 代码仓（AGPL-3.0） | — | — | 传染性红线 | 禁入主线 |

## 2. 四层许可结论（代码 / 权重 / 数据 / 声音）

| 层级 | 结论 |
| --- | --- |
| 代码 | MIT / Apache-2.0 可商用；AGPL/GPL 一律排除（含部分 RVC macOS 分支：`audiohacking/RVC-MacOS`、`RTCK-DEV/RVC-WebUI-MacOS-app` 为 AGPL-3.0；`qingbo1011/RVC-WebUI-MacOS` 为 MIT） |
| 权重 | RVC HF 权重 MIT、VCTK CC BY 4.0、HuBERT Apache-2.0；DiffSinger 官方 OpenCpop 检查点**无独立权重许可**；OpenVPI 声码器 **CC BY-NC-SA 4.0**；RMVPE 上游 `yxlllc/RMVPE` **无 LICENSE**（可用 MIT 的 FCPE/CREPE 替代） |
| 数据 | OpenCpop 官方仓库无 LICENSE、官方页证书过期，HF 镜像卡 metadata（GPL-2.0）与正文（CC BY-NC-ND 4.0）冲突 → 取得书面确认前按**非商用**处理；VCTK CC BY 4.0 |
| 声音 | 模型许可不授予真人声音人格权；克隆/训练/商用直播/再分发均需声音权利人**书面授权**；不得用公众人物或来源不明音色；不得上传参考音到外部服务 |

**合成输出再训练**：不自动获得商用权，须同时满足原模型条款 + 训练数据许可 + 声音授权；建议每条输出留存「模型版本 + 权重许可 + 声音授权 + 数据来源」元数据。

## 3. 五组情绪参考音（统一声线试听方案）

录制规格：24kHz / mono / 16-bit PCM WAV；每条 5.0s ± 0.3s；峰值约 -3dBFS 不削波；前后各 0.2s 静音；同一人、同麦、同距离、同房间、同增益，一次录完；不加混响/压缩/过度降噪；整组统一响度参数，不逐条标准化。

| 标签 | 试听文本 | 表演提示 |
| --- | --- | --- |
| `sweet_normal` | 今天海风很温柔，我在这里陪着你，慢慢说说话，好不好？ | 温柔日常，微笑，气声轻，句尾轻上扬（约 4.8s） |
| `tsundere_refuse` | 哼，才不是为了你才留下的，别自作多情，我只是刚好有空而已。 | 傲娇拒绝，先急后软，重音在「别自作多情」（约 4.9s） |
| `rage_spray` | 你再说一遍试试看？我警告你，别太过分了，真的会生气的！ | 愤怒喷人，爆破音清晰，音量抬升不削波（约 4.6s） |
| `lazy_yawn` | 唔……好困啊，让我再赖一会儿，就一小会儿，别吵我嘛…… | 慵懒哈欠，开头真哈欠/吸气，尾音拖长（约 5.2s） |
| `happy_rice` | 开饭啦！今天有我最喜欢的米饭，太幸福了，我要开动咯！ | 干饭开心，明亮、节奏跳、句尾带笑（约 4.7s） |

口径：这五条是**说话参考音/试听**，不是唱歌；SVS 需声库训练，SVC 需源演唱 + 目标模型；RVC 训练建议 ≥10 分钟授权干声。

## 4. 未知 / 待确认

- OpenCpop 官方许可（仓库无 LICENSE、页面证书过期、镜像卡 metadata 与正文冲突）；
- DiffSinger 官方检查点的独立权重许可与各声库商用条款；
- RMVPE 实际权重来源与许可；
- RVC / DDSP-SVC 在 M4 MPS 上的真实稳定性与耗时（需实跑才知道）；
- 合成输出在具体司法辖区的版权归属。

## 5. 落地顺序（建议）

1. 非商用验证：OpenUtau（macOS arm64）+ DiffSinger 官方声库跑「谱 + 歌词」SVS 听感；RVC MIT 分支 + 授权测试音色跑「源演唱 → 目标音色」SVC 听感。
2. 商用 clean-room：OpenVPI DiffSinger + MakeDiffSinger + SingingVocoders 自训；RVC/DDSP-SVC 用授权数据自训并替换 RMVPE 与 NC 声码器；许可与授权分别留档。
3. 不做：GPT-SoVITS 冒充 SVS；AGPL/GPL 分支进主线；OpenCpop 检查点商用；未授权音色；上传声音到外部服务。

## 6. 来源

- OpenVPI DiffSinger <https://github.com/openvpi/DiffSinger>；OpenUtau <https://github.com/openutau/OpenUtau>；macOS arm64 0.1.576 <https://github.com/openutau/OpenUtau/releases/tag/0.1.576>；DiffSinger 支持说明 <https://github.com/openutau/OpenUtau/wiki/DiffSinger-support>
- OpenVPI 声码器权重（CC BY-NC-SA 4.0）<https://github.com/openvpi/vocoders/releases/tag/pc-nsf-hifigan-44.1k-hop512-128bin-2025.02>；许可说明 <https://openvpi.github.io/vocoders/>；SingingVocoders <https://github.com/openvpi/SingingVocoders>；MakeDiffSinger <https://github.com/openvpi/MakeDiffSinger>
- NNSVS <https://github.com/nnsvs/nnsvs>；安装文档 <https://nnsvs.github.io/nnsvs/installation.html>；ENUNU <https://github.com/oatsu-gh/ENUNU>
- RVC <https://github.com/RVC-Project/Retrieval-based-Voice-Conversion-WebUI>；权重仓 <https://huggingface.co/lj1995/VoiceConversionWebUI>；VCTK（CC BY 4.0）<https://datashare.ed.ac.uk/handle/10283/3443>；HuBERT <https://huggingface.co/facebook/hubert-base-ls960>
- RMVPE：<https://github.com/Dream-High/RMVPE>、<https://github.com/yxlllc/RMVPE>（无 LICENSE）；替代 FCPE <https://pypi.org/project/torchfcpe>、torchcrepe <https://github.com/maxrmorrison/torchcrepe>
- DDSP-SVC <https://github.com/yxlllc/DDSP-SVC>；so-vits-svc（AGPL-3.0）<https://github.com/svc-develop-team/so-vits-svc>；Seed-VC（GPL-3.0）<https://github.com/Plachtaa/seed-vc>
- OpenCpop <https://github.com/wenet-e2e/opencpop>；镜像卡 <https://huggingface.co/datasets/cyjin-yl/GreendamOpencpop>
- RVC macOS 分支：MIT <https://github.com/qingbo1011/RVC-WebUI-MacOS>；AGPL <https://github.com/audiohacking/RVC-MacOS>
