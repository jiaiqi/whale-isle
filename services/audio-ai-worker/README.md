# services/audio-ai-worker — Python 独立推理进程

> 状态：**未开工**（对应工单 `T-M2-01` ~ `T-M2-04`）｜ [SPEC §3.4](../../docs/SPEC.md)

## 技术基线

- **环境**：`uv` 管理 Python 3.11 独立虚拟环境；启动时自动探测硬件后端——macOS Apple Silicon → `mps`，Windows N 卡 → `cuda`，无独显 → `cpu`。
- **对外服务**：FastAPI + WebSocket，接入 Electron 主进程 JSON-RPC 2.0 总线（18760）。

## 目录规划

```text
tts_engine/     本地 GPT-SoVITS v2 (MPS/CUDA) + 云端 OpenAI/SiliconFlow/FishAudio 混合路由；
                绑定大肥鱼 5 组 5 秒情绪参考音频（嘴甜常态/傲娇反驳/破防喷水/困倦摸鱼/干饭兴奋）；
                输入带情绪前缀（如 "[傲娇反驳] ..."），网关剥离前缀路由参考音频并回传口型包络
svc_singing/    点歌台：违禁曲目黑名单 → Demucs v4 伴奏分离 → 前 25 秒切片先做 RVC v2 (RMVPE)
                变声混音先唱（流式预缓冲）→ 后台异步完成剩余切片无缝拼接落盘；
                本地磁盘缓存池 cache/songs/blue-whale-maid_<hash>.ogg（二次点播 <50ms 命中）
asset_pipeline/ 移植自 dsh-pet：绿幕视频抠像、脚底对齐、转 VP9-Alpha WebM 自动化工具链
```

## 边界

- ✅ 接口数据结构必须与 `packages/shared-protocol` 生成的 Python Pydantic 模型（T-M0-02 导出）一致，严禁手写裸 JSON 契约。
- ❌ 严禁任何密钥回传/远端上报逻辑（Gate 2 扫描）。
