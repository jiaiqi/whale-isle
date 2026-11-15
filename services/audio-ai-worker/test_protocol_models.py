"""T-M0-02 契约单测——"夹具双侧 probe"纪律的 Python 侧（TS 侧见 index.spec.ts）。

夹具与 TS 侧共享同一份 fixtures/blue-whale-maid.json，确保跨语言契约不漂移。
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from protocol_models import DiningProfilePreset, NormalizedLiveEvent, PetPersonaConfig
from pydantic import ValidationError

FIXTURE = (
    Path(__file__).resolve().parents[2]
    / "packages"
    / "shared-protocol"
    / "fixtures"
    / "blue-whale-maid.json"
)


def test_persona_fixture_roundtrip() -> None:
    """蓝鲸女仆夹具可通过 Pydantic 校验且默认值落位（与 TS 断言一致）。"""
    persona = PetPersonaConfig.model_validate(json.loads(FIXTURE.read_text(encoding="utf-8")))
    assert persona.id == "blue-whale-maid"
    assert persona.ownerTitles == ["鱼片", "主人"]
    assert persona.innerVoiceConfig.thinkTagName == "think"
    assert persona.reflexRules[0].cooldownMs == 8000
    assert persona.riceBowl.lowRiceWarningRatio == 0.15
    assert persona.voiceProfile.rvcIndexRate == 0.75
    assert persona.licenseScope == "DEV_ONLY_NON_COMMERCIAL"


def test_persona_rejects_bad_action_state() -> None:
    """非法 actionState 拒绝（雷区规则 actionState 枚举强校验）。"""
    data = json.loads(FIXTURE.read_text(encoding="utf-8"))
    data["reflexRules"][0]["actionState"] = "fly"
    try:
        PetPersonaConfig.model_validate(data)
    except ValidationError:
        return
    raise AssertionError("非法 actionState 应被拒绝")


def test_normalized_live_event_defaults() -> None:
    """直播事件默认值：mergedCount=1 / grudgeTags=[] / intimacyScore=0。"""
    event = NormalizedLiveEvent.model_validate(
        {
            "eventId": "aaaaaaa1-2222-4333-8444-555555555555",
            "platform": "douyin",
            "eventType": "DANMAKU",
            "sender": {"uid": "u-1001", "nickname": "路过的鱼干"},
            "payload": {},
            "assignedPriority": "P1_CADENCE",
            "timestamp": 1700000000000,
        }
    )
    assert event.payload.mergedCount == 1
    assert event.sender.grudgeTags == []
    assert event.sender.intimacyScore == 0


def test_dining_profile_rejects_unknown_slot() -> None:
    """干饭套餐槽位键仅允许 6 个 WorkbenchRoleSlot。"""
    ok = DiningProfilePreset.model_validate(
        {
            "profileId": "DELUXE_LIVESTREAM",
            "displayName": "🍱 豪华直播档",
            "roleBindings": {"MAIN_PERSONA_BRAIN": "deepseek-official/deepseek-reasoner"},
        }
    )
    assert ok.profileId == "DELUXE_LIVESTREAM"
    try:
        DiningProfilePreset.model_validate(
            {
                "profileId": "DELUXE_LIVESTREAM",
                "displayName": "x",
                "roleBindings": {"HACK_SLOT": "x"},
            }
        )
    except ValidationError:
        return
    raise AssertionError("未知槽位键应被拒绝")
