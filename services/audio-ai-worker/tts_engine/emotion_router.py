"""情绪感知 TTS 混合路由（T-M2-02，SPEC §3.4）。

职责：
  - 情绪标签 → 匹配大肥鱼参考音频（voice pack，5 组 5 秒情绪参考音频）；
  - 本地 GPT-SoVITS 优先推理，失败自动降级到云端后端（degraded=True 如实上报）；
  - 产出音频流 + 口型包络（viseme 序列），供桌宠同步嘴型。

接口先行：真实 torch 推理（2GB+ 模型）按 TTSBackend 可插拔，本模块提供确定性 stub 实现，
接口与真实实现完全一致（真实推理接入时替换 backend 工厂即可）。
"""

from __future__ import annotations

import base64
import io
import math
import re
import struct
import uuid
import wave
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol

EmotionTag = Literal["sweet_normal", "tsundere_refuse", "rage_spray", "lazy_yawn", "happy_rice"]
Viseme = Literal["closed", "wide", "round", "open", "teeth"]

EMOTION_PREFIXES: dict[str, EmotionTag] = {
    "[嘴甜常态]": "sweet_normal",
    "[傲娇反驳]": "tsundere_refuse",
    "[破防喷水]": "rage_spray",
    "[困倦摸鱼]": "lazy_yawn",
    "[干饭兴奋]": "happy_rice",
}

_PREFIX_RE = re.compile(r"^\s*\[([^\]]+)\]\s*")


@dataclass(frozen=True)
class EmotionVoiceProfile:
    """情绪参考音频（voice pack 单条）。"""

    emotion_tag: EmotionTag
    ref_audio_path: str
    ref_text: str
    ref_duration_ms: int = 5_000
    action_state: str = "idle"


@dataclass(frozen=True)
class TtsVoicePack:
    """音色包：5 组情绪参考音频的集合。"""

    voice_pack_id: str
    default_emotion_tag: EmotionTag
    profiles: tuple[EmotionVoiceProfile, ...]
    license_scope: str = "DEV_ONLY_NON_COMMERCIAL"

    def profile_for(self, emotion_tag: EmotionTag) -> EmotionVoiceProfile:
        for profile in self.profiles:
            if profile.emotion_tag == emotion_tag:
                return profile
        raise KeyError(f"音色包 {self.voice_pack_id} 未登记情绪：{emotion_tag}")


@dataclass(frozen=True)
class LipEnvelope:
    """口型包络：时间锚点 → viseme + 幅度。"""

    visemes: tuple[dict[str, Any], ...]
    total_duration_ms: int


@dataclass
class SynthesisResult:
    synth_id: str
    emotion_tag: EmotionTag
    ref_audio_path: str
    backend: str
    degraded: bool
    format: str
    duration_ms: int
    audio: bytes
    lip_envelope: LipEnvelope


class TtsBackend(Protocol):
    """推理后端接口（真实 GPT-SoVITS / 云端 TTS 均实现此协议）。"""

    name: str

    def synthesize(self, text: str, profile: EmotionVoiceProfile, sample_rate: int) -> bytes: ...


class StubLocalBackend:
    """本地后端 stub：确定性波形（无 torch 依赖），同参同输出。"""

    name = "local-gpt-sovits"

    def synthesize(self, text: str, profile: EmotionVoiceProfile, sample_rate: int) -> bytes:
        # 情绪影响基频与谐波结构：傲娇（高、紧）vs 困倦（低、缓）
        base_hz = {
            "sweet_normal": 320.0,
            "tsundere_refuse": 430.0,
            "rage_spray": 520.0,
            "lazy_yawn": 180.0,
            "happy_rice": 400.0,
        }.get(profile.emotion_tag, 300.0)
        return _render_wave(text, sample_rate, base_hz)


class StubCloudBackend:
    """云端后端 stub：模拟网络后端（音色略高，模拟云端模型差异）。"""

    name = "cloud-siliconflow"

    def synthesize(self, text: str, profile: EmotionVoiceProfile, sample_rate: int) -> bytes:
        return _render_wave(text, sample_rate, 360.0)


class FailingBackend:
    """故障注入后端：始终失败（用于验证降级链路）。"""

    name = "local-gpt-sovits"

    def synthesize(self, text: str, profile: EmotionVoiceProfile, sample_rate: int) -> bytes:
        raise RuntimeError("LOCAL_BACKEND_UNAVAILABLE")


