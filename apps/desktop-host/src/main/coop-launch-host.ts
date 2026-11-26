/**
 * 三游戏联机启动器 IPC 宿主（T-M6-51 拆分自 index.ts）。
 *
 * 只做「探测 → 隔离目录 → 参数数组 spawn → 如实回报」，不拼 shell 字符串；
 * 端点数据由 index 注入（CoopHost 是唯一事实源），本模块不持有游戏状态。
 */
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ipcMain } from 'electron';
import { guessModsDirs, isolateDataEnv } from '@workbench/stardew-mods';
import {
  detectLaunchStatus,
  launchDstCluster,
  launchTerrariaClient,
  launchTerrariaServer,
  prepareStardewProfile,
  spawnGameProcess,
  writeDstClusterToken,
} from './coop-launcher';

export interface CoopLaunchEndpoint {
  id: string;
  gameId: 'stardew' | 'terraria' | 'dst';
  routingId: string;
  characterId: string;
  endpoint: string;
}

export function createCoopLaunchHost(options: {
  userDataDir: string;
  platform: NodeJS.Platform;
  homeDir: string;
  /** 仓库根（sidecar dist 入口定位；打包态不可用时如实报错） */
  repoRoot: string;
  endpoints: () => CoopLaunchEndpoint[];
  nodeExecutable?: string;
  /** T-M6-62：为每个星露谷 AI 队友的隔离 profile 写专属 active-avatar.json */
  avatarSync?: { writeForProfile(input: { profileModsDir: string; characterId: string; displayName: string }): { ok: boolean; error?: string } };
  characterName?: (characterId: string) => string;
}): { registerIpc(): void; dstClusterDir: string; profilesRoot: string } {
  const profilesRoot = join(options.userDataDir, 'coop-profiles', 'stardew');
  const terrariaProfilesRoot = join(options.userDataDir, 'coop-profiles', 'terraria');
  const dstClusterRoot = options.platform === 'win32'
    ? join(options.homeDir, 'Documents/Klei/DoNotStarveTogether')
    : join(options.homeDir, '.klei/DoNotStarveTogether');
  const dstClusterDir = join(dstClusterRoot, 'WhaleIsle');
  const dstSidecarEntry = join(options.repoRoot, 'services', 'dst-bridge-sidecar', 'dist', 'index.js');

  const stardewModsDir = (): string | null => guessModsDirs(options.platform, options.homeDir).find((dir) => existsSync(dir)) ?? null;
  const dstEndpoints = (): CoopLaunchEndpoint[] => options.endpoints().filter((item) => item.gameId === 'dst');
  const detect = async (): Promise<Awaited<ReturnType<typeof detectLaunchStatus>>> => detectLaunchStatus(options.platform, options.homeDir, profilesRoot);

  const registerIpc = (): void => {
    ipcMain.handle('coop:launch-status', async () => detect());
    ipcMain.handle('coop:dst-status', () => {
      const tokenPath = join(dstClusterDir, 'cluster_token.txt');
      return {
        clusterDir: dstClusterDir,
        tokenSaved: existsSync(tokenPath),
        overridesSaved: existsSync(join(dstClusterDir, 'Master', 'modoverrides.lua')),
        sidecarEntry: dstSidecarEntry,
        sidecarAvailable: existsSync(dstSidecarEntry),
        agents: dstEndpoints().map((item) => ({ id: item.id, routingId: item.routingId, characterId: item.characterId })),
      };
    });
    // 只写入落盘，不把 token 回传渲染层或写日志
    ipcMain.handle('coop:dst-save-token', (_e, token: string) => {
      try {
        const saved = writeDstClusterToken(dstClusterDir, String(token ?? ''));
        return { ok: true, path: saved.path };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    });
    ipcMain.handle('coop:launch-human', async (_e, gameId: 'stardew' | 'terraria' | 'dst') => {
      const status = (await detect()).find((item) => item.gameId === gameId);
      if (gameId === 'stardew') {
        if (status?.executable == null) return { ok: false, error: status?.detail ?? '未找到 StardewModdingAPI' };
        const child = spawnGameProcess(status.executable, []);
        child.unref();
        return { ok: true, pid: child.pid };
      }
      if (gameId === 'terraria') {
        const agents = options.endpoints()
          .filter((item) => item.gameId === 'terraria')
          .map((item) => ({ agentId: item.id, port: Number(new URL(item.endpoint).port || '18090') }));
        const result = launchTerrariaServer({
          executable: status?.executable ?? null,
          bridge: status?.bridge ?? { detected: false, path: null, detail: '未探测桥接 Mod' },
          profilesRoot: terrariaProfilesRoot,
          agents,
        });
        return result.ok
          ? { ok: true, pid: result.pid, aiPorts: result.aiPorts }
          : { ok: false, error: result.error };
      }
      if (!existsSync(join(dstClusterDir, 'cluster_token.txt'))) return { ok: false, error: '请先在第 1 步保存 Klei cluster_token' };
      try {
        const result = launchDstCluster({
          clusterDir: dstClusterDir,
          controlledUserIds: dstEndpoints().map((item) => item.routingId).filter((id) => id !== ''),
          serverExecutable: status?.executable ?? null,
          sidecarEntry: dstSidecarEntry,
          nodeExecutable: options.nodeExecutable ?? process.execPath,
          runAsNode: true,
        });
        return { ok: true, pid: result.serverPid, sidecarPid: result.sidecarPid, controlled: result.controlled, modOverridesPath: result.modOverridesPath };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    });
    ipcMain.handle('coop:launch-ai', async (_e, agentId: string) => {
      const endpoint = options.endpoints().find((item) => item.id === agentId);
      if (endpoint === undefined) return { ok: false, error: '未知队友端点' };
      if (endpoint.gameId === 'terraria') {
        const status = (await detect()).find((item) => item.gameId === 'terraria');
        const result = launchTerrariaClient({
          clientExecutable: status?.clientExecutable ?? null,
          profilesRoot: terrariaProfilesRoot,
          agentId,
          bridgePort: Number(new URL(endpoint.endpoint).port || '18090'),
        });
        return result.ok
          ? { ok: true, pid: result.pid, port: result.bridgePort, note: '客户端已拉起；首次需在该 Steam 账号登录并创建角色后桥接生效' }
          : { ok: false, error: result.error, port: result.bridgePort };
      }
      if (endpoint.gameId === 'dst') {
        if (endpoint.routingId === '') return { ok: false, error: '请先为该队友填写 Klei UserID（routingId）再启动' };
        if (!existsSync(join(dstClusterDir, 'cluster_token.txt'))) return { ok: false, error: '请先在第 1 步保存 Klei cluster_token' };
        try {
          const result = launchDstCluster({
            clusterDir: dstClusterDir,
            controlledUserIds: dstEndpoints().map((item) => item.routingId).filter((id) => id !== ''),
            serverExecutable: (await detect()).find((item) => item.gameId === 'dst')?.executable ?? null,
            sidecarEntry: dstSidecarEntry,
            nodeExecutable: options.nodeExecutable ?? process.execPath,
            runAsNode: true,
          });
          return { ok: true, pid: result.serverPid, sidecarPid: result.sidecarPid, controlled: result.controlled, port: 18100 };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      }
      const modsDir = stardewModsDir();
      if (modsDir === null) return { ok: false, error: '未找到星露谷 Mods 目录' };
      const port = Number(new URL(endpoint.endpoint).port || '18080');
      try {
        const prepared = await prepareStardewProfile({ modsDir, profileDir: profilesRoot, agentId, port });
        // T-M6-62：把该队友的桌宠形象写进隔离 profile（Mod 目录已由 prepareStardewProfile 实体复制）
        if (options.avatarSync !== undefined && endpoint.characterId !== '') {
          const written = options.avatarSync.writeForProfile({
            profileModsDir: prepared.profileModsDir,
            characterId: endpoint.characterId,
            displayName: options.characterName?.(endpoint.characterId) ?? endpoint.characterId,
          });
          if (!written.ok) console.warn('[coop-launch] 队友外观写入失败：', written.error);
        }
        const status = (await detect()).find((item) => item.gameId === 'stardew');
        if (status?.executable == null) return { ok: false, error: '未找到 StardewModdingAPI' };
        // V2-P2-09B：联机实例必须隔离存档与设置，否则第二个实例会与 owner 共用
        // `~/.config/StardewValley`（含 owner 的两个存档）。只注入 XDG_*，不动 HOME。
        const isolateDataDir = join(profilesRoot, agentId, 'stardew-data');
        const isolateEnv = isolateDataEnv(isolateDataDir);
        if (isolateEnv === null) {
          return { ok: false, error: `隔离数据目录不是绝对路径：${isolateDataDir}` };
        }
        try {
          mkdirSync(isolateEnv.XDG_CONFIG_HOME, { recursive: true });
          mkdirSync(isolateEnv.XDG_DATA_HOME, { recursive: true });
        } catch (error) {
          return { ok: false, error: `无法创建隔离数据目录：${error instanceof Error ? error.message : String(error)}` };
        }
        const child = spawnGameProcess(
          status.executable,
          ['--mods-path', prepared.profileModsDir],
          undefined,
          undefined,
          { ...process.env, ...isolateEnv },
        );
        child.unref();
        return {
          ok: true,
          pid: child.pid,
          profileModsDir: prepared.profileModsDir,
          isolateDataDir,
          port,
        };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    });
  };

  return { registerIpc, dstClusterDir, profilesRoot };
}
