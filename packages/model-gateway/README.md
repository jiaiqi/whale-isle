# packages/model-gateway — 模型与供应商网关层

> 状态：**未开工**（对应工单 `T-M1-03`）｜ [SPEC §3.3](../../docs/SPEC.md)

## 职责（融合 CC Switch & Magpie 范式）

- **两步式供应商配置**：内置预设库（DeepSeek、SiliconFlow、OpenRouter、火山方舟、OpenAI、Anthropic、MiniMax、本地 Ollama/MLX/GPT-SoVITS）；同厂商 `Region（CN/GLOBAL/LOCAL）` × `Plan（按量/Coding 套餐）` 胶囊切换；`/v1/models` 一键拉取测试；Full URL 免拼接开关。
- **单屏 6 角色绑定**：`MAIN_PERSONA_BRAIN` / `STARDEW_GAME_PLANNER` / `DANMAKU_FAST_ROUTER` / `VISION_STORYBOARD` / `VOICE_TTS_SPEECH` / `VOICE_SVC_SINGING`（见 shared-protocol `WorkbenchRoleSlotSchema`）。
- **干饭套餐**：🍚 省饭摸鱼档 / 🍱 豪华直播档 / 🛡️ 本地断网档 一键切换。
- **粘性路由**：会话内固定同一节点吃满 Prompt Cache；上游 429/5xx 时 100ms 内静默切换备用 Key。
- **隐私脱敏**：发往云端前屏蔽本机用户名、绝对路径、API Key、剪贴板隐私（敏感路径 100% 替换为 `{{MASKED}}`）。
- **Token 计量**：为"赛博饭碗"提供 1 粒米 = 1 Token 的消耗流水。

## 边界（dependency-cruiser 强制）

- ❌ 任何 UI 组件严禁绕过本包直接调 LLM API（架构方向死锁）。
- ✅ API Key 只存本地安全凭据库；对外仅暴露 `apiKeyMaskedOrRef` 掩码。
