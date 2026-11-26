/**
 * V2-P3-05 星露谷一键启动器（主进程）。
 *
 * 目标：用户点一次「启动星露谷」，鲸屿负责找到安装、优先用 SMAPI 拉起游戏（保证 Mod 被加载），
 * 然后轮询 BWF MCP 端口，直到 `get_state` 真实应答或超时。
 *
 * 铁律：
 *   - 只有 MCP `get_state` 正常应答才把状态置为 `ready`，绝不「按时间猜」。
 *   - 端口一律用 `127.0.0.1`（macOS 的 `localhost` 会先解析到 `::1`，BWF 只注册 IPv4，见 T-M6-74）。
 *   - 游戏已在运行（进程或端口在）时不重复启动。
 *   - 子进程必须 detached + unref：鲸屿退出不能把游戏一起带走。
 *   - 不做任何合成键鼠输入；BWF 提供 `load_save` 时经 MCP 调用，否则如实提示「请在标题画面选择存档」。
 *
 * 启动方式取舍（2026-11-26 真机实测结论见 docs/v2/evidence/P3-stardew-launcher-verification.md）：
 *   主方式 smapi —— 直接 spawn `Contents/MacOS/StardewModdingAPI`，不经过 Terminal，进程树干净；
 *   回退 steam —— `open steam://rungameid/413150`，依赖 Steam 的 StardewValley 启动脚本指向 SMAPI。
 */
import { execFile as nodeExecFile, spawn as nodeSpawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir as osHomedir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_BWF_MCP_PORT,
  StardewLaunchOptionsSchema,
  type StardewInstallInfo,
  type StardewLaunchOptions,
  type StardewLaunchState,
  type StardewLaunchStatus,
  type StardewLaunchStrategy,
} from '@workbench/shared-protocol';
import { gameExecutableDir, guessGameRootDirs, guessModsDirs, guessSmapiBinaries } from '@workbench/stardew-mods';
import { probeGameHealth } from './game-health';

export const STARDEW_STEAM_APP_ID = '413150';
export const DEFAULT_LAUNCH_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 2_000;
const HEALTH_TIMEOUT_MS = 4_000;

type HealthStatus = 'online' | 'reachable' | 'offline';

export interface LaunchProbeResult {
  status: HealthStatus;
  detail: string;
  error?: string;
}

/** 可注入依赖：单测全部用假实现，不碰真实进程/网络。 */
export interface StardewLauncherDeps {
  platform?: NodeJS.Platform;
  homedir?: string;
  exists?: (path: string) => boolean;
  readFile?: (path: string) => string;
  spawnImpl?: typeof nodeSpawn;
  execFileImpl?: typeof nodeExecFile;
  fetchImpl?: typeof fetch;
  probe?: (endpoint: string, timeoutMs: number) => Promise<LaunchProbeResult>;
  processRunning?: () => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

function defaultProbe(endpoint: string, timeoutMs: number): Promise<LaunchProbeResult> {
  return probeGameHealth('stardew', { endpoint, timeoutMs }).then((report) => ({
    status: report.status,
    detail: report.detail,
    ...(report.error === undefined ? {} : { error: report.error }),
  }));
}

function runExecFile(
  impl: typeof nodeExecFile,
  file: string,
  args: string[],
  timeout = 3_000,
): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    try {
      impl(file, args, { timeout }, (error, stdout) => {
        resolve({ ok: error === null, stdout: String(stdout ?? '') });
      });
    } catch {
      resolve({ ok: false, stdout: '' });
    }
  });
}

/** Steam 安装清单（用于环境探测展示，不参与启动决策）。 */
export function steamAppManifestPath(platform: NodeJS.Platform, home: string): string {
  if (platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'Steam', 'steamapps', `appmanifest_${STARDEW_STEAM_APP_ID}.acf`);
  }
  if (platform === 'win32') {
    return `C:\\Program Files (x86)\\Steam\\steamapps\\appmanifest_${STARDEW_STEAM_APP_ID}.acf`;
  }
  return join(home, '.steam', 'steam', 'steamapps', `appmanifest_${STARDEW_STEAM_APP_ID}.acf`);
}

