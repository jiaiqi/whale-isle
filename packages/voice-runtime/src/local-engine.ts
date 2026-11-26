/**
 * 本地语音引擎的安装状态判定与档位化降级链（item 10）。
 *
 * 唯一判据：`<enginesRoot>/<engineId>/<version>/installed.json` **存在且能过校验**。
 * - 没有这个文件（例如刚跑过 `fetch-engine.mjs --remove`）= 未安装；
 * - 清单里登记的文件缺失或字节数不符 = 不完整，同样按未安装处理；
 * - 任何"看起来像装了"的猜测都不允许——宁可报未安装走降级，也不许把半包当可用引擎。
 *
 * 档位（`VoiceEngineTier`）：
 * - `commercial_default`（默认）：商业 API 优先；本地引擎即使装了也只作为**可选离线档**列在后面；
 * - `offline_preferred`：用户主动选离线档，本地引擎排第一。
 *
 * 严禁再用「本地装没装」隐式决定优先级：本机实测本地引擎一句话要等 17–43 秒，
 * 装了不等于该默认走它。档位由用户显式选择（设置里的 `voiceEngineTier`），且随时可切回。
 */
import { existsSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { OFFLINE_TIER_COST_TEXT, type VoiceEngineTier } from '@workbench/shared-protocol';

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

/** 该档在本次计划中的角色：主选 / 兜底 / 可选（用户没选、但装着且能切过去） */
export type VoiceFallbackRole = 'primary' | 'fallback' | 'optional';

export interface VoiceFallbackStep {
  step: VoiceBackendStep;
  /** 相对"本地表现力引擎"的质量降级：本地引擎本身=false，其余=true（语义未变） */
  degraded: boolean;
  role: VoiceFallbackRole;
  reason: string;
}

export interface VoiceFallbackPlan {
  /** 首选后端（= plan[0]，便于宿主直接取） */
  primary: VoiceBackendStep;
  plan: VoiceFallbackStep[];
  /** 本次采用的档位（调用方没传时就是默认档） */
  tier: VoiceEngineTier;
  /** 所选档位的首选后端是否真的排在第一；false = 档位没兑现，必须如实告诉用户 */
  tierHonored: boolean;
}

/**
 * 生成档位化降级链：
 * - `commercial_default`：商业 API → （装了的话）离线档 → 系统 TTS；
 * - `offline_preferred`：本地引擎 → 商业 API → 系统 TTS；
 * - 只保留"当前真的可用"的档位，缺哪档都写清具体原因，便于 UI 如实显示而不是装作本地在工作。
 */
export function planVoiceFallback(input: {
  local: LocalEngineState;
  commercialAvailable: boolean;
  systemTtsAvailable?: boolean;
  /** 用户显式选择的档位；缺省 = 默认档（商业 API 优先） */
  tier?: VoiceEngineTier;
}): VoiceFallbackPlan {
  const tier = input.tier ?? 'commercial_default';
  // 提前取出两个分支各自的稳定字段：闭包里 TS 无法对 `input.local` 做窄化
  const localInstalled = input.local.installed;
  const localReason = input.local.installed ? '' : input.local.reason;
  const localLabel = input.local.installed ? `${input.local.marker.engineId}@${input.local.marker.version}` : '';

  const localStep = (role: VoiceFallbackRole): VoiceFallbackStep => {
    if (!localInstalled) {
      return { step: 'local_engine', degraded: false, role, reason: `本地引擎未安装（${localReason}）` };
    }
    return {
      step: 'local_engine',
      degraded: false,
      role,
      reason: `本地引擎 ${localLabel}（离线档，代价：${OFFLINE_TIER_COST_TEXT}）`,
    };
  };

  const commercialStep = (role: VoiceFallbackRole): VoiceFallbackStep => {
    let reason: string;
    if (role !== 'primary') {
      reason = localInstalled
        ? '商业 API 兜底（离线档不可用时才走）'
        : `本地引擎未安装（${localReason}），走商业 API`;
    } else if (tier === 'offline_preferred') {
      reason = `你选择了离线档，但本地引擎未安装（${localReason}），已回落到商业 API`;
    } else {
      reason = '商业 API 默认档（item 10 结论：本机自托管不可用，默认走商业 API）';
    }
    return { step: 'commercial_api', degraded: true, role, reason };
  };

  const systemStep = (role: VoiceFallbackRole): VoiceFallbackStep => ({
    step: 'system_tts',
    degraded: true,
    role,
    reason: '商业 API 也不可用时的系统音色兜底（quality=system_fallback）',
  });

  const plan: VoiceFallbackStep[] = [];
  /** 第一跳永远是主选；其后的档位按调用方给的语义（兜底 / 可选）标注 */
  const roleFor = (roleAfterFirst: VoiceFallbackRole): VoiceFallbackRole =>
    plan.length === 0 ? 'primary' : roleAfterFirst;

  if (tier === 'offline_preferred') {
    if (localInstalled) plan.push(localStep('primary'));
    if (input.commercialAvailable) plan.push(commercialStep(roleFor('fallback')));
    if (input.systemTtsAvailable ?? true) plan.push(systemStep(roleFor('fallback')));
  } else {
    if (input.commercialAvailable) plan.push(commercialStep('primary'));
    if (localInstalled) plan.push(localStep(roleFor('optional')));
    if (input.systemTtsAvailable ?? true) plan.push(systemStep(roleFor('fallback')));
  }

  const primary = plan[0]?.step ?? 'system_tts';
  const tierPreferred: VoiceBackendStep = tier === 'offline_preferred' ? 'local_engine' : 'commercial_api';
  return { primary, plan, tier, tierHonored: primary === tierPreferred };
}
