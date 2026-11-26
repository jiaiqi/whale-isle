"""T-M2-01 音频 Sidecar 骨架测试（[SIMULATION]，TestClient 无需真实端口）。"""

import base64
import io
import json
import wave

from fastapi.testclient import TestClient

from app import APP_VERSION, app, detect_backend, estimate_duration_ms, synth_wav_stub

client = TestClient(app)


def test_health_reports_backend_and_version() -> None:
    response = client.get("/health")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["version"] == APP_VERSION
    assert body["backend"] in {"mps", "cuda", "cpu"}


def test_health_reports_tts_capability_honestly() -> None:
    """探针实测来源：`/health.tts` 必须如实说「这是占位后端、不支持情绪 TTS」。"""
    body = client.get("/health").json()
    tts = body["tts"]
    assert tts["mode"] == "placeholder"
    assert tts["engine"] == "stub-sine-placeholder"
    assert tts["supportsEmotion"] is False
    assert "占位" in tts["detail"]


def test_synthesize_endpoint_marks_placeholder_audio() -> None:
    """骨架合成接口不许把正弦波当成真实 TTS 回执。"""
    response = client.post("/tts/synthesize", json={"text": "测试", "durationMs": 200})
    assert response.status_code == 200
    body = response.json()
    assert body["placeholder"] is True
    assert body["backend"] == "stub-sine-placeholder"
    assert body["placeholderReason"]


def test_detect_backend_matches_platform_heuristics() -> None:
    backend = detect_backend()
    if backend == "mps":
        import platform

        assert platform.system() == "Darwin" and platform.machine() == "arm64"


def test_synth_stub_deterministic_and_valid_wav() -> None:
    audio_a = synth_wav_stub(200)
    audio_b = synth_wav_stub(200)  # 同参同输出（缓存语义）
    assert audio_a == audio_b
    with wave.open(io.BytesIO(audio_a), "rb") as wav:
        assert wav.getframerate() == 24000
        assert wav.getnframes() == int(24000 * 200 / 1000)


def test_estimate_duration_floor() -> None:
    assert estimate_duration_ms("") == 600  # 空串落到底线
    assert estimate_duration_ms("嗯") >= 600


def test_synthesize_endpoint_roundtrip() -> None:
    response = client.post("/tts/synthesize", json={"text": "哼，本鱼才没有偷懒！", "emotionTag": "tsundere_refuse"})
    assert response.status_code == 200
    body = response.json()
    assert body["format"] == "wav"
    assert body["durationMs"] >= 600
    audio = base64.b64decode(body["audioBase64"])
    with wave.open(io.BytesIO(audio), "rb") as wav:
        assert wav.getnframes() > 0


def test_synthesize_rejects_empty_text() -> None:
    response = client.post("/tts/synthesize", json={"text": "   "})
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "EMPTY_TEXT"


def test_synthesize_duration_override() -> None:
    response = client.post("/tts/synthesize", json={"text": "短句", "durationMs": 1234})
    assert response.json()["durationMs"] == 1234


def test_ws_speak_roundtrip_and_errors() -> None:
    with client.websocket_connect("/ws/audio") as ws:
        ws.send_text(json.dumps({"jsonrpc": "2.0", "id": 1, "method": "ping"}))
        assert json.loads(ws.receive_text())["result"] == "pong"

        ws.send_text(json.dumps({"jsonrpc": "2.0", "id": 2, "method": "speak", "params": {"text": "开饭！", "durationMs": 800}}))
        result = json.loads(ws.receive_text())["result"]
        assert result["event"] == "synthesized"
        assert result["durationMs"] == 800

        ws.send_text(json.dumps({"jsonrpc": "2.0", "id": 3, "method": "speak", "params": {}}))
        assert json.loads(ws.receive_text())["error"]["code"] == -32602

        ws.send_text(json.dumps({"jsonrpc": "2.0", "id": 4, "method": "nope"}))
        assert json.loads(ws.receive_text())["error"]["code"] == -32601

        ws.send_text("not-json")
        assert json.loads(ws.receive_text())["error"]["code"] == -32700
