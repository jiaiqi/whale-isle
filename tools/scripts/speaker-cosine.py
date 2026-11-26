#!/usr/bin/env python3
"""[工具] 说话人嵌入余弦：把「音色一致性」量成一个数，不靠耳朵。

用途：同一段音色描述（VoiceDesign）连续生成 N 条音频后，检查它们是不是同一个人的声音。
做法：sherpa-onnx 说话人嵌入模型（3D-Speaker CAM++，中文 16k）+ 两两余弦相似度。

口径与限制（必须一起引用，别只报一个好数字）：
- 嵌入模型只衡量「音色/说话人」相似度，**不衡量情感是否到位、也不衡量好不好听**。
- 输入若不是 16 kHz，脚本用线性插值重采样到 16 kHz（不是专业重采样器），会带来极小偏差。
- 相关性判读靠**相对比较**：同一模型同一描述内部的分布 vs 跨描述/跨供应商的分布。
  绝对阈值（如 >0.8 算同一个人）只是经验参考，不是物理常数。

用法：
  python tools/scripts/speaker-cosine.py artifacts/tts-ab/mimo-voicedesign/*.wav
  python tools/scripts/speaker-cosine.py --model /tmp/speaker-emb/campplus.onnx dir-a/*.wav
退出码：0 正常；2 缺模型或没有可读 wav。
"""
from __future__ import annotations

import argparse
import itertools
import statistics
import sys
import wave
from pathlib import Path

import numpy as np

DEFAULT_MODEL = "/tmp/speaker-emb/campplus.onnx"
TARGET_RATE = 16_000


def read_wav(path: Path) -> tuple[np.ndarray, int]:
    with wave.open(str(path), "rb") as w:
        if w.getsampwidth() != 2:
            raise ValueError(f"{path.name}: 只支持 16-bit PCM")
        channels = w.getnchannels()
        rate = w.getframerate()
        raw = w.readframes(w.getnframes())
    data = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    if channels > 1:
        data = data.reshape(-1, channels).mean(axis=1)
    return data, rate


def resample_linear(samples: np.ndarray, src_rate: int, dst_rate: int) -> np.ndarray:
    if src_rate == dst_rate:
        return samples
    duration = len(samples) / src_rate
    n_out = int(round(duration * dst_rate))
    if n_out <= 0:
        return np.zeros(0, dtype=np.float32)
    src_idx = np.linspace(0.0, len(samples) - 1, num=n_out, dtype=np.float64)
    return np.interp(src_idx, np.arange(len(samples)), samples).astype(np.float32)


def cosine(a: np.ndarray, b: np.ndarray) -> float:
    na, nb = float(np.linalg.norm(a)), float(np.linalg.norm(b))
    if na == 0.0 or nb == 0.0:
        return float("nan")
    return float(np.dot(a, b) / (na * nb))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument(
        "--against",
        default=None,
        help="逐条与这个 wav 比（打印每条的余弦），用于「克隆输出 vs 设计版原样本」这类对照",
    )
    parser.add_argument("wavs", nargs="+")
    args = parser.parse_args()

    model_path = Path(args.model)
    if not model_path.exists():
        print(f"缺说话人嵌入模型：{model_path}", file=sys.stderr)
        print("下载（28 MB，Apache-2.0）：", file=sys.stderr)
        print(
            "  curl -L -o /tmp/speaker-emb/campplus.onnx "
            "https://github.com/k2-fsa/sherpa-onnx/releases/download/"
            "speaker-recongition-models/3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx",
            file=sys.stderr,
        )
        return 2

    paths = [Path(p) for p in args.wavs if Path(p).suffix.lower() == ".wav"]
    paths = [p for p in paths if p.exists()]
    if len(paths) < 2:
        print("至少需要 2 个 wav 才能算两两余弦", file=sys.stderr)
        return 2

    import sherpa_onnx  # 延迟导入：--help 不需要装依赖

    config = sherpa_onnx.SpeakerEmbeddingExtractorConfig(
        model=str(model_path), num_threads=args.threads, provider="cpu"
    )
    extractor = sherpa_onnx.SpeakerEmbeddingExtractor(config)

    names: list[str] = []
    embeddings: list[np.ndarray] = []
    for path in sorted(paths):
        samples, rate = read_wav(path)
        samples = resample_linear(samples, rate, TARGET_RATE)
        stream = extractor.create_stream()
        stream.accept_waveform(sample_rate=TARGET_RATE, waveform=samples)
        stream.input_finished()
        if not extractor.is_ready(stream):
            print(f"跳过 {path.name}：时长不足以提取嵌入", file=sys.stderr)
            continue
        names.append(path.name)
        embeddings.append(np.asarray(extractor.compute(stream), dtype=np.float32))

    if len(embeddings) < 2:
        print("可用嵌入少于 2 条，无法比较", file=sys.stderr)
        return 2

    if args.against is not None:
        against = Path(args.against)
        if against.name not in names:
            print(f"--against 的文件没进比较集合：{against}", file=sys.stderr)
            return 2
        idx = names.index(against.name)
        base = embeddings[idx]
        rows = [(name, cosine(base, emb)) for name, emb in zip(names, embeddings)]
        print(f"对照基准：{against.name}")
        for name, value in rows:
            print(f"  {name}: {value:.4f}")
        vals = [v for _, v in rows if not np.isnan(v)]
        if vals:
            print(f"余弦 均值 {statistics.fmean(vals):.4f} · 最小 {min(vals):.4f} · 最大 {max(vals):.4f} · "
                  f"标准差 {statistics.pstdev(vals):.4f}（n={len(vals)}）")
        print("（只反映音色/说话人相似度，不反映情感与听感）")
        return 0

    pairs = [
        (names[i], names[j], cosine(embeddings[i], embeddings[j]))
        for i, j in itertools.combinations(range(len(names)), 2)
    ]
    values = sorted(v for _, _, v in pairs if not np.isnan(v))
    print(f"样本 {len(names)} 条，两两组合 {len(pairs)} 对")
    print(f"余弦 均值 {statistics.fmean(values):.4f} · 中位 {statistics.median(values):.4f} · "
          f"最小 {values[0]:.4f} · 最大 {values[-1]:.4f} · 标准差 {statistics.pstdev(values):.4f}")
    print("（只反映音色/说话人相似度，不反映情感与听感）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
