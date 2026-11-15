"""音频 Sidecar 服务骨架（T-M2-01）。

职责边界：
  - /health        硬件后端探测（mps/cuda/cpu）与服务状态
  - /tts/synthesize 合成骨架（确定性 WAV stub；真实 GPT-SoVITS 接线在 T-M2-02）
  - /ws/audio       JSON-RPC 2.0 风格 WebSocket 通道（speak → synthesized）

单端语音播放锁（AudioLeaseManager）在宿主渲染进程——本服务只负责合成与排队语义的
数据供给；真实模型推理依赖（torch 等）不进骨架，按 optional 依赖在 T-M2-02 接入。
"""

from __future__ import annotations

import base64
import io
import json
import math
import platform
import shutil
import struct
import uuid
import wave
from typing import Any, Literal

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse

from tts_engine.emotion_router import (
    EmotionTtsRouter,
    EmotionVoiceProfile,
    TtsVoicePack,
)

Backend = Literal["mps", "cuda", "cpu"]

APP_VERSION = "0.1.0"

app = FastAPI(title="audio-ai-worker", version=APP_VERSION)

# 大肥鱼音色包（SPEC §3.4：5 组 5 秒情绪参考音频；素材 licenseScope 非商用）
VOICE_PACK = TtsVoicePack(
    voice_pack_id="blue-whale-maid-v1",
    default_emotion_tag="sweet_normal",
    profiles=(
        EmotionVoiceProfile("sweet_normal", "ref/sweet_normal.wav", "主人好~", 5_000, "happy_maid"),
        EmotionVoiceProfile("tsundere_refuse", "ref/tsundere_refuse.wav", "哼，本鱼才没有偷懒！", 5_000, "happy_maid"),
        EmotionVoiceProfile("rage_spray", "ref/rage_spray.wav", "噗——喷水抗议！", 5_000, "rage_spray"),
        EmotionVoiceProfile("lazy_yawn", "ref/lazy_yawn.wav", "唔……困了", 5_000, "hungry_lazy"),
        EmotionVoiceProfile("happy_rice", "ref/happy_rice.wav", "开饭啦！", 5_000, "eat_rice"),
    ),
)
TTS_ROUTER = EmotionTtsRouter(voice_pack=VOICE_PACK)


def detect_backend() -> Backend:
    """硬件后端探测：Apple Silicon → mps；N 卡（nvidia-smi 存在）→ cuda；否则 cpu。

    不引入 torch（骨架零重依赖）；torch 可用时用其权威探测结果覆盖。
    """
    try:  # torch 为可选依赖，存在时以它为准
        import torch  # type: ignore[import-not-found]

        if getattr(torch.backends, "mps", None) is not None and torch.backends.mps.is_available():
            return "mps"
        if torch.cuda.is_available():
            return "cuda"
        return "cpu"
    except ImportError:
        pass
    if platform.system() == "Darwin" and platform.machine() == "arm64":
        return "mps"
    if shutil.which("nvidia-smi") is not None:
        return "cuda"
    return "cpu"


def synth_wav_stub(duration_ms: int, sample_rate: int = 24000) -> bytes:
    """确定性 WAV 生成（骨架 stub）：440Hz 正弦，时长按请求；同参同输出（可缓存语义）。"""
    frames = max(1, int(sample_rate * duration_ms / 1000))
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        for i in range(frames):
            value = int(12000 * math.sin(2 * math.pi * 440 * i / sample_rate))
            wav.writeframes(struct.pack("<h", value))
    return buffer.getvalue()


def estimate_duration_ms(text: str, ms_per_char: int = 220) -> int:
    """播放时长估算（锁的 TTL 默认值来源）；标点按半速折算。"""
    chars = sum(1 for ch in text if not ch.isspace())
    return max(600, chars * ms_per_char)


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "service": "audio-ai-worker",
        "version": APP_VERSION,
        "backend": detect_backend(),
        "platform": platform.platform(),
    }


@app.post("/tts/synthesize")
def synthesize(payload: dict[str, Any]) -> JSONResponse:
    """合成骨架：{text, emotionTag?, voicePackId?, durationMs?} → {audioBase64, durationMs, synthId}。"""
    text = str(payload.get("text", "")).strip()
    if not text:
        return JSONResponse(status_code=400, content={"error": {"code": "EMPTY_TEXT", "message": "text 不能为空"}})
    duration_ms = int(payload.get("durationMs") or estimate_duration_ms(text))
    audio = synth_wav_stub(duration_ms)
    return JSONResponse(
        {
            "synthId": str(uuid.uuid4()),
            "format": "wav",
            "durationMs": duration_ms,
            "audioBase64": base64.b64encode(audio).decode("ascii"),
            "backend": detect_backend(),
        }
    )


@app.post("/tts/emotion")
def synthesize_with_emotion(payload: dict[str, Any]) -> JSONResponse:
    """情绪感知合成：{text, emotionTag?} → 音频流 + 口型包络 + 命中的参考音频路径。"""
    text = str(payload.get("text", "")).strip()
    if not text:
        return JSONResponse(status_code=400, content={"error": {"code": "EMPTY_TEXT", "message": "text 不能为空"}})
    result = TTS_ROUTER.synthesize(text)
    return JSONResponse(TTS_ROUTER.result_to_dict(result))


@app.get("/tts/voice-pack")
def voice_pack() -> dict[str, Any]:
    """音色包清单（宿主侧核对参考音频登记与素材许可）。"""
    return {
        "voicePackId": VOICE_PACK.voice_pack_id,
        "defaultEmotionTag": VOICE_PACK.default_emotion_tag,
        "licenseScope": VOICE_PACK.license_scope,
        "profiles": [
            {
                "emotionTag": profile.emotion_tag,
                "refAudioPath": profile.ref_audio_path,
                "refText": profile.ref_text,
                "refDurationMs": profile.ref_duration_ms,
                "actionState": profile.action_state,
            }
            for profile in VOICE_PACK.profiles
        ],
    }


@app.websocket("/ws/audio")
async def ws_audio(websocket: WebSocket) -> None:
    """JSON-RPC 2.0 风格通道：speak → synthesized；ping → pong。"""
    await websocket.accept()
    try:
        while True:
            raw = await websocket.receive_text()
            try:
                message = json.loads(raw)
            except json.JSONDecodeError:
                await websocket.send_text(json.dumps({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "JSON 解析失败"}}))
                continue
            request_id = message.get("id")
            method = message.get("method")
            if method == "ping":
                await websocket.send_text(json.dumps({"jsonrpc": "2.0", "id": request_id, "result": "pong"}))
            elif method == "speak":
                params = message.get("params") or {}
                text = str(params.get("text", "")).strip()
                if not text:
                    await websocket.send_text(json.dumps({"jsonrpc": "2.0", "id": request_id, "error": {"code": -32602, "message": "缺少 text"}}))
                    continue
                duration_ms = int(params.get("durationMs") or estimate_duration_ms(text))
                audio = synth_wav_stub(duration_ms)
                await websocket.send_text(
                    json.dumps(
                        {
                            "jsonrpc": "2.0",
                            "id": request_id,
                            "result": {
                                "event": "synthesized",
                                "synthId": str(uuid.uuid4()),
                                "format": "wav",
                                "durationMs": duration_ms,
                                "audioBase64": base64.b64encode(audio).decode("ascii"),
                            },
                        }
                    )
                )
            else:
                await websocket.send_text(json.dumps({"jsonrpc": "2.0", "id": request_id, "error": {"code": -32601, "message": f"未知方法：{method}"}}))
    except WebSocketDisconnect:
        return