/** 探测安装布局（纯函数式，所有 fs 访问可注入）。 */
export function detectStardewInstall(deps: StardewLauncherDeps = {}): StardewInstallInfo {
  const platform = deps.platform ?? process.platform;
  const home = deps.homedir ?? osHomedir();
  const exists = deps.exists ?? existsSync;
  const modsCandidates = guessModsDirs(platform, home);
  const modsDir = modsCandidates.find((candidate) => exists(candidate)) ?? modsCandidates[0] ?? '';
  const steamAppPresent = exists(steamAppManifestPath(platform, home));

  for (const gameRoot of guessGameRootDirs(platform, home)) {
    if (!exists(gameRoot)) continue;
    const executableDir = gameExecutableDir(platform, gameRoot);
    const smapiCandidate = guessSmapiBinaries(platform, gameRoot)[0] ?? '';
    return {
      gameInstalled: true,
      smapiInstalled: smapiCandidate !== '' && exists(smapiCandidate),
      bwfInstalled: modsDir !== '' && exists(join(modsDir, 'BlindWhaleFarmer', 'manifest.json')),
      steamAppPresent,
      gameDir: gameRoot,
      executableDir,
      smapiBinary: smapiCandidate,
      modsDir,
    };
  }

  return {
    gameInstalled: false,
    smapiInstalled: false,
    bwfInstalled: false,
    steamAppPresent,
    gameDir: '',
    executableDir: '',
    smapiBinary: '',
    modsDir,
  };
}

/** 从 BWF `config.json` 读取 McpPort；读不到就用默认 18088。 */
export function resolveBwfPort(
  modsDir: string,
  deps: Pick<StardewLauncherDeps, 'exists' | 'readFile'> = {},
): number {
  const exists = deps.exists ?? existsSync;
  const readFile = deps.readFile ?? ((path: string) => readFileSync(path, 'utf8'));
  if (modsDir === '') return DEFAULT_BWF_MCP_PORT;
  const configPath = join(modsDir, 'BlindWhaleFarmer', 'config.json');
  if (!exists(configPath)) return DEFAULT_BWF_MCP_PORT;
  try {
    const parsed = JSON.parse(readFile(configPath)) as { McpPort?: unknown };
    const port = Number(parsed.McpPort);
    if (Number.isInteger(port) && port >= 1024 && port <= 65535) return port;
  } catch {
    /* 配置损坏 → 默认端口，启动器后续会用真实探活结果说话 */
  }
  return DEFAULT_BWF_MCP_PORT;
}

/** 用 MCP tools/call 调 BWF 的 load_save（不经过适配器白名单，避免工具枚举差异）。 */
async function requestLoadSave(
  endpoint: string,
  fetchImpl: typeof fetch,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now() % 1_000_000,
        method: 'tools/call',
        params: { name: 'load_save', arguments: {} },
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const raw = await response.text();
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}: ${raw.slice(0, 160)}` };
    // MCP 响应可能是纯 JSON 或 SSE；只要出现 error 字段就如实判失败。
    if (/"error"\s*:\s*\{/.test(raw)) {
      const message = /"message"\s*:\s*"([^"]*)"/.exec(raw)?.[1] ?? 'MCP 返回 error';
      return { ok: false, error: message };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function emptyInstall(): StardewInstallInfo {
  return {
    gameInstalled: false,
    smapiInstalled: false,
    bwfInstalled: false,
    steamAppPresent: false,
    gameDir: '',
    executableDir: '',
    smapiBinary: '',
    modsDir: '',
  };
}

function baseStatus(): StardewLaunchStatus {
  return {
    state: 'not_installed',
    install: emptyInstall(),
    strategy: null,
    fallbackStrategy: null,
    endpoint: `http://127.0.0.1:${DEFAULT_BWF_MCP_PORT}/mcp`,
    mcpPort: DEFAULT_BWF_MCP_PORT,
    gameRunning: false,
    saveLoadRequested: false,
    autoLoadSave: true,
    attempts: 0,
    startedAt: null,
    elapsedMs: 0,
    timeoutMs: DEFAULT_LAUNCH_TIMEOUT_MS,
    message: '尚未探测安装',
    hint: '',
  };
}

export interface StardewLauncher {
  launch(options?: StardewLaunchOptions): Promise<StardewLaunchStatus>;
  status(): StardewLaunchStatus;
  cancel(): StardewLaunchStatus;
  dispose(): void;
}

class DefaultStardewLauncher implements StardewLauncher {
  private readonly deps: Required<Pick<StardewLauncherDeps, 'platform' | 'homedir' | 'exists' | 'readFile' | 'spawnImpl' | 'execFileImpl' | 'fetchImpl' | 'probe' | 'sleep' | 'now'>> & {
    processRunning: () => Promise<boolean>;
  };
  private statusValue: StardewLaunchStatus = baseStatus();
  private cancelled = false;
  private saveLoadAttempted = false;
  private loopToken = 0;

