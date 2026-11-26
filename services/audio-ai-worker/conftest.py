"""Shared fixtures for audio-ai-worker tests."""

from pathlib import Path

import pytest


@pytest.fixture(autouse=True)
def isolate_voice_assets(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("WHALE_VOICE_ASSETS_ROOT", str(tmp_path))