@dataclass
class EmotionTtsRouter:
    """情绪感知 TTS 路由：本地优先 + 云端降级。"""

    voice_pack: TtsVoicePack
    local_backend: TtsBackend = field(default_factory=StubLocalBackend)
    cloud_backend: TtsBackend = field(default_factory=StubCloudBackend)
    sample_rate: int = 24_000

    def parse_emotion(self, text: str) -> tuple[EmotionTag, str]:
        """解析情绪前缀 → (emotionTag, 正文)；无前缀用默认情绪。"""
        match = _PREFIX_RE.match(text)
        if not match:
            return self.voice_pack.default_emotion_tag, text
        tag = match.group(1)
        for prefix, emotion in EMOTION_PREFIXES.items():
            if tag == prefix.strip("[]"):
                return emotion, text[match.end() :]
        return self.voice_pack.default_emotion_tag, text

    def synthesize(self, text: str) -> SynthesisResult:
        emotion, body = self.parse_emotion(text)
        profile = self.voice_pack.profile_for(emotion)

        degraded = False
        backend = self.local_backend
        try:
            audio = backend.synthesize(body, profile, self.sample_rate)
        except Exception:  # noqa: BLE001 —— 本地失败一律降级到云端（不打断对话）
            degraded = True
            backend = self.cloud_backend
            audio = backend.synthesize(body, profile, self.sample_rate)

        duration_ms = _duration_ms(body)
        envelope = build_lip_envelope(body, duration_ms)
        return SynthesisResult(
            synth_id=str(uuid.uuid4()),
            emotion_tag=emotion,
            ref_audio_path=profile.ref_audio_path,
            backend=backend.name,
            degraded=degraded,
            format="wav",
            duration_ms=duration_ms,
            audio=audio,
            lip_envelope=envelope,
        )

    def result_to_dict(self, result: SynthesisResult) -> dict[str, Any]:
        """转成与 shared-protocol TtsSynthesisResultSchema 对齐的字典（跨语言契约）。"""
        return {
            "synthId": result.synth_id,
            "emotionTag": result.emotion_tag,
            "refAudioPath": result.ref_audio_path,
            "backend": result.backend,
            "degraded": result.degraded,
            "format": result.format,
            "durationMs": result.duration_ms,
            "audioBase64": base64.b64encode(result.audio).decode("ascii"),
            "lipEnvelope": {
                "visemes": [dict(item) for item in result.lip_envelope.visemes],
                "totalDurationMs": result.lip_envelope.total_duration_ms,
            },
        }


def build_lip_envelope(text: str, duration_ms: int) -> LipEnvelope:
    """按音节生成口型包络：中文按字计，标点为停顿（closed）。"""
    visemes: list[dict[str, Any]] = []
    cursor = 0
    syllables = [ch for ch in text if not ch.isspace()]
    if not syllables:
        return LipEnvelope(visemes=(), total_duration_ms=duration_ms)

    per = max(1, duration_ms // len(syllables))
    openers = "aeiou"
    for index, ch in enumerate(syllables):
        if ch in "，。！？、,.!?;；：:":
            viseme = "closed"
            amplitude = 0.1
        elif ch in "bpmfv":
            viseme = "teeth"
            amplitude = 0.35
        elif ch in "uw":
            viseme = "round"
            amplitude = 0.6
        elif ch in openers:
            viseme = "wide"
            amplitude = 0.85
        else:
            viseme = "open"
            amplitude = 0.5
        visemes.append(
            {
                "viseme": viseme,
                "startMs": cursor,
                "durationMs": per,
                "amplitude": round(amplitude, 3),
            }
        )
        cursor += per
    return LipEnvelope(visemes=tuple(visemes), total_duration_ms=duration_ms)


def _duration_ms(text: str, ms_per_char: int = 220) -> int:
    chars = sum(1 for ch in text if not ch.isspace())
    return max(600, chars * ms_per_char)


def _render_wave(text: str, sample_rate: int, base_hz: float) -> bytes:
    """确定性波形渲染：音节调制振幅的正弦（stub 后端的语音替身）。"""
    duration_ms = _duration_ms(text)
    frames = max(1, int(sample_rate * duration_ms / 1000))
    syllables = [ch for ch in text if not ch.isspace()] or [" "]
    per = max(1, frames // len(syllables))
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        for i in range(frames):
            syllable_index = min(len(syllables) - 1, i // per)
            ch = syllables[syllable_index]
            # 音节起点的包络（起音 12ms 渐入）
            local = i % per
            envelope = min(1.0, local / max(1, int(sample_rate * 0.012)))
            # 音节类型微调基频：元音更亮、辅音更闷（stub 的拟真度）
            tone = 1.0 if ch in "aeiou" else 0.88
            value = int(9000 * envelope * math.sin(2 * math.pi * base_hz * tone * i / sample_rate))
            wav.writeframes(struct.pack("<h", value))
    return buffer.getvalue()
