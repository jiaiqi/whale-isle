# Whale Isle V2 验证证据归档索引（Evidence Archive）

本目录按里程碑或关键工单归档**真实可执行、可复现的验证证据**（命令、退出码、Commit Hash、覆盖率摘要、打包产物与尚未验收的真机/外部平台缺口）。

## 归档规范

1. 必须严格区分 `[REAL-DEVICE]`、`[E2E-HOST]`、`[SIMULATION]` 与 `UNVERIFIED / STUB`。
2. 禁止伪造、补写或外推未实际打印的测试数量、覆盖率、耗时与余额结果。
3. 每次里程碑或高风险工单完成后，新增或更新对应证据文档，并在 [EVALUATION.md](../EVALUATION.md) 与 [TRACEABILITY.md](../TRACEABILITY.md) 中引用。

## 当前证据清单

| 证据文件 | 覆盖范围 | 结论口径 |
| --- | --- | --- |
| [P0-foundation-verification.md](./P0-foundation-verification.md) | `V2-P0-01` ~ `V2-P0-05` | 自动化门禁、单测覆盖率、`node:sqlite` 迁移恢复、`electron-builder` 打包与 Electron 45 E2E 实测通过；外部 CLI 自动调用与 V1 旧库真机抽检诚实标注待验 |
| [P1-character-life-verification.md](./P1-character-life-verification.md) | `V2-P1-01` | 12 域 `CharacterCore` 与 `LifeRuntime`（`92.33%` 分支覆盖）、`verify:gate` 7/7、Electron 45 E2E 实测通过 |
| [P1-voice-mixer-verification.md](./P1-voice-mixer-verification.md) | `V2-P1-02` | `IMPLEMENTED_UNVERIFIED`：`@workbench/voice-runtime` 单测、`verify:gate` 7/7 与 Electron 45 E2E 通过；真实音频听感、云端 TTS Key 与 Windows SAPI 实机待验 |
| [P1-provider-quota-verification.md](./P1-provider-quota-verification.md) | `V2-P1-03` | `IMPLEMENTED_UNVERIFIED`：四级诚实额度契约与探针（`90.86%` 分支覆盖）、`verify:gate` 7/7 与 Electron 45 E2E 通过；Kimi / MiniMax Coding Plan 真实 Key 待验 |
| [P1-memory-growth-verification.md](./P1-memory-growth-verification.md) | `V2-P1-04` | 类人五类记忆、模糊印象、情绪召回与级联真删除（37 单测 + `verify:gate` 7/7 + Electron 45 E2E 2/2 全绿） |
| [P1-obsidian-ui-verification.md](./P1-obsidian-ui-verification.md) | `V2-P1-05` | Obsidian Tide 中控台重构、`App.tsx` Strangler 拆解、四大签名组件与 V2 生命中枢（`verify:gate` 7/7 + 全部 4 个 Electron 45 E2E 套件全绿） |
| [P1-stardew-ai-first-verification.md](./P1-stardew-ai-first-verification.md) | `V2-P1-06` | `IMPLEMENTED_UNVERIFIED`：清除默认静默规则代驾、三方控制权租约、13 项控制指令与 12 项验收场景仿真（`verify:gate` 7/7 + Electron 45 E2E 全绿；待真实《星露谷》+ SMAPI 实机联调与浸泡） |
| [P2-guide-learning-verification.md](./P2-guide-learning-verification.md) | `V2-P2-01` | `IMPLEMENTED_UNVERIFIED`：攻略溯源、游戏版本/Mod 兼容校验、实玩置信度演进与反例更新闭环（`verify:gate` 7/7 + 64 专项单测 + Electron 45 E2E 全绿；待真实《星露谷》多日实机校验） |
| [P2-ecosystem-isolation-verification.md](./P2-ecosystem-isolation-verification.md) | `V2-P2-02` | `REQ-SEC-01 DONE` / `REQ-EXT-01 IMPLEMENTED_UNVERIFIED`：第三方插件 Worker Isolate 隔离、`PolicyBroker` P0–P5、`SkillRegistry`、双向 MCP 与多 Harness 扩展（`verify:gate` 7/7 + Electron 45 E2E 全绿；新外部 CLI 真机联调待验） |
| [P2-media-gateway-verification.md](./P2-media-gateway-verification.md) | `V2-P2-03` | `IMPLEMENTED_UNVERIFIED`：`MediaGenerationGateway`、Character Bible 一致性、十态资产溯源与候选区审查隔离（`verify:gate` 7/7 + 33 专项单测 + Electron 45 E2E 全绿；真实云端生图 Key 待验） |
| [P2-3d-blender-pipeline-verification.md](./P2-3d-blender-pipeline-verification.md) | `V2-P2-04` | `IMPLEMENTED_UNVERIFIED`：3D 大模型 HTTP 管线、Blender 无头脚本与跨平台探测、真实 glTF/VRM 二进制骨骼与 Viseme 质检（`verify:gate` 7/7 + 6 专项单测 + Electron 45 E2E 全绿；本机缺 Blender 与 Hunyuan3D 服务待真机验收） |
| [P2-character-studio-crosspet-verification.md](./P2-character-studio-crosspet-verification.md) | `V2-P2-05` | `IMPLEMENTED_UNVERIFIED`：Character Bible 持久化与晋升、Live2D/2D 分层 QA、商业/直播硬拦截与 CrossPet 30 角色全量合法导入（`verify:gate` 7/7 + 5 专项单测 + Electron 45 E2E 全绿；外部 `.moc3` 真机渲染待 `V2-P3-01`） |
| [P2-pixel-stardew-avatar-verification.md](./P2-pixel-stardew-avatar-verification.md) | `V2-P2-06` | `IMPLEMENTED_UNVERIFIED`：11 步像素流水线、纯 Node PNG 编解码、`WhaleIsleAvatar.dll` 编译暂存与导出一致性核验（`verify:gate` 7/7 + 4 专项单测 + Electron 45 E2E 全绿；进星露谷游戏目视确认待 `[REAL-DEVICE]`） |
| [P2-asset-registry-stage-sound-verification.md](./P2-asset-registry-stage-sound-verification.md) | `V2-P2-07` | `DONE`：十态 `AssetRegistryV2` 快照与一键回滚、SHA-256 防篡改、非商用清源阻断与原创舞台背景/WAV 音效工坊（`verify:gate` 7/7 + 3 专项单测 + Electron 45 E2E 全绿） |
| [P2-coop-runtime-v1-verification.md](./P2-coop-runtime-v1-verification.md) | `V2-P2-08` | `IMPLEMENTED_UNVERIFIED`：`CoopRuntimeV1` 人机独立租约、任务板、防误卖资源锁、本机真实 Mods 兼容扫盘与断线重连恢复（`verify:gate` 7/7 + 5 专项单测 + Electron 45 E2E 全绿；双端实机联机待 `[REAL-DEVICE]`） |
| [P3-performance-stage-verification.md](./P3-performance-stage-verification.md) | `V2-P3-01` | `IMPLEMENTED_UNVERIFIED`：`SingEngine`（SVS/SVC 与导唱分离）、曲库四重授权门禁、双语 LRC 音频时钟、`PerformanceDirector` 6 层仲裁与沉默权、2D/Live2D/VRM/OBS 统一 `StageRuntime`（`verify:gate` 7/7 + 6 专项单测 + Electron 45 E2E 全绿；真实神经歌声 Worker 与 3D/Live2D 画布目视待 `[REAL-DEVICE]`） |
| [P3-tidepaper-ui-verification.md](./P3-tidepaper-ui-verification.md) | `REQ-UI-01` / `ADR-003` | `DONE`：中控台切换至 Tidepaper（晨雾/夜潮 + 5 强调色）主基线，保留 Obsidian Tide / Tide Deep 可选主题，并实盘接入 P2 资产联机摘要与 P3-01 表演舞台面板（`verify:gate` 7/7 + WCAG 对比度 + Electron 45 E2E 4 套件全绿） |
| [P3-tidepaper-v3.1-shell-verification.md](./P3-tidepaper-v3.1-shell-verification.md) | `REQ-UI-01` / `ADR-003` | `DONE`（视觉与外壳层）：纸面材质去模糊、IA 六组、三层控制权条、在场胶囊、角色卡向上菜单、PageHead 与 `⌘K` 直达小鲸；`ComputerUseLease` 未接线如实标注「未接入 · P3」（`verify:gate` 7/7 + WCAG ≥4.5 + Electron 45 E2E 3/3 & 8/8 全绿） |
| [P3-live-runtime-obs-verification.md](./P3-live-runtime-obs-verification.md) | `V2-P3-02` | `IMPLEMENTED_UNVERIFIED`：`LiveRuntimeV2`（弹幕护栏/去重、礼物合并感谢、曲库四重版权拦截、诚实断连降级探测、OBS 舞台投影与场次摘要）及宿主 7 路 IPC 与 UI 接线（`live-runtime.ts` `91.66%` 分支 + `verify:gate` 7/7 + Electron 45 E2E 4 套件全绿；真实直播平台测试账号待 `[REAL-DEVICE]`） |
| [P3-browser-computer-use-verification.md](./P3-browser-computer-use-verification.md) | `V2-P3-03` | `IMPLEMENTED_UNVERIFIED`：`AccountVault` / Per-Character Browser Profile 隔离、`ComputerUseLease` 设备级单主控与用户输入抢占、确定性浏览器 runner、CAPTCHA `awaiting_human` 交接、P5 一次性确认（runtime-core `90.16%` 分支 + `verify:gate` 7/7 + Electron 45 E2E 3/3 与 `ui.e2e` 9/9 全绿；真实 OS 注入与 TCC 授权待 `[REAL-DEVICE]`） |
| [TTS-local-engine-benchmark-verification.md](./TTS-local-engine-benchmark-verification.md) | item 10（表现力语音） | `[REAL-DEVICE]`：本机 CosyVoice2-0.5B 三后端实测（RTF P50 2.42 / 一句话 17–43 秒 / 冷启动 30.6 秒）→ 默认档切商业 API、本地引擎降为可选离线档；§9 收尾三件，§10 两家商业 TTS 接入（听感对拍**未实测**，缺 `openai-tts` 凭据且当前实例为 mock-keychain） |
| [zipvoice-internal-validation.md](./zipvoice-internal-validation.md) | item 10 后续（`[INTERNAL-VALIDATION-NONCOMMERCIAL]`） | `[REAL-DEVICE]`（仅本机 CPU 推理）：ZipVoice-Distill int8 能跑通，RTF P50 0.475 / 一句话 1.2–2.9 秒 / 冷启动 0.61 秒 / 678 MB，ASR 回环 11/15 逐字一致；**权重 CC-BY-NC 不可商用不可随包**，无情绪通道，未接 `fetch-engine.mjs` 与 Worker |
| [mimo-tts-candidate-integration.md](./mimo-tts-candidate-integration.md) | item 10 后续（小米 MiMo 候选） | `[SIMULATION]`：`MimoTtsProvider` 两种模式（VoiceClone/VoiceDesign）请求体与响应解析、候选不进兜底链、探针不宣称情绪；8 例单测 + 假服务端跑通四家 bench 链路；**真实 API 未实连（缺 `mimo-tts` 凭据）**，首包/耗时/音色漂移/情绪全部未实测，含「限时免费风险」与切回路径 |
