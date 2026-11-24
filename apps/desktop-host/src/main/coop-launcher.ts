/** 三游戏联机一键启动（T-M6-42 / T-M6-47）：路径探测、星露谷隔离 profile、泰拉专用服与 DST 集群。 */
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { guessModsDirs } from '@workbench/stardew-mods';
import { scanModsDir } from '@workbench/stardew-mods';

export interface LaunchStatus {
  gameId: 'stardew' | 'terraria' | 'dst';
  detected: boolean;
  executable: string | null;
  /** 客户端可执行文件（泰拉瑞亚 AI 客户端尝试拉起时需要；星露谷/饥荒为 null） */
  clientExecutable?: string | null;
  /** 泰拉瑞亚桥接 Mod 探测结果 */
  bridge?: TerrariaBridgeInfo;
  /** DST 集群根目录（~/.klei/DoNotStarveTogether 等） */
  clusterRoot?: string;
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
    // WhaleIsleAvatar 必须实体复制：每个 AI 队友要写自己的 active-avatar.json（T-M6-62）
    if (entry.name === bwf.folderName || entry.name === 'WhaleIsleAvatar') continue;
    if (existsSync(target)) continue;
    try { symlinkSync(source, target, entry.isDirectory() ? 'dir' : 'file'); } catch { /* 平台不支持符号链接时跳过，不阻塞 BWF */ }
  }
  const sourceAvatar = join(input.modsDir, 'WhaleIsleAvatar');
  if (existsSync(join(sourceAvatar, 'manifest.json'))) {
    cpSync(sourceAvatar, join(profileModsDir, 'WhaleIsleAvatar'), { recursive: true, force: true });
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
  const terrariaClientCandidates = terrariaCandidates.map((path) => path.replace(/tModLoaderServer(\.exe)?$/, 'tModLoader$1'));
  const terrariaClient = terrariaClientCandidates.find((path) => existsSync(path)) ?? null;
  const terrariaBridge = detectTerrariaBridge(platform, homedir);
  const clusterRoot = platform === 'win32'
    ? join(homedir, 'Documents/Klei/DoNotStarveTogether')
    : join(homedir, '.klei/DoNotStarveTogether');
  const dstCandidates = platform === 'darwin'
    ? [join(homedir, "Library/Application Support/Steam/steamapps/common/Don't Starve Together Dedicated Server/bin/dontstarve_dedicated_server_nullrenderer")]
    : platform === 'win32'
      ? ["C:\\Program Files (x86)\\Steam\\steamapps\\common\\Don't Starve Together Dedicated Server\\bin\\dontstarve_dedicated_server_nullrenderer.exe"]
      : [join(homedir, ".steam/steam/steamapps/common/Don't Starve Together Dedicated Server/bin/dontstarve_dedicated_server_nullrenderer")];
  const dst = dstCandidates.find((path) => existsSync(path)) ?? null;
  return [
    { gameId: 'stardew', detected: smapi !== null && mods !== null, executable: smapi, clientExecutable: null, detail: mods === null ? '未找到 StarDew Mods 目录' : `Mods=${mods}`, agents: stardewAgents },
    {
      gameId: 'terraria',
      detected: terraria !== null,
      executable: terraria,
      clientExecutable: terrariaClient,
      bridge: terrariaBridge,
      detail: terraria === null
        ? '未找到 tModLoaderServer；请确认 Steam 安装'
        : `tModLoaderServer=${terraria}${terrariaBridge.detected ? ' · 桥接 Mod 已就绪' : ' · 缺 terraria-bridge.tmod'}`,
      agents: [],
    },
    {
      gameId: 'dst',
      detected: dst !== null,
      executable: dst,
      clientExecutable: null,
      clusterRoot,
      detail: dst === null
        ? '未找到 DST 专用服；cluster_token 需 Klei 账号生成'
        : `DST=${dst}；集群目录 ${clusterRoot}`,
      agents: [],
    },
  ];
}

export function spawnGameProcess(executable: string, args: string[], cwd?: string, spawnImpl: typeof spawn = spawn): ChildProcess {
  return spawnImpl(executable, args, { cwd, stdio: 'ignore', detached: true });
}

// ───────────────────────── 泰拉瑞亚（T-M6-47） ─────────────────────────

export interface TerrariaBridgeInfo {
  detected: boolean;
  /** terraria-bridge.tmod / 源码目录路径 */
  path: string | null;
  detail: string;
}

/** 探测 tModLoader 的 Mods 目录与 terraria-bridge（编译产物 .tmod 或源码目录）。 */
export function detectTerrariaBridge(platform: NodeJS.Platform, homedir: string): TerrariaBridgeInfo {
  const roots = platform === 'darwin'
    ? [join(homedir, 'Library/Application Support/Terraria/tModLoader/Mods')]
    : platform === 'win32'
      ? [join(homedir, 'Documents/My Games/Terraria/tModLoader/Mods')]
      : [join(homedir, '.local/share/Terraria/tModLoader/Mods')];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const entries = readdirSync(root);
    const tmod = entries.find((entry) => /terraria-bridge.*\.tmod$/i.test(entry));
    if (tmod !== undefined) return { detected: true, path: join(root, tmod), detail: `已安装 ${tmod}` };
    const folder = entries.find((entry) => /^terraria-bridge$/i.test(entry));
    if (folder !== undefined) return { detected: true, path: join(root, folder), detail: '源码目录存在但未编译为 .tmod' };
  }
  return { detected: false, path: null, detail: '未找到 terraria-bridge.tmod（先在 tModLoader 内构建/订阅）' };
}

