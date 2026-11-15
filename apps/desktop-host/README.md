# apps/desktop-host — Electron 跨平台宿主

> 状态：**未开工**（对应工单 `T-M1-02`、`T-M1-05`、`T-M2-01` 宿主侧、`T-M4-03`）｜ [SPEC §2/§3.1](../../docs/SPEC.md)

## 目录规划

```text
src/main/               主进程：透明穿透窗管理、全局快捷键、SQLite（better-sqlite3）服务、
                        WebSocket + JSON-RPC 2.0 中心网关（端口 18760）、Python Sidecar 守护
src/renderer/pet-stage/ 桌面透明桌宠窗口：WebM 渲染 + 双轨气泡（对话 / <think> 云朵）+ 赛博饭碗小挂件
src/renderer/director/  主播中控台（React 19 + Tailwind）：模型配置（CC Switch/Magpie 风格）、
                        人设微调、直播控制台、切片导出；前端状态用 Dexie.js (IndexedDB)
src/renderer/obs-layer/ OBS 专用透明浏览器源（端口 18765）：高帧率字幕、点歌歌词滚屏、弹幕投票面板
```

## 关键实现要点

- **像素级鼠标穿透**：pet-stage 每 50ms 离屏 1x1 Canvas 读鼠标坐标 Alpha——`alpha > 20` 时 `setIgnoreMouseEvents(false)`；`alpha <= 20` 时 `setIgnoreMouseEvents(true, { forward: true })` 穿透到底层星露谷/桌面。
- **单端语音播放锁**：带 TTL 超时的 `AudioLease`，以 WebAudio `onended` 真实回执或超时释放；配合 shared-protocol 的 `AudioPlaybackLeaseSchema` / `AudioPlaybackReceiptSchema`。
- **无边框置顶透明窗**：Mac/Win 双平台行为一致；多显示器异构 DPI。

## 边界

- ❌ 渲染进程严禁直接调 LLM API / SQLite 文件；一律经主进程网关与 `model-gateway`。
- ✅ 跨进程通信统一走 JSON-RPC 2.0（18760），消息形状受 `@workbench/shared-protocol` 契约校验。
