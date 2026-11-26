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
