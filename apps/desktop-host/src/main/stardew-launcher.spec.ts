/**
 * V2-P3-05 星露谷启动器状态机单测。
 *
 * 全部依赖注入：假 fs、假 spawn、假 fetch、假时钟、假探活。
 * 覆盖：安装探测 / 未安装 / SMAPI 缺失 / 正常启动 / 已在运行不重复启动 /
 *       SMAPI 失败回退 Steam / 超时 / 标题画面自动 load_save。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createStardewLauncher,
  detectStardewInstall,
  resolveBwfPort,
  steamAppManifestPath,
  type StardewLauncherDeps,
  type LaunchProbeResult,
} from './stardew-launcher';

const HOME = '/Users/tester';
const GAME_ROOT = `${HOME}/Library/Application Support/Steam/steamapps/common/Stardew Valley`;
const EXE_DIR = `${GAME_ROOT}/Contents/MacOS`;
const SMAPI = `${EXE_DIR}/StardewModdingAPI`;
const MODS = `${EXE_DIR}/Mods`;
const BWF_MANIFEST = `${MODS}/BlindWhaleFarmer/manifest.json`;
const BWF_CONFIG = `${MODS}/BlindWhaleFarmer/config.json`;
const STEAM_MANIFEST = steamAppManifestPath('darwin', HOME);

function installExists(extra: string[] = []): (path: string) => boolean {
  const paths = new Set([GAME_ROOT, EXE_DIR, SMAPI, MODS, BWF_MANIFEST, BWF_CONFIG, STEAM_MANIFEST, ...extra]);
  return (path) => paths.has(path);
}

function fakeSpawn(behaviour: (command: string) => 'ok' | 'error') {
  const calls: Array<{ command: string; args: string[] }> = [];
  const impl = ((command: string, args: string[]) => {
    calls.push({ command, args });
    const listeners = new Map<string, (value?: unknown) => void>();
    const child = {
      pid: 4242,
      once(event: string, handler: (value?: unknown) => void) {
        listeners.set(event, handler);
        return child;
      },
      unref: () => undefined,
    };
    queueMicrotask(() => {
      if (behaviour(command) === 'error') listeners.get('error')?.(new Error('spawn ENOENT'));
      else listeners.get('spawn')?.();
    });
    return child;
  }) as unknown as StardewLauncherDeps['spawnImpl'];
  return { impl: impl as NonNullable<StardewLauncherDeps['spawnImpl']>, calls };
}

function sequenceProbe(sequence: LaunchProbeResult[]) {
  let index = 0;
  return vi.fn(async () => {
    const value = sequence[Math.min(index, sequence.length - 1)] ?? { status: 'offline', detail: '无' };
    index += 1;
    return value;
  });
}

async function settle(launcher: ReturnType<typeof createStardewLauncher>, states: string[] = ['ready', 'timeout', 'failed', 'not_installed']) {
  for (let i = 0; i < 200; i += 1) {
    const status = launcher.status();
    if (states.includes(status.state)) return status;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return launcher.status();
}

function baseDeps(overrides: Partial<StardewLauncherDeps> = {}): StardewLauncherDeps {
  let nowMs = 0;
  const refuseFetch = (async () => {
    throw new Error('ECONNREFUSED');
  }) as unknown as typeof fetch;
  return {
    platform: 'darwin',
    homedir: HOME,
    exists: installExists(),
    readFile: () => JSON.stringify({ McpPort: 18088 }),
    spawnImpl: fakeSpawn(() => 'ok').impl,
    processRunning: async () => false,
    probe: sequenceProbe([{ status: 'offline', detail: '未监听' }]),
    fetchImpl: refuseFetch,
    sleep: async (ms: number) => { nowMs += ms; },
    now: () => nowMs,
    ...overrides,
  };
}

describe('detectStardewInstall', () => {
  it('macOS 默认 Steam 布局：游戏根 / Contents/MacOS / SMAPI / Mods / BWF', () => {
    const install = detectStardewInstall(baseDeps());
    expect(install).toMatchObject({
      gameInstalled: true,
      smapiInstalled: true,
      bwfInstalled: true,
      steamAppPresent: true,
      gameDir: GAME_ROOT,
      executableDir: EXE_DIR,
      smapiBinary: SMAPI,
      modsDir: MODS,
    });
  });

  it('没有游戏目录 → gameInstalled=false', () => {
    const install = detectStardewInstall(baseDeps({ exists: () => false }));
    expect(install.gameInstalled).toBe(false);
    expect(install.smapiInstalled).toBe(false);
  });
});

describe('resolveBwfPort', () => {
  it('优先读取 BWF config.json 的 McpPort', () => {
    expect(resolveBwfPort(MODS, { exists: installExists(), readFile: () => '{"McpPort":19000}' })).toBe(19000);
  });

  it('配置缺失或损坏时回退默认 18088', () => {
    expect(resolveBwfPort(MODS, { exists: () => false })).toBe(18088);
    expect(resolveBwfPort(MODS, { exists: installExists(), readFile: () => '{坏 JSON' })).toBe(18088);
  });
});

describe('StardewLauncher 状态机', () => {
  it('未安装 → not_installed，且不 spawn', async () => {
    const spawn = fakeSpawn(() => 'ok');
    const launcher = createStardewLauncher(baseDeps({ exists: () => false, spawnImpl: spawn.impl }));
    const status = await launcher.launch();
    expect(status.state).toBe('not_installed');
    expect(spawn.calls).toHaveLength(0);
  });

  it('游戏在但 SMAPI 缺失 → failed，且不 spawn', async () => {
    const spawn = fakeSpawn(() => 'ok');
    const launcher = createStardewLauncher(baseDeps({
      exists: (path) => path === GAME_ROOT || path === EXE_DIR || path === MODS,
      spawnImpl: spawn.impl,
    }));
    const status = await launcher.launch();
    expect(status.state).toBe('failed');
    expect(status.message).toContain('SMAPI');
    expect(spawn.calls).toHaveLength(0);
  });

  it('直接 spawn SMAPI → launching → wait → ready（只有 get_state 应答才 ready）', async () => {
    const spawn = fakeSpawn(() => 'ok');
    const launcher = createStardewLauncher(baseDeps({
      spawnImpl: spawn.impl,
      probe: sequenceProbe([
        { status: 'offline', detail: '未监听' },
        { status: 'offline', detail: '未监听' },
        { status: 'online', detail: 'BWF MCP 在线 · get_state 正常应答' },
      ]),
    }));
    const first = await launcher.launch();
    expect(first.state).toBe('launching');
    expect(first.strategy).toBe('smapi');
    expect(spawn.calls[0]?.command).toBe(SMAPI);

    const done = await settle(launcher);
    expect(done.state).toBe('ready');
    expect(done.attempts).toBeGreaterThanOrEqual(2);
    expect(done.message).toContain('BWF MCP 已就绪');
  });

  it('游戏已在运行（MCP reachable）→ 不重复 spawn，等待后 ready', async () => {
    const spawn = fakeSpawn(() => 'ok');
    const launcher = createStardewLauncher(baseDeps({
      spawnImpl: spawn.impl,
      probe: sequenceProbe([
        { status: 'reachable', detail: 'Mod 在运行但未就绪' },
        { status: 'online', detail: 'BWF MCP 在线' },
      ]),
    }));
    const first = await launcher.launch();
    expect(first.gameRunning).toBe(true);
    expect(first.state).toBe('waiting_mcp');
    expect(spawn.calls).toHaveLength(0);
    const done = await settle(launcher);
    expect(done.state).toBe('ready');
  });

  it('SMAPI spawn 失败 → 回退 Steam（open steam://rungameid/413150）', async () => {
    const spawn = fakeSpawn((command) => (command === SMAPI ? 'error' : 'ok'));
    const launcher = createStardewLauncher(baseDeps({
      spawnImpl: spawn.impl,
      probe: sequenceProbe([
        { status: 'offline', detail: '未监听' },
        { status: 'online', detail: 'BWF MCP 在线' },
      ]),
    }));
    const first = await launcher.launch();
    expect(first.state).toBe('launching');
    expect(first.strategy).toBe('steam');
    expect(first.fallbackStrategy).toBe('smapi');
    expect(spawn.calls.map((call) => call.command)).toEqual([SMAPI, 'open']);
    expect(spawn.calls[1]?.args).toEqual(['steam://rungameid/413150']);
    expect((await settle(launcher)).state).toBe('ready');
  });

  it('两种方式都失败 → failed（如实给出错误）', async () => {
    const spawn = fakeSpawn(() => 'error');
    const launcher = createStardewLauncher(baseDeps({ spawnImpl: spawn.impl }));
    const status = await launcher.launch();
    expect(status.state).toBe('failed');
    expect(status.message).toContain('spawn ENOENT');
  });

  it('一直连不上 → timeout，并提示检查 SMAPI/BWF 端口', async () => {
    const launcher = createStardewLauncher(baseDeps({
      probe: sequenceProbe([{ status: 'offline', detail: '未监听' }]),
    }));
    await launcher.launch({ timeoutMs: 6_000 });
    const done = await settle(launcher);
    expect(done.state).toBe('timeout');
    expect(done.hint).toContain('MCP 端口');
  });

  it('停在标题画面（reachable）→ 调一次 load_save，超时提示手动选存档', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '正在读取存档' }] } }),
    })) as unknown as typeof fetch;
    const launcher = createStardewLauncher(baseDeps({
      fetchImpl,
      probe: sequenceProbe([{ status: 'reachable', detail: 'Mod 在运行但未就绪' }]),
    }));
    await launcher.launch({ timeoutMs: 6_000, autoLoadSave: true });
    const done = await settle(launcher);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(done.state).toBe('timeout');
    expect(done.saveLoadRequested).toBe(true);
    expect(done.hint).toContain('标题画面');
  });
});
