"""T-M5-17 声音工坊门禁（pytest + httpx TestClient，零外网）。

覆盖（用户验收四条全映射）：
  1. 参数一致性：audition 接收的 speed/pauseConfig/pitchShiftSemitones 与 save-pack 落盘
     的 voice_matrix.json 100% 一致；
  2. refText 空值拦截：400 + autoFill 兜底，绝不放行空文本触发内部 ASR；
  3. audition-svc 资源互斥锁：先暂停 TTS 再执行 RVC（mutexTrace 断言），结束后恢复；
  4. 设计/切片/权重导入/低内存降级的确定性行为。
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

import app as app_mod
from voice_studio import DESIGN_PRESETS, MUTEX

client = TestClient(app_mod.app)


def _b64_ok(payload: dict[str, Any], key: str = "audioB64") -> bool:
    return isinstance(payload.get(key), str) and len(payload[key]) > 100


def test_health_includes_voice_studio() -> None:
    r = client.get("/api/voice-studio/status")
    assert r.status_code == 200
    body = r.json()
    assert body["hardware"] in ("mps", "cuda", "cpu")
    assert "mutex" in body


def test_design_cloud_prompt_archived() -> None:
    r = client.post(
        "/api/voice-studio/design",
        json={
            "mode": "cloud_voice_design",
            "prompt": "dfeiyu_tsundere_whale",
            "previewText": "哼，本鱼才没有偷懒呢！",
            "emotionTag": "sweet_normal",
        },
    )
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert "12到14岁" in body["promptArchived"]
    assert Path(body["refAudioPath"]).exists()
    assert _b64_ok(body, "previewAudioB64")


def test_design_cloud_requires_prompt() -> None:
    r = client.post("/api/voice-studio/design", json={"mode": "cloud_voice_design"})
    assert r.status_code == 400


def test_design_weight_import_validates() -> None:
    # 不存在路径 → 404
    r = client.post(
        "/api/voice-studio/design",
        json={"mode": "local_weight_import", "weightPath": "/nonexistent/x.pth"},
    )
    assert r.status_code == 404
    # 假权重文件
    fake = Path("/tmp/_fake_weight.pth")
    fake.write_bytes(b"fake")
    r2 = client.post(
        "/api/voice-studio/design",
        json={
            "mode": "local_weight_import",
            "weightPath": str(fake),
            "licenseScope": "DEV_ONLY_NON_COMMERCIAL",
        },
    )
    assert r2.status_code == 200
    assert r2.json()["licenseScope"] == "DEV_ONLY_NON_COMMERCIAL"
    fake.unlink()


def test_slice_extract_deterministic_slices() -> None:
    import wave

    tmp = Path("/tmp/_vs_test_20s.wav")
    with wave.open(str(tmp), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(24000)
        w.writeframes(b"\x00\x00" * 24000 * 20)
    r = client.post(
        "/api/voice-studio/slice-extract",
        json={"filePath": str(tmp), "separateVocal": False},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert len(body["slices"]) >= 2
    assert all(3.0 <= (s["endSec"] - s["startSec"]) <= 8.0 + 0.01 for s in body["slices"])
    assert all(s["refTextDraft"] for s in body["slices"])
    tmp.unlink()


def test_slice_extract_missing_file() -> None:
    r = client.post("/api/voice-studio/slice-extract", json={"filePath": "/no/such.wav"})
    assert r.status_code == 404


def test_audition_tts_params_passthrough_exact() -> None:
    """验收第 1 条：speed/pauseConfig 修改 → 后端收到参数与保存后 100% 一致。"""
    params = {
        "emotionTag": "tsundere_refuse",
        "refAudioPath": "ref/tsundere.wav",
        "refText": "哼、哼！才不是因为担心主人呢！",
        "speed": 1.25,
        "temperature": 0.55,
        "topP": 0.9,
        "topK": 20,
        "pauseConfig": {"periodMs": 400, "commaMs": 200, "ellipsisMs": 500},
        "prependSfxPath": "sfx/pop.wav",
        "sfxVolume": 0.3,
    }
    r = client.post("/api/voice-studio/audition-tts", json=params)
    assert r.status_code == 200
    body = r.json()
    assert body["renderedParams"] == params  # 逐键 100% 一致
    assert body["skipCache"] is True
    assert _b64_ok(body)


def test_audition_tts_empty_ref_text_blocked() -> None:
    """验收第 2 条：refText 空值拦截 + autoFill 兜底。"""
    r = client.post(
        "/api/voice-studio/audition-tts",
        json={"emotionTag": "rage_spray", "refText": "   "},
    )
    assert r.status_code == 400
    body = r.json()
    assert "refText" in body["error"]
    assert body["autoFill"]  # 自动填充草稿供前端一键使用


def test_audition_svc_mutex_trace() -> None:
    """验收第 3 条：RVC 资源互斥——先暂停 TTS 再执行，结束后恢复。"""
    r = client.post(
        "/api/voice-studio/audition-svc",
        json={
            "pitchShiftSemitones": 12,
            "indexRate": 0.8,
            "protectVoiceless": 0.33,
            "vocalGainDb": 1.5,
            "accompanimentGainDb": -4.0,
        },
        params={"testText": "副歌 15 秒"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["mutexTrace"] == ["tts_suspended", "rvc_running", "tts_resumed"]
    # 释放后互斥状态归零
    assert MUTEX.status()["ttsSuspended"] is False
    assert MUTEX.status()["activeHeavyTask"] is None


def test_audition_svc_low_memory_returns_resources_low() -> None:
    """低内存护栏：<4GB 时 422 + resourcesLow（调用方降级云端试听）。"""
    import voice_studio

    orig = voice_studio._available_memory_gb
    voice_studio._available_memory_gb = lambda: 2.0
    try:
        r = client.post(
            "/api/voice-studio/audition-svc",
            json={"pitchShiftSemitones": 2, "indexRate": 0.75},
        )
        assert r.status_code == 422
        assert r.json()["resourcesLow"] is True
    finally:
        voice_studio._available_memory_gb = orig


def test_save_pack_persists_and_hot_reloads() -> None:
    """验收第 1 条收尾：save-pack 落盘 voice_matrix.json 与入参 100% 一致。"""
    emotion_params = [
        {
            "emotionTag": tag,
            "refAudioPath": f"ref/{tag}.wav",
            "refText": f"{tag} 的参考台词",
            "speed": 1.0 + i * 0.05,
            "temperature": 0.8,
            "topP": 1.0,
            "topK": 15,
            "pauseConfig": {"periodMs": 340, "commaMs": 150, "ellipsisMs": 460},
            "prependSfxPath": "",
            "sfxVolume": 0.0,
        }
        for i, tag in enumerate(
            ["sweet_normal", "tsundere_refuse", "rage_spray", "lazy_yawn", "clumsy_panic"]
        )
    ]
    svc_params = {
        "rvcModelPath": "rvc/xiaojing.pth",
        "indexPath": "rvc/xiaojing.index",
        "pitchShiftSemitones": 2,
        "indexRate": 0.75,
        "protectVoiceless": 0.33,
        "vocalGainDb": 0.0,
        "accompanimentGainDb": -3.0,
    }
    r = client.post(
        "/api/voice-studio/save-pack",
        json={
            "petId": "blue-whale-maid",
            "voicePackId": "blue-whale-maid-v2",
            "emotionParams": emotion_params,
            "svcParams": svc_params,
        },
    )
    assert r.status_code == 200
    body = r.json()
    assert body["hotReload"] is True
    matrix_path = Path(body["savedPath"])
    assert matrix_path.exists()
    matrix = json.loads(matrix_path.read_text(encoding="utf-8"))
    # 逐锚点参数 100% 一致
    for sent, stored in zip(emotion_params, matrix["tts"]["profiles"], strict=True):
        assert stored == sent
    assert matrix["svc"] == svc_params
    assert matrix["licenseScope"] == "DEV_ONLY_NON_COMMERCIAL"


def test_save_pack_rejects_duplicate_and_empty() -> None:
    dup = [
        {
            "emotionTag": "sweet_normal",
            "refText": "a",
            "speed": 1.0,
            "temperature": 1.0,
            "topP": 1.0,
            "topK": 15,
        },
        {
            "emotionTag": "sweet_normal",
            "refText": "b",
            "speed": 1.1,
            "temperature": 1.0,
            "topP": 1.0,
            "topK": 15,
        },
    ]
    r = client.post("/api/voice-studio/save-pack", json={"emotionParams": dup})
    assert r.status_code == 400
    empty = [
        {"emotionTag": "lazy_yawn", "refText": "", "speed": 1.0, "temperature": 1.0}
    ]
    r2 = client.post("/api/voice-studio/save-pack", json={"emotionParams": empty})
    assert r2.status_code == 400
    assert r2.json()["autoFill"]


def test_mutex_concurrent_heavy_task_rejected() -> None:
    """互斥占用中第二个重任务 → 409。"""
    MUTEX.acquire("demucs_slice")
    try:
        r = client.post(
            "/api/voice-studio/audition-svc", json={"pitchShiftSemitones": 0}
        )
        assert r.status_code == 409
    finally:
        MUTEX.release()
    assert MUTEX.status()["activeHeavyTask"] is None


def test_design_presets_include_user_prompt() -> None:
    assert "12到14岁" in DESIGN_PRESETS["dfeiyu_tsundere_whale"]
    assert "6到8岁" in DESIGN_PRESETS["loli_sweet"]
