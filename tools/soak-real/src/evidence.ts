/**
 * 现场包落盘（T-M6-67，RUNBOOK §1.5）。
 *
 * `artifacts/soak/<runId>/stuck/<序号>-<kind>/` 下 7 件：
 *   verdict.json / last50.jsonl / state.txt / planner.json / screen.png / save/（外加失败时的 *.err）
 *
 * 铁律：截图与存档拷贝失败只写 `.err` 说明，**绝不抛异常**——现场包不完整也得先保住判定证据。
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { StuckVerdict } from './stuck-detector';

export interface CaptureResult {
  ok: boolean;
  error?: string;
}

export type CaptureScreen = (file: string) => CaptureResult;
export type CopySave = (source: string, destination: string) => CaptureResult;

export interface EvidenceOptions {
  runDir: string;
  /** 存档目录（默认 ~/.config/StardewValley/Saves/泡泡湾_454908853）；null = 不拷贝 */
  saveDir?: string | null;
  captureScreen?: CaptureScreen;
  copySave?: CopySave;
}

export interface StuckPackInput {
  /** 从 1 开始的卡死序号 */
  index: number;
  verdict: StuckVerdict;
  /** 最近事件（按时间顺序；只取最后 50 条） */
  events: readonly unknown[];
  /** 判定瞬间的 get_state 原文 */
  stateText: string;
  /** planner.debugSnapshot() 结果 */
  planner: unknown;
  dayKey: string | null;
  clock: string | null;
}

export interface StuckPack {
  /** 相对 runDir 的现场目录（写进报告，保持可迁移） */
  dir: string;
  files: string[];
  errors: string[];
}

/**
 * macOS 全屏截图（screencapture -x 静音）；非 macOS 或失败返回错误说明，不抛异常。
 * `run`/`platform` 可注入，便于单测覆盖失败分支而不真的截屏。
 */
export function captureScreenWith(
  run: typeof spawnSync,
  file: string,
  platform: NodeJS.Platform = process.platform,
): CaptureResult {
  if (platform !== 'darwin') {
    return { ok: false, error: `screencapture 仅在 macOS 可用（当前 ${platform}）` };
  }
  try {
    const result = run('screencapture', ['-x', file], { encoding: 'utf8' });
    if (result.error) return { ok: false, error: result.error.message };
    if (result.status !== 0) {
      return { ok: false, error: (result.stderr || `screencapture 退出码 ${String(result.status)}`).trim() };
    }
    if (!existsSync(file)) return { ok: false, error: 'screencapture 返回成功但文件不存在' };
    return { ok: true };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

export const defaultCaptureScreen: CaptureScreen = (file) => captureScreenWith(spawnSync, file);

/** 递归拷贝存档目录；失败返回错误说明，不抛异常 */
export const defaultCopySave: CopySave = (source, destination) => {
  try {
    if (!existsSync(source)) return { ok: false, error: `存档目录不存在：${source}` };
    cpSync(source, destination, { recursive: true });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 建 run 目录（artifacts/soak/<runId>） */
export function createRunDir(rootDir: string, runId: string): string {
  const dir = join(rootDir, runId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeJsonFile(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/** 全量事件流：一行一条，带 ts/ISO 与原始事件 */
export function appendEventLine(file: string, event: unknown, now: number): void {
  appendFileSync(file, `${JSON.stringify({ ts: now, at: new Date(now).toISOString(), event })}\n`, 'utf8');
}

/**
 * 写一份卡死现场包。逐文件容错：任一文件写失败只记录在 errors，绝不影响其余文件与主循环。
 */
export function writeStuckPack(options: EvidenceOptions, input: StuckPackInput): StuckPack {
  const relDir = join('stuck', `${String(input.index).padStart(2, '0')}-${input.verdict.kind}`);
  const dir = join(options.runDir, relDir);
  const files: string[] = [];
  const errors: string[] = [];

  const attempt = (name: string, run: () => void): void => {
    try {
      run();
      files.push(name);
    } catch (error) {
      errors.push(`${name}: ${errorMessage(error)}`);
    }
  };

  attempt('dir', () => mkdirSync(dir, { recursive: true }));

  attempt('verdict.json', () =>
    writeJsonFile(join(dir, 'verdict.json'), {
      ...input.verdict,
      atIso: new Date(input.verdict.at).toISOString(),
      dayKey: input.dayKey,
      clock: input.clock,
    }),
  );

  attempt('last50.jsonl', () => {
    const tail = input.events.slice(-50);
    const body = tail.map((event) => JSON.stringify(event)).join('\n');
    writeFileSync(join(dir, 'last50.jsonl'), body === '' ? '' : `${body}\n`, 'utf8');
  });

  attempt('state.txt', () =>
    writeFileSync(join(dir, 'state.txt'), input.stateText === '' ? '(无状态快照：观察者未开启或尚未取到状态)\n' : input.stateText, 'utf8'),
  );

  attempt('planner.json', () => writeJsonFile(join(dir, 'planner.json'), input.planner));

  // 截图：失败只写 screen.err
  const screenFile = join(dir, 'screen.png');
  const capture = options.captureScreen ?? defaultCaptureScreen;
  let screen: CaptureResult;
  try {
    screen = capture(screenFile);
  } catch (error) {
    screen = { ok: false, error: errorMessage(error) };
  }
  if (screen.ok) {
    files.push('screen.png');
  } else {
    attempt('screen.err', () => writeFileSync(join(dir, 'screen.err'), `${screen.error ?? '未知错误'}\n`, 'utf8'));
  }

  // 存档拷贝：失败只写 save.err
  if (options.saveDir === undefined || options.saveDir === null || options.saveDir === '') {
    attempt('save.err', () => writeFileSync(join(dir, 'save.err'), '未配置存档目录（--save-dir 或 WHALE_SOAK_SAVE_DIR）\n', 'utf8'));
  } else {
    const copy = options.copySave ?? defaultCopySave;
    let saved: CaptureResult;
    try {
      saved = copy(options.saveDir, join(dir, 'save'));
    } catch (error) {
      saved = { ok: false, error: errorMessage(error) };
    }
    if (saved.ok) {
      files.push('save/');
    } else {
      attempt('save.err', () => writeFileSync(join(dir, 'save.err'), `${saved.error ?? '未知错误'}\n`, 'utf8'));
    }
  }

  return { dir: relDir, files, errors };
}