/** tModLoaderServer 启动参数：端口 / 世界 / 自动创建（参数数组，绝不拼 shell 字符串）。 */
export function terrariaServerArgs(input: { port?: number; worldPath?: string; worldName?: string; autocreate?: boolean }): string[] {
  const port = safePort(input.port ?? 7777);
  const worldName = (input.worldName ?? 'WhaleIsle').replace(/[^A-Za-z0-9_-]/g, '') || 'WhaleIsle';
  const args = ['-port', String(port), '-worldname', worldName, '-noupnp'];
  if (input.worldPath !== undefined) args.push('-world', resolve(input.worldPath));
  else if (input.autocreate !== false) args.push('-autocreate', '1');
  return args;
}

export interface TerrariaLaunchResult {
  ok: boolean;
  /** 分配给 AI 桥接的端口（与联机端点保持一致，互不冲突） */
  aiPorts: number[];
  pid?: number;
  bridge: TerrariaBridgeInfo;
  error?: string;
}

/**
 * 拉起本地 tModLoader 专用服（:7777），并把每个 AI 队友的桥接端口写入隔离 profile 供排查。
 * 真机限制如实回报：每只 AI 仍需独立 tModLoader 客户端；本地服本身只提供世界。
 */
export function launchTerrariaServer(options: {
  executable: string | null;
  bridge: TerrariaBridgeInfo;
  profilesRoot: string;
  agents: Array<{ agentId: string; port: number }>;
  port?: number;
  worldPath?: string;
  spawnImpl?: typeof spawn;
}): TerrariaLaunchResult {
  const aiPorts = options.agents.map((agent) => safePort(agent.port));
  for (const agent of options.agents) {
    const dir = join(resolve(options.profilesRoot), safeAgentId(agent.agentId));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'bridge-port.txt'), `${safePort(agent.port)}\n`, 'utf8');
  }
  if (options.executable === null) {
    return { ok: false, aiPorts, bridge: options.bridge, error: '未找到 tModLoaderServer（请确认 Steam 已安装 tModLoader）' };
  }
  if (!options.bridge.detected) return { ok: false, aiPorts, bridge: options.bridge, error: options.bridge.detail };
  const child = spawnGameProcess(options.executable, terrariaServerArgs({ port: options.port ?? 7777, ...(options.worldPath === undefined ? {} : { worldPath: options.worldPath }) }), dirname(options.executable), options.spawnImpl ?? spawn);
  child.unref();
  return { ok: true, aiPorts, ...(child.pid === undefined ? {} : { pid: child.pid }), bridge: options.bridge };
}

/** 尝试拉起 tModLoader 客户端并直连本机专用服（每只 AI 一个客户端实例 / 独立 Steam 账号）。 */
export function launchTerrariaClient(options: {
  clientExecutable: string | null;
  profilesRoot: string;
  agentId: string;
  bridgePort: number;
  serverPort?: number;
  spawnImpl?: typeof spawn;
}): { ok: boolean; pid?: number; bridgePort: number; error?: string } {
  const bridgePort = safePort(options.bridgePort);
  const dir = join(resolve(options.profilesRoot), safeAgentId(options.agentId));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'bridge-port.txt'), `${bridgePort}\n`, 'utf8');
  if (options.clientExecutable === null) {
    return { ok: false, bridgePort, error: '未找到 tModLoader 客户端可执行文件；请手动登录该 AI 的 Steam 账号后连入 127.0.0.1:7777' };
  }
  const child = spawnGameProcess(
    options.clientExecutable,
    ['-join', '127.0.0.1', '-port', String(safePort(options.serverPort ?? 7777))],
    dirname(options.clientExecutable),
    options.spawnImpl ?? spawn,
  );
  child.unref();
  return { ok: true, ...(child.pid === undefined ? {} : { pid: child.pid }), bridgePort };
}

// ───────────────────────── 饥荒 DST（T-M6-47） ─────────────────────────

/** cluster_token 只接受 Klei 生成的单行 token；不 trim 内部空白、不写日志。 */
export function assertClusterToken(token: string): string {
  const value = token.trim();
  if (value === '') throw new Error('cluster_token 不能为空');
  if (!/^[A-Za-z0-9+/=_-]{8,512}$/.test(value)) throw new Error('cluster_token 含非法字符（只允许 Klei 生成的 base64 风格串）');
  return value;
}

