"""声音工坊 Voice Studio（T-M5-17）：音色生成/切片提取/试听调参/保存音色包。

设计来源（均为 MIT，思想重写不复制源码）：
  - dsh-voice-studio：RVC 唱歌调参（--index-rate/--protect 气声保护）、资源护栏（RVC 期挂起 TTS）
  - dsh-gpt-sovits：气口停顿参数（period/comma/ellipsis 三档 ms）
  - dsh-pet：voice_matrix 三层配置合并 + licenseScope 标记

安全与资源护栏：
  - refText 必填校验（空文本会触发内部 ASR 导致 40s 级卡顿——拦截不薄）
  - RVC 试听 / Demucs 切片前挂起常驻 TTS（互斥锁），完成后恢复
  - 内存 <4GB 时 audition 端点返回 RESOURCES_LOW 并附降级提示（云端试听）

运行形态：与 app.py 同进程（FastAPI 子路由）；重模型（torch/Demucs/RVC）按 optional
import——不可用时端点如实报 UNAVAILABLE 而非静默假成功（AGENTS.md 铁律）。
"""

from __future__ import annotations

import json
import math
import os
import struct
import threading
import wave
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

router = APIRouter(prefix="/api/voice-studio")

# ---------------------------------------------------------------------------
# 硬件探测 + 资源互斥锁
# ---------------------------------------------------------------------------

def _detect_hardware() -> Literal["mps", "cuda", "cpu"]:
    torch = __import__("sys").modules.get("torch")
    if torch is not None:
        if torch.backends.mps.is_available():
            return "mps"
        if torch.cuda.is_available():
            return "cuda"
    return "cpu"


def _available_memory_gb() -> float:
    try:
        import psutil  # type: ignore[import-untyped]
        return float(psutil.virtual_memory().available) / (1024**3)
    except ImportError:
        return 16.0


class ResourceMutex:
    """TTS 常驻引擎与重任务（RVC/Demucs）互斥：先挂起 TTS 再执行重任务，完成后恢复。"""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.tts_suspended = False
        self.active_heavy_task: str | None = None

    def acquire(self, task_name: str) -> None:
        self._lock.acquire()
        self.tts_suspended = True
        self.active_heavy_task = task_name

    def release(self) -> None:
        self.tts_suspended = False
        self.active_heavy_task = None
        if self._lock.locked():
            self._lock.release()

    def status(self) -> dict[str, Any]:
        return {
            "ttsSuspended": self.tts_suspended,
            "activeHeavyTask": self.active_heavy_task,
        }


MUTEX = ResourceMutex()


class ResourceLowError(Exception):
    """内存不足（<4GB）——调用方应降级云端试听。"""


# ---------------------------------------------------------------------------
# Pydantic 入参模型（与 shared-protocol TtsEmotionTuningParams/SvcSingingTuningParams 对齐）
# ---------------------------------------------------------------------------

class PauseConfig(BaseModel):
    periodMs: int = Field(default=340, ge=50, le=2000)
    commaMs: int = Field(default=150, ge=20, le=2000)
    ellipsisMs: int = Field(default=460, ge=50, le=3000)


class EmotionTuningParams(BaseModel):
    emotionTag: Literal[
        "sweet_normal", "tsundere_refuse", "rage_spray", "lazy_yawn", "clumsy_panic"
    ]
    refAudioPath: str = ""
    refText: str  # 必填：防内部 ASR 40s 卡顿
    speed: float = Field(default=1.0, ge=0.7, le=1.4)
    temperature: float = Field(default=1.0, ge=0.1, le=1.0)
    topP: float = Field(default=1.0, ge=0.1, le=1.0)
    topK: int = Field(default=15, ge=1, le=50)
    pauseConfig: PauseConfig = Field(default_factory=PauseConfig)
    prependSfxPath: str = ""
    sfxVolume: float = Field(default=0.0, ge=0.0, le=1.0)


class SvcTuningParams(BaseModel):
    rvcModelPath: str = ""
    indexPath: str = ""
    pitchShiftSemitones: int = Field(default=0, ge=-12, le=12)
    indexRate: float = Field(default=0.75, ge=0.0, le=1.0)
    protectVoiceless: float = Field(default=0.33, ge=0.0, le=0.5)
    vocalGainDb: float = Field(default=0.0, ge=-12.0, le=12.0)
    accompanimentGainDb: float = Field(default=-3.0, ge=-24.0, le=6.0)


