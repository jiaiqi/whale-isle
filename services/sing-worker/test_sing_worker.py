"""whale-sing-worker 单元测试（[SIMULATION]：后端全部以假 HTTP 替身替代，不触真实推理）。"""

from __future__ import annotations

import importlib
import sys
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).parent))


def _reload(env: dict[str, str]) -> Any:
    """按给定环境变量重载模块（端点配置在 import 时读取）。"""
    for key in (
        "WHALE_SING_SVS_ENDPOINT",
        "WHALE_SING_SVC_ENDPOINT",
        "WHALE_SING_TTS_ENDPOINT",
        "WHALE_SING_PROBE_TIMEOUT_S",
        "WHALE_SING_RENDER_TIMEOUT_S",
        "WHALE_SING_SVS_MODEL_PATH",
        "WHALE_SING_SVS_MODEL_SHA256",
        "WHALE_SING_SVS_MODEL_ID",
        "WHALE_SING_SVC_MODEL_PATH",
        "WHALE_SING_SVC_MODEL_SHA256",
        "WHALE_SING_SVC_MODEL_ID",
    ):
        if key in env:
            import os

            os.environ[key] = env[key]
        else:
            import os

            os.environ.pop(key, None)
    sys.modules.pop("app", None)
    return importlib.import_module("app")


def test_health_without_backends_reports_honest_unavailable() -> None:
    module = _reload({})
    with TestClient(module.app) as client:
        resp = client.get("/sing/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["svs"] is False
    assert body["svc"] is False
    names = {b["name"]: b for b in body["backends"]}
    assert names["svs"]["ready"] is False
    assert "未配置" in names["svs"]["detail"]
    # 普通 TTS 即使在线也不得冒充唱歌能力
    assert body["ttsClone"]["ready"] is False
    assert "不得当作 SVS/SVC 使用" in body["ttsClone"]["detail"]


def test_svs_render_without_backend_returns_501_not_fake_audio() -> None:
    module = _reload({})
    with TestClient(module.app) as client:
        resp = client.post("/sing/svs", json={"requestId": "r1", "characterId": "c", "voiceProfileId": "v", "mode": "svs"})
    assert resp.status_code == 501
    assert "未配置" in resp.json()["detail"]
    assert "audioBase64" not in resp.json()


def test_svc_requires_backend_too() -> None:
    module = _reload({})
    with TestClient(module.app) as client:
        resp = client.post("/sing/svc", json={"requestId": "r2", "characterId": "c", "voiceProfileId": "v", "mode": "svc"})
    assert resp.status_code == 501


def test_worker_own_health_is_independent_of_singing_capability() -> None:
    module = _reload({})
    with TestClient(module.app) as client:
        resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json()["ok"] is True


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))


# ---------------------------------------------------------------------------
# neuralVerified 证据门禁（2026-11-26 owner 纠正：音频字节不构成神经推理证据）
# ---------------------------------------------------------------------------


def test_evidence_missing_when_no_model_path() -> None:
    """没有权重路径 → evidence=None 且给出原因，绝不置 neuralVerified。"""
    module = _reload({})
    evidence, missing = module.build_model_evidence("svs")
    assert evidence is None
    assert "未配置" in missing
    assert "无法核实推理来源" in missing


def test_evidence_missing_when_weight_file_absent(tmp_path: Any) -> None:
    module = _reload({"WHALE_SING_SVS_MODEL_PATH": str(tmp_path / "nope.pth")})
    evidence, missing = module.build_model_evidence("svs")
    assert evidence is None
    assert "不存在" in missing


def test_evidence_reports_actual_fingerprint_when_no_expected(tmp_path: Any) -> None:
    """未注册期望指纹时，给出实际指纹并标 weight_fingerprint（可复核）。"""
    weight = tmp_path / "xiaojing.pth"
    weight.write_bytes(b"fake-weight-bytes")
    module = _reload({"WHALE_SING_SVS_MODEL_PATH": str(weight), "WHALE_SING_SVS_MODEL_ID": "diffsinger:xiaojing-v1"})
    evidence, missing = module.build_model_evidence("svs")
    assert missing is None
    assert evidence is not None
    assert evidence["modelId"] == "diffsinger:xiaojing-v1"
    assert evidence["verifiedBy"] == "weight_fingerprint"
    assert len(evidence["weightSha256"]) == 64


def test_evidence_rejects_fingerprint_mismatch(tmp_path: Any) -> None:
    """期望指纹与实际不符 → 拒绝出证据（防止挂错模型还宣称已核实）。"""
    weight = tmp_path / "xiaojing.pth"
    weight.write_bytes(b"fake-weight-bytes")
    module = _reload(
        {
            "WHALE_SING_SVS_MODEL_PATH": str(weight),
            "WHALE_SING_SVS_MODEL_SHA256": "0" * 64,
        }
    )
    evidence, missing = module.build_model_evidence("svs")
    assert evidence is None
    assert "指纹不匹配" in missing


def test_evidence_accepts_matching_fingerprint(tmp_path: Any) -> None:
    import hashlib

    weight = tmp_path / "xiaojing.pth"
    payload = b"fake-weight-bytes"
    weight.write_bytes(payload)
    module = _reload(
        {
            "WHALE_SING_SVS_MODEL_PATH": str(weight),
            "WHALE_SING_SVS_MODEL_SHA256": hashlib.sha256(payload).hexdigest(),
        }
    )
    evidence, missing = module.build_model_evidence("svs")
    assert missing is None
    assert evidence is not None
    assert evidence["weightSha256"] == hashlib.sha256(payload).hexdigest()


def test_attach_evidence_flips_false_without_evidence() -> None:
    """有音频但无证据 → neuralVerified=False + evidenceMissing（核心红线）。"""
    module = _reload({})
    body = module._attach_evidence({"audioBase64": "FAKE_AUDIO_BYTES"}, "svs")
    assert body["neuralVerified"] is False
    assert body["evidenceMissing"]
    assert "audioBase64" in body  # 音频仍在，只是不被当作推理证据
