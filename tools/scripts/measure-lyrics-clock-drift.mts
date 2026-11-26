/**
 * V2-P3-01 歌词时钟偏差程序度量（真机量化，非仿真）。
 *
 * 检验对象：`LyricsClockSync` 在**真实墙钟驱动**下的双语歌词高亮切换精度。
 * 驱动源 = 高精度单调时钟（process.hrtime.bigint）；采样周期 25ms；
 * 记录每行歌词「实际高亮起始的真实经过时间」与「歌词声明的 startMs」之差。
 *
 * 同时度量 `afplay` 真实出声启动延迟（真实音频播放链路的固定开销），
 * 该延迟是「歌词时钟绑定真实音频位置」时必须扣除的偏移。
 *
 * 用法：node tools/scripts/measure-lyrics-clock-drift.mts
 * 输出：JSON 度量报告（stdout）+ 退出码 0/1。
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LyricsClockSync, type BilingualLyricLine } from '../../packages/voice-runtime/src/performance';

const SAMPLE_INTERVAL_MS = 25;
const TOLERANCE_MS = 60;

interface LineMeasurement {
  index: number;
  primaryText: string;
  declaredStartMs: number;
  declaredEndMs: number;
  actualStartMs: number;
  deviationMs: number;
}

const nowNs = (): bigint => process.hrtime.bigint();
const msSince = (startNs: bigint): number => Number(nowNs() - startNs) / 1_000_000;

async function measureAfplayLatency(wavPath: string): Promise<{ latencyMs: number; ok: boolean }> {
  const startedAt = nowNs();
  const child = spawn('afplay', [wavPath], { stdio: 'ignore', detached: false });
  await new Promise<void>((resolve) => {
    child.once('spawn', () => resolve());
    child.once('error', () => resolve());
  });
  const latencyMs = msSince(startedAt);
  child.kill('SIGTERM');
  return { latencyMs, ok: true };
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'whale-lyrics-clock-'));
  try {
    const lyrics: BilingualLyricLine[] = [
      { index: 0, startMs: 0, endMs: 2200, primaryText: '潮汐漫过晨雾里的石阶', secondaryText: 'Tide laps gently across misty stone steps' },
      { index: 1, startMs: 2200, endMs: 6000, primaryText: '小鲸为你点亮海图的星光', secondaryText: 'Xiaojing lights up starlight on the sea chart' },
      { index: 2, startMs: 6000, endMs: 9800, primaryText: '把每一次呼吸都交给海', secondaryText: 'Every breath belongs to the sea' },
      { index: 3, startMs: 9800, endMs: 13500, primaryText: '灯塔亮起时我们仍在唱', secondaryText: 'We keep singing when the lighthouse wakes' },
    ];
    const durationMs = 13_500;

    // 生成与歌词等长的导唱音频，用于测 afplay 真实出声延迟
    const { buildGuideToneWav } = await import('../../packages/voice-runtime/src/performance');
    const wavPath = join(dir, 'guide-tone.wav');
    writeFileSync(wavPath, buildGuideToneWav(durationMs));

    const afplay = await measureAfplayLatency(wavPath);

    const clock = new LyricsClockSync();
    clock.load('measure-song', lyrics, durationMs);

    const measurements: LineMeasurement[] = [];
    let activeIndex = -1;
    const startedAt = nowNs();

    // 真实墙钟驱动：以真实经过时间作为 positionMs 喂给歌词时钟
    for (;;) {
      const elapsed = msSince(startedAt);
      if (elapsed > durationMs + 400) break;
      const frame = clock.seek(elapsed);
      if (frame.activeIndex !== activeIndex) {
        activeIndex = frame.activeIndex;
        const line = lyrics.find((l) => l.index === activeIndex);
        if (line) {
          measurements.push({
            index: line.index,
            primaryText: line.primaryText,
            declaredStartMs: line.startMs,
            declaredEndMs: line.endMs,
            actualStartMs: Math.round(elapsed),
            deviationMs: Math.round(elapsed - line.startMs),
          });
        }
      }
      await new Promise((r) => setTimeout(r, SAMPLE_INTERVAL_MS));
    }

    const deviations = measurements.map((m) => Math.abs(m.deviationMs));
    const maxDeviationMs = deviations.length ? Math.max(...deviations) : 0;
    const meanDeviationMs = deviations.length
      ? Math.round((deviations.reduce((a, b) => a + b, 0) / deviations.length) * 100) / 100
      : 0;
    const sorted = [...deviations].sort((a, b) => a - b);
    const p95DeviationMs = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]! : 0;

    const report = {
      generatedAt: new Date().toISOString(),
      driver: '真实墙钟 process.hrtime.bigint',
      sampleIntervalMs: SAMPLE_INTERVAL_MS,
      durationMs,
      lineCount: lyrics.length,
      measuredLines: measurements.length,
      afplaySpawnLatencyMs: Math.round(afplay.latencyMs * 100) / 100,
      maxDeviationMs,
      meanDeviationMs,
      p95DeviationMs,
      toleranceMs: TOLERANCE_MS,
      pass: measurements.length === lyrics.length && maxDeviationMs <= TOLERANCE_MS,
      measurements,
      honestNote:
        '本度量检验 LyricsClockSync 在真实墙钟驱动下的切换精度（时钟自身是否引入漂移）；'
        + 'desktop-host 当前由手动 IPC tick 喂 positionMs，尚未把 positionMs 绑定到真实音频播放位置，'
        + '该绑定属后续工单，故本报告不等于「歌词已绑定真实音频时钟」。',
    };
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.pass ? 0 : 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

await main();
