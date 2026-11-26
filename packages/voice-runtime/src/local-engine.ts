/**
 * 本地语音引擎的安装状态判定与降级链（item 10 阶段 1/2）。
 *
 * 唯一判据：`<enginesRoot>/<engineId>/<version>/installed.json` **存在且能过校验**。
 * - 没有这个文件（例如刚跑过 `fetch-engine.mjs --remove`）= 未安装；
 * - 清单里登记的文件缺失或字节数不符 = 不完整，同样按未安装处理；
 * - 任何"看起来像装了"的猜测都不允许——宁可报未安装走降级，也不许把半包当可用引擎。
 *
 * 降级链按方案 §5.5：本地表现力引擎 → 商业 API → 系统 TTS，每一跳都标 degraded，不静默。
 */
import { existsSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export interface EngineInstalledFile {
  path: string;
  bytes: number;
  sha256: string;
}

export interface EngineInstalledMarker {
  engineId: string;
  version: string;
  displayName?: string;
  repoId?: string;
  revision?: string;
  installedAt: string;
  totalBytes: number;
  files: EngineInstalledFile[];
}

export type LocalEngineState =
  | { installed: true; path: string; marker: EngineInstalledMarker }
  | {
      installed: false;
      reason: 'no_marker' | 'corrupt_marker' | 'wrong_engine' | 'file_missing' | 'size_mismatch';
      detail: string;
      path: string;
    };

/** 文件系统端口：默认走真实 fs，单测可注入替身（不 sleep、不依赖真实磁盘布局） */
export interface EngineFsPort {
  exists(path: string): boolean;
  readFile(path: string): string;
  size(path: string): number;
  listDirs(path: string): string[];
}

export const nodeEngineFs: EngineFsPort = {
  exists: (path) => existsSync(path),
  readFile: (path) => readFileSync(path, 'utf8'),
  size: (path) => {
    try {
      return statSync(path).size;
    } catch {
      return -1;
    }
  },
  listDirs: (path) => {
    try {
      return readdirSync(path, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      return [];
    }
  },
};

export interface ResolveLocalEngineInput {
  enginesRoot: string;
  engineId: string;
  /** 不传则取 <enginesRoot>/<engineId> 下按名字倒序的第一个版本目录 */
  version?: string;
  fs?: EngineFsPort;
}

/** 判定某个本地引擎是否真的可用；不做 sha256 全量校验（那是 `--check` 的事），只查存在与字节数 */
export function resolveLocalEngine(input: ResolveLocalEngineInput): LocalEngineState {
  const fs = input.fs ?? nodeEngineFs;
  const engineRoot = join(input.enginesRoot, input.engineId);
  const version = input.version ?? pickLatestVersion(fs, engineRoot);
  const path = version === null ? engineRoot : join(engineRoot, version);
  const markerPath = join(path, 'installed.json');

  if (!fs.exists(markerPath)) {
    return { installed: false, reason: 'no_marker', detail: `未找到 installed.json（${markerPath}）`, path };
  }
  let marker: EngineInstalledMarker;
  try {
    marker = JSON.parse(fs.readFile(markerPath)) as EngineInstalledMarker;
  } catch {
    return { installed: false, reason: 'corrupt_marker', detail: 'installed.json 不是合法 JSON', path };
  }
  if (marker.engineId !== input.engineId || !Array.isArray(marker.files) || marker.files.length === 0) {
    return { installed: false, reason: 'wrong_engine', detail: `installed.json 与请求的引擎不符（${String(marker.engineId)}）`, path };
  }
  for (const file of marker.files) {
    const target = join(path, file.path);
    const size = fs.size(target);
    if (size < 0) {
      return { installed: false, reason: 'file_missing', detail: `权重文件缺失：${file.path}`, path };
    }
    if (size !== file.bytes) {
      return { installed: false, reason: 'size_mismatch', detail: `权重文件字节数不符：${file.path}（期望 ${file.bytes}，实得 ${size}）`, path };
    }
  }
  return { installed: true, path, marker };
}

function pickLatestVersion(fs: EngineFsPort, engineRoot: string): string | null {
  const versions = fs
    .listDirs(engineRoot)
    .filter((name) => !name.startsWith('.'))
    .sort();
  return versions.at(-1) ?? null;
}

export type VoiceBackendStep = 'local_engine' | 'commercial_api' | 'system_tts';

export interface VoiceFallbackStep {
  step: VoiceBackendStep;
  /** 相对"本地表现力引擎"的降级程度：本地原样=false，其余=true */
  degraded: boolean;
  reason: string;
}

export interface VoiceFallbackPlan {
  /** 首选后端（= plan[0]，便于宿主直接取） */
  primary: VoiceBackendStep;
  plan: VoiceFallbackStep[];
}

/**
 * 生成降级链：顺序固定（本地 → 商业 → 系统），但只保留"当前真的可用"的档位；
 * 本地未安装时第一档就标 degraded 并给出具体原因，便于 UI 如实显示而不是装作本地在工作。
 */
export function planVoiceFallback(input: {
  local: LocalEngineState;
  commercialAvailable: boolean;
  systemTtsAvailable?: boolean;
}): VoiceFallbackPlan {
  const plan: VoiceFallbackStep[] = [];
  if (input.local.installed) {
    plan.push({ step: 'local_engine', degraded: false, reason: `本地引擎 ${input.local.marker.engineId}@${input.local.marker.version}` });
  }
  if (input.commercialAvailable) {
    plan.push({
      step: 'commercial_api',
      degraded: true,
      reason: input.local.installed ? '本地引擎不可用时的兜底' : `本地引擎未安装（${input.local.reason}），走商业 API`,
    });
  }
  if (input.systemTtsAvailable ?? true) {
    plan.push({ step: 'system_tts', degraded: true, reason: '商业 API 也不可用时的系统音色兜底（quality=system_fallback）' });
  }
  return { primary: plan[0]?.step ?? 'system_tts', plan };
}
