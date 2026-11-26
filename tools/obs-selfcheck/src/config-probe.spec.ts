import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  defaultObsConfigPaths,
  evaluatePreconditions,
  isHwAccelEnabled,
  readHwAccelState,
  readIniValue,
  readWebsocketState,
} from './config-probe';

const workDirs: string[] = [];

function makeObsDir(globalIni: string | null, wsConfig: unknown): string {
  const root = mkdtempSync(join(tmpdir(), 'obs-selfcheck-'));
  workDirs.push(root);
  const base = join(root, 'obs-studio');
  mkdirSync(join(base, 'plugin_config', 'obs-websocket'), { recursive: true });
  if (globalIni !== null) writeFileSync(join(base, 'global.ini'), globalIni);
  if (wsConfig !== null) {
    writeFileSync(
      join(base, 'plugin_config', 'obs-websocket', 'config.json'),
      typeof wsConfig === 'string' ? wsConfig : JSON.stringify(wsConfig),
    );
  }
  return base;
}

afterEach(() => {
  while (workDirs.length > 0) {
    const dir = workDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe('readIniValue', () => {
  it('读出 CRLF ini 里的值', () => {
    const ini = '[General]\r\nBrowserHWAccel=true\r\nMaxLogs=10\r\n';
    expect(readIniValue(ini, 'BrowserHWAccel')).toBe('true');
    expect(readIniValue(ini, 'MaxLogs')).toBe('10');
    expect(readIniValue(ini, 'Missing')).toBeNull();
  });
});

describe('readHwAccelState / isHwAccelEnabled', () => {
  it('global.ini 缺失时 present=false', () => {
    const base = makeObsDir(null, null);
    const state = readHwAccelState({
      globalIni: join(base, 'global.ini'),
      websocketConfig: join(base, 'plugin_config', 'obs-websocket', 'config.json'),
    });
    expect(state.present).toBe(false);
    expect(state.value).toBeNull();
    // 未配置时按 OBS 默认（开启）处理
    expect(isHwAccelEnabled(state)).toBe(true);
  });

  it('显式 false 时判为关闭', () => {
    const base = makeObsDir('[General]\nBrowserHWAccel=false\n', null);
    const state = readHwAccelState({
      globalIni: join(base, 'global.ini'),
      websocketConfig: join(base, 'plugin_config', 'obs-websocket', 'config.json'),
    });
    expect(state.present).toBe(true);
    expect(state.value).toBe('false');
    expect(isHwAccelEnabled(state)).toBe(false);
  });
});

describe('readWebsocketState', () => {
  it('读出开关、端口与认证要求', () => {
    const base = makeObsDir(null, { server_enabled: true, server_port: 4455, auth_required: true });
    const state = readWebsocketState({
      globalIni: join(base, 'global.ini'),
      websocketConfig: join(base, 'plugin_config', 'obs-websocket', 'config.json'),
    });
    expect(state.present).toBe(true);
    expect(state.enabled).toBe(true);
    expect(state.port).toBe(4455);
    expect(state.authRequired).toBe(true);
    expect(state.parseFailed).toBe(false);
  });

  it('配置损坏时如实标 parseFailed，不假装读到了开关', () => {
    const base = makeObsDir(null, '{ broken json');
    const state = readWebsocketState({
      globalIni: join(base, 'global.ini'),
      websocketConfig: join(base, 'plugin_config', 'obs-websocket', 'config.json'),
    });
    expect(state.parseFailed).toBe(true);
    expect(state.enabled).toBeNull();
  });

  it('配置文件缺失时 present=false', () => {
    const base = makeObsDir(null, null);
    const state = readWebsocketState({
      globalIni: join(base, 'global.ini'),
      websocketConfig: join(base, 'plugin_config', 'obs-websocket', 'config.json'),
    });
    expect(state.present).toBe(false);
  });
});

describe('evaluatePreconditions', () => {
  it('硬件加速开启 → 前置不满足并给出处置建议', () => {
    const base = makeObsDir('[General]\nBrowserHWAccel=true\n', { server_enabled: false });
    const report = evaluatePreconditions({
      globalIni: join(base, 'global.ini'),
      websocketConfig: join(base, 'plugin_config', 'obs-websocket', 'config.json'),
    });
    expect(report.satisfied).toBe(false);
    expect(report.hwAccelEnabled).toBe(true);
    expect(report.summary).toContain('前置不满足');
    expect(report.remedy).toContain('浏览器源硬件加速');
  });

  it('硬件加速关闭 → 前置满足', () => {
    const base = makeObsDir('[General]\nBrowserHWAccel=false\n', { server_enabled: true, server_port: 4455 });
    const report = evaluatePreconditions({
      globalIni: join(base, 'global.ini'),
      websocketConfig: join(base, 'plugin_config', 'obs-websocket', 'config.json'),
    });
    expect(report.satisfied).toBe(true);
    expect(report.websocket.enabled).toBe(true);
  });
});

describe('defaultObsConfigPaths', () => {
  it('指向 macOS 标准 OBS 配置目录', () => {
    const paths = defaultObsConfigPaths('/Users/tester');
    expect(paths.globalIni).toBe('/Users/tester/Library/Application Support/obs-studio/global.ini');
    expect(paths.websocketConfig).toContain('plugin_config/obs-websocket/config.json');
  });
});
