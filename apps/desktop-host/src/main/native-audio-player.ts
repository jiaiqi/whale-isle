/**
 * V2-P3-01 真实音频播放头接线：把 `tools/native/macos-audio-helper.swift`（AVAudioPlayer）
 * 编译成 `whale-audio-helper`，用 spawn 播放并**逐行读取真实播放位置**。
 *
 * 为什么不用 `afplay`：`afplay` 只回报进程退出，拿不到播放位置，歌词/口型只能靠墙钟推算。
 * 这里的位置来自 `AVAudioPlayer.currentTime`（设备时钟驱动的真实播放头），
 * 调用方据此驱动 `PerformanceDirector.tickClock()`，才算把 `positionMs` 接到真实播放位置。
 *
 * 安全与诚实口径：
 * - helper 源码在仓库内，首次使用时用系统 `swiftc` 编译到 userData 缓存（按源码 SHA-256 版本化，
 *   不进 Git、不随包分发二进制），调用一律参数数组、不走 shell。
 * - swiftc 缺失/编译失败 → 返回 `ok:false`，调用方回退 `afplay` 并如实标记 `realPlayhead=false`，
 *   绝不把墙钟推算冒充成真实播放头。
 * - helper 输出非法 JSON 或提前崩溃 → 结果按失败返回，不静默当成播放成功。
 */