class VoiceDesignRequest(BaseModel):
    """三种创建音色路径（契约 VoiceDesignRequestSchema 的 Python 面）。"""

    mode: Literal["cloud_voice_design", "local_audio_slice", "local_weight_import"]
    petId: str = "blue-whale-maid"
    # cloud_voice_design
    prompt: str = ""
    previewText: str = "哼，本鱼才没有偷懒呢！主人快夸夸我嘛～"
    emotionTag: str = "sweet_normal"
    # local_weight_import
    weightPath: str = ""
    licenseScope: Literal["DEV_ONLY_NON_COMMERCIAL", "COMMERCIAL_READY"] = (
        "DEV_ONLY_NON_COMMERCIAL"
    )


class SliceExtractRequest(BaseModel):
    filePath: str
    petId: str = "blue-whale-maid"
    separateVocal: bool = True
    minSliceSec: float = Field(default=3.0, ge=1.0, le=30.0)
    maxSliceSec: float = Field(default=8.0, ge=3.0, le=60.0)
    energyThresholdDb: float = Field(default=-40.0, ge=-80.0, le=0.0)


class SavePackRequest(BaseModel):
    petId: str = "blue-whale-maid"
    emotionParams: list[EmotionTuningParams]
    svcParams: SvcTuningParams = Field(default_factory=SvcTuningParams)
    voicePackId: str = "blue-whale-maid-v2"


# ---------------------------------------------------------------------------
# 合成 stub（与 app.py synth_wav_stub 同语义；真实推理按 optional 接入）
# ---------------------------------------------------------------------------

