import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareStardewProfile, safeAgentId, safePort } from './coop-launcher';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('coop-launcher 星露谷隔离 profile', () => {
  it('普通 Mod 符号链接，BWF 独立拷贝并改 McpPort，不污染原配置', async () => {
    const root = mkdtempSync(join(tmpdir(), 'coop-launch-')); dirs.push(root);
    const mods = join(root, 'Mods'); mkdirSync(join(mods, 'OtherMod'), { recursive: true });
    writeFileSync(join(mods, 'OtherMod', 'manifest.json'), JSON.stringify({ UniqueID: 'Other.Mod', Name: 'Other' }));
    mkdirSync(join(mods, 'BlindWhaleFarmer'), { recursive: true });
    writeFileSync(join(mods, 'BlindWhaleFarmer', 'manifest.json'), JSON.stringify({ UniqueID: 'Darian.BWF', Name: 'Blind Whale Farmer' }));
    writeFileSync(join(mods, 'BlindWhaleFarmer', 'config.json'), JSON.stringify({ McpPort: 18080, ShowHud: true, Keep: 1 }));
    const result = await prepareStardewProfile({ modsDir: mods, profileDir: join(root, 'profiles'), agentId: 'agent-1', port: 18081 });
    expect(lstatSync(join(result.profileModsDir, 'OtherMod')).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(result.profileModsDir, 'BlindWhaleFarmer')).isSymbolicLink()).toBe(false);
    const copied = JSON.parse(readFileSync(join(result.bwfFolder, 'config.json'), 'utf8'));
    expect(copied).toMatchObject({ McpPort: 18081, ShowHud: false, Keep: 1 });
    expect(JSON.parse(readFileSync(join(mods, 'BlindWhaleFarmer', 'config.json'), 'utf8')).McpPort).toBe(18080);
    expect(existsSync(join(root, 'profiles', 'agent-1', 'Mods'))).toBe(true);
  });
  it('拒绝路径穿越与非法端口', () => {
    expect(() => safeAgentId('../escape')).toThrow(/非法/);
    expect(() => safePort(80)).toThrow(/非法/);
  });
});

import { launchDstCluster, launchTerrariaServer, terrariaServerArgs, writeDstClusterToken, writeDstModOverrides } from './coop-launcher';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

function fakeSpawn(record: Array<{ cmd: string; args: string[]; env?: NodeJS.ProcessEnv }>) {
  return ((cmd: string, args?: readonly string[], options?: { env?: NodeJS.ProcessEnv }) => {
    record.push({ cmd, args: [...(args ?? [])], ...(options?.env === undefined ? {} : { env: options.env }) });
    return { pid: 4000 + record.length, unref: () => undefined } as unknown as ChildProcess;
  }) as unknown as typeof spawn;
}

describe('coop-launcher 泰拉瑞亚专用服', () => {
  it('参数数组生成：端口/世界名/自动建界，非法端口拒绝', () => {
    expect(terrariaServerArgs({ port: 7777 })).toEqual(['-port', '7777', '-worldname', 'WhaleIsle', '-noupnp', '-autocreate', '1']);
    expect(terrariaServerArgs({ port: 7778, worldName: '我的世界!', worldPath: '/tmp/w.wld' })).toEqual(['-port', '7778', '-worldname', 'WhaleIsle', '-noupnp', '-world', '/tmp/w.wld']);
    expect(() => terrariaServerArgs({ port: 80 })).toThrow(/非法端口/);
  });

  it('为每只 AI 写桥接端口文件；未装桥接 Mod 时如实失败', () => {
    const root = mkdtempSync(join(tmpdir(), 'coop-terraria-')); dirs.push(root);
    const record: Array<{ cmd: string; args: string[] }> = [];
    const ok = launchTerrariaServer({
      executable: '/fake/tModLoaderServer',
      bridge: { detected: true, path: '/Mods/terraria-bridge.tmod', detail: 'ok' },
      profilesRoot: root,
      agents: [{ agentId: 'agent-a', port: 18090 }, { agentId: 'agent-b', port: 18091 }],
      spawnImpl: fakeSpawn(record),
    });
    expect(ok.ok).toBe(true);
    expect(record[0]?.cmd).toBe('/fake/tModLoaderServer');
    expect(record[0]?.args).toContain('7777');
    expect(readFileSync(join(root, 'agent-a', 'bridge-port.txt'), 'utf8').trim()).toBe('18090');
    expect(readFileSync(join(root, 'agent-b', 'bridge-port.txt'), 'utf8').trim()).toBe('18091');

    const missing = launchTerrariaServer({
      executable: '/fake/tModLoaderServer',
      bridge: { detected: false, path: null, detail: '缺 terraria-bridge.tmod' },
      profilesRoot: root,
      agents: [],
      spawnImpl: fakeSpawn(record),
    });
    expect(missing).toMatchObject({ ok: false });
    expect(missing.error).toContain('terraria-bridge');
  });
});