  constructor(deps: StardewLauncherDeps = {}) {
    this.deps = {
      platform: deps.platform ?? process.platform,
      homedir: deps.homedir ?? osHomedir(),
      exists: deps.exists ?? existsSync,
      readFile: deps.readFile ?? ((path: string) => readFileSync(path, 'utf8')),
      spawnImpl: deps.spawnImpl ?? nodeSpawn,
      execFileImpl: deps.execFileImpl ?? nodeExecFile,
      fetchImpl: deps.fetchImpl ?? fetch,
      probe: deps.probe ?? defaultProbe,
      sleep: deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms))),
      now: deps.now ?? Date.now,
      processRunning: deps.processRunning ?? (() => this.defaultProcessRunning()),
    };
  }

  status(): StardewLaunchStatus {
    return { ...this.statusValue, install: { ...this.statusValue.install } };
  }

  cancel(): StardewLaunchStatus {
    this.cancelled = true;
    this.loopToken += 1;
    if (this.statusValue.state === 'launching' || this.statusValue.state === 'waiting_mcp') {
      this.patch({ state: 'failed', message: '已取消启动等待（游戏进程如已拉起不会被强行关闭）', hint: '' });
    }
    return this.status();
  }

  dispose(): void {
    this.cancelled = true;
    this.loopToken += 1;
  }

  async launch(options: StardewLaunchOptions = {}): Promise<StardewLaunchStatus> {
    if (this.statusValue.state === 'launching' || this.statusValue.state === 'waiting_mcp') {
      return this.status();
    }

    const parsed = StardewLaunchOptionsSchema.safeParse(options);
    const opts = parsed.success ? parsed.data : {};
    const install = detectStardewInstall(this.deps);
    const mcpPort = opts.port ?? resolveBwfPort(install.modsDir, this.deps);
    const timeoutMs = opts.timeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS;
    const autoLoadSave = opts.autoLoadSave ?? true;
    const strategy = opts.strategy ?? 'auto';

    this.cancelled = false;
    this.saveLoadAttempted = false;
    this.loopToken += 1;
    this.statusValue = {
      ...baseStatus(),
      install,
      endpoint: `http://127.0.0.1:${mcpPort}/mcp`,
      mcpPort,
      timeoutMs,
      autoLoadSave,
      message: '正在探测安装…',
    };

    if (!install.gameInstalled) {
      this.patch({
        state: 'not_installed',
        message: `未找到《星露谷物语》安装目录（已检查 ${guessGameRootDirs(this.deps.platform, this.deps.homedir).join('、') || '当前平台默认路径'}）`,
        hint: '请先在 Steam 安装游戏；若装在非默认 Steam 库，请把游戏目录加入默认库或等待后续支持自定义路径。',
      });
      return this.status();
    }
    if (!install.smapiInstalled && strategy !== 'steam') {
      this.patch({
        state: 'failed',
        message: '已找到游戏，但未检测到 SMAPI 可执行文件',
        hint: `请先把 SMAPI 安装到 ${install.executableDir}；没有 SMAPI 时启动不会加载 BWF Mod。`,
      });
      return this.status();
    }

    // ① 已经在跑：先看 MCP，健康就直接 ready；否则只等待，不重复启动。
    const initial = await this.deps.probe(this.statusValue.endpoint, HEALTH_TIMEOUT_MS);
    if (initial.status === 'online') {
      this.patch({ state: 'ready', gameRunning: true, message: `《星露谷物语》已在运行：${initial.detail}`, hint: '' });
      return this.status();
    }
    const running = initial.status === 'reachable' || (await this.deps.processRunning());
    if (running) {
      this.patch({
        state: 'waiting_mcp',
        gameRunning: true,
        message: initial.status === 'reachable'
          ? '游戏已在运行，BWF MCP 已应答但游戏侧未就绪（可能在标题画面），继续等待…'
          : '检测到 SMAPI 进程已在运行，不重复启动，等待 MCP 就绪…',
      });
      void this.pollUntilReady(timeoutMs);
      return this.status();
    }

    // ② 启动：auto = 先 SMAPI，失败回退 Steam。
    const attempts: StardewLaunchStrategy[] = strategy === 'auto'
      ? ['smapi', 'steam']
      : [strategy];
    let lastError = '';
    for (const attempt of attempts) {
      const spawned = await this.spawnStrategy(attempt, install);
      if (spawned.ok) {
        this.patch({
          state: 'launching',
          gameRunning: true,
          strategy: attempt,
          fallbackStrategy: attempt !== attempts[0] ? attempts[0] ?? null : null,
          startedAt: this.deps.now(),
          message: attempt === 'smapi'
            ? `已通过 SMAPI 启动（pid ${spawned.pid ?? '—'}），等待 MCP 端口 ${mcpPort}…`
            : '已通过 Steam 启动，等待 MCP 端口…',
          hint: '',
        });
        void this.pollUntilReady(timeoutMs);
        return this.status();
      }
      lastError = spawned.error ?? '未知错误';
    }

    this.patch({
      state: 'failed',
      message: `启动失败：${lastError}`,
      hint: '可直接运行游戏目录里的 StardewModdingAPI，或检查 Steam 是否已登录。',
    });
    return this.status();
  }

  private patch(next: Partial<StardewLaunchStatus>): void {
    this.statusValue = {
      ...this.statusValue,
      ...next,
      elapsedMs: this.statusValue.startedAt === null ? 0 : Math.max(0, this.deps.now() - this.statusValue.startedAt),
    };
  }

  private async defaultProcessRunning(): Promise<boolean> {
    if (this.deps.platform === 'win32') {
      const result = await runExecFile(this.deps.execFileImpl, 'tasklist', ['/FI', 'IMAGENAME eq StardewModdingAPI.exe']);
      return result.ok && /StardewModdingAPI\.exe/i.test(result.stdout);
    }
    const result = await runExecFile(this.deps.execFileImpl, 'pgrep', ['-f', 'StardewModdingAPI']);
    return result.ok && result.stdout.trim() !== '';
  }

  private async spawnStrategy(
    strategy: StardewLaunchStrategy,
    install: StardewInstallInfo,
  ): Promise<{ ok: boolean; pid?: number; error?: string }> {
    if (strategy === 'smapi') {
      if (!install.smapiInstalled) return { ok: false, error: 'SMAPI 可执行文件不存在' };
      return this.spawnDetached(install.smapiBinary, [], {
        cwd: install.executableDir,
        env: { ...process.env, SMAPI_NO_TERMINAL: 'true', SMAPI_USE_CURRENT_SHELL: 'true' },
      });
    }
    if (this.deps.platform === 'darwin') {
      return this.spawnDetached('open', [`steam://rungameid/${STARDEW_STEAM_APP_ID}`], {});
    }
    if (this.deps.platform === 'win32') {
      return this.spawnDetached('cmd', ['/c', 'start', '', `steam://rungameid/${STARDEW_STEAM_APP_ID}`], {});
    }
    return this.spawnDetached('xdg-open', [`steam://rungameid/${STARDEW_STEAM_APP_ID}`], {});
  }

  private spawnDetached(
    command: string,
    args: string[],
    options: { cwd?: string; env?: NodeJS.ProcessEnv },
  ): Promise<{ ok: boolean; pid?: number; error?: string }> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: { ok: boolean; pid?: number; error?: string }): void => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      try {
        const child = this.deps.spawnImpl(command, args, {
          ...options,
          detached: true,
          stdio: 'ignore',
        });
        child.once('error', (error: Error) => finish({ ok: false, error: error.message }));
        child.once('spawn', () => finish({ ok: true, ...(child.pid === undefined ? {} : { pid: child.pid }) }));
        // 假 spawn / 极端情况下没有 spawn 事件：下一拍按成功处理，真实错误仍会走 error 分支。
        setTimeout(() => finish({ ok: true, ...(child.pid === undefined ? {} : { pid: child.pid }) }), 300);
        child.unref();
      } catch (error) {
        finish({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    });
  }

  private async pollUntilReady(timeoutMs: number): Promise<void> {
    const token = this.loopToken;
    const deadline = this.deps.now() + timeoutMs;
    let lastStatus: HealthStatus = 'offline';
    let lastDetail = '';

    while (this.loopToken === token && !this.cancelled) {
      const remaining = deadline - this.deps.now();
      if (remaining <= 0) {
        this.patch({
          state: 'timeout',
          gameRunning: true,
          message: `等待 BWF MCP 就绪超时（${Math.round(timeoutMs / 1000)}s）`,
          hint: lastStatus === 'reachable'
            ? '游戏已连上 MCP 但未进入存档：请在游戏标题画面手动选择存档（本次未能自动读档）。'
            : `MCP 端口 ${this.statusValue.mcpPort} 一直未监听：确认 SMAPI 控制台显示 BWF 已加载、端口与 Mod 配置一致。`,
        });
        return;
      }

      await this.deps.sleep(Math.min(POLL_INTERVAL_MS, remaining));
      if (this.loopToken !== token || this.cancelled) return;

      const probe = await this.deps.probe(this.statusValue.endpoint, Math.min(HEALTH_TIMEOUT_MS, Math.max(500, remaining)));
      if (this.loopToken !== token || this.cancelled) return;
      this.statusValue.attempts += 1;
      lastStatus = probe.status;
      lastDetail = probe.detail;

      if (probe.status === 'online') {
        this.patch({
          state: 'ready',
          gameRunning: true,
          message: `BWF MCP 已就绪：${probe.detail}`,
          hint: '',
        });
        return;
      }

      if (probe.status === 'reachable') {
        this.patch({
          state: 'waiting_mcp',
          gameRunning: true,
          message: this.saveLoadAttempted
            ? 'MCP 已应答；已请求载入最近存档，等待进入游戏…'
            : `MCP 已应答但游戏侧未就绪（${probe.detail}），可能在标题画面…`,
        });
        if (this.statusValue.autoLoadSave && !this.saveLoadAttempted) {
          this.saveLoadAttempted = true;
          const result = await requestLoadSave(this.statusValue.endpoint, this.deps.fetchImpl);
          if (this.loopToken !== token || this.cancelled) return;
          if (result.ok) {
            this.patch({ saveLoadRequested: true, message: '已请求 BWF 载入最近存档，等待游戏进入存档（约 15s）…' });
          } else {
            this.patch({ message: `自动读档失败（${result.error ?? '未知原因'}），等待手动选择存档…` });
          }
        }
        continue;
      }

      this.patch({
        state: 'waiting_mcp',
        gameRunning: true,
        message: `游戏已启动，等待 BWF MCP 端口 ${this.statusValue.mcpPort}…（${lastDetail || '尚未监听'}）`,
      });
    }
  }
}

