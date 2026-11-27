#!/usr/bin/env python3
"""情绪矩阵分析：跨档 vs 档内（说话人余弦 + 韵律特征距离）。

配套 `tools/scripts/emotion-matrix.mts` 的产物目录（`armA/` / `armB/` / `armC/`，
每臂 5 档情绪 × N 条）。判据写在 `docs/v2/evidence/mimo-tts-candidate-integration.md`
§2.16.1，**先注册后跑**，这里只负责把数字算出来，不做判定。

两个距离口径，各有分工，谁都不能替谁下结论：

1. **说话人余弦**（sherpa-onnx CAM++）：编码的是音色/说话人，**对情绪不敏感**。
   跨档余弦显著低于档内 → 说明参考音频把「说话人」都换掉了（可能是情绪带来的连带效果，
   也可能是参考音频本身的音色漂移），不能单独用来论证情绪。
2. **韵律特征距离**（MFCC-13 + F0 统计 + 时长 + RMS + 频谱质心，z-score 后欧氏距离）：
   显式含 F0 / 能量 / 频谱形状，对情绪敏感，是「情绪是否真的被锁住」的主口径。

同一套距离同时算「档内」（同情绪档内两两）与「跨档」（不同情绪档之间两两），
两者的比值/差值才是判据要的东西。

用法：
  python3 -I tools/scripts/emotion-matrix-analysis.py artifacts/tts-ab/emotion-matrix-12-hanhan-difa
  python3 -I tools/scripts/emotion-matrix-analysis.py <dir> --json

依赖 numpy + sherpa-onnx（与 speaker-cosine.py 相同）。说话人嵌入模型默认在
/tmp/speaker-emb/campplus.onnx，缺失时只跳过余弦口径、韵律口径照常给。
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import math
import sys
import wave
from pathlib import Path

import numpy as np

REPO_ROOT = Path(__file__).resolve().parents[2]
EMBED_MODEL = "/tmp/speaker-emb/campplus.onnx"
TARGET_RATE = 16_000

# ── 韵律特征参数（与 voice-stability.py 保持同一套 F0/RMS 口径，便于交叉引用）──
FRAME_MS = 40.0
HOP_MS = 10.0
F0_MIN = 60.0
F0_MAX = 500.0
VOICED_CORR = 0.3
REL_ENERGY_FLOOR_DB = -40.0
MFCC_FRAME_MS = 25.0
MFCC_HOP_MS = 10.0
N_MFCC = 13
N_MEL = 26


def load_speaker_cosine_module():
    """复用 speaker-cosine.py 的嵌入提取（它带连字符，不能直接 import）。"""
    path = REPO_ROOT / "tools" / "scripts" / "speaker-cosine.py"
    spec = importlib.util.spec_from_file_location("speaker_cosine", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def read_wav(path: Path) -> tuple[np.ndarray, int]:
    with wave.open(str(path), "rb") as wf:
        sr = wf.getframerate()
        channels = wf.getnchannels()
        width = wf.getsampwidth()
        raw = wf.readframes(wf.getnframes())
    if width == 2:
        data = np.frombuffer(raw, dtype="<i2").astype(np.float64) / 32768.0
    elif width == 4:
        data = np.frombuffer(raw, dtype="<i4").astype(np.float64) / 2147483648.0
    elif width == 1:
        data = (np.frombuffer(raw, dtype=np.uint8).astype(np.float64) - 128.0) / 128.0
    else:
        raise ValueError(f"{path.name}: 不支持的采样位宽 {width * 8} bit")
    if channels > 1:
        data = data.reshape(-1, channels).mean(axis=1)
    return data, sr


def resample_linear(samples: np.ndarray, src_rate: int, dst_rate: int) -> np.ndarray:
    if src_rate == dst_rate:
        return samples
    duration = len(samples) / src_rate
    n_out = int(round(duration * dst_rate))
    if n_out <= 0:
        return np.zeros(0, dtype=np.float64)
    src_idx = np.linspace(0.0, len(samples) - 1, num=n_out, dtype=np.float64)
    return np.interp(src_idx, np.arange(len(samples)), samples).astype(np.float64)


def frame_f0(x: np.ndarray, sr: int) -> tuple[list[tuple[float, float]], list[float]]:
    frame = max(1, int(sr * FRAME_MS / 1000.0))
    hop = max(1, int(sr * HOP_MS / 1000.0))
    min_lag = max(1, int(sr / F0_MAX))
    max_lag = int(sr / F0_MIN)
    f0s: list[tuple[float, float]] = []
    rms_list: list[float] = []
    if len(x) < frame:
        return f0s, rms_list
    for start in range(0, len(x) - frame + 1, hop):
        seg = x[start : start + frame]
        rms = float(np.sqrt(np.mean(seg * seg)))
        rms_list.append(rms)
        if rms <= 0.0:
            continue
        seg = seg - float(np.mean(seg))
        corr = np.correlate(seg, seg, mode="full")[frame - 1 :]
        if corr[0] <= 0.0:
            continue
        corr = corr / corr[0]
        hi = min(max_lag, len(corr) - 1)
        if hi <= min_lag:
            continue
        window = corr[min_lag : hi + 1]
        lag = int(np.argmax(window)) + min_lag
        if corr[lag] < VOICED_CORR:
            continue
        f0s.append((sr / lag, rms))
    return f0s, rms_list


def hz_to_mel(f: np.ndarray | float) -> np.ndarray | float:
    return 2595.0 * np.log10(1.0 + np.asarray(f) / 700.0)


def mel_to_hz(m: np.ndarray | float) -> np.ndarray | float:
    return 700.0 * (10.0 ** (np.asarray(m) / 2595.0) - 1.0)


def mel_filterbank(sr: int, n_fft: int, n_mel: int = N_MEL) -> np.ndarray:
    f_min, f_max = 0.0, sr / 2.0
    m_min, m_max = hz_to_mel(f_min), hz_to_mel(f_max)
    m_points = m_min + np.linspace(0.0, m_max - m_min, n_mel + 2)
    f_points = mel_to_hz(m_points)
    bins = np.floor((n_fft + 1) * f_points / sr).astype(int)
    bins = np.clip(bins, 0, n_fft // 2)
    fb = np.zeros((n_mel, n_fft // 2 + 1), dtype=np.float64)
    for m in range(n_mel):
        left, center, right = bins[m], bins[m + 1], bins[m + 2]
        if center == left:
            center = min(left + 1, n_fft // 2)
        if right == center:
            right = min(center + 1, n_fft // 2)
        for k in range(left, center):
            fb[m, k] = (k - left) / max(1, center - left)
        for k in range(center, right):
            fb[m, k] = (right - k) / max(1, right - center)
    return fb


def dct_matrix(n_out: int, n_in: int) -> np.ndarray:
    """DCT-II（正交归一化），纯 numpy 实现，避免额外依赖。"""
    k = np.arange(n_out).reshape(-1, 1)
    n = np.arange(n_in).reshape(1, -1)
    basis = np.cos(np.pi * k * (2 * n + 1) / (2 * n_in))
    basis[0] *= 1.0 / math.sqrt(2.0)
    return basis * math.sqrt(2.0 / n_in)


def prosody_vector(path: Path) -> tuple[np.ndarray, dict[str, float | None]]:
    """韵律特征向量 + 三个客观读数（时长 / RMS / F0 中位）。"""
    x, sr = read_wav(path)
    duration_s = len(x) / sr if sr > 0 else 0.0
    rms = float(np.sqrt(np.mean(x * x))) if len(x) > 0 else 0.0
    rms_db = 20.0 * math.log10(rms) if rms > 0.0 else None

    candidates, rms_list = frame_f0(x, sr)
    peak = max(rms_list) if rms_list else 0.0
    floor = peak * (10.0 ** (REL_ENERGY_FLOOR_DB / 20.0))
    voiced = [f0 for f0, r in candidates if r > floor]
    f0_median = float(np.median(voiced)) if voiced else None

    # ── MFCC（显式频率轴，含高斯化 mel 滤波器组）──
    frame_len = max(1, int(sr * MFCC_FRAME_MS / 1000.0))
    hop_len = max(1, int(sr * MFCC_HOP_MS / 1000.0))
    emphasized = np.append(x[0], x[1:] - 0.97 * x[:-1]) if len(x) > 1 else x
    n_fft = 512
    window = np.hamming(frame_len)
    frames: list[np.ndarray] = []
    for start in range(0, max(1, len(emphasized) - frame_len + 1), hop_len):
        seg = emphasized[start : start + frame_len]
        if len(seg) < frame_len:
            break
        frames.append(seg * window)
    mfcc_mean = np.zeros(N_MFCC)
    mfcc_std = np.zeros(N_MFCC)
    centroid_mean = 0.0
    if len(frames) > 0:
        padded = np.array(frames)
        if padded.shape[0] < n_fft // 2:
            padded = np.pad(padded, ((0, n_fft // 2 - padded.shape[0]), (0, 0)))
        spectrum = np.abs(np.fft.rfft(padded, n=n_fft)) ** 2
        freqs = np.fft.rfftfreq(n_fft, 1.0 / sr)
        total = spectrum.sum(axis=1) + 1e-12
        centroid_mean = float(np.mean((spectrum * freqs).sum(axis=1) / total))
        fb = mel_filterbank(sr, n_fft)
        mel_energy = spectrum @ fb.T
        log_mel = np.log(mel_energy + 1e-10)
        coeffs = log_mel @ dct_matrix(N_MFCC, N_MEL).T
        mfcc_mean = coeffs.mean(axis=0)
        mfcc_std = coeffs.std(axis=0)

    # ── 特征向量：MFCC 均值/标准差 + F0 统计 + 时长 + RMS + 频谱质心 ──
    f0_arr = np.array(voiced, dtype=np.float64) if len(voiced) > 0 else np.array([0.0])
    f0_feats = np.array([
        float(np.median(f0_arr)),
        float(np.mean(f0_arr)),
        float(np.std(f0_arr)),
        float(np.percentile(f0_arr, 10)),
        float(np.percentile(f0_arr, 90)),
    ])
    energy_feats = np.array([
        rms_db if rms_db is not None else -100.0,
        float(np.std(rms_list)) if len(rms_list) > 0 else 0.0,
        duration_s,
        centroid_mean,
    ])
    vector = np.concatenate([mfcc_mean, mfcc_std, f0_feats, energy_feats])
    readings = {
        "durationS": round(duration_s, 4),
        "rmsDbfs": round(rms_db, 2) if rms_db is not None else None,
        "f0MedianHz": round(f0_median, 2) if f0_median is not None else None,
    }
    return vector, readings


def zscore_vectors(vectors: np.ndarray) -> np.ndarray:
    mean = vectors.mean(axis=0)
    std = vectors.std(axis=0)
    std[std == 0.0] = 1.0
    return (vectors - mean) / std


def collect_pairs(
    vectors: np.ndarray,
    labels: list[str],
) -> tuple[list[float], list[float]]:
    """返回 (档内距离列表, 跨档距离列表)。"""
    within: list[float] = []
    across: list[float] = []
    n = len(vectors)
    for i in range(n):
        for j in range(i + 1, n):
            dist = float(np.linalg.norm(vectors[i] - vectors[j]))
            if labels[i] == labels[j]:
                within.append(dist)
            else:
                across.append(dist)
    return within, across


def summarize(values: list[float]) -> dict[str, float | int | None]:
    if not values:
        return {"n": 0, "mean": None, "std": None, "min": None, "max": None}
    arr = np.array(values, dtype=np.float64)
    return {
        "n": len(values),
        "mean": round(float(arr.mean()), 4),
        "std": round(float(arr.std(ddof=0)), 4),
        "min": round(float(arr.min()), 4),
        "max": round(float(arr.max()), 4),
    }


def speaker_cosine_matrix(
    sc: object,
    files: list[Path],
) -> tuple[list[float], list[float]] | None:
    model_path = Path(EMBED_MODEL)
    if not model_path.exists():
        return None
    import sherpa_onnx  # 延迟导入

    config = sherpa_onnx.SpeakerEmbeddingExtractorConfig(
        model=str(model_path), num_threads=4, provider="cpu"
    )
    extractor = sherpa_onnx.SpeakerEmbeddingExtractor(config)
    embeddings: list[np.ndarray] = []
    labels: list[str] = []
    for path in files:
        samples, rate = read_wav(path)
        samples = resample_linear(samples, rate, TARGET_RATE).astype(np.float32)
        stream = extractor.create_stream()
        stream.accept_waveform(sample_rate=TARGET_RATE, waveform=samples)
        stream.input_finished()
        if not extractor.is_ready(stream):
            continue
        embeddings.append(np.asarray(extractor.compute(stream), dtype=np.float32))
        labels.append(path.stem.rsplit("-", 1)[0])
    if len(embeddings) < 2:
        return None
    within: list[float] = []
    across: list[float] = []
    for i in range(len(embeddings)):
        for j in range(i + 1, len(embeddings)):
            value = float(sc.cosine(embeddings[i], embeddings[j]))  # type: ignore[attr-defined]
            if labels[i] == labels[j]:
                within.append(value)
            else:
                across.append(value)
    return within, across


def refs_self_similarity(sc: object, ref_dir: Path) -> dict[str, object] | None:
    """参考集内部两两相似度：这套参考音频本身是不是同一个人？

    音色漂移基线。语音角色要求「五条情绪参考仍是同一个角色」，
    如果这套参考自己内部余弦就很低，说明按档参考会把角色音色也一起换掉（产品风险）。
    """
    files = sorted(ref_dir.glob("*.wav"))
    if len(files) < 2:
        return None
    model_path = Path(EMBED_MODEL)
    if not model_path.exists():
        return None
    import sherpa_onnx

    config = sherpa_onnx.SpeakerEmbeddingExtractorConfig(
        model=str(model_path), num_threads=4, provider="cpu"
    )
    extractor = sherpa_onnx.SpeakerEmbeddingExtractor(config)
    embeddings: list[np.ndarray] = []
    for path in files:
        samples, rate = read_wav(path)
        samples = resample_linear(samples, rate, TARGET_RATE).astype(np.float32)
        stream = extractor.create_stream()
        stream.accept_waveform(sample_rate=TARGET_RATE, waveform=samples)
        stream.input_finished()
        if not extractor.is_ready(stream):
            continue
        embeddings.append(np.asarray(extractor.compute(stream), dtype=np.float32))
    if len(embeddings) < 2:
        return None
    values: list[float] = []
    for i in range(len(embeddings)):
        for j in range(i + 1, len(embeddings)):
            values.append(float(sc.cosine(embeddings[i], embeddings[j])))  # type: ignore[attr-defined]
    return {"pairs": len(values), **summarize(values)}


def emotion_vs_neutral_wins(
    arm_dir: Path,
    emotion_refs: Path,
    neutral_refs: Path,
) -> dict[str, object] | None:
    """情绪参考 vs 中性参考：同一条克隆离哪条参考更近？

    这是**情绪特异性的判决**：
    - 对每条克隆，取它自己那一档的情绪参考（refs/<档>.wav）与同一档的中性参考
      （refs-neutral/<档>.wav），比谁更近；
    - 情绪参考胜出 = 这条克隆的情绪特征来自情绪参考，而不是「参考音频是谁都行」。

    中性参考是漂移对照：它和情绪参考同描述、同句、无情绪指令，唯一的差别是情绪指令。
    """
    files = sorted(arm_dir.glob("*.wav"))
    if not files:
        return None
    emotion_refs = {p.stem: p for p in emotion_refs.glob("*.wav")}
    neutral_refs = {p.stem: p for p in neutral_refs.glob("*.wav")}
    labels = [p.stem.rsplit("-", 1)[0] for p in files]
    if not all(label in emotion_refs and label in neutral_refs for label in labels):
        return None

    def vector_of(path: Path) -> np.ndarray:
        return prosody_vector(path)[0]

    emotion_vecs = {k: vector_of(v) for k, v in emotion_refs.items()}
    neutral_vecs = {k: vector_of(v) for k, v in neutral_refs.items()}
    all_vecs = np.array(list(emotion_vecs.values()) + list(neutral_vecs.values()))
    mean, std = all_vecs.mean(axis=0), all_vecs.std(axis=0)
    std[std == 0.0] = 1.0

    def z(vec: np.ndarray) -> np.ndarray:
        return (vec - mean) / std

    emotion_z = {k: z(v) for k, v in emotion_vecs.items()}
    neutral_z = {k: z(v) for k, v in neutral_vecs.items()}

    f0_emotion = {k: float(prosody_vector(v)[1]["f0MedianHz"] or 0.0) for k, v in emotion_refs.items()}
    f0_neutral = {k: float(prosody_vector(v)[1]["f0MedianHz"] or 0.0) for k, v in neutral_refs.items()}

    prosody_wins = 0
    f0_wins = 0
    for path, label in zip(files, labels):
        clone_z = z(prosody_vector(path)[0])
        d_emotion = float(np.linalg.norm(clone_z - emotion_z[label]))
        d_neutral = float(np.linalg.norm(clone_z - neutral_z[label]))
        if d_emotion < d_neutral:
            prosody_wins += 1
        clone_f0 = float(prosody_vector(path)[1]["f0MedianHz"] or 0.0)
        if abs(clone_f0 - f0_emotion[label]) < abs(clone_f0 - f0_neutral[label]):
            f0_wins += 1
    return {
        "clones": len(files),
        "prosodyCloserToEmotionRef": prosody_wins,
        "f0CloserToEmotionRef": f0_wins,
    }


def reference_alignment(
    arm_dir: Path,
    ref_dir: Path,
) -> dict[str, object] | None:
    """参考对齐测试：每条克隆最像哪一条参考？

    两条距离各问一件事：
    - **F0 对齐**：克隆的基频中位数最接近自己那条参考？（情绪的韵律特征被继承了吗）
    - **韵律距离对齐**：z-score 后最接近自己那条参考？

    返回 top-1 命中率（自己的参考排第一）与 top-2 命中率。命中率高 = 情绪确实由
    那条参考带进来了，而不是所有档听起来都一样。
    """
    files = sorted(arm_dir.glob("*.wav"))
    ref_files = sorted(ref_dir.glob("*.wav"))
    if not files or len(ref_files) < 2:
        return None
    ref_labels = [p.stem for p in ref_files]
    ref_vecs: list[np.ndarray] = []
    ref_f0: list[float] = []
    for path in ref_files:
        vector, reading = prosody_vector(path)
        ref_vecs.append(vector)
        ref_f0.append(float(reading["f0MedianHz"] or 0.0))
    ref_matrix = zscore_vectors(np.array(ref_vecs))

    clone_vecs: list[np.ndarray] = []
    clone_f0: list[float] = []
    clone_labels: list[str] = []
    for path in files:
        vector, reading = prosody_vector(path)
        clone_vecs.append(vector)
        clone_f0.append(float(reading["f0MedianHz"] or 0.0))
        clone_labels.append(path.stem.rsplit("-", 1)[0])
    clone_matrix = zscore_vectors(np.array(clone_vecs))

    # z-score 的基准要用参考集，否则克隆与参考不同量纲
    joint = zscore_vectors(np.array(ref_vecs + clone_vecs))
    ref_matrix = joint[: len(ref_vecs)]
    clone_matrix = joint[len(ref_vecs) :]

    f0_hits = 0
    f0_top2 = 0
    dist_hits = 0
    dist_top2 = 0
    for idx, label in enumerate(clone_labels):
        own = ref_labels.index(label) if label in ref_labels else -1
        f0_order = sorted(range(len(ref_f0)), key=lambda i: abs(clone_f0[idx] - ref_f0[i]))
        dist_order = sorted(
            range(len(ref_vecs)),
            key=lambda i: float(np.linalg.norm(clone_matrix[idx] - ref_matrix[i])),
        )
        if own >= 0:
            if f0_order[0] == own:
                f0_hits += 1
            if own in f0_order[:2]:
                f0_top2 += 1
            if dist_order[0] == own:
                dist_hits += 1
            if own in dist_order[:2]:
                dist_top2 += 1
    n = len(clone_labels)
    return {
        "clones": n,
        "f0Top1": f0_hits,
        "f0Top2": f0_top2,
        "prosodyTop1": dist_hits,
        "prosodyTop2": dist_top2,
    }


def identity_retention(
    sc: object,
    arm_dir: Path,
    ref_dir: Path,
) -> dict[str, object] | None:
    """身份保持度：克隆和**自己那条参考**说话人有多像？和**别人那条参考**有多像？

    这条测的是「按档参考会不会把角色音色也换掉」：
    - 若 clone_i 对 ref_i 的余弦高、对 ref_j 的余弦低 → 五档是**五个不同的人**，
      情绪分开了，但角色身份没了（产品上是硬伤）；
    - 若两者都高 → 五档是同一个人不同情绪（这才是想要的结果）。
    """
    model_path = Path(EMBED_MODEL)
    if not model_path.exists():
        return None
    clones = sorted(arm_dir.glob("*.wav"))
    refs = sorted(ref_dir.glob("*.wav"))
    if not clones or len(refs) < 2:
        return None
    import sherpa_onnx

    config = sherpa_onnx.SpeakerEmbeddingExtractorConfig(
        model=str(model_path), num_threads=4, provider="cpu"
    )
    extractor = sherpa_onnx.SpeakerEmbeddingExtractor(config)

    def embed(path: Path) -> np.ndarray | None:
        samples, rate = read_wav(path)
        samples = resample_linear(samples, rate, TARGET_RATE).astype(np.float32)
        stream = extractor.create_stream()
        stream.accept_waveform(sample_rate=TARGET_RATE, waveform=samples)
        stream.input_finished()
        if not extractor.is_ready(stream):
            return None
        return np.asarray(extractor.compute(stream), dtype=np.float32)

    ref_emb = {p.stem: embed(p) for p in refs}
    ref_emb = {k: v for k, v in ref_emb.items() if v is not None}
    own: list[float] = []
    other: list[float] = []
    for path in clones:
        label = path.stem.rsplit("-", 1)[0]
        if label not in ref_emb:
            continue
        emb = embed(path)
        if emb is None:
            continue
        for key, ref in ref_emb.items():
            value = float(sc.cosine(emb, ref))  # type: ignore[attr-defined]
            if key == label:
                own.append(value)
            else:
                other.append(value)
    return {
        "toOwnRef": summarize(own),
        "toOtherRefs": summarize(other),
        "gap": round(float(np.mean(own) - np.mean(other)), 4) if own and other else None,
    }


def arm_ref_dir(arm: str, root: Path) -> Path | None:
    """每条臂用它自己那套参考音频（对齐测试必须对着它实际用的参考）。"""
    mapping = {
        'armB': root / 'refs',
        'armC': root / 'refs',
        'armD': root / 'refs-neutral',
        'armE': root / 'refs-daily',
        'armF': root / 'refs-2stage',
    }
    return mapping.get(arm)


def analyze_arm(arm_dir: Path, sc: object, ref_dir: Path | None) -> dict[str, object]:
    files = sorted(arm_dir.glob("*.wav"))
    if not files:
        return {"arm": arm_dir.name, "error": "没有 wav"}
    vectors: list[np.ndarray] = []
    labels: list[str] = []
    readings: list[dict[str, float | None]] = []
    for path in files:
        vector, reading = prosody_vector(path)
        vectors.append(vector)
        labels.append(path.stem.rsplit("-", 1)[0])
        readings.append(reading)
    matrix = zscore_vectors(np.array(vectors))
    within_dist, across_dist = collect_pairs(matrix, labels)
    cosine = speaker_cosine_matrix(sc, files)

    # 每档的客观读数（用于 M2：档间极差 vs 档内标准差）
    by_emotion: dict[str, list[dict[str, float | None]]] = {}
    for label, reading in zip(labels, readings):
        by_emotion.setdefault(label, []).append(reading)
    per_emotion: dict[str, dict[str, float | None]] = {}
    for emotion, rows in sorted(by_emotion.items()):
        entry: dict[str, float | None] = {}
        for key in ("durationS", "rmsDbfs", "f0MedianHz"):
            vals = [r[key] for r in rows if r.get(key) is not None]
            entry[f"{key}Mean"] = round(float(np.mean(vals)), 4) if vals else None
            entry[f"{key}Std"] = round(float(np.std(vals)), 4) if vals else None
            entry[f"{key}Min"] = round(float(np.min(vals)), 4) if vals else None
            entry[f"{key}Max"] = round(float(np.max(vals)), 4) if vals else None
        entry["n"] = len(rows)
        per_emotion[emotion] = entry

    spread: dict[str, float | None] = {}
    for key in ("durationS", "rmsDbfs", "f0MedianHz"):
        means = [v[f"{key}Mean"] for v in per_emotion.values() if v[f"{key}Mean"] is not None]
        stds = [v[f"{key}Std"] for v in per_emotion.values() if v[f"{key}Std"] is not None]
        if means:
            spread[f"{key}Range"] = round(float(np.max(means) - np.min(means)), 4)
            spread[f"{key}PooledStd"] = round(float(np.mean(stds)), 4) if stds else None
        else:
            spread[f"{key}Range"] = None
            spread[f"{key}PooledStd"] = None

    result: dict[str, object] = {
        "arm": arm_dir.name,
        "files": len(files),
        "prosodyDistance": {
            "within": summarize(within_dist),
            "across": summarize(across_dist),
        },
        "perEmotion": per_emotion,
        "spread": spread,
    }
    if cosine is not None:
        within_cos, across_cos = cosine
        result["speakerCosine"] = {"within": summarize(within_cos), "across": summarize(across_cos)}
    else:
        result["speakerCosine"] = None
    if ref_dir is not None:
        result["referenceAlignment"] = reference_alignment(arm_dir, ref_dir)
        result["identityRetention"] = identity_retention(sc, arm_dir, ref_dir)
    return result


def main() -> int:
    ap = argparse.ArgumentParser(description="情绪矩阵：跨档 vs 档内距离")
    ap.add_argument("dir", type=Path, help="emotion-matrix 的产物根目录（含 armA/armB/armC）")
    ap.add_argument("--json", action="store_true", help="输出 JSON")
    ap.add_argument("--refs-dir", type=Path, default=None, help="做参考对齐测试用的参考音频目录")
    ap.add_argument("--refs-neutral-dir", type=Path, default=None, help="中性参考（漂移对照）目录")
    args = ap.parse_args()

    sc = load_speaker_cosine_module()
    arms = sorted(p for p in args.dir.glob("arm*") if p.is_dir())
    if not arms:
        print(f"{args.dir} 下没有 arm* 子目录", file=sys.stderr)
        return 2
    results = [analyze_arm(arm, sc, arm_ref_dir(arm.name, args.dir)) for arm in arms]
    refs_summary: dict[str, object] = {}
    for name in ('refs', 'refs-neutral', 'refs-daily', 'refs-2stage'):
        directory = args.dir / name
        if directory.is_dir():
            refs_summary[name] = refs_self_similarity(sc, directory)
    if args.refs_dir is not None and args.refs_neutral_dir is not None:
        for r in results:
            arm_dir = args.dir / str(r["arm"])
            r["emotionVsNeutral"] = emotion_vs_neutral_wins(arm_dir, args.refs_dir, args.refs_neutral_dir)

    if args.json:
        print(json.dumps({"dir": str(args.dir), "refs": refs_summary, "arms": results}, ensure_ascii=False, indent=2))
        return 0

    print(f"# 情绪矩阵分析 · {args.dir}\n")
    if refs_summary:
        for key, value in refs_summary.items():
            if value:
                print(f"参考集自相似（{key}）：{value}")
        print()
    for r in results:
        if "error" in r:
            print(f"## {r['arm']}：{r['error']}\n")
            continue
        print(f"## 臂 {r['arm']}（{r['files']} 条）\n")
        print("| 口径 | 档内 | 跨档 |")
        print("| --- | --- | --- |")
        cos = r.get("speakerCosine")
        if cos:
            w, a = cos["within"], cos["across"]  # type: ignore[index]
            print(f"| 说话人余弦（越大越像） | 均值 {w['mean']}（n={w['n']}） | 均值 {a['mean']}（n={a['n']}） |")
        pd = r["prosodyDistance"]  # type: ignore[index]
        w, a = pd["within"], pd["across"]
        print(f"| 韵律特征距离（越小越像） | 均值 {w['mean']}（n={w['n']}） | 均值 {a['mean']}（n={a['n']}） |")
        print()
        print("| 档 | 条数 | 时长 s | RMS dBFS | F0 中位 Hz |")
        print("| --- | --- | --- | --- | --- |")
        for emotion, e in r["perEmotion"].items():  # type: ignore[union-attr]
            f0 = "—" if e["f0MedianHzMean"] is None else f"{e['f0MedianHzMean']:.2f}"
            rms = "—" if e["rmsDbfsMean"] is None else f"{e['rmsDbfsMean']:.2f}"
            print(f"| {emotion} | {e['n']} | {e['durationSMean']} | {rms} | {f0} |")
        evn = r.get("emotionVsNeutral")
        if evn:
            e = evn  # type: ignore[assignment]
            print(f"情绪参考 vs 中性参考（同一档内比）：更靠近情绪参考的比例 —— 韵律 "
                  f"{e['prosodyCloserToEmotionRef']}/{e['clones']} · F0 {e['f0CloserToEmotionRef']}/{e['clones']}")
        ident = r.get("identityRetention")
        if ident:
            i = ident  # type: ignore[assignment]
            print(f"身份保持度：对**自己**那条参考余弦 {i['toOwnRef']['mean']} · 对**别人**的参考 "
                  f"{i['toOtherRefs']['mean']} · 差 {i['gap']}")
        align = r.get("referenceAlignment")
        if align:
            a = align  # type: ignore[assignment]
            print(f"参考对齐（自己的参考排第几）：F0 top1 {a['f0Top1']}/{a['clones']} · top2 {a['f0Top2']}/{a['clones']}"
                  f" ｜ 韵律距离 top1 {a['prosodyTop1']}/{a['clones']} · top2 {a['prosodyTop2']}/{a['clones']}")
            print()
        sp = r["spread"]  # type: ignore[index]
        print()
        print(f"档间极差 vs 档内 σ：时长 {sp['durationSRange']} / σ {sp['durationSPooledStd']}"
              f" · RMS {sp['rmsDbfsRange']} / σ {sp['rmsDbfsPooledStd']}"
              f" · F0 {sp['f0MedianHzRange']} / σ {sp['f0MedianHzPooledStd']}")
        print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
