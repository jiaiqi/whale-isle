#!/usr/bin/env python3
"""强度阶梯 A/B/C 的读数汇总（时长 / RMS / F0 中位），按「档 × 级」聚合并套用预注册判据。

判据与定义见 `docs/v2/evidence/mimo-tts-candidate-integration.md` §2.18.1（跑之前写死）：
  P1：Δ(ℓ, F0) ≥ 2·σ(ℓ, F0)
  P2：Δ(ℓ, 时长) ≥ 2·σ(ℓ, 时长) 且 Δ(ℓ, RMS) ≥ 2·σ(ℓ, RMS)
  该级成立 = P1 或 P2；三级至少一级成立 → 情绪在客观量上拉开。

用法：
  uv run --quiet --with numpy python -I tools/scripts/performance-ladder-summary.py artifacts/tts-ab/perform2-07-tiancui
"""
from __future__ import annotations

import json
import math
import statistics
import sys
from itertools import groupby
from pathlib import Path

import importlib.util

_here = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("voice_stability", _here / "voice-stability.py")
_vs = importlib.util.module_from_spec(_spec)
assert _spec.loader is not None
_spec.loader.exec_module(_vs)

PERFORMANCES = [("tiaopi", "调皮"), ("aojiao", "傲娇"), ("chajiao", "撒娇")]
LEVELS = ["A", "B", "C"]
METRICS = [("durationS", "时长 s"), ("rmsDbfs", "RMS dBFS"), ("f0MedianHz", "F0 中位 Hz")]

# §2.17 上一版（单级，每档 3 条）的均值，用于并排对照
PREVIOUS = {
    "tiaopi": {"durationS": 5.1733, "rmsDbfs": -23.9667, "f0MedianHz": 348.1867},
    "aojiao": {"durationS": 4.16, "rmsDbfs": -23.5333, "f0MedianHz": 335.8967},
    "chajiao": {"durationS": 4.3733, "rmsDbfs": -22.9067, "f0MedianHz": 335.34},
}


def main() -> int:
    root = Path(sys.argv[1] if len(sys.argv) > 1 else "artifacts/tts-ab/perform2-07-tiancui")
    manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    rows = manifest["rows"]

    cells: dict[tuple[str, str], list[dict]] = {}
    for row in sorted(rows, key=lambda r: (r["performance"], r["level"], r["i"])):
        if row.get("ok") is not True:
            continue
        readings = _vs.analyze(Path(row["file"]))
        cells.setdefault((row["performance"], row["level"]), []).append(
            {
                "file": row["file"],
                "durationS": float(readings["durationS"]),
                "rmsDbfs": float(readings["rmsDbfs"]),
                "f0MedianHz": float(readings["f0MedianHz"]),
                "tagsUsed": row.get("tagsUsed", []),
            }
        )

    def cell_stats(items: list[dict], metric: str) -> tuple[float, float]:
        values = [item[metric] for item in items]
        return statistics.mean(values), (statistics.pstdev(values) if len(values) > 1 else 0.0)

    summary: dict = {"root": str(root), "levels": {}, "criteria": {}}
    for level in LEVELS:
        level_block: dict = {"cells": {}, "delta": {}, "pooledStd": {}, "verdict": {}}
        for key, label in PERFORMANCES:
            items = cells.get((key, level), [])
            if not items:
                continue
            level_block["cells"][key] = {
                "label": label,
                "n": len(items),
                "tagsUsed": items[0]["tagsUsed"],
                **{
                    metric: {"mean": cell_stats(items, metric)[0], "std": cell_stats(items, metric)[1]}
                    for metric, _ in METRICS
                },
                "files": [item["file"] for item in items],
            }
        for metric, _ in METRICS:
            means = [level_block["cells"][key][metric]["mean"] for key, _ in PERFORMANCES if key in level_block["cells"]]
            stds = [level_block["cells"][key][metric]["std"] for key, _ in PERFORMANCES if key in level_block["cells"]]
            if len(means) < 3:
                continue
            delta = max(means) - min(means)
            pooled = math.sqrt(sum(s * s for s in stds) / len(stds))
            level_block["delta"][metric] = delta
            level_block["pooledStd"][metric] = pooled
            level_block["verdict"][f"{metric}:Δ>=2σ"] = delta >= 2 * pooled
        p1 = level_block["verdict"].get("f0MedianHz:Δ>=2σ", False)
        p2 = level_block["verdict"].get("durationS:Δ>=2σ", False) and level_block["verdict"].get("rmsDbfs:Δ>=2σ", False)
        level_block["verdict"]["P1"] = p1
        level_block["verdict"]["P2"] = p2
        level_block["verdict"]["holds"] = bool(p1 or p2)
        summary["levels"][level] = level_block

    summary["criteria"]["anyLevelHolds"] = any(block["verdict"].get("holds", False) for block in summary["levels"].values())
    summary["criteria"]["statement"] = "情绪在客观量上拉开了" if summary["criteria"]["anyLevelHolds"] else "客观量仍拉不开"

    # 与上一版并排
    summary["previousVersion"] = {}
    for metric, _ in METRICS:
        means = [PREVIOUS[key][metric] for key, _ in PERFORMANCES]
        summary["previousVersion"][metric] = max(means) - min(means)

    (root / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"# 强度阶梯汇总 · {root}\n")
    for level in LEVELS:
        block = summary["levels"].get(level)
        if block is None:
            continue
        print(f"## {level} 级")
        print("| 档 | n | 时长 s | RMS dBFS | F0 中位 Hz | 标签 |")
        print("| --- | --- | --- | --- | --- | --- |")
        for key, label in PERFORMANCES:
            cell = block["cells"].get(key)
            if cell is None:
                continue
            print(
                f"| {label} | {cell['n']} | {cell['durationS']['mean']:.2f}(σ{cell['durationS']['std']:.2f}) "
                f"| {cell['rmsDbfs']['mean']:.2f}(σ{cell['rmsDbfs']['std']:.2f}) "
                f"| {cell['f0MedianHz']['mean']:.1f}(σ{cell['f0MedianHz']['std']:.1f}) "
                f"| {', '.join(cell['tagsUsed']) or '—'} |"
            )
        for metric, label in METRICS:
            if metric not in block["delta"]:
                continue
            print(
                f"- {label}：Δ **{block['delta'][metric]:.2f}** vs 2σ {2 * block['pooledStd'][metric]:.2f}"
                f"（{'PASS' if block['verdict'][f'{metric}:Δ>=2σ'] else 'FAIL'}）"
            )
        print(f"- P1 {block['verdict']['P1']} · P2 {block['verdict']['P2']} → **{'成立' if block['verdict']['holds'] else '不成立'}**\n")
    print(f"结论：**{summary['criteria']['statement']}**")
    prev = summary["previousVersion"]
    print(
        f"上一版 Δ：时长 {prev['durationS']:.2f}s · RMS {prev['rmsDbfs']:.2f}dB · F0 {prev['f0MedianHz']:.1f}Hz"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
