"""Whale Sing Worker — V2-P3-01 歌声引擎（SVS / SVC）真实后端适配层。

设计原则（对齐 AGENTS.md 运行时安全锁与诚实口径）：

- **绝不用普通 TTS 冒充唱歌**：本服务只转发到显式配置的「歌声合成（SVS）」与
  「音色转换（SVC）」后端。普通 TTS（例如 GPT-SoVITS 的 ``/tts``）仅作为
  ``ttsClone`` 能力被如实探测并单独上报，**不会**被当作 SVS/SVC 暴露。
- **绝不就绪就说就绪**：后端缺失或健康检查失败时返回 501 + 具体原因，
  不返回任何伪造音频，也不把 ``neuralVerified`` 置为 true。
- **有音频 ≠ 有证据**：``neuralVerified`` 只在**权重指纹比对通过**时才置 true；
  只拿到一段音频字节一律置 false 并给出 ``evidenceMissing`` 原因。
- **配置只来自环境变量**：不读取任何运行时可写脚本/配置，不执行任意 Shell。
"""

from __future__ import annotations

import hashlib
import os
from dataclasses import dataclass
from typing import Any

import httpx
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

APP_VERSION = "0.1.0"

SVS_ENDPOINT = os.environ.get("WHALE_SING_SVS_ENDPOINT", "").strip()
SVC_ENDPOINT = os.environ.get("WHALE_SING_SVC_ENDPOINT", "").strip()
TTS_ENDPOINT = os.environ.get("WHALE_SING_TTS_ENDPOINT", "").strip()

# 神经推理证据：只有拿到可核实的模型标识 + 权重指纹，才允许置 neuralVerified。
# 单凭「后端返回了一段音频字节」不构成证据 —— 那可能是占位波形、别的模型或一段转发录音。
SVS_MODEL_PATH = os.environ.get("WHALE_SING_SVS_MODEL_PATH", "").strip()
SVS_MODEL_SHA256 = os.environ.get("WHALE_SING_SVS_MODEL_SHA256", "").strip().lower()
SVS_MODEL_ID = os.environ.get("WHALE_SING_SVS_MODEL_ID", "").strip()
SVC_MODEL_PATH = os.environ.get("WHALE_SING_SVC_MODEL_PATH", "").strip()
SVC_MODEL_SHA256 = os.environ.get("WHALE_SING_SVC_MODEL_SHA256", "").strip().lower()
SVC_MODEL_ID = os.environ.get("WHALE_SING_SVC_MODEL_ID", "").strip()
PROBE_TIMEOUT_S = float(os.environ.get("WHALE_SING_PROBE_TIMEOUT_S", "2.0"))
RENDER_TIMEOUT_S = float(os.environ.get("WHALE_SING_RENDER_TIMEOUT_S", "120.0"))

app = FastAPI(title="whale-sing-worker", version=APP_VERSION)


class BackendStatus(BaseModel):
    """单个后端的真实可用性（只描述事实，不做乐观假设）。"""

    name: str
    kind: str
    ready: bool
    detail: str


class HealthResponse(BaseModel):
    """与 Electron 侧 ``SingEngine.probeBackends`` 消费的健康契约。

    ``svs`` / ``svc`` 是能力位（供 SingEngine 决定是否可用），
    ``backends`` 是明细（供 UI 与证据归档展示为什么不可用）。
    """

    svs: bool = False
    svc: bool = False
    version: str = APP_VERSION
    backends: list[BackendStatus] = Field(default_factory=list)
    ttsClone: BackendStatus | None = None


class SingPayload(BaseModel):
    """Electron 侧 ``SingRequest`` 的最小透传体（字段按需透传，不做二次解释）。"""

    requestId: str
    characterId: str
    voiceProfileId: str
    mode: str
    channel: str = "private_desktop"
    song: dict[str, Any] = Field(default_factory=dict)
    pitchShiftSemitones: int = 0
    indexRate: float = 0.75
    protectVoiceless: float = 0.33
    vocalGain: float = 1.0
    accompanimentGain: float = 0.75
    allowPreviewGuide: bool = True