import { spawn, spawnSync, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';

/** stdin 关闭、stdout/stderr 为管道的子进程（helper 只读 stdout 事件流） */
type AudioHelperChild = ChildProcessByStdio<null, Readable, Readable>;
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

const HELPER_SOURCE_NAME = 'macos-audio-helper.swift';

export interface NativeAudioHelperInfo {
  ok: boolean;
  helperPath?: string;
  reason?: string;
  /** 本次触发编译的耗时 */
  compileMs?: number;
}

/** 从 appPath 向上查找仓库根的 tools/native/macos-audio-helper.swift */
export function locateAudioHelperSource(appPath: string): string | null {
  let dir = appPath;
  for (let i = 0; i < 6; i += 1) {
    const candidate = join(dir, 'tools', 'native', HELPER_SOURCE_NAME);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** 确保 helper 二进制可用：源码 SHA-256 命中缓存则复用，否则调用 swiftc 编译 */
export function ensureNativeAudioHelper(options: {
  appPath: string;
  cacheDir: string;
  compile?: (source: string, out: string) => { ok: boolean; stderr?: string };
}): NativeAudioHelperInfo {
  if (process.platform !== 'darwin') return { ok: false, reason: 'unsupported_platform' };
  const source = locateAudioHelperSource(options.appPath);
  if (source === null) return { ok: false, reason: 'source_not_found' };

  const sourceHash = createHash('sha256').update(readFileSync(source)).digest('hex').slice(0, 16);
  const helperPath = join(options.cacheDir, `whale-audio-helper-${sourceHash}`);
  if (existsSync(helperPath) && statSync(helperPath).size > 0) return { ok: true, helperPath };

  mkdirSync(options.cacheDir, { recursive: true });
  const compile = options.compile ?? defaultCompile;
  const startedAt = Date.now();
  const result = compile(source, helperPath);
  if (!result.ok) return { ok: false, reason: `compile_failed: ${result.stderr ?? 'unknown'}` };
  return { ok: true, helperPath, compileMs: Date.now() - startedAt };
}

function defaultCompile(source: string, out: string): { ok: boolean; stderr?: string } {
  const r = spawnSync('swiftc', ['-O', '-o', out, source], { encoding: 'utf8', timeout: 120_000 });
  if (r.error) return { ok: false, stderr: String(r.error) };
  if (r.status !== 0) return { ok: false, stderr: (r.stderr ?? '').slice(0, 500) };
  return { ok: true };
}

export type AudioHelperEventType = 'started' | 'position' | 'ended' | 'stopped' | 'error' | 'probe';

export interface AudioHelperEvent {
  type: AudioHelperEventType;
  positionMs?: number;
  durationMs?: number;
  wallMs?: number;
  reason?: string;
}

/** 解析 helper 的一行 JSON；非法行返回 null（调用方只统计有效事件，不臆造位置） */
export function parseAudioHelperLine(line: string): AudioHelperEvent | null {
  const text = line.trim();
  if (text === '' || !text.startsWith('{')) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const type = record.type;
  if (
    type !== 'started' && type !== 'position' && type !== 'ended'
    && type !== 'stopped' && type !== 'error' && type !== 'probe'
  ) {
    return null;
  }
  const event: AudioHelperEvent = { type };
  if (typeof record.positionMs === 'number' && Number.isFinite(record.positionMs)) {
    event.positionMs = record.positionMs;
  }
  if (typeof record.durationMs === 'number' && Number.isFinite(record.durationMs)) {
    event.durationMs = record.durationMs;
  }
  if (typeof record.wallMs === 'number' && Number.isFinite(record.wallMs)) {
    event.wallMs = record.wallMs;
  }
  if (typeof record.reason === 'string' && record.reason !== '') event.reason = record.reason;
  return event;
}

export interface AudioPlaybackResult {
  ok: boolean;
  /** 真实播放头走到的最远位置（不是墙钟时长） */
  playedMs: number;
  /** 是否由真实播放头回报（helper 路径恒为 true；afplay 回退路径为 false） */
  realPlayhead: boolean;
  reason?: string;
}

export interface NativeAudioPlayer {
  play(input: {
    filePath: string;
    /** 只播到该位置即停（用于首切片试播/截断） */
    durationMs?: number;
    onPosition?: (positionMs: number) => void;
  }): Promise<AudioPlaybackResult>;
  stop(): void;
  /** 当前真实播放位置（未在播时为 null） */
  positionMs(): number | null;
  active(): boolean;
}

export interface CreateNativeAudioPlayerOptions {
  helperPath: string;
  /** 测试替身：默认 node:child_process.spawn */
  spawnImpl?: (cmd: string, args: string[]) => AudioHelperChild;
}

export function createNativeAudioPlayer(options: CreateNativeAudioPlayerOptions): NativeAudioPlayer {
  const spawnImpl = options.spawnImpl
    ?? ((cmd: string, args: string[]) => spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] }));
  let child: AudioHelperChild | null = null;
  let latestPosition: number | null = null;

  return {
    play({ filePath, durationMs, onPosition }) {
      return new Promise<AudioPlaybackResult>((resolve) => {
        if (child !== null) {
          resolve({ ok: false, playedMs: 0, realPlayhead: true, reason: '已有播放进行中' });
          return;
        }
        const args = ['play', filePath];
        if (typeof durationMs === 'number' && durationMs > 0) args.push('--duration-ms', String(Math.round(durationMs)));

        let maxPosition = 0;
        let errorReason: string | undefined;
        let sawEnded = false;
        let sawStopped = false;
        let durationFromHelper: number | undefined;
        let buffer = '';
        let settled = false;

        const finish = (ok: boolean, reason?: string): void => {
          if (settled) return;
          settled = true;
          child = null;
          latestPosition = null;
          resolve({
            ok,
            playedMs: Math.round(maxPosition),
            realPlayhead: true,
            ...(reason === undefined ? {} : { reason }),
          });
        };

        let spawned: AudioHelperChild;
        try {
          spawned = spawnImpl(options.helperPath, args);
        } catch (err) {
          resolve({
            ok: false,
            playedMs: 0,
            realPlayhead: true,
            reason: `helper 启动失败：${err instanceof Error ? err.message : String(err)}`,
          });
          return;
        }
        child = spawned;

        spawned.stdout.setEncoding('utf8');
        spawned.stdout.on('data', (chunk: string) => {
          buffer += chunk;
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            const event = parseAudioHelperLine(line);
            if (event === null) continue;
            if (event.type === 'position' && event.positionMs !== undefined) {
              maxPosition = Math.max(maxPosition, event.positionMs);
              latestPosition = event.positionMs;
              onPosition?.(event.positionMs);
            } else if (event.type === 'started' && event.durationMs !== undefined) {
              durationFromHelper = event.durationMs;
            } else if (event.type === 'ended') {
              sawEnded = true;
              if (event.positionMs !== undefined) maxPosition = Math.max(maxPosition, event.positionMs);
            } else if (event.type === 'stopped') {
              sawStopped = true;
              if (event.positionMs !== undefined) maxPosition = Math.max(maxPosition, event.positionMs);
            } else if (event.type === 'error') {
              errorReason = event.reason ?? 'helper 报错';
            }
          }
        });
        spawned.stderr.setEncoding('utf8');
        let stderrText = '';
        spawned.stderr.on('data', (chunk: string) => { stderrText += chunk; });

        spawned.on('error', (err: Error) => finish(false, `helper 启动失败：${err.message}`));
        spawned.on('close', (code: number | null) => {
          if (errorReason !== undefined) {
            finish(false, errorReason);
            return;
          }
          if (sawStopped) {
            finish(false, '播放被停止');
            return;
          }
          if (code === 0 && sawEnded) {
            // 截断播放（--duration-ms）时 helper 也报 ended，但真实时长以播放头为准
            finish(true);
            return;
          }
          const detail = stderrText.trim() === '' ? '' : `：${stderrText.trim().slice(0, 200)}`;
          const durationHint = durationFromHelper === undefined ? '' : `（文件时长 ${durationFromHelper}ms）`;
          finish(false, `helper 退出码 ${String(code)}${durationHint}${detail}`);
        });
      });
    },
    stop() {
      const running = child;
      if (running === null) return;
      try {
        running.kill('SIGTERM');
      } catch {
        /* 已退出 */
      }
    },
    positionMs() {
      return latestPosition;
    },
    active() {
      return child !== null;
    },
  };
}