/** 生产用启动器。 */
export function createStardewLauncher(deps: StardewLauncherDeps = {}): StardewLauncher {
  return new DefaultStardewLauncher(deps);
}

/**
 * E2E 专用假启动器（仅在 PET_STAGE_E2E=1 时装配）：
 * 不 spawn、不联网，按固定节奏推进 launching → waiting_mcp → ready，用于验证 UI 状态机。
 */
export function createFakeStardewLauncher(deps: { stepMs?: number } = {}): StardewLauncher {
  const stepMs = deps.stepMs ?? 350;
  const install: StardewInstallInfo = {
    gameInstalled: true,
    smapiInstalled: true,
    bwfInstalled: true,
    steamAppPresent: true,
    gameDir: '/tmp/whale-e2e/Stardew Valley',
    executableDir: '/tmp/whale-e2e/Stardew Valley/Contents/MacOS',
    smapiBinary: '/tmp/whale-e2e/Stardew Valley/Contents/MacOS/StardewModdingAPI',
    modsDir: '/tmp/whale-e2e/Stardew Valley/Contents/MacOS/Mods',
  };
  let status: StardewLaunchStatus = {
    ...baseStatus(),
    install,
    message: 'E2E 假启动器待命',
  };
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const schedule = (fn: () => void, ms: number): void => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      fn();
    }, ms);
    timers.add(timer);
  };
  return {
    launch(options: StardewLaunchOptions = {}): Promise<StardewLaunchStatus> {
      timers.forEach((timer) => clearTimeout(timer));
      timers.clear();
      status = {
        ...status,
        state: 'launching',
        strategy: 'smapi',
        gameRunning: true,
        startedAt: Date.now(),
        message: 'E2E：已通过 SMAPI 启动（假）',
        hint: '',
        timeoutMs: options.timeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS,
      };
      schedule(() => {
        status = { ...status, state: 'waiting_mcp', message: 'E2E：等待 BWF MCP（假）' };
      }, stepMs);
      schedule(() => {
        status = { ...status, state: 'ready', message: 'E2E：BWF MCP 已就绪（假）' };
      }, stepMs * 3);
      return Promise.resolve({ ...status, install: { ...status.install } });
    },
    status(): StardewLaunchStatus {
      return { ...status, install: { ...status.install } };
    },
    cancel(): StardewLaunchStatus {
      timers.forEach((timer) => clearTimeout(timer));
      timers.clear();
      status = { ...status, state: 'failed', message: 'E2E：已取消（假）' };
      return { ...status, install: { ...status.install } };
    },
    dispose(): void {
      timers.forEach((timer) => clearTimeout(timer));
      timers.clear();
    },
  };
}

/** 供 UI/文档复用的状态中文名（未知状态原样返回，不臆造）。 */
export const STARDEW_LAUNCH_STATE_LABEL: Record<StardewLaunchState, string> = {
  not_installed: '未安装',
  launching: '正在启动',
  waiting_mcp: '等待游戏就绪',
  ready: '已就绪',
  timeout: '等待超时',
  failed: '启动失败',
};
