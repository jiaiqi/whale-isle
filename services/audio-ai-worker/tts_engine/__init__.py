"""TTS 引擎包（T-M2-02）：情绪感知 TTS 混合路由。"""

from .emotion_router import (
    EMOTION_PREFIXES,
    PLACEHOLDER_REASON,
    EmotionTtsRouter,
    EmotionVoiceProfile,
    LipEnvelope,
    StubCloudBackend,
    StubLocalBackend,
    SynthesisResult,
    TtsBackend,
    TtsVoicePack,
    build_lip_envelope,
)

__all__ = [
    "EMOTION_PREFIXES",
    "PLACEHOLDER_REASON",
    "EmotionTtsRouter",
    "EmotionVoiceProfile",
    "LipEnvelope",
    "StubCloudBackend",
    "StubLocalBackend",
    "SynthesisResult",
    "TtsBackend",
    "TtsVoicePack",
    "build_lip_envelope",
]
