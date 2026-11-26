/**
 * OBS 配置只读探测（item 4 / `V2-P3-02`）。
 *
 * 唯一职责：把「本机 OBS 是否处于浏览器源硬件加速导致渲染全黑的已知缺陷状态」
 * 变成一条**只读**、可复跑的判据，避免以后把 OBS 侧渲染缺陷误判成我们 overlay 页面的问题。
 *
 * 硬边界：本模块**只读** OBS 配置文件，绝不写入、绝不修改 owner 的全局设置。
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface ObsConfigPaths {
  globalIni: string;
  websocketConfig: string;
}

export function defaultObsConfigPaths(home: string = homedir()): ObsConfigPaths {
  const base = join(home, 'Library', 'Application Support', 'obs-studio');
  return {
    globalIni: join(base, 'global.ini'),
    websocketConfig: join(base, 'plugin_config', 'obs-websocket', 'config.json'),
  };
}

/** 从 ini 文本取 key 值（OBS 用 CRLF 的 ini）；取不到返回 null */
export function readIniValue(text: string, key: string): string | null {
  const match = new RegExp(`^\\s*${key}\\s*=\\s*(.*)$`, 'm').exec(text);
  return match === null ? null : (match[1] ?? '').trim();
}

export interface HwAccelState {
  /** global.ini 是否存在 */
  present: boolean;
  /** 显式配置值；未配置时为 null（OBS 默认按 true 处理） */
  value: string | null;
  path: string;
}

export function readHwAccelState(paths: ObsConfigPaths = defaultObsConfigPaths()): HwAccelState {
  if (!existsSync(paths.globalIni)) {
    return { present: false, value: null, path: paths.globalIni };
  }
  return {
    present: true,
    value: readIniValue(readFileSync(paths.globalIni, 'utf8'), 'BrowserHWAccel'),
    path: paths.globalIni,
  };
}

/** 硬件加速是否处于「开启或未显式关闭」的状态（OBS 未配置时默认开启） */
export function isHwAccelEnabled(state: HwAccelState): boolean {
  if (state.value === null) return true;
  return state.value.toLowerCase() === 'true';
}

export interface ObsWebsocketState {
  present: boolean;
  enabled: boolean | null;
  port: number | null;
  authRequired: boolean | null;
  parseFailed: boolean;
}

export function readWebsocketState(paths: ObsConfigPaths = defaultObsConfigPaths()): ObsWebsocketState {
  if (!existsSync(paths.websocketConfig)) {
    return { present: false, enabled: null, port: null, authRequired: null, parseFailed: false };
  }
  try {
    const raw = JSON.parse(readFileSync(paths.websocketConfig, 'utf8')) as Record<string, unknown>;
    return {
      present: true,
      enabled: raw.server_enabled === true,
      port: typeof raw.server_port === 'number' ? raw.server_port : null,
      authRequired: raw.auth_required === true,
      parseFailed: false,
    };
  } catch {
    return { present: true, enabled: null, port: null, authRequired: null, parseFailed: true };
  }
}

export interface PreconditionReport {
  hwAccel: HwAccelState;
  hwAccelEnabled: boolean;
  websocket: ObsWebsocketState;
  /** 前置是否满足（false = 处于已知全黑缺陷状态） */
  satisfied: boolean;
  /** 人类可读结论 */
  summary: string;
  /** 处置建议（不含任何自动改配置的动作） */
  remedy: string;
}

/**
 * 生成前置判定报告。
 * 关键：即便前置不满足，本函数也**只报告不修改**——改 OBS 全局设置属于 owner 决策。
 */
export function evaluatePreconditions(paths: ObsConfigPaths = defaultObsConfigPaths()): PreconditionReport {
  const hwAccel = readHwAccelState(paths);
  const websocket = readWebsocketState(paths);
  const enabled = isHwAccelEnabled(hwAccel);
  return {
    hwAccel,
    hwAccelEnabled: enabled,
    websocket,
    satisfied: !enabled,
    summary: enabled
      ? '前置不满足：本机处于「浏览器源硬件加速开启」状态，browser_source 已知会渲染全黑'
      : '前置满足：浏览器源硬件加速已关闭，browser_source 应可正常渲染',
    remedy: enabled
      ? 'OBS → 设置 → 高级 → 源 → 关闭「浏览器源硬件加速」；随后用 `pnpm obs:selfcheck --probe` 复核。'
      : '无需处置；若仍见全黑请用 `pnpm obs:selfcheck --probe` 取像素证据后再判断。',
  };
}
