"""T-M2-02 情绪感知 TTS 路由测试（[SIMULATION]，无 torch 依赖）。"""

import base64
import io
import wave

from tts_engine.emotion_router import (
    EMOTION_PREFIXES,
    EmotionTtsRouter,
    EmotionVoiceProfile,
    FailingBackend,
    StubCloudBackend,
    StubLocalBackend,
    TtsVoicePack,
    build_lip_envelope,
)

PACK = TtsVoicePack(
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


def test_parse_emotion_prefixes() -> None:
    router = EmotionTtsRouter(voice_pack=PACK)
    emotion, body = router.parse_emotion("[傲娇反驳] 哼，本鱼才没有偷懒！")
    assert emotion == "tsundere_refuse"
    assert body == "哼，本鱼才没有偷懒！"
    # 无前缀 → 默认情绪 + 原文
    emotion, body = router.parse_emotion("普通一句话")
    assert emotion == "sweet_normal"
    assert body == "普通一句话"
    # 未知前缀 → 默认情绪 + 原文
    emotion, body = router.parse_emotion("[未知标签] 正文")
    assert emotion == "sweet_normal"
    assert body == "[未知标签] 正文"


def test_gate_tsundere_refuse_matches_correct_reference_audio() -> None:
    """门禁：传入 `[傲娇反驳]` 标签文本 → 正确匹配傲娇参考音频。"""
    router = EmotionTtsRouter(voice_pack=PACK)
    result = router.synthesize("[傲娇反驳] 哼，本鱼才没有偷懒！")
    assert result.emotion_tag == "tsundere_refuse"
    assert result.ref_audio_path == "ref/tsundere_refuse.wav"
    assert result.backend == "local-gpt-sovits"
    assert result.degraded is False


def test_gate_returns_valid_audio_stream() -> None:
    """门禁：返回有效音频流（非空、可解析 WAV、时长与正文匹配）。"""
    router = EmotionTtsRouter(voice_pack=PACK)
    result = router.synthesize("[傲娇反驳] 哼，本鱼才没有偷懒！")
    assert len(result.audio) > 0
    with wave.open(io.BytesIO(result.audio), "rb") as wav:
        assert wav.getframerate() == 24_000
        assert wav.getnframes() == int(24_000 * result.duration_ms / 1000)


def test_gate_returns_lip_envelope_consistent_with_duration() -> None:
    """门禁：返回口型包络（viseme 序列非空且与时长一致）。"""
    router = EmotionTtsRouter(voice_pack=PACK)
    result = router.synthesize("[傲娇反驳] 哼，本鱼才没有偷懒！")
    envelope = result.lip_envelope
    assert len(envelope.visemes) > 0
    assert envelope.total_duration_ms == result.duration_ms
    # 起始时间为 0 且连续推进
    assert envelope.visemes[0]["startMs"] == 0
    for previous, current in zip(envelope.visemes, envelope.visemes[1:]):
        assert current["startMs"] == previous["startMs"] + previous["durationMs"]
    # 标点为闭口停顿
    visemes = [item["viseme"] for item in envelope.visemes]
    assert "closed" in visemes


def test_lip_envelope_empty_text() -> None:
    envelope = build_lip_envelope("", 600)
    assert envelope.visemes == ()
    assert envelope.total_duration_ms == 600


def test_lip_envelope_viseme_selection_rules() -> None:
    envelope = build_lip_envelope("a我，", 300)
    visemes = [item["viseme"] for item in envelope.visemes]
    assert visemes[0] == "wide"  # a → 元音张口
    assert visemes[1] == "open"  # 我 → 辅音开口
    assert visemes[2] == "closed"  # ，→ 停顿闭口


def test_local_failure_degrades_to_cloud() -> None:
    router = EmotionTtsRouter(
        voice_pack=PACK,
        local_backend=FailingBackend(),
        cloud_backend=StubCloudBackend(),
    )
    result = router.synthesize("[破防喷水] 噗——")
    assert result.degraded is True
    assert result.backend == "cloud-siliconflow"
    assert result.ref_audio_path == "ref/rage_spray.wav"
    assert len(result.audio) > 0


def test_cloud_failure_propagates() -> None:
    router = EmotionTtsRouter(
        voice_pack=PACK,
        local_backend=FailingBackend(),
        cloud_backend=FailingBackend(),
    )
    try:
        router.synthesize("[破防喷水] 噗——")
    except RuntimeError as error:
        assert "LOCAL_BACKEND_UNAVAILABLE" in str(error)
    else:
        raise AssertionError("云端也失败时应向上抛错")


def test_result_to_dict_matches_contract_shape() -> None:
    router = EmotionTtsRouter(voice_pack=PACK)
    payload = router.result_to_dict(router.synthesize("[干饭兴奋] 开饭啦！"))
    assert payload["emotionTag"] == "happy_rice"
    assert payload["refAudioPath"] == "ref/happy_rice.wav"
    assert payload["format"] == "wav"
    assert payload["degraded"] is False
    assert base64.b64decode(payload["audioBase64"])
    assert payload["lipEnvelope"]["visemes"]
    assert payload["lipEnvelope"]["totalDurationMs"] == payload["durationMs"]


def test_unknown_emotion_profile_raises() -> None:
    # 已登记情绪可取到
    assert PACK.profile_for("sweet_normal").ref_audio_path == "ref/sweet_normal.wav"
    # 未登记情绪抛 KeyError（契约层拒绝，不静默回落）
    try:
        PACK.profile_for("unknown_emotion")  # type: ignore[arg-type]
    except KeyError:
        pass
    else:
        raise AssertionError("未登记情绪应抛 KeyError")
    # 五种情绪前缀全部有登记
    assert len(EMOTION_PREFIXES) == 5
    assert len(PACK.profiles) == 5


def test_stub_backends_are_deterministic() -> None:
    profile = PACK.profiles[0]
    backend = StubLocalBackend()
    assert backend.synthesize("测试", profile, 24_000) == backend.synthesize("测试", profile, 24_000)