/** 安全落盘 cluster_token.txt（0600），绝不把 token 写进日志或返回值。 */
export function writeDstClusterToken(clusterDir: string, token: string): { ok: true; path: string } {
  const value = assertClusterToken(token);
  const dir = resolve(clusterDir);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'cluster_token.txt');
  writeFileSync(path, value, { encoding: 'utf8', mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* Windows 无 POSIX 权限，忽略 */ }
  const ini = join(dir, 'cluster.ini');
  if (!existsSync(ini)) {
    writeFileSync(ini, [
      '[GAMEPLAY]',
      'game_mode = survival',
      'max_players = 4',
      'pvp = false',
      'pause_when_empty = false',
      '',
      '[NETWORK]',
      'cluster_name = Whale Isle',
      'cluster_password =',
      'offline_cluster = true',
      '',
    ].join('\n'), 'utf8');
  }
  return { ok: true, path };
}

function luaString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]/g, ' ')}"`;
}

/**
 * 写 `Master/modoverrides.lua`：受控角色 UserID 逗号串联 + 与 sidecar 共享的 pair_token。
 * 同一 token 同时用于 sidecar 环境变量，保证两侧一致；token 不回传渲染层。
 */
export function writeDstModOverrides(options: {
  clusterDir: string;
  controlledUserIds: string[];
  pairToken?: string;
  endpoint?: string;
}): { ok: true; path: string; pairToken: string; controlled: string[] } {
  const controlled = options.controlledUserIds
    .map((id) => id.trim())
    .filter((id) => id !== '')
    .map((id) => {
      if (!/^[A-Za-z0-9_:-]{1,64}$/.test(id)) throw new Error(`非法 Klei UserID：${id}`);
      return id;
    });
  const token = options.pairToken === undefined || options.pairToken === '' ? randomUUID().replace(/-/g, '') : assertClusterToken(options.pairToken);
  const master = join(resolve(options.clusterDir), 'Master');
  mkdirSync(master, { recursive: true });
  const path = join(master, 'modoverrides.lua');
  const body = [
    '-- 由 Whale Isle 联机向导生成（T-M6-47）；再次保存会整文件覆盖。',
    'return {',
    '  ["dst-bridge"] = {',
    '    enabled = true,',
    '    configuration_options = {',
    `      bridge_endpoint = ${luaString(options.endpoint ?? 'http://127.0.0.1:18100')},`,
    `      pair_token = ${luaString(token)},`,
    '      tick_interval = 2,',
    `      ai_player_userid = ${luaString(controlled.join(','))},`,
    '    },',
    '  },',
    '}',
    '',
  ].join('\n');
  writeFileSync(path, body, 'utf8');
  return { ok: true, path, pairToken: token, controlled };
}

export interface DstLaunchOptions {
  clusterDir: string;
  controlledUserIds: string[];
  pairToken?: string;
  /** 专用服二进制（null 表示只起 sidecar） */
  serverExecutable: string | null;
  /** sidecar 入口（repo 内 dist/index.js 或 src/index.ts） */
  sidecarEntry: string;
  /** 运行 sidecar 的 node 可执行文件（Electron 主进程可传 process.execPath 并开 runAsNode） */
  nodeExecutable: string;
  /** 用 ELECTRON_RUN_AS_NODE=1 让 Electron 二进制充当 node（打包/开发都可用） */
  runAsNode?: boolean;
  port?: number;
  spawnImpl?: typeof spawn;
}

export interface DstLaunchResult {
  ok: boolean;
  clusterDir: string;
  modOverridesPath: string;
  controlled: string[];
  serverPid?: number;
  sidecarPid?: number;
  error?: string;
}

/** 一键：写 token + modoverrides → 拉专用服 + 单 Sidecar（:18100 多 Agent 复用）。 */
export function launchDstCluster(options: DstLaunchOptions): DstLaunchResult {
  const port = safePort(options.port ?? 18100);
  const overrides = writeDstModOverrides({
    clusterDir: options.clusterDir,
    controlledUserIds: options.controlledUserIds,
    ...(options.pairToken === undefined ? {} : { pairToken: options.pairToken }),
  });
  const spawnImpl = options.spawnImpl ?? spawn;
  const clusterDir = resolve(options.clusterDir);
  const env = {
    ...process.env,
    DST_PAIR_TOKEN: overrides.pairToken,
    DST_PORT: String(port),
    DST_CLUSTER_DIR: clusterDir,
    ...(options.runAsNode === true ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    ...(options.serverExecutable === null ? {} : { DST_BINARY: options.serverExecutable, DST_AUTOSTART: '1' }),
  };
  let serverPid: number | undefined;
  if (options.serverExecutable !== null) {
    const server = spawnImpl(options.serverExecutable, ['-cluster', 'WhaleIsle', '-shard', 'Master'], { cwd: dirname(options.serverExecutable), stdio: 'ignore', detached: true, env });
    server.unref();
    serverPid = server.pid;
  }
  const sidecar = spawnImpl(options.nodeExecutable, [options.sidecarEntry], { stdio: 'ignore', detached: true, env });
  sidecar.unref();
  return {
    ok: true,
    clusterDir,
    modOverridesPath: overrides.path,
    controlled: overrides.controlled,
    ...(serverPid === undefined ? {} : { serverPid }),
    ...(sidecar.pid === undefined ? {} : { sidecarPid: sidecar.pid }),
  };
}
