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
