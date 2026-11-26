#!/usr/bin/env python3
"""同一指令多次合成的稳定性度量（时长 / 整体 RMS / F0 中位数）。

用途：回答「同一档情绪，十次像不像同一次」。只看三个客观量，不替人下听感结论：
  - 时长：wav 帧数 / 采样率，秒；
  - 整体 RMS：整段均方根，dBFS；
  - F0 中位数：40ms 帧 / 10ms  hop 的自相关基频，只统计浊音帧（归一化自相关峰值 ≥ 0.3 且
    帧能量高于最响帧 -40dB），Hz。

用法：
  python3 -I tools/scripts/voice-stability.py artifacts/tts-ab/mimo-tts-daily-consistency
  python3 -I tools/scripts/voice-stability.py <dir> --json

依赖 numpy（与 speaker-cosine.py 相同）。读数只对同一段文本、同一采样率的产物有意义；
不同文本/不同模型的绝对值不可横向比较。
"""
from __future__ import annotations

import argparse
import json
import math
import sys
import wave
from pathlib import Path

import numpy as np

FRAME_MS = 40.0
HOP_MS = 10.0
F0_MIN = 60.0
F0_MAX = 500.0
VOICED_CORR = 0.3
REL_ENERGY_FLOOR_DB = -40.0


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


def frame_f0(x: np.ndarray, sr: int) -> tuple[list[tuple[float, float]], list[float]]:
    """返回 ([(f0, 帧 RMS)] 浊音候选, 每帧 RMS 列表)。"""
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


def analyze(path: Path) -> dict[str, float | str | int]:
    x, sr = read_wav(path)
    duration_s = len(x) / sr if sr > 0 else 0.0
    rms = float(np.sqrt(np.mean(x * x))) if len(x) > 0 else 0.0
    rms_db = 20.0 * math.log10(rms) if rms > 0.0 else float("-inf")
    candidates, rms_list = frame_f0(x, sr)
    peak = max(rms_list) if rms_list else 0.0
    floor = peak * (10.0 ** (REL_ENERGY_FLOOR_DB / 20.0))
    # 自相关阈值之外再卡一道能量地板：安静帧的"基频"多半是噪声
    voiced = [f0 for f0, rms in candidates if rms > floor]
    return {
        "file": path.name,
        "sampleRate": sr,
        "durationS": round(duration_s, 4),
        "rmsDbfs": round(rms_db, 2) if math.isfinite(rms_db) else None,
        "f0MedianHz": round(float(np.median(voiced)), 2) if voiced else None,
        "f0Frames": len(voiced),
    }


def summarize(rows: list[dict[str, float | str | int | None]], key: str) -> dict[str, float] | None:
    vals = [float(r[key]) for r in rows if r.get(key) is not None]  # type: ignore[arg-type]
    if not vals:
        return None
    arr = np.array(vals)
    mean = float(arr.mean())
    std = float(arr.std(ddof=1)) if len(arr) > 1 else 0.0
    return {
        "mean": round(mean, 4),
        "std": round(std, 4),
        "min": round(float(arr.min()), 4),
        "max": round(float(arr.max()), 4),
        # CV 取绝对值做分母：RMS 用 dBFS 表示时均值是负数，直接除会得到负 CV
        "cv": round(std / abs(mean), 4) if mean != 0 else 0.0,
        "n": len(arr),
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="同一指令多次合成的时长 / RMS / F0 离散度")
    ap.add_argument("dir", type=Path, help="含 wav 的目录（bench --consistency 的产物）")
    ap.add_argument("--json", action="store_true", help="输出 JSON 而不是 markdown")
    args = ap.parse_args()

    files = sorted(args.dir.glob("*.wav"))
    if not files:
        print(f"{args.dir} 下没有 wav", file=sys.stderr)
        return 2
    rows = [analyze(p) for p in files]
    summary = {k: summarize(rows, k) for k in ("durationS", "rmsDbfs", "f0MedianHz")}

    if args.json:
        print(json.dumps({"rows": rows, "summary": summary}, ensure_ascii=False, indent=2))
        return 0

    print(f"# {args.dir} · {len(rows)} 条\n")
    print("| 文件 | 时长 s | RMS dBFS | F0 中位 Hz | 浊音帧 |")
    print("| --- | --- | --- | --- | --- |")
    for r in rows:
        f0 = "—" if r["f0MedianHz"] is None else f"{r['f0MedianHz']:.2f}"
        rms = "—" if r["rmsDbfs"] is None else f"{r['rmsDbfs']:.2f}"
        print(f"| {r['file']} | {r['durationS']:.3f} | {rms} | {f0} | {r['f0Frames']} |")
    print("\n| 指标 | 均值 | 标准差 | 最小 | 最大 | CV |")
    print("| --- | --- | --- | --- | --- | --- |")
    for key, label in (("durationS", "时长 s"), ("rmsDbfs", "RMS dBFS"), ("f0MedianHz", "F0 中位 Hz")):
        s = summary[key]
        if s is None:
            print(f"| {label} | — | — | — | — | — |")
            continue
        print(f"| {label} | {s['mean']} | {s['std']} | {s['min']} | {s['max']} | {s['cv']} |")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
