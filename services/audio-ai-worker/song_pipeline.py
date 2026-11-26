"""点歌台原子能力服务（SPEC §3.4 的 Python 面）。

职责边界（重要）：
  - 本模块**只**提供重推理原子能力：Demucs v4 人声/伴奏分离、RVC v2 (RMVPE) 声线转换、
    ffmpeg 混音/拼接。**编排**（授权门禁 → 黑名单 → 缓存池 → 首切片预缓冲 → 后台补齐）
    在 TS 侧 `@workbench/voice-runtime` 的 `SongConsole`，本模块不重复实现。
  - 任一能力未就绪时返回 **501 + 具体缺口**，绝不返回占位音频冒充真唱（AGENTS.md §2.2 真实执行回执铁律）。
  - 推理一律通过外部可执行文件（demucs / rvc 命令行）调用，不在本服务内联 torch 推理，
    避免把 2GB+ 权重加载进常驻 TTS 进程。

真实可执行文件路径一律来自环境变量，不读取运行时可写脚本、不执行任意 Shell 拼接：
  WHALE_SONG_DEMUCS_BIN   默认 `demucs`
  WHALE_SONG_RVC_BIN      默认 `rvc`
  WHALE_SONG_FFMPEG_BIN   默认 `ffmpeg`
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

router = APIRouter(prefix="/api/song")

DEMUCS_BIN = os.environ.get("WHALE_SONG_DEMUCS_BIN", "demucs").strip() or "demucs"
RVC_BIN = os.environ.get("WHALE_SONG_RVC_BIN", "rvc").strip() or "rvc"
FFMPEG_BIN = os.environ.get("WHALE_SONG_FFMPEG_BIN", "ffmpeg").strip() or "ffmpeg"
RVC_MODEL_PATH = os.environ.get("WHALE_SONG_RVC_MODEL", "").strip()
RVC_INDEX_PATH = os.environ.get("WHALE_SONG_RVC_INDEX", "").strip()

CapabilityName = Literal["demucs", "rvc", "ffmpeg", "rmvpe"]


class SongCapability(BaseModel):
    """单个原子能力的真实就绪情况（只描述事实）。"""

    name: CapabilityName
    ready: bool
    detail: str
    hint: str = ""


class CapabilitiesResponse(BaseModel):
    capabilities: list[SongCapability]
    ready: bool
    missing: list[str] = Field(default_factory=list)


class SeparateRequest(BaseModel):
    sourceAudioPath: str
    outputDir: str
    model: str = "htdemucs"


class RenderSliceRequest(BaseModel):
    vocalPath: str
    accompanimentPath: str
    startMs: int = Field(ge=0)
    durationMs: int = Field(gt=0)
    outputPath: str
    pitchShiftSemitones: int = Field(default=0, ge=-12, le=12)
    indexRate: float = Field(default=0.75, ge=0.0, le=1.0)
    protectVoiceless: float = Field(default=0.33, ge=0.0, le=0.5)
    vocalGainDb: float = Field(default=0.0, ge=-12.0, le=12.0)
    accompanimentGainDb: float = Field(default=-3.0, ge=-24.0, le=6.0)


class ConcatRequest(BaseModel):
    slicePaths: list[str]
    outputPath: str


def _which(binary: str) -> str | None:
    """在 PATH 中定位可执行文件（不执行它）。"""
    return shutil.which(binary)


def _file_ready(path: str) -> bool:
    if not path.strip():
        return False
    p = Path(path)
    return p.exists() and p.is_file() and p.stat().st_size > 0


def probe_capabilities() -> CapabilitiesResponse:
    """真实探测四个原子能力；缺什么就说什么，不做乐观假设。"""
    caps: list[SongCapability] = []

    demucs_path = _which(DEMUCS_BIN)
    caps.append(
        SongCapability(
            name="demucs",
            ready=demucs_path is not None,
            detail=f"demucs 可执行（{demucs_path}）" if demucs_path else f"未找到 demucs（{DEMUCS_BIN}）",
            hint="" if demucs_path else "安装 demucs v4 并确保其命令行在 PATH 中",
        )
    )

    rvc_path = _which(RVC_BIN)
    model_ok = _file_ready(RVC_MODEL_PATH)
    rvc_detail = []
    if rvc_path is None:
        rvc_detail.append(f"未找到 rvc 可执行（{RVC_BIN}）")
    if not model_ok:
        rvc_detail.append("未配置 RVC 声线模型权重（WHALE_SONG_RVC_MODEL 为空或文件不存在）")
    caps.append(
        SongCapability(
            name="rvc",
            ready=rvc_path is not None and model_ok,
            detail="；".join(rvc_detail) if rvc_detail else f"rvc 可执行（{rvc_path}）+ 声线权重就绪",
            hint="" if rvc_path is not None and model_ok else "提供 .pth 声线模型与对应 .index 后设置 WHALE_SONG_RVC_MODEL / WHALE_SONG_RVC_INDEX",
        )
    )

    ffmpeg_path = _which(FFMPEG_BIN)
    caps.append(
        SongCapability(
            name="ffmpeg",
            ready=ffmpeg_path is not None,
            detail=f"ffmpeg 可执行（{ffmpeg_path}）" if ffmpeg_path else f"未找到 ffmpeg（{FFMPEG_BIN}）",
            hint="" if ffmpeg_path else "安装 ffmpeg（混音与拼接必需）",
        )
    )

    index_ok = _file_ready(RVC_INDEX_PATH)
    caps.append(
        SongCapability(
            name="rmvpe",
            ready=index_ok,
            detail="RMVPE 检索索引就绪" if index_ok else "未配置 .index 检索索引（WHALE_SONG_RVC_INDEX 为空或文件不存在）",
            hint="" if index_ok else "提供与 .pth 配套的 .index（音色还原度检索）",
        )
    )

    missing = [c.name for c in caps if not c.ready]
    return CapabilitiesResponse(capabilities=caps, ready=not missing, missing=missing)


@router.get("/capabilities", response_model=CapabilitiesResponse)
def capabilities() -> CapabilitiesResponse:
    """点歌台原子能力探测（供 TS 侧 SongConsole.probeCapabilities 消费）。"""
    return probe_capabilities()


def _run(cmd: list[str]) -> tuple[bool, str]:
    """执行外部命令（参数数组，不经 shell），返回 (是否成功, 输出摘要)。"""
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=1800, check=False)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return False, f"执行失败：{exc}"
    if proc.returncode != 0:
        tail = (proc.stderr or proc.stdout or "").strip().splitlines()[-3:]
        return False, f"退出码 {proc.returncode}：{' / '.join(tail)}"
    return True, "ok"


@router.post("/separate")
def separate(req: SeparateRequest) -> Any:
    """Demucs v4：分离人声与伴奏。不产出占位音频。"""
    caps = probe_capabilities()
    demucs_cap = next(c for c in caps.capabilities if c.name == "demucs")
    if not demucs_cap.ready:
        return JSONResponse(status_code=501, content={"error": demucs_cap.detail, "hint": demucs_cap.hint, "capability": "demucs"})
    if not _file_ready(req.sourceAudioPath):
        return JSONResponse(
            status_code=400,
            content={"error": f"源音频不存在或为空：{req.sourceAudioPath}", "capability": "demucs"},
        )
    out_dir = Path(req.outputDir)
    out_dir.mkdir(parents=True, exist_ok=True)
    demucs_out = out_dir / "demucs"
    ok, detail = _run(
        [
            DEMUCS_BIN,
            "--two-stems=vocals",
            "-n",
            req.model,
            "-o",
            str(demucs_out),
            req.sourceAudioPath,
        ]
    )
    if not ok:
        return JSONResponse(status_code=502, content={"error": f"Demucs 分离失败：{detail}", "capability": "demucs"})
    stem_dir = demucs_out / req.model / Path(req.sourceAudioPath).stem
    vocal = stem_dir / "vocals.wav"
    accompaniment = stem_dir / "no_vocals.wav"
    if not _file_ready(str(vocal)) or not _file_ready(str(accompaniment)):
        return JSONResponse(
            status_code=502,
            content={"error": f"Demucs 未产出预期分轨（{stem_dir}）", "capability": "demucs"},
        )
    return {"vocalPath": str(vocal), "accompanimentPath": str(accompaniment)}


@router.post("/render-slice")
def render_slice(req: RenderSliceRequest) -> Any:
    """RVC v2 (RMVPE)：人声切片声线转换 + 与伴奏混音。不产出占位音频。"""
    caps = probe_capabilities()
    rvc_cap = next(c for c in caps.capabilities if c.name == "rvc")
    if not rvc_cap.ready:
        return JSONResponse(status_code=501, content={"error": rvc_cap.detail, "hint": rvc_cap.hint, "capability": "rvc"})
    ffmpeg_cap = next(c for c in caps.capabilities if c.name == "ffmpeg")
    if not ffmpeg_cap.ready:
        return JSONResponse(
            status_code=501, content={"error": ffmpeg_cap.detail, "hint": ffmpeg_cap.hint, "capability": "ffmpeg"}
        )
    for label, path in (("人声切片", req.vocalPath), ("伴奏", req.accompanimentPath)):
        if not _file_ready(path):
            return JSONResponse(status_code=400, content={"error": f"{label}不存在或为空：{path}"})

    out_path = Path(req.outputPath)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    converted = out_path.with_suffix(".rvc.wav")
    ok, detail = _run(
        [
            RVC_BIN,
            "infer",
            "--input",
            req.vocalPath,
            "--output",
            str(converted),
            "--model",
            RVC_MODEL_PATH,
            *(["--index", RVC_INDEX_PATH] if RVC_INDEX_PATH else []),
            "--pitch",
            str(req.pitchShiftSemitones),
            "--index-rate",
            str(req.indexRate),
            "--protect",
            str(req.protectVoiceless),
        ]
    )
    if not ok:
        return JSONResponse(status_code=502, content={"error": f"RVC 声线转换失败：{detail}", "capability": "rvc"})
    if not _file_ready(str(converted)):
        return JSONResponse(status_code=502, content={"error": "RVC 未产出转换音频", "capability": "rvc"})

    start_s = req.startMs / 1000.0
    duration_s = req.durationMs / 1000.0
    ok, detail = _run(
        [
            FFMPEG_BIN,
            "-y",
            "-ss",
            f"{start_s:.3f}",
            "-t",
            f"{duration_s:.3f}",
            "-i",
            req.accompanimentPath,
            "-i",
            str(converted),
            "-filter_complex",
            f"[0:a]volume={req.accompanimentGainDb}dB[a0];[1:a]volume={req.vocalGainDb}dB[a1];[a0][a1]amix=inputs=2:duration=longest",
            "-c:a",
            "libvorbis",
            "-q:a",
            "5",
            str(out_path),
        ]
    )
    if not ok:
        return JSONResponse(status_code=502, content={"error": f"ffmpeg 混音失败：{detail}", "capability": "ffmpeg"})
    if not _file_ready(str(out_path)):
        return JSONResponse(status_code=502, content={"error": "混音未产出音频", "capability": "ffmpeg"})
    return {"audioPath": str(out_path), "durationMs": req.durationMs}


@router.post("/concat")
def concat(req: ConcatRequest) -> Any:
    """把多个切片无缝拼接为最终产物（ffmpeg concat demuxer）。"""
    caps = probe_capabilities()
    ffmpeg_cap = next(c for c in caps.capabilities if c.name == "ffmpeg")
    if not ffmpeg_cap.ready:
        return JSONResponse(
            status_code=501, content={"error": ffmpeg_cap.detail, "hint": ffmpeg_cap.hint, "capability": "ffmpeg"}
        )
    if not req.slicePaths:
        return JSONResponse(status_code=400, content={"error": "slicePaths 不能为空"})
    missing = [p for p in req.slicePaths if not _file_ready(p)]
    if missing:
        return JSONResponse(status_code=400, content={"error": f"切片文件缺失：{missing}"})

    out_path = Path(req.outputPath)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    list_file = out_path.with_suffix(".concat.txt")
    list_file.write_text(
        "\n".join(f"file '{Path(p).resolve()}'" for p in req.slicePaths) + "\n", encoding="utf-8"
    )
    ok, detail = _run(
        [FFMPEG_BIN, "-y", "-f", "concat", "-safe", "0", "-i", str(list_file), "-c:a", "libvorbis", "-q:a", "5", str(out_path)]
    )
    if not ok:
        return JSONResponse(status_code=502, content={"error": f"拼接失败：{detail}", "capability": "ffmpeg"})
    if not _file_ready(str(out_path)):
        return JSONResponse(status_code=502, content={"error": "拼接未产出音频", "capability": "ffmpeg"})
    duration_ms = _probe_duration_ms(out_path)
    return {"audioPath": str(out_path), "durationMs": duration_ms}


def _probe_duration_ms(path: Path) -> int:
    """用 ffprobe（若可用）读真实时长；读不到就如实返回 0，不编造。"""
    ffprobe = shutil.which("ffprobe")
    if ffprobe is None:
        return 0
    try:
        proc = subprocess.run(
            [ffprobe, "-v", "quiet", "-print_format", "json", "-show_format", str(path)],
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return 0
    if proc.returncode != 0:
        return 0
    try:
        payload = json.loads(proc.stdout)
        return int(float(payload["format"]["duration"]) * 1000)
    except (ValueError, KeyError, TypeError):
        return 0