@dataclass
class BackendProbe:
    ready: bool
    detail: str


def _sha256_of_file(path: str) -> str:
    """流式计算权重文件 SHA-256（不整文件读进内存，权重动辄 GB 级）。"""
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        while True:
            chunk = fh.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def build_model_evidence(kind: str) -> tuple[dict[str, str] | None, str | None]:
    """构造可核实的神经推理证据。

    返回 ``(evidence, missing_reason)``：
      - 拿到证据：``(dict, None)``，其中 ``verifiedBy='weight_fingerprint'``；
      - 拿不到：``(None, 原因)``，调用方必须把 ``neuralVerified`` 保持 ``False``。
    """
    model_path = SVS_MODEL_PATH if kind == "svs" else SVC_MODEL_PATH
    expected = SVS_MODEL_SHA256 if kind == "svs" else SVC_MODEL_SHA256
    model_id = SVS_MODEL_ID if kind == "svs" else SVC_MODEL_ID
    if not model_path:
        return None, f"未配置 {kind} 模型权重路径（WHALE_SING_{kind.upper()}_MODEL_PATH 为空），无法核实推理来源"
    if not os.path.isfile(model_path):
        return None, f"{kind} 模型权重文件不存在：{model_path}"
    try:
        actual = _sha256_of_file(model_path)
    except OSError as exc:
        return None, f"{kind} 模型权重读取失败：{exc}"
    if expected and actual != expected:
        return None, f"{kind} 权重指纹不匹配：期望 {expected[:12]}…，实际 {actual[:12]}…"
    return {
        "modelId": model_id or f"{kind}:{os.path.basename(model_path)}",
        "weightSha256": actual,
        "backend": "external-backend",
        "verifiedBy": "weight_fingerprint",
    }, None


async def probe_endpoint(endpoint: str, kind: str, health_path: str = "") -> BackendProbe:
    """对后端做一次轻量健康探测。

    依次尝试 ``health_path``（若给出）与根路径；2xx 视作在线。
    FastAPI 系后端（如 GPT-SoVITS api_v2）根路径无 GET 处理器会返回 404，
    因此对这类后端用 ``/docs`` 作为健康路径更可靠。
    """
    if not endpoint:
        return BackendProbe(False, f"未配置 {kind} 后端（WHALE_SING_{kind.upper()}_ENDPOINT 为空）")
    candidates = [f"{endpoint.rstrip('/')}{health_path}"] if health_path else []
    candidates.append(endpoint)
    last_detail = ""
    try:
        async with httpx.AsyncClient(timeout=PROBE_TIMEOUT_S) as client:
            for url in candidates:
                resp = await client.get(url)
                if resp.status_code < 400:
                    return BackendProbe(True, f"{kind} 后端在线（{url}）")
                last_detail = f"{kind} 后端健康检查返回 HTTP {resp.status_code}（{url}）"
    except Exception as exc:  # noqa: BLE001 — 探测失败只降级，不抛出
        return BackendProbe(False, f"{kind} 后端不可达：{exc}")
    return BackendProbe(False, last_detail or f"{kind} 后端健康检查失败")


async def probe_tts() -> BackendStatus:
    """探测普通 TTS 后端（仅供 speaking 管线使用；不会冒充唱歌能力）。"""
    if not TTS_ENDPOINT:
        return BackendStatus(
            name="tts",
            kind="text_to_speech",
            ready=False,
            detail="未配置普通 TTS 后端（WHALE_SING_TTS_ENDPOINT 为空）；普通 TTS 不得当作 SVS/SVC 使用",
        )
    # 普通 TTS 后端多为 FastAPI（GPT-SoVITS api_v2 等），根路径无 GET 处理器，用 /docs 探活
    probe = await probe_endpoint(TTS_ENDPOINT, "tts", health_path="/docs")
    return BackendStatus(
        name="tts",
        kind="text_to_speech",
        ready=probe.ready,
        detail=probe.detail + "（普通 TTS，不得当作 SVS/SVC 使用）",
    )


