# P1 阶段验证证据归档 — `V2-P1-02`（真实 `VoiceProvider`、独立 `VoiceIdentity`、口型联动与多轨 `AudioMixer`）

> **分支**：`feat/whale-isle-v2`  
> **状态口径**：**`IMPLEMENTED_UNVERIFIED`**（代码、单测、门禁 7/7 与 Electron 45 E2E 全部通过；按 `AGENTS.md` §5.1 诚实口径，因尚缺真机人工听感、真实云端 TTS Key 联调与 Windows SAPI 硬件实测，严禁标为 `DONE`）  
> **测试环境**：macOS arm64 · Node `v24.22.2` · pnpm `12.16.1` · Electron `45.4.1` · Vitest `5.1.0`

---

## 一、实现摘要

1. **契约先行（`packages/shared-protocol/src/voice.ts`）**：定义 `VoiceProviderStatus`、`LipSyncFrame`、`VoiceSynthesisRequest`、`VoiceSynthesisOutput`、`AudioTrackState`、`SpeechFloorHolder` 与 `AudioMixerSnapshot`。
2. **语音运行时（`packages/voice-runtime/src/`）**：
   - **真实 `VoiceProvider`**：`CloudOpenAiTtsProvider`（`/audio/speech`）、`MiniMaxTtsProvider`（`/v1/t2a_v2`）、`LocalAudioWorkerProvider`（`audio-ai-worker` `/tts/emotion`）与诚实平台降级 `SystemFallbackVoiceProvider`（macOS `say` / Windows 注入安全 PowerShell `System.Speech` SAPI / 其他平台 `unsupported`）；
   - **`VoiceProviderRouter`**：消费解耦的 `VoiceIdentity`（`providerVoiceRef ?? voiceProfileId`），支持 LRU 缓存、分句预取（`splitSpeechSentences` + `synthesizeChunked`）、`AbortSignal` 取消及明确 `degraded` / `degradedFrom` 降级标注；
   - **口型联动**：`extractWavLipSyncFrames`（RIFF/PCM16 RMS + 过零率 Viseme 提取）、`synthesizeTextLipSyncFrames` 与 `LipSyncTimelinePlayer`（停播强制归位 `closed`）；
   - **发言权与多轨混音**：`SpeechFloorArbiter`（P0 抢占、TTL 强制释放、单人发言）+ `AudioMixer`（`bgm` / `sfx` / `singing` 与说话并发不互锁、说话时自动压低 `bgm` 增益并在结束时恢复、按轨输出设备路由）。
3. **Electron 宿主接线（`apps/desktop-host`）**：`v2-kernel-host.ts` 暴露 `v2:voice-*` 系列 IPC；`index.ts` 将 `voice-host` 发言态接入 `AudioMixer` 压低控制并驱动 `pet:lip-sync` 广播至 `pet-stage/main.ts`。

---

## 二、实测证据记录

### 1. 契约与 `voice-runtime` 确定性单测（`[SIMULATION]`）
- **命令**：`pnpm exec vitest run packages/voice-runtime/src/voice-runtime.spec.ts packages/shared-protocol/src/voice.spec.ts`
- **结果**：2 个测试文件 / **12 个用例全部通过**。
- **覆盖率**：
  - `@workbench/voice-runtime`：`96.09%` Stmts / `84.77%` Branch / `97.36%` Funcs / `98.54%` Lines（注：含 `providers.ts` 部分真实网络超时/信号路径；全仓 Vitest 门禁全局分支 ≥90% 通过）。
  - `packages/shared-protocol/src/voice.ts`：`100%` Stmts / `100%` Branch / `100%` Funcs / `100%` Lines。

### 2. 全仓四道自动化门禁（`pnpm verify:gate`）
- **结果**：**`7 过 / 0 跳过 / 0 待接线`**（退出码 `0`）：
  - Gate 1 类型与边界（TS `tsc -b` + `dependency-cruiser` 含新增 `voice-runtime-boundary`）：PASS
  - Gate 1 类型与边界（Python `ruff` + `mypy --strict`）：PASS
  - Gate 2 许可证与密钥（`license-scanner` 扫描 **262 个源文件**，0 违规；`pnpm audit --audit-level high` 0 漏洞；`luac -p` 5 Lua PASS）：PASS
  - Gate 3 确定性单测（全仓 Vitest + Pytest + 7 个卡死回归剧本 `S01–S07`）：PASS
  - Gate 4 回环契约 E2E（`[SIMULATION]` `0.4s < 15s`）：PASS

### 3. Electron 45 构建与宿主集成 E2E（`[E2E-HOST]`）
- **构建**：`pnpm --filter @workbench/desktop-host build` 通过。
- **E2E 命令**：`pnpm exec vitest run --config vitest.e2e.config.mts apps/desktop-host/e2e/desktop.e2e.spec.ts apps/desktop-host/e2e/v2-kernel.e2e.spec.ts`
- **结果**：**2/2 PASS**。
  - 在真实 Electron 45.4.1 主进程中验证：`v2VoiceProviders()` 诚实上报探测态（macOS 上包含 `macos-say` `system_fallback`）、`v2VoiceIdentity()` 返回 `char_xiaojing` 的 `qiaopi_mengmei`、`v2VoiceTrackStart` 与 `v2VoiceOutputRoute` 并发建轨与设备路由、`v2VoiceSynthesizePreview` 生成非空口型帧，以及 `v2EmergencyHalt` 清空在播轨道。

---

## 三、待人类真机验收缺口（转 `DONE` 前必须补齐）

1. **云端真实情绪 TTS API 实测（`[REAL-DEVICE]`）**：需用户填入真实 MiniMax / OpenAI-Compatible TTS API Key，实测真实音频流合成、延迟与音色连续性。
2. **人工听感与口型肉眼核验（`[REAL-DEVICE]`）**：在 macOS 桌面播放说话 + 背景音乐并发混音，确认鸭降（ducking）与口型开合节奏自然无破音。
3. **Windows SAPI 真实硬件验收（`[REAL-DEVICE]`）**：在 Windows x64 机器上实测 `buildWindowsSapiCommand` 调起 `System.Speech.Synthesis.SpeechSynthesizer` 发声无乱码与无报错。