describe('coop-launcher DST 集群', () => {
  it('cluster_token 0600 落盘，非法 token 拒绝且不回显', () => {
    const root = mkdtempSync(join(tmpdir(), 'coop-dst-')); dirs.push(root);
    const saved = writeDstClusterToken(root, '  abcdefgh12345678  ');
    expect(readFileSync(saved.path, 'utf8')).toBe('abcdefgh12345678');
    expect(readFileSync(join(root, 'cluster.ini'), 'utf8')).toContain('[NETWORK]');
    expect(() => writeDstClusterToken(root, '')).toThrow(/不能为空/);
    expect(() => writeDstClusterToken(root, 'bad token with space')).toThrow(/非法字符/);
  });

  it('modoverrides 写入受控 UserID 与同一 pair_token，Lua 转义安全', () => {
    const root = mkdtempSync(join(tmpdir(), 'coop-dst-')); dirs.push(root);
    const result = writeDstModOverrides({ clusterDir: root, controlledUserIds: ['KU_whale', 'KU_grok'], pairToken: 'token-123456' });
    const body = readFileSync(result.path, 'utf8');
    expect(result.controlled).toEqual(['KU_whale', 'KU_grok']);
    expect(body).toContain('ai_player_userid = "KU_whale,KU_grok"');
    expect(body).toContain('pair_token = "token-123456"');
    expect(body).toContain('["dst-bridge"]');
    expect(() => writeDstModOverrides({ clusterDir: root, controlledUserIds: ['bad"id'] })).toThrow(/非法 Klei UserID/);
  });

  it('启动时专用服与 sidecar 都拿到同一 token 环境变量，渲染层不回传 token', () => {
    const root = mkdtempSync(join(tmpdir(), 'coop-dst-')); dirs.push(root);
    const record: Array<{ cmd: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];
    const result = launchDstCluster({
      clusterDir: join(root, 'WhaleIsle'),
      controlledUserIds: ['KU_whale'],
      serverExecutable: '/fake/dontstarve_dedicated_server_nullrenderer',
      sidecarEntry: '/repo/services/dst-bridge-sidecar/dist/index.js',
      nodeExecutable: '/fake/node',
      runAsNode: true,
      spawnImpl: fakeSpawn(record),
    });
    expect(result.ok).toBe(true);
    expect(result.serverPid).toBeDefined();
    expect(result.sidecarPid).toBeDefined();
    expect(JSON.stringify(result)).not.toContain('DST_PAIR_TOKEN');
    const [server, sidecar] = record;
    expect(server?.cmd).toBe('/fake/dontstarve_dedicated_server_nullrenderer');
    expect(server?.env?.DST_AUTOSTART).toBe('1');
    expect(sidecar?.cmd).toBe('/fake/node');
    expect(sidecar?.args).toEqual(['/repo/services/dst-bridge-sidecar/dist/index.js']);
    expect(sidecar?.env?.ELECTRON_RUN_AS_NODE).toBe('1');
    expect(sidecar?.env?.DST_PAIR_TOKEN).toBe(server?.env?.DST_PAIR_TOKEN);
    expect(sidecar?.env?.DST_PORT).toBe('18100');
  });
});