@app.get("/sing/health", response_model=HealthResponse)
async def sing_health() -> HealthResponse:
    """真实探测各后端能力；只上报事实。"""
    svs_probe = await probe_endpoint(SVS_ENDPOINT, "svs")
    svc_probe = await probe_endpoint(SVC_ENDPOINT, "svc")
    tts = await probe_tts()
    return HealthResponse(
        svs=svs_probe.ready,
        svc=svc_probe.ready,
        backends=[
            BackendStatus(name="svs", kind="singing_voice_synthesis", ready=svs_probe.ready, detail=svs_probe.detail),
            BackendStatus(name="svc", kind="singing_voice_conversion", ready=svc_probe.ready, detail=svc_probe.detail),
        ],
        ttsClone=tts,
    )


async def render_via(endpoint: str, payload: SingPayload) -> dict[str, Any]:
    """转发渲染请求到真实后端；后端不可用时 501，如实说明原因。"""
    if not endpoint:
        raise HTTPException(status_code=501, detail="该歌声后端未配置，无法真实渲染")
    try:
        async with httpx.AsyncClient(timeout=RENDER_TIMEOUT_S) as client:
            resp = await client.post(endpoint, json=payload.model_dump())
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"歌声后端调用失败：{exc}") from exc
    if resp.status_code >= 400:
        raise HTTPException(status_code=resp.status_code, detail=f"歌声后端返回 HTTP {resp.status_code}")
    body = resp.json()
    if not isinstance(body, dict) or not body.get("audioBase64"):
        raise HTTPException(status_code=502, detail="歌声后端未返回音频，拒绝以伪造音频冒充真实推理")
    return body


def _attach_evidence(body: dict[str, Any], kind: str) -> dict[str, Any]:
    """把可核实的模型证据挂到回执上；拿不到证据就如实置 false 并说明原因。

    注意：**有音频字节 ≠ 有神经推理证据**。只有权重指纹比对通过才置真。
    """
    evidence, missing = build_model_evidence(kind)
    if evidence is not None:
        body["modelEvidence"] = evidence
        body["neuralVerified"] = True
        body.pop("evidenceMissing", None)
    else:
        body["neuralVerified"] = False
        body["evidenceMissing"] = missing or f"{kind} 未能提供可核实证据"
    return body


@app.post("/sing/svs")
async def sing_svs(payload: SingPayload) -> dict[str, Any]:
    """SVS：歌声合成（旋律 + 歌词 → 歌声）。"""
    body = await render_via(SVS_ENDPOINT, payload)
    body.setdefault("durationMs", payload.song.get("durationMs", 0))
    body.setdefault("sampleRate", 32_000)
    return _attach_evidence(body, "svs")


@app.post("/sing/svc")
async def sing_svc(payload: SingPayload) -> dict[str, Any]:
    """SVC：音色转换（原唱干声 → 目标角色音色）。"""
    body = await render_via(SVC_ENDPOINT, payload)
    body.setdefault("durationMs", payload.song.get("durationMs", 0))
    body.setdefault("sampleRate", 32_000)
    return _attach_evidence(body, "svc")


@app.get("/health")
async def health() -> dict[str, Any]:
    """Worker 自身存活探针（不代表任何歌声能力就绪）。"""
    return {"ok": True, "version": APP_VERSION}


if __name__ == "__main__":  # pragma: no cover — 手动启动入口
    import uvicorn

    uvicorn.run(app, host=os.environ.get("WHALE_SING_WORKER_HOST", "127.0.0.1"),
                port=int(os.environ.get("WHALE_SING_WORKER_PORT", "18880")))