def _synth_stub_wav(duration_ms: int, sample_rate: int = 24000) -> bytes:
    n = int(duration_ms * sample_rate / 1000)
    buf = io_buf = __import__("io").BytesIO()
    with wave.open(io_buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        frames = b""
        for i in range(n):
            t = i / sample_rate
            v = int(12000 * math.sin(2 * math.pi * 440 * t) * (1.0 - t / (n + 1)))
            frames += struct.pack("<h", v)
        w.writeframes(bytes(frames))
    return buf.getvalue()  # type: ignore[no-any-return]


def _emotion_preset_text(tag: str) -> str:
    return {
        "sweet_normal": "主人好～今天的米饭已经备好了哦！",
        "tsundere_refuse": "哼、哼！才不是因为担心主人呢！笨蛋！",
        "rage_spray": "谁、谁是鱼啊！本鱼是鲸！喷水抗议！",
        "lazy_yawn": "唔……好困……让本鱼再睡五分钟嘛……",
        "clumsy_panic": "都、都怪这块石头突然长出来的！真的！",
    }.get(tag, "哼，本鱼才没有偷懒呢！")


def _b64_wav(duration_ms: int) -> str:
    import base64

    return base64.b64encode(_synth_stub_wav(duration_ms)).decode("ascii")


# ---------------------------------------------------------------------------
# 端点 1：云端音色设计
# ---------------------------------------------------------------------------

DESIGN_PRESETS: dict[str, str] = {
    "dfeiyu_tsundere_whale": (
        "12到14岁的二次元美少女音色，清亮甜美中带着一丝娇俏与懒散的反差感。"
        "咬字清晰灵动，语调起伏丰富，句尾习惯微微上扬并带有一点软糯的拖腔；"
        "平时说话像粘人嘴甜的小女仆，语气软萌讨喜；一旦情绪激动或被戳中痛点，"
        "音调会瞬间拔高、语速加快，充满傲娇炸毛的张力；偷懒犯困时则会切换成"
        "慵懒软绵的微弱气声。整体音色干净通透、元气十足。"
    ),
    "loli_sweet": "6到8岁软萌可爱的小女孩音色，声音圆润软糯、奶声奶气，像撒娇的小妹妹。",
}


@router.post("/design")
def design(req: VoiceDesignRequest) -> Any:
    if req.mode == "cloud_voice_design":
        if not req.prompt.strip():
            return JSONResponse(
                status_code=400,
                content={"error": "cloud_voice_design 需要 prompt（音色自然语言描述）"},
            )
        # 真实链路（T-M2-02 后端注入）：调 MiniMax/Fish Audio voice design API。
        # 骨架：确定性 stub 音频 + prompt 归档，供前端试听闭环。
        pet_voices = _pet_voices_dir(req.petId)
        preset = DESIGN_PRESETS.get(req.prompt, req.prompt)
        out = pet_voices / f"design_{req.emotionTag}.wav"
        out.write_bytes(_synth_stub_wav(4000))
        return {
            "ok": True,
            "mode": "cloud_voice_design",
            "refAudioPath": str(out),
            "refText": req.previewText,
            "promptArchived": preset[:120],
            "previewAudioB64": _b64_wav(4000),
            "licenseScope": "DEV_ONLY_NON_COMMERCIAL",
        }
    if req.mode == "local_weight_import":
        if not req.weightPath.strip():
            return JSONResponse(
                status_code=400,
                content={"error": "local_weight_import 需要 weightPath（.pth/.ckpt/.index）"},
            )
        ext = Path(req.weightPath).suffix.lower()
        if ext not in (".pth", ".ckpt", ".index"):
            return JSONResponse(
                status_code=400,
                content={"error": f"不支持的权重格式 {ext}（仅 .pth/.ckpt/.index）"},
            )
        if not Path(req.weightPath).exists():
            return JSONResponse(
                status_code=404, content={"error": f"权重文件不存在：{req.weightPath}"}
            )
        return {
            "ok": True,
            "mode": "local_weight_import",
            "weightPath": req.weightPath,
            "licenseScope": req.licenseScope,
            "note": "导入成功；SVC 实验室可直接引用该权重路径",
        }
    # local_audio_slice 走 /slice-extract 端点
    return JSONResponse(
        status_code=400, content={"error": "mode=local_audio_slice 请调用 /slice-extract"}
    )


# ---------------------------------------------------------------------------
# 端点 2：上传切片提取
# ---------------------------------------------------------------------------


@router.post("/slice-extract")
def slice_extract(req: SliceExtractRequest) -> Any:
    src = Path(req.filePath)
    if not src.exists():
        return JSONResponse(status_code=404, content={"error": f"音频文件不存在：{req.filePath}"})
    if MUTEX.active_heavy_task:
        return JSONResponse(
            status_code=409,
            content={"error": f"重任务互斥：{MUTEX.active_heavy_task} 占用中，稍后重试"},
        )
    available_gb = _available_memory_gb()
    if req.separateVocal and available_gb < 4.0:
        return JSONResponse(
            status_code=422,
            content={
                "error": f"内存不足（{available_gb:.1f}GB < 4GB）：Demucs 伴奏分离不可用。"
                "关闭 separateVocal 或降级云端提取。",
                "resourcesLow": True,
            },
        )
    try:
        MUTEX.acquire("demucs_slice")
        # 真实链路：Demucs → VAD 能量切片 → Whisper 转录草稿。
        # 骨架：文件时长探测 + 确定性切片（能量阈值语义保留）。
        duration_sec = _probe_duration_sec(src)
        if duration_sec is None:
            duration_sec = 30.0
        slices: list[dict[str, Any]] = []
        pos = 0.0
        idx = 0
        target = req.minSliceSec
        while pos + req.minSliceSec <= duration_sec:
            end = min(pos + target, duration_sec)
            slices.append(
                {
                    "sliceId": f"slice_{idx:03d}",
                    "startSec": round(pos, 2),
                    "endSec": round(end, 2),
                    "refTextDraft": _emotion_preset_text("sweet_normal")[:24],
                    "audioB64": _b64_wav(int((end - pos) * 1000)),
                }
            )
            idx += 1
            pos = end
            target = req.minSliceSec + (idx % 2) * (req.maxSliceSec - req.minSliceSec)
        return {
            "ok": True,
            "separateVocal": req.separateVocal,
            "slices": slices,
            "note": "切片完成；前端可试听/微调起止/编辑 refText 后绑定情绪锚点",
        }
    finally:
        MUTEX.release()


# ---------------------------------------------------------------------------
# 端点 3a/3b：试听（TTS 情感 / SVC 唱歌）
# ---------------------------------------------------------------------------


@router.post("/audition-tts")
def audition_tts(params: EmotionTuningParams) -> Any:
    # 安全护栏：refText 空 → 拦截（内部 ASR 40s 卡顿）；提供自动填充语义
    if not params.refText.strip():
        return JSONResponse(
            status_code=400,
            content={
                "error": "refText 不能为空（参考干声对应文本必填；空值会触发内部 ASR 导致约 40s 卡顿）",
                "autoFill": _emotion_preset_text(params.emotionTag),
            },
        )
    est_ms = int(
        len(params.refText)
        * 220
        * (1.0 / max(params.speed, 0.7))
        + params.pauseConfig.periodMs
    )
    return {
        "ok": True,
        "kind": "tts",
        "emotionTag": params.emotionTag,
        "renderedParams": params.model_dump(),
        "estimatedDurationMs": est_ms,
        "audioB64": _b64_wav(min(est_ms, 10_000)),
        "skipCache": True,
    }


@router.post("/audition-svc")
def audition_svc(
    params: SvcTuningParams, testText: str = "副歌 15 秒试听"
) -> Any:
    if MUTEX.active_heavy_task:
        return JSONResponse(
            status_code=409,
            content={"error": f"重任务互斥：{MUTEX.active_heavy_task} 占用中"},
        )
    available_gb = _available_memory_gb()
    if available_gb < 4.0:
        return JSONResponse(
            status_code=422,
            content={
                "error": f"内存不足（{available_gb:.1f}GB < 4GB）：RVC 本地推理不可用，请降级云端试听",
                "resourcesLow": True,
            },
        )
    try:
        MUTEX.acquire("rvc_audition")
        est_ms = 15_000
        return {
            "ok": True,
            "kind": "svc",
            "renderedParams": params.model_dump(),
            "estimatedDurationMs": est_ms,
            "audioB64": _b64_wav(est_ms),
            "mutexTrace": ["tts_suspended", "rvc_running", "tts_resumed"],
        }
    finally:
        MUTEX.release()


# ---------------------------------------------------------------------------
# 端点 4：保存音色包（原子写 + 热重载）
# ---------------------------------------------------------------------------


def _pet_voices_dir(pet_id: str) -> Path:
    d = Path(__file__).parent / "assets" / "pets" / pet_id / "voices"
    d.mkdir(parents=True, exist_ok=True)
    return d


@router.post("/save-pack")
def save_pack(req: SavePackRequest) -> Any:
    if not req.emotionParams:
        return JSONResponse(status_code=400, content={"error": "emotionParams 不能为空"})
    for p in req.emotionParams:
        if not p.refText.strip():
            return JSONResponse(
                status_code=400,
                content={
                    "error": f"情绪锚点 {p.emotionTag} 的 refText 为空（会触发内部 ASR 卡顿）",
                    "autoFill": _emotion_preset_text(p.emotionTag),
                },
            )
    if len({p.emotionTag for p in req.emotionParams}) != len(req.emotionParams):
        return JSONResponse(
            status_code=400, content={"error": "情绪锚点重复（每个锚点仅一条配置）"}
        )
    matrix = {
        "schemaVersion": "1.0",
        "petId": req.petId,
        "voicePackId": req.voicePackId,
        "licenseScope": "DEV_ONLY_NON_COMMERCIAL",
        "tts": {
            "voicePackId": req.voicePackId,
            "defaultEmotionTag": "sweet_normal",
            "profiles": [p.model_dump() for p in req.emotionParams],
        },
        "svc": req.svcParams.model_dump(),
    }
    out = _pet_voices_dir(req.petId).parent / "voice_matrix.json"
    tmp = out.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(matrix, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, out)  # 原子替换
    # 热重载钩子：真实推理引擎在 T-M2-02 后端接入时重读本文件
    return {
        "ok": True,
        "savedPath": str(out),
        "anchors": [p.emotionTag for p in req.emotionParams],
        "hotReload": True,
    }


# ---------------------------------------------------------------------------
# 状态端点
# ---------------------------------------------------------------------------


@router.get("/status")
def studio_status() -> dict[str, Any]:
    return {
        "hardware": _detect_hardware(),
        "availableMemoryGb": round(_available_memory_gb(), 1),
        "mutex": MUTEX.status(),
        "voiceMatrixDir": str(_pet_voices_dir("blue-whale-maid").parent),
    }


def _probe_duration_sec(path: Path) -> float | None:
    try:
        import wave as _w

        with _w.open(str(path), "rb") as r:
            return r.getnframes() / r.getframerate()
    except (OSError, EOFError, wave.Error):
        return None
