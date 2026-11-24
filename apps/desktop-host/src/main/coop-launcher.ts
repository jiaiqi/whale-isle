/** 三游戏联机一键启动（T-M6-42）：路径探测、星露谷隔离 profile 与参数数组 spawn。 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { guessModsDirs } from '@workbench/stardew-mods';
import { scanModsDir } from '@workbench/stardew-mods';

export interface LaunchStatus {
  gameId: 'stardew' | 'terraria' | 'dst';
  detected: boolean;
  executable: string | null;
  detail: string;
  agents: Array<{ agentId: string; profileDir: string; ready: boolean }>;
}

export function safeAgentId(id: string): string {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(id)) throw new Error(`非法 agentId：${id}`);
  return id;
}
export function safePort(port: number): number {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(`非法端口：${port}`);
  return port;
}

/** 生成隔离 profile：普通 Mod 符号链接复用，BWF 独立拷贝并改写 config，绝不改原 Mods。 */
export async function prepareStardewProfile(input: {
  modsDir: string;
  profileDir: string;
  agentId: string;
  port: number;
}): Promise<{ profileModsDir: string; bwfFolder: string }> {
  const agentId = safeAgentId(input.agentId);
  const port = safePort(input.port);
  const scan = await scanModsDir(input.modsDir);
  if (!scan.exists) throw new Error(`Mods 目录不存在：${input.modsDir}`);
  const bwf = scan.mods.find((mod) => /blind.?whale|大肥鱼|BWF/i.test(`${mod.uniqueId} ${mod.name}`));
  if (bwf === undefined) throw new Error('未找到 BWF/BlindWhaleFarmer Mod');
  const profileModsDir = join(resolve(input.profileDir), agentId, 'Mods');
  mkdirSync(profileModsDir, { recursive: true });
  for (const entry of readdirSync(input.modsDir, { withFileTypes: true })) {
    const source = join(input.modsDir, entry.name);
    const target = join(profileModsDir, entry.name);
    if (entry.name === bwf.folderName) continue;
    if (existsSync(target)) continue;
    try { symlinkSync(source, target, entry.isDirectory() ? 'dir' : 'file'); } catch { /* 平台不支持符号链接时跳过，不阻塞 BWF */ }
  }
  const sourceBwf = join(input.modsDir, bwf.folderName);
  const targetBwf = join(profileModsDir, bwf.folderName);
  cpSync(sourceBwf, targetBwf, { recursive: true, force: true });
  const configPath = join(targetBwf, 'config.json');
  let config: Record<string, unknown> = {};
  try { config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>; } catch { /* 新配置 */ }
  config.McpPort = port;
  config.ShowHud = false;
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return { profileModsDir, bwfFolder: targetBwf };
}

export async function detectLaunchStatus(platform: NodeJS.Platform, homedir: string, profilesRoot: string): Promise<LaunchStatus[]> {
  const mods = guessModsDirs(platform, homedir).find((dir) => existsSync(dir)) ?? null;
  const smapi = mods === null ? null : [
    join(dirname(mods), 'StardewModdingAPI'),
    join(dirname(mods), 'StardewModdingAPI.exe'),
    join(dirname(dirname(mods)), 'StardewModdingAPI'),
  ].find((path) => existsSync(path)) ?? null;
  const stardewAgents = existsSync(profilesRoot) ? readdirSync(profilesRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => ({ agentId: d.name, profileDir: join(profilesRoot, d.name), ready: existsSync(join(profilesRoot, d.name, 'Mods')) })) : [];
  const terrariaCandidates = platform === 'darwin'
    ? [join(homedir, 'Library/Application Support/Steam/steamapps/common/tModLoader/tModLoader.app/Contents/MacOS/tModLoaderServer')]
    : platform === 'win32'
      ? ['C:\\Program Files (x86)\\Steam\\steamapps\\common\\tModLoader\\tModLoaderServer.exe']
      : [join(homedir, '.steam/steam/steamapps/common/tModLoader/tModLoaderServer')];
  const terraria = terrariaCandidates.find((path) => existsSync(path)) ?? null;
  const dstCandidates = platform === 'darwin'
    ? [join(homedir, "Library/Application Support/Steam/steamapps/common/Don't Starve Together Dedicated Server/bin/dontstarve_dedicated_server_nullrenderer")]
    : platform === 'win32'
      ? ["C:\\Program Files (x86)\\Steam\\steamapps\\common\\Don't Starve Together Dedicated Server\\bin\\dontstarve_dedicated_server_nullrenderer.exe"]
      : [join(homedir, ".steam/steam/steamapps/common/Don't Starve Together Dedicated Server/bin/dontstarve_dedicated_server_nullrenderer")];
  const dst = dstCandidates.find((path) => existsSync(path)) ?? null;
  return [
    { gameId: 'stardew', detected: smapi !== null && mods !== null, executable: smapi, detail: mods === null ? '未找到 StarDew Mods 目录' : `Mods=${mods}`, agents: stardewAgents },
    { gameId: 'terraria', detected: terraria !== null, executable: terraria, detail: terraria === null ? '未找到 tModLoaderServer；请确认 Steam 安装' : `tModLoaderServer=${terraria}`, agents: [] },
    { gameId: 'dst', detected: dst !== null, executable: dst, detail: dst === null ? "未找到 DST 专用服；cluster_token 需 Klei 账号生成" : `DST=${dst}；仍需 cluster_token 与 sidecar`, agents: [] },
  ];
}

export function spawnGameProcess(executable: string, args: string[], cwd?: string, spawnImpl: typeof spawn = spawn): ChildProcess {
  return spawnImpl(executable, args, { cwd, stdio: 'ignore', detached: true });
}
