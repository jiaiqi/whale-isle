"""点歌台原子能力服务测试（SPEC §3.4 的 Python 面）。

核心断言：能力缺失时**如实 501 + 具体缺口**，绝不返回占位音频；
命令一律以参数数组传递（不经 shell），且不因探测而执行任何重推理。
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import app as app_mod

client = TestClient(app_mod.app)


def test_capabilities_reports_honest_state() -> None:
    """能力探测只描述事实：ready 与 missing 必须自洽。"""
    r = client.get("/api/song/capabilities")
    assert r.status_code == 200
    body = r.json()
    names = [c["name"] for c in body["capabilities"]]
    assert names == ["demucs", "rvc", "ffmpeg", "rmvpe"]
    ready_names = [c["name"] for c in body["capabilities"] if c["ready"]]
    assert sorted(body["missing"]) == sorted(set(names) - set(ready_names))
    assert body["ready"] is (len(body["missing"]) == 0)
    for cap in body["capabilities"]:
        assert cap["detail"].strip() != ""
        if not cap["ready"]:
            assert cap["hint"].strip() != ""


def test_capabilities_does_not_fake_rvc_without_model() -> None:
    """没有 .pth 权重时 rvc 必须为 false（本机全盘无 .pth 的真实现状）。"""
    body = client.get("/api/song/capabilities").json()
    rvc = next(c for c in body["capabilities"] if c["name"] == "rvc")
    if not rvc["ready"]:
        assert "权重" in rvc["detail"] or "rvc" in rvc["detail"]


def test_separate_501_when_demucs_missing(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Demucs 不可用 → 501 + 缺口说明，且响应体不含任何音频。"""
    import song_pipeline

    monkeypatch.setattr(song_pipeline, "_which", lambda _b: None)
    src = tmp_path / "src.wav"
    src.write_bytes(b"RIFF0000WAVE")
    r = client.post(
        "/api/song/separate",
        json={"sourceAudioPath": str(src), "outputDir": str(tmp_path / "out")},
    )
    assert r.status_code == 501
    body = r.json()
    assert body["capability"] == "demucs"
    assert "demucs" in body["error"]
    assert "audio" not in {k.lower() for k in body}
    assert not (tmp_path / "out").exists() or not any((tmp_path / "out").iterdir())


def test_separate_400_when_source_missing(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """源音频缺失 → 400（不猜路径、不静默生成）。"""
    import song_pipeline

    monkeypatch.setattr(song_pipeline, "_which", lambda b: f"/fake/{b}")
    r = client.post(
        "/api/song/separate",
        json={"sourceAudioPath": str(tmp_path / "nope.wav"), "outputDir": str(tmp_path / "out")},
    )
    assert r.status_code == 400
    assert "源音频" in r.json()["error"]


def test_render_slice_501_when_rvc_missing(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """RVC 不可用 → 501，绝不产出占位切片。"""
    import song_pipeline

    monkeypatch.setattr(song_pipeline, "_which", lambda b: None if b == "rvc" else f"/fake/{b}")
    vocal = tmp_path / "vocal.wav"
    vocal.write_bytes(b"RIFF0000WAVE")
    acc = tmp_path / "acc.wav"
    acc.write_bytes(b"RIFF0000WAVE")
    r = client.post(
        "/api/song/render-slice",
        json={
            "vocalPath": str(vocal),
            "accompanimentPath": str(acc),
            "startMs": 0,
            "durationMs": 25000,
            "outputPath": str(tmp_path / "slice.ogg"),
        },
    )
    assert r.status_code == 501
    assert r.json()["capability"] == "rvc"
    assert not (tmp_path / "slice.ogg").exists()


def test_render_slice_400_when_inputs_missing(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """输入缺失在能力就绪时也返回 400，而不是造一个空音频。"""
    import song_pipeline

    monkeypatch.setattr(song_pipeline, "_which", lambda b: f"/fake/{b}")
    monkeypatch.setattr(song_pipeline, "RVC_MODEL_PATH", str(tmp_path / "m.pth"))
    (tmp_path / "m.pth").write_bytes(b"x")
    r = client.post(
        "/api/song/render-slice",
        json={
            "vocalPath": str(tmp_path / "missing.wav"),
            "accompanimentPath": str(tmp_path / "missing2.wav"),
            "startMs": 0,
            "durationMs": 1000,
            "outputPath": str(tmp_path / "slice.ogg"),
        },
    )
    assert r.status_code == 400
    assert "不存在或为空" in r.json()["error"]


def test_concat_501_when_ffmpeg_missing(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """ffmpeg 不可用 → 501。"""
    import song_pipeline

    monkeypatch.setattr(song_pipeline, "_which", lambda _b: None)
    r = client.post(
        "/api/song/concat",
        json={"slicePaths": [str(tmp_path / "a.ogg")], "outputPath": str(tmp_path / "out.ogg")},
    )
    assert r.status_code == 501
    assert r.json()["capability"] == "ffmpeg"


def test_concat_400_on_empty_and_missing_slices(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import song_pipeline

    monkeypatch.setattr(song_pipeline, "_which", lambda b: f"/fake/{b}")
    empty = client.post("/api/song/concat", json={"slicePaths": [], "outputPath": str(tmp_path / "o.ogg")})
    assert empty.status_code == 400
    missing = client.post(
        "/api/song/concat",
        json={"slicePaths": [str(tmp_path / "nope.ogg")], "outputPath": str(tmp_path / "o.ogg")},
    )
    assert missing.status_code == 400
    assert "缺失" in missing.json()["error"]


def test_commands_are_argument_arrays_not_shell_strings(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """外部命令必须以参数数组传递（不经 shell），杜绝注入。"""
    import song_pipeline

    calls: list[list[str]] = []

    def fake_which(b: str) -> str | None:
        return f"/fake/{b}"

    def fake_run(cmd: list[str]) -> tuple[bool, str]:
        calls.append(cmd)
        return False, "fake"

    monkeypatch.setattr(song_pipeline, "_which", fake_which)
    monkeypatch.setattr(song_pipeline, "_run", fake_run)
    monkeypatch.setattr(song_pipeline, "RVC_MODEL_PATH", str(tmp_path / "m.pth"))
    (tmp_path / "m.pth").write_bytes(b"x")
    for name in ("v.wav", "a.wav"):
        (tmp_path / name).write_bytes(b"RIFF0000WAVE")
    client.post(
        "/api/song/separate",
        json={"sourceAudioPath": str(tmp_path / "v.wav"), "outputDir": str(tmp_path / "o")},
    )
    assert calls, "分离应至少调用一次外部命令"
    for cmd in calls:
        assert isinstance(cmd, list)
        assert all(isinstance(part, str) for part in cmd)
        # 不允许出现 shell 元字符拼接痕迹
        assert not any(";" in part or "&&" in part or "|" in part for part in cmd)
