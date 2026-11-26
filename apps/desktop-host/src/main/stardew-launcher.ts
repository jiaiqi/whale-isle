/**
 * V2-P3-05 / V2-P3-07 星露谷启动器与从 0 建档/建角色编排器（主进程）。
 *
 * 职责：
 *   - 支持续玩已有档 (`load_only`)、无档自动建档 (`continue_or_create`)、强制从 0 新建 (`always_new`) 与人工标题画面 (`manual`)；
 *   - 支持单机 (`singleplayer`) 与联机房主 (`coop_host`)，房主模式必须等到 `lan.lanListening === true` 才判定 `ready`；
 *   - 默认尊重存储模式（`isolated` 仅注入 XDG_CONFIG_HOME / XDG_DATA_HOME，不动 HOME，禁回退 Steam）；
 *   - 语言双保险：隔离目录预先同步 `<languageCode>` 到隔离 `startup_preferences`，并注入 `WHALE_STARDEW_LANG` 环境变量；
 *   - 不依赖前台 CGEvent 键鼠点击，全程通过 BWF MCP `create_new_save` / `load_save` 与 `/settings` runtime 快照驱动。
 */
import { execFile as nodeExecFile, spawn as nodeSpawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir as osHomedir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_BWF_MCP_PORT,
  StardewLaunchOptionsSchema,
  type StardewGameMode,
  type StardewInstallInfo,
  type StardewLanHostStatus,
  type StardewLanguageCode,
  type StardewLaunchErrorCode,
  type StardewLaunchOptions,
  type StardewLaunchState,
  type StardewLaunchStatus,
  type StardewLaunchStrategy,
  type StardewNewSaveConfig,
  type StardewSavePolicy,
  type StardewStorageMode,
} from '@workbench/shared-protocol';
import {
  gameExecutableDir, guessGameRootDirs, guessModsDirs, guessSmapiBinaries, isolateDataEnv,
} from '@workbench/stardew-mods';
import { probeBwfRuntime, probeGameHealth, type BwfRuntimeProbe } from './game-health';
import { ensureIsolatedStartupLanguage } from './stardew-launch-prefs';

export const STARDEW_STEAM_APP_ID = '413150';
export const DEFAULT_LAUNCH_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 2_000;
const HEALTH_TIMEOUT_MS = 4_000;
const MAX_CONTROL_RETRIES = 20;

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
  probeRuntime?: (baseUrl: string, timeoutMs: number) => Promise<BwfRuntimeProbe | null>;
  processRunning?: () => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** 创建隔离数据目录（默认递归 mkdir）；单测注入计数替身 */
  ensureDir?: (path: string) => void;
  /** 隔离目录首启语言初始化替身；省略且未替代 ensureDir 时写入隔离 startup_preferences */
  ensureIsolatedLanguage?: (xdgConfigHome: string, language: StardewLanguageCode) => void;
  /** 默认鲸屿隔离根目录（未显式传 isolateDataDir 且 storageMode='isolated' 时启用） */
  defaultIsolateDataDir?: string;
  /** 建档前同步 P2-06 像素形象钩子（写入 active-avatar.json，syncDisplayName=false） */
  syncAvatar?: (input: {
    characterId?: string;
    farmerName: string;
    modsPath?: string;
  }) => Promise<{ ok: boolean; error?: string }> | { ok: boolean; error?: string };
}

function defaultProbe(endpoint: string, timeoutMs: number, fetchImpl?: typeof fetch): Promise<LaunchProbeResult> {
  return probeGameHealth('stardew', {
    endpoint,
    timeoutMs,
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
  }).then((report) => ({
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

interface BwfControlCallResult {
  ok: boolean;
  code: StardewLaunchErrorCode;
  text: string;
  error?: string;
}

function extractRpcFromBody(raw: string): { result?: unknown; error?: unknown } | null {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) {
    try {
      return JSON.parse(trimmed) as { result?: unknown; error?: unknown };
    } catch {
      /* 继续尝试 SSE */
    }
  }
  const lines = raw.split('\n').filter((line) => line.trimStart().startsWith('data:'));
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse((lines[i] ?? '').trimStart().slice(5).trim()) as { result?: unknown; error?: unknown };
    } catch {
      /* 尝试上一行 */
    }
  }
  return null;
}

function classifyBwfControlError(tool: 'load_save' | 'create_new_save', text: string): StardewLaunchErrorCode {
  if (/\[LANGUAGE_LOADING\]|正在加载语言设置/u.test(text)) return 'LANGUAGE_LOADING';
  if (/\[TITLE_NOT_READY\]|不在标题画面|入场动画/u.test(text)) return 'TITLE_NOT_READY';
  if (/\[SAVE_NOT_FOUND\]|没有找到任何存档|没有名字里带/u.test(text)) return 'SAVE_NOT_FOUND';
  if (/\[TOO_MANY_FARMS\]/u.test(text)) return 'TOO_MANY_FARMS';
  if (/\[INVALID_OPTIONS\]/u.test(text)) return 'INVALID_OPTIONS';
  if (/未知控制工具|未知工具|Unknown tool|tool .*not found|not supported/iu.test(text)) return 'BWF_PATCH_MISSING';
  return tool === 'create_new_save' ? 'CREATE_SAVE_FAILED' : 'LOAD_SAVE_FAILED';
}

async function callBwfControlTool(
  endpoint: string,
  tool: 'load_save' | 'create_new_save',
  args: Record<string, unknown>,
  fetchImpl: typeof fetch,
  timeoutMs = 25_000,
): Promise<BwfControlCallResult> {
  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now() % 1_000_000,
        method: 'tools/call',
        params: { name: tool, arguments: args },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const raw = await response.text();
    if (!response.ok) {
      return { ok: false, code: 'MCP_UNREACHABLE', text: '', error: `HTTP ${response.status}: ${raw.slice(0, 160)}` };
    }
    const rpc = extractRpcFromBody(raw);
    if (!rpc) {
      if (/"error"\s*:\s*\{/.test(raw)) {
        const message = /"message"\s*:\s*"([^"]*)"/.exec(raw)?.[1] ?? 'MCP 返回 error';
        return { ok: false, code: classifyBwfControlError(tool, message), text: '', error: message };
      }
      return { ok: true, code: 'NONE', text: raw };
    }
    if (rpc.error != null) {
      const msg = typeof rpc.error === 'object' && rpc.error !== null && 'message' in rpc.error
        ? String((rpc.error as { message: unknown }).message)
        : JSON.stringify(rpc.error);
      return { ok: false, code: classifyBwfControlError(tool, msg), text: msg, error: msg };
    }
    const resObj = rpc.result as { content?: Array<{ text?: string }>; isError?: boolean } | undefined;
    const text = (resObj?.content ?? []).map((item) => item.text ?? '').join('');
    const isFailedText = /^失败：|^错误：/u.test(text);
    if (resObj?.isError === true || isFailedText) {
      return {
        ok: false,
        code: classifyBwfControlError(tool, text),
        text,
        error: text || 'MCP 控制调用失败',
      };
    }
    return { ok: true, code: 'NONE', text };
  } catch (error) {
    return {
      ok: false,
      code: tool === 'create_new_save' ? 'CREATE_SAVE_FAILED' : 'LOAD_SAVE_FAILED',
      text: '',
      error: error instanceof Error ? error.message : String(error),
    };
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
    phase: 'idle',
    errorCode: 'NONE',
    savePolicy: 'load_only',
    gameMode: 'singleplayer',
    storageMode: 'standard',
    language: 'zh',
    createdSaveSlot: null,
    lanHost: null,
  };
}

export interface StardewLauncher {
  launch(options?: StardewLaunchOptions): Promise<StardewLaunchStatus>;
  status(): StardewLaunchStatus;
  cancel(): StardewLaunchStatus;
  dispose(): void;
}

interface ActiveLaunchPlan {
  savePolicy: StardewSavePolicy;
  gameMode: StardewGameMode;
  storageMode: StardewStorageMode;
  language: StardewLanguageCode;
  saveSlotName?: string;
  modsPath?: string;
  newSave?: StardewNewSaveConfig;
  mcpPort: number;
}

const TRANSIENT_RETRY_CODES: ReadonlySet<StardewLaunchErrorCode> = new Set([
  'LANGUAGE_LOADING',
  'TITLE_NOT_READY',
]);

class DefaultStardewLauncher implements StardewLauncher {
  private readonly deps: {
    platform: NodeJS.Platform;
    homedir: string;
    exists: (path: string) => boolean;
    readFile: (path: string) => string;
    spawnImpl: typeof nodeSpawn;
    execFileImpl: typeof nodeExecFile;
    fetchImpl: typeof fetch;
    probe: (endpoint: string, timeoutMs: number) => Promise<LaunchProbeResult>;
    probeRuntime: (baseUrl: string, timeoutMs: number) => Promise<BwfRuntimeProbe | null>;
    processRunning: () => Promise<boolean>;
    sleep: (ms: number) => Promise<void>;
    now: () => number;
    ensureDir: (path: string) => void;
    ensureIsolatedLanguage: (xdgConfigHome: string, language: StardewLanguageCode) => void;
    defaultIsolateDataDir?: string;
    syncAvatar?: StardewLauncherDeps['syncAvatar'];
  };
  private statusValue: StardewLaunchStatus = baseStatus();
  private cancelled = false;
  private saveLoadAttempted = false;
  private switchedToNewSave = false;
  private controlAttempts = 0;
  private avatarSyncedForLaunch = false;
  private loopToken = 0;
  private activePlan: ActiveLaunchPlan | null = null;

  constructor(deps: StardewLauncherDeps = {}) {
    const fetchImpl = deps.fetchImpl ?? fetch;
    this.deps = {
      platform: deps.platform ?? process.platform,
      homedir: deps.homedir ?? osHomedir(),
      exists: deps.exists ?? existsSync,
      readFile: deps.readFile ?? ((path: string) => readFileSync(path, 'utf8')),
      spawnImpl: deps.spawnImpl ?? nodeSpawn,
      execFileImpl: deps.execFileImpl ?? nodeExecFile,
      fetchImpl,
      probe: deps.probe ?? ((endpoint, timeoutMs) => defaultProbe(endpoint, timeoutMs, fetchImpl)),
      probeRuntime: deps.probeRuntime ?? ((baseUrl, timeoutMs) => probeBwfRuntime(baseUrl, timeoutMs, fetchImpl)),
      processRunning: deps.processRunning ?? (() => this.defaultProcessRunning()),
      sleep: deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms))),
      now: deps.now ?? Date.now,
      ensureDir: deps.ensureDir ?? ((path: string) => { mkdirSync(path, { recursive: true }); }),
      // 若外部覆盖了 ensureDir 假替身且未传 ensureIsolatedLanguage，说明运行在虚拟路径单测，不触碰真实磁盘。
      ensureIsolatedLanguage: deps.ensureIsolatedLanguage
        ?? (deps.ensureDir !== undefined
          ? () => undefined
          : (xdgConfigHome, language) => { ensureIsolatedStartupLanguage(xdgConfigHome, language); }),
      ...(deps.defaultIsolateDataDir === undefined ? {} : { defaultIsolateDataDir: deps.defaultIsolateDataDir }),
      ...(deps.syncAvatar === undefined ? {} : { syncAvatar: deps.syncAvatar }),
    };
  }

  status(): StardewLaunchStatus {
    return {
      ...this.statusValue,
      install: { ...this.statusValue.install },
      lanHost: this.statusValue.lanHost === null ? null : { ...this.statusValue.lanHost },
    };
  }

  cancel(): StardewLaunchStatus {
    this.cancelled = true;
    this.loopToken += 1;
    if (this.statusValue.state === 'launching' || this.statusValue.state === 'waiting_mcp') {
      this.patch({
        state: 'failed',
        phase: 'failed',
        errorCode: 'CANCELLED',
        message: '已取消启动等待（游戏进程如已拉起不会被强行关闭）',
        hint: '',
      });
    }
    return this.status();
  }

  dispose(): void {
    this.cancelled = true;
    this.loopToken += 1;
  }

  private async maybeSyncAvatarBeforeCreate(plan: ActiveLaunchPlan): Promise<void> {
    if (this.avatarSyncedForLaunch) return;
    if (!plan.newSave || plan.newSave.appearance?.syncPixelAvatar === false) return;
    if (!this.deps.syncAvatar) return;
    this.avatarSyncedForLaunch = true;
    this.patch({ phase: 'syncing_avatar', message: '正在将当前桌宠像素形象写入 WhaleIsleAvatar…' });
    try {
      const res = await this.deps.syncAvatar({
        ...(plan.newSave.appearance?.characterId === undefined ? {} : { characterId: plan.newSave.appearance.characterId }),
        farmerName: plan.newSave.farmerName,
        ...(plan.modsPath === undefined ? {} : { modsPath: plan.modsPath }),
      });
      if (!res.ok && res.error) {
        this.patch({ hint: `像素形象预同步未生效（将沿用原生捏脸外观）：${res.error}` });
      }
    } catch (error) {
      this.patch({
        hint: `像素形象预同步异常（将沿用原生捏脸外观）：${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  async launch(options: StardewLaunchOptions = {}): Promise<StardewLaunchStatus> {
    if (this.statusValue.state === 'launching' || this.statusValue.state === 'waiting_mcp') {
      return this.status();
    }

    const parsed = StardewLaunchOptionsSchema.safeParse(options);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      const where = first?.path.join('.') ?? 'options';
      this.patch({
        state: 'failed',
        phase: 'failed',
        errorCode: 'INVALID_OPTIONS',
        message: `启动参数不合法（${where}）：${first?.message ?? '未知错误'}`,
        hint: '请检查角色名/农场名/喜好（1~24字符无非法符号）、coop_host 小屋数 >= 1，以及隔离路径必须为绝对路径。',
      });
      return this.status();
    }
    const opts = parsed.data;
    const install = detectStardewInstall(this.deps);
    const mcpPort = opts.port ?? resolveBwfPort(install.modsDir, this.deps);
    const timeoutMs = opts.timeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS;
    const savePolicy: StardewSavePolicy = opts.savePolicy ?? (opts.autoLoadSave === false ? 'manual' : 'load_only');
    const autoLoadSave = savePolicy !== 'manual' && opts.autoLoadSave !== false;
    const gameMode: StardewGameMode = opts.gameMode ?? opts.newSave?.mode ?? 'singleplayer';
    const language: StardewLanguageCode = opts.language ?? 'zh';
    const strategy = opts.strategy ?? 'auto';

    // 显式 isolateDataDir 最高优先；否则按 storageMode='isolated' 启用鲸屿默认隔离根目录
    const rawIsolateDir = opts.isolateDataDir
      ?? (opts.storageMode === 'isolated'
        ? (this.deps.defaultIsolateDataDir ?? join(this.deps.homedir, '.whale-isle', 'stardew-isolated'))
        : null);
    const storageMode: StardewStorageMode = rawIsolateDir !== null ? 'isolated' : (opts.storageMode ?? 'standard');
    const isolateEnv = rawIsolateDir === null ? null : isolateDataEnv(rawIsolateDir);

    this.cancelled = false;
    this.saveLoadAttempted = false;
    this.switchedToNewSave = false;
    this.controlAttempts = 0;
    this.avatarSyncedForLaunch = false;
    this.loopToken += 1;

    const newSaveValidated = opts.newSave
      ? {
        ...opts.newSave,
        mode: opts.newSave.mode ?? gameMode,
        startingCabins: (opts.newSave.mode ?? gameMode) === 'coop_host'
          ? Math.max(1, opts.newSave.startingCabins ?? 1)
          : (opts.newSave.startingCabins ?? 0),
        cabinLayout: opts.newSave.cabinLayout ?? 'nearby',
        skipIntro: opts.newSave.skipIntro ?? true,
        separateWallets: opts.newSave.separateWallets ?? false,
        profitMargin: opts.newSave.profitMargin ?? 'normal',
        farmType: opts.newSave.farmType ?? 'standard',
      }
      : undefined;

    this.activePlan = {
      savePolicy,
      gameMode,
      storageMode,
      language,
      ...(opts.saveSlotName === undefined ? {} : { saveSlotName: opts.saveSlotName }),
      ...(opts.modsPath === undefined ? {} : { modsPath: opts.modsPath }),
      ...(newSaveValidated === undefined ? {} : { newSave: newSaveValidated }),
      mcpPort,
    };

    this.statusValue = {
      ...baseStatus(),
      install,
      endpoint: `http://127.0.0.1:${mcpPort}/mcp`,
      mcpPort,
      timeoutMs,
      autoLoadSave,
      phase: 'probing',
      errorCode: 'NONE',
      savePolicy,
      gameMode,
      storageMode,
      language,
      message: '正在探测安装…',
    };

    if (rawIsolateDir !== null && isolateEnv === null) {
      this.patch({
        state: 'failed',
        phase: 'failed',
        errorCode: 'ISOLATION_REJECTED',
        message: `隔离数据目录必须是绝对路径：${rawIsolateDir}`,
        hint: '相对路径会被 .NET 静默忽略并回退到 owner 存档目录，宿主不会在这种情况下启动游戏。',
      });
      return this.status();
    }
    if (rawIsolateDir !== null && strategy === 'steam') {
      this.patch({
        state: 'failed',
        phase: 'failed',
        errorCode: 'ISOLATION_REJECTED',
        message: 'Steam 启动策略无法携带隔离环境变量，已拒绝启动以免共用 owner 存档',
        hint: "请把 strategy 改为 'smapi'（或 'auto'），或在切到常规目录后再用 Steam 启动。",
      });
      return this.status();
    }

    if (!install.gameInstalled) {
      this.patch({
        state: 'not_installed',
        phase: 'failed',
        errorCode: 'GAME_NOT_INSTALLED',
        message: `未找到《星露谷物语》安装目录（已检查 ${guessGameRootDirs(this.deps.platform, this.deps.homedir).join('、') || '当前平台默认路径'}）`,
        hint: '请先在 Steam 安装游戏；若装在非默认 Steam 库，请把游戏目录加入默认库或等待后续支持自定义路径。',
      });
      return this.status();
    }
    if (!install.smapiInstalled && (rawIsolateDir !== null || strategy !== 'steam')) {
      this.patch({
        state: 'failed',
        phase: 'failed',
        errorCode: 'SMAPI_NOT_INSTALLED',
        message: '已找到游戏，但未检测到 SMAPI 可执行文件',
        hint: `请先把 SMAPI 安装到 ${install.executableDir}；隔离模式与自动建档严格要求通过 SMAPI 启动以加载 Mod。`,
      });
      return this.status();
    }

    // 建档策略时预先写入 active-avatar.json（syncDisplayName=false），避免后续覆盖新角色名
    if (savePolicy === 'always_new' || (savePolicy === 'continue_or_create' && newSaveValidated !== undefined)) {
      await this.maybeSyncAvatarBeforeCreate(this.activePlan);
    }

    // ① 已经在跑：先看 MCP；always_new 不能在已有存档中假装建档
    const initial = await this.deps.probe(this.statusValue.endpoint, HEALTH_TIMEOUT_MS);
    if (initial.status === 'online') {
      if (savePolicy === 'always_new') {
        this.patch({
          state: 'failed',
          phase: 'failed',
          gameRunning: true,
          errorCode: 'CREATE_SAVE_FAILED',
          message: '游戏当前已进入某个存档，无法直接从 0 新建存档',
          hint: '请先退回游戏标题画面或关闭当前游戏实例，再点击「从 0 开玩」。',
        });
        return this.status();
      }
      if (gameMode === 'coop_host') {
        const rt = await this.deps.probeRuntime(this.statusValue.endpoint, HEALTH_TIMEOUT_MS);
        const lan = rt?.lan ?? null;
        if (lan?.isHost && lan.serverRunning && lan.lanListening) {
          this.patch({
            state: 'ready',
            phase: 'ready',
            gameRunning: true,
            lanHost: lan,
            createdSaveSlot: lan.saveFolderName ?? rt?.saveFolderName ?? null,
            message: `《星露谷物语》联机房主已在运行：端口 ${lan.lanPort} 监听中`,
            hint: '',
          });
          return this.status();
        }
        if (lan && !lan.isHost) {
          this.patch({
            state: 'failed',
            phase: 'failed',
            gameRunning: true,
            lanHost: lan,
            errorCode: 'COOP_SERVER_NOT_READY',
            message: '当前运行中的存档为单机模式（非联机房主）',
            hint: '请退回标题画面后通过「从 0 联机房主开玩」或使用 coopHost 模式载入存档。',
          });
          return this.status();
        }
        this.patch({
          state: 'waiting_mcp',
          phase: 'waiting_lan_server',
          gameRunning: true,
          lanHost: lan,
          message: '已进入存档，等待联机房主 LAN 服务器监听…',
        });
        void this.pollUntilReady(timeoutMs);
        return this.status();
      }
      const rt = await this.deps.probeRuntime(this.statusValue.endpoint, HEALTH_TIMEOUT_MS);
      this.patch({
        state: 'ready',
        phase: 'ready',
        gameRunning: true,
        createdSaveSlot: rt?.saveFolderName ?? null,
        lanHost: rt?.lan ?? null,
        message: `《星露谷物语》已在运行：${initial.detail}`,
        hint: '',
      });
      return this.status();
    }

    const running = initial.status === 'reachable' || (await this.deps.processRunning());
    if (running) {
      this.patch({
        state: 'waiting_mcp',
        phase: initial.status === 'reachable' ? 'waiting_title' : 'waiting_bwf',
        gameRunning: true,
        message: initial.status === 'reachable'
          ? '游戏已在运行，BWF MCP 已应答（标题画面），准备执行进档/建档…'
          : '检测到 SMAPI 进程已在运行，不重复启动，等待 MCP 就绪…',
      });
      void this.pollUntilReady(timeoutMs);
      return this.status();
    }

    // ② 启动：隔离模式严禁回退 Steam（V2-P2-09B）
    const attempts: StardewLaunchStrategy[] = rawIsolateDir !== null
      ? ['smapi']
      : strategy === 'auto'
        ? ['smapi', 'steam']
        : [strategy];
    let lastError = '';
    for (const attempt of attempts) {
      this.patch({ phase: 'spawning' });
      const spawned = await this.spawnStrategy(attempt, install, isolateEnv, this.activePlan);
      if (spawned.ok) {
        this.patch({
          state: 'launching',
          phase: 'waiting_bwf',
          gameRunning: true,
          strategy: attempt,
          fallbackStrategy: attempt !== attempts[0] ? attempts[0] ?? null : null,
          startedAt: this.deps.now(),
          message: attempt === 'smapi'
            ? `已通过 SMAPI 启动（pid ${spawned.pid ?? '—'}，${storageMode === 'isolated' ? '隔离目录' : '常规目录'}/${language}），等待 MCP 端口 ${mcpPort}…`
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
      phase: 'failed',
      errorCode: 'SPAWN_FAILED',
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
    isolateEnv: { XDG_CONFIG_HOME: string; XDG_DATA_HOME: string } | null,
    plan: ActiveLaunchPlan,
  ): Promise<{ ok: boolean; pid?: number; error?: string }> {
    if (strategy === 'smapi') {
      if (!install.smapiInstalled) return { ok: false, error: 'SMAPI 可执行文件不存在' };
      if (isolateEnv !== null) {
        try {
          this.deps.ensureDir(isolateEnv.XDG_CONFIG_HOME);
          this.deps.ensureDir(isolateEnv.XDG_DATA_HOME);
          this.deps.ensureIsolatedLanguage(isolateEnv.XDG_CONFIG_HOME, plan.language);
        } catch (err) {
          return { ok: false, error: `无法初始化隔离数据目录：${err instanceof Error ? err.message : String(err)}` };
        }
      }
      const args = plan.modsPath ? ['--mods-path', plan.modsPath] : [];
      return this.spawnDetached(install.smapiBinary, args, {
        cwd: install.executableDir,
        env: {
          ...process.env,
          SMAPI_NO_TERMINAL: 'true',
          SMAPI_USE_CURRENT_SHELL: 'true',
          WHALE_BWF_MCP_PORT: String(plan.mcpPort),
          WHALE_STARDEW_LANG: plan.language,
          ...(isolateEnv ?? {}),
        },
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
        setTimeout(() => finish({ ok: true, ...(child.pid === undefined ? {} : { pid: child.pid }) }), 300);
        child.unref();
      } catch (error) {
        finish({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    });
  }

  private async runCreateNewSaveStep(plan: ActiveLaunchPlan): Promise<void> {
    if (!plan.newSave) {
      this.patch({
        state: 'failed',
        phase: 'failed',
        errorCode: 'INVALID_OPTIONS',
        message: '缺少 newSave 建档参数',
        hint: '请在从 0 新建前填写农夫名、农场名与喜好。',
      });
      return;
    }
    await this.maybeSyncAvatarBeforeCreate(plan);
    this.patch({ phase: 'creating_save', message: `正在在标题画面自动创建新档「${plan.newSave.farmName}」…` });
    const res = await callBwfControlTool(
      this.statusValue.endpoint,
      'create_new_save',
      {
        ...plan.newSave,
        language: plan.language,
      },
      this.deps.fetchImpl,
    );
    if (res.ok) {
      this.saveLoadAttempted = true;
      this.patch({
        saveLoadRequested: true,
        phase: 'waiting_world',
        message: `已触发从 0 建档（${plan.newSave.farmerName} · ${plan.newSave.farmName}），等待进入第 1 天…`,
      });
      return;
    }
    this.controlAttempts += 1;
    if (TRANSIENT_RETRY_CODES.has(res.code) && this.controlAttempts < MAX_CONTROL_RETRIES) {
      this.patch({
        state: 'waiting_mcp',
        phase: 'waiting_title',
        errorCode: res.code,
        message: `标题画面尚未就绪（${res.code}），稍后自动重试建档…`,
      });
      return;
    }
    this.saveLoadAttempted = true;
    const hint = res.code === 'BWF_PATCH_MISSING'
      ? '请编译并部署 BlindWhaleFarmer 第 3 份增量补丁（需支持 create_new_save 与 lan_status）。'
      : res.code === 'TOO_MANY_FARMS'
        ? '星露谷存档数量达到上限，请删除旧档后再试。'
        : '请查看游戏标题画面或日志排查原因。';
    this.patch({
      state: 'failed',
      phase: 'failed',
      errorCode: res.code,
      message: `自动建档失败（${res.code}）：${res.error ?? '未知原因'}`,
      hint,
    });
  }

  private async checkLegacyBwfForFeature(plan: ActiveLaunchPlan): Promise<boolean> {
    if (plan.savePolicy !== 'always_new' && plan.gameMode !== 'coop_host') return true;
    const rt = await this.deps.probeRuntime(this.statusValue.endpoint, HEALTH_TIMEOUT_MS);
    if (rt === null) return true; // 端口未通或探活降级时留给 create_new_save 控制调用判定
    if (!rt.capabilities.includes('create_new_save') && plan.savePolicy === 'always_new') {
      this.patch({
        state: 'failed',
        phase: 'failed',
        errorCode: 'BWF_PATCH_MISSING',
        message: '检测到旧版 BlindWhaleFarmer Mod（缺少 create_new_save 能力），无法自动从 0 建档',
        hint: '请编译部署 mods/bwf-patches/2026-11-26-auto-new-save-and-lan-status.patch 补丁后重试。',
      });
      return false;
    }
    if (plan.gameMode === 'coop_host' && !rt.capabilities.includes('lan_status')) {
      this.patch({
        state: 'failed',
        phase: 'failed',
        errorCode: 'BWF_PATCH_MISSING',
        message: '检测到旧版 BlindWhaleFarmer Mod（缺少 lan_status 能力），无法验证联机房主端口',
        hint: '请编译部署第 3 份 BWF 补丁后再开启联机房主。',
      });
      return false;
    }
    return true;
  }

  private async pollUntilReady(timeoutMs: number): Promise<void> {
    const token = this.loopToken;
    const deadline = this.deps.now() + timeoutMs;
    const plan = this.activePlan ?? {
      savePolicy: 'load_only' as StardewSavePolicy,
      gameMode: 'singleplayer' as StardewGameMode,
      storageMode: 'standard' as StardewStorageMode,
      language: 'zh' as StardewLanguageCode,
      mcpPort: this.statusValue.mcpPort,
    };
    let lastStatus: HealthStatus = 'offline';
    let lastDetail = '';

    while (this.loopToken === token && !this.cancelled) {
      const remaining = deadline - this.deps.now();
      if (remaining <= 0) {
        const isLanWait = this.statusValue.phase === 'waiting_lan_server';
        this.patch({
          state: 'timeout',
          phase: 'failed',
          errorCode: isLanWait ? 'COOP_SERVER_NOT_READY' : 'TIMEOUT',
          gameRunning: true,
          message: isLanWait
            ? `等待联机房主 LAN 服务器超时（${Math.round(timeoutMs / 1000)}s）`
            : `等待 BWF MCP 就绪超时（${Math.round(timeoutMs / 1000)}s）`,
          hint: isLanWait
            ? '已进入存档但 UDP 24642 房主服务未就绪：请检查房主配置与 BWF 补丁。'
            : lastStatus === 'reachable'
              ? '游戏已连上 MCP 但未进入存档：请在游戏标题画面手动选择存档（本次未能自动读档/建档）。'
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
        if (plan.gameMode === 'coop_host') {
          const rt = await this.deps.probeRuntime(this.statusValue.endpoint, HEALTH_TIMEOUT_MS);
          if (this.loopToken !== token || this.cancelled) return;
          if (rt !== null && !rt.capabilities.includes('lan_status')) {
            this.patch({
              state: 'failed',
              phase: 'failed',
              errorCode: 'BWF_PATCH_MISSING',
              gameRunning: true,
              message: '检测到旧版 BlindWhaleFarmer Mod（缺少 lan_status），无法确认房主 LAN 监听状态',
              hint: '请更新 BlindWhaleFarmer 第 3 份补丁并重启游戏。',
            });
            return;
          }
          const lan = rt?.lan ?? null;
          if (!lan?.isHost || !lan.serverRunning || !lan.lanListening) {
            this.patch({
              state: 'waiting_mcp',
              phase: 'waiting_lan_server',
              gameRunning: true,
              lanHost: lan,
              createdSaveSlot: rt?.saveFolderName ?? this.statusValue.createdSaveSlot,
              message: `已进入存档，等待联机房主 LAN 服务器在端口 ${lan?.lanPort ?? 24642} 监听…`,
            });
            continue;
          }
          this.patch({
            state: 'ready',
            phase: 'ready',
            errorCode: 'NONE',
            gameRunning: true,
            lanHost: lan,
            createdSaveSlot: lan.saveFolderName ?? rt?.saveFolderName ?? this.statusValue.createdSaveSlot,
            message: `BWF MCP 与房主 LAN 已就绪（端口 ${lan.lanPort}，空余小屋 ${lan.availableFarmhandSlots}/${lan.startingCabins}）`,
            hint: '',
          });
          return;
        }

        const rt = await this.deps.probeRuntime(this.statusValue.endpoint, HEALTH_TIMEOUT_MS);
        if (this.loopToken !== token || this.cancelled) return;
        this.patch({
          state: 'ready',
          phase: 'ready',
          errorCode: 'NONE',
          gameRunning: true,
          createdSaveSlot: rt?.saveFolderName ?? this.statusValue.createdSaveSlot,
          lanHost: rt?.lan ?? null,
          message: `BWF MCP 已就绪：${probe.detail}`,
          hint: '',
        });
        return;
      }

      if (probe.status === 'reachable') {
        if (plan.savePolicy === 'manual') {
          this.patch({
            state: 'waiting_mcp',
            phase: 'waiting_title',
            gameRunning: true,
            message: 'MCP 已应答（标题画面），等待人工手动读档或建档…',
          });
          continue;
        }

        if (!this.saveLoadAttempted) {
          const patchOk = await this.checkLegacyBwfForFeature(plan);
          if (!patchOk || this.loopToken !== token || this.cancelled) return;

          if (plan.savePolicy === 'always_new' || this.switchedToNewSave) {
            await this.runCreateNewSaveStep(plan);
            if (this.statusValue.state === 'failed') return;
            continue;
          }

          this.patch({
            state: 'waiting_mcp',
            phase: 'loading_save',
            gameRunning: true,
            message: 'MCP 已应答（标题画面），正在请求自动载入存档…',
          });
          const loadArgs: Record<string, unknown> = {
            ...(plan.saveSlotName === undefined ? {} : { save: plan.saveSlotName }),
            coopHost: plan.gameMode === 'coop_host',
            language: plan.language,
          };
          const loadRes = await callBwfControlTool(this.statusValue.endpoint, 'load_save', loadArgs, this.deps.fetchImpl);
          if (this.loopToken !== token || this.cancelled) return;

          if (loadRes.ok) {
            this.saveLoadAttempted = true;
            this.patch({
              saveLoadRequested: true,
              phase: 'waiting_world',
              errorCode: 'NONE',
              message: '已请求 BWF 载入存档，等待进入游戏世界（约 15s）…',
            });
            continue;
          }

          this.controlAttempts += 1;
          if (TRANSIENT_RETRY_CODES.has(loadRes.code) && this.controlAttempts < MAX_CONTROL_RETRIES) {
            this.patch({
              state: 'waiting_mcp',
              phase: 'waiting_title',
              errorCode: loadRes.code,
              message: `标题画面或语言设置加载中（${loadRes.code}），稍后自动重调读档…`,
            });
            continue;
          }

          if (loadRes.code === 'SAVE_NOT_FOUND' && plan.savePolicy === 'continue_or_create' && plan.newSave) {
            this.switchedToNewSave = true;
            await this.runCreateNewSaveStep(plan);
            if (this.statusValue.state === 'failed') return;
            continue;
          }

          if (loadRes.code === 'BWF_PATCH_MISSING') {
            this.saveLoadAttempted = true;
            this.patch({
              state: 'failed',
              phase: 'failed',
              errorCode: 'BWF_PATCH_MISSING',
              message: `BWF 缺少目标能力（${loadRes.error ?? '未知原因'}）`,
              hint: '请更新 BlindWhaleFarmer 补丁后再试。',
            });
            return;
          }

          this.saveLoadAttempted = true;
          this.patch({
            state: 'waiting_mcp',
            phase: 'waiting_title',
            errorCode: loadRes.code,
            message: `自动读档失败（${loadRes.error ?? '未知原因'}），等待手动选择存档…`,
          });
        } else {
          this.patch({
            state: 'waiting_mcp',
            phase: 'waiting_world',
            gameRunning: true,
            message: 'MCP 已应答；已发送进档指令，等待进入游戏世界…',
          });
        }
        continue;
      }

      this.patch({
        state: 'waiting_mcp',
        phase: 'waiting_bwf',
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
 * 校验参数合法性，按真实状态机节奏推进 launching → waiting_mcp（creating_save / waiting_lan_server）→ ready。
 */
export function createFakeStardewLauncher(
  deps: { stepMs?: number; defaultIsolateDataDir?: string } = {},
): StardewLauncher {
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
    storageMode: 'isolated',
    language: 'zh',
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

      const parsed = StardewLaunchOptionsSchema.safeParse(options);
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        status = {
          ...status,
          state: 'failed',
          phase: 'failed',
          errorCode: 'INVALID_OPTIONS',
          message: `E2E 参数不合法：${first?.message ?? '未知错误'}`,
          hint: '请检查启动参数',
        };
        return Promise.resolve({ ...status, install: { ...status.install } });
      }
      const opts = parsed.data;
      const savePolicy = opts.savePolicy ?? (opts.autoLoadSave === false ? 'manual' : 'load_only');
      const gameMode = opts.gameMode ?? opts.newSave?.mode ?? 'singleplayer';
      const storageMode = opts.isolateDataDir !== undefined ? 'isolated' : (opts.storageMode ?? 'isolated');
      const language = opts.language ?? 'zh';
      const mcpPort = opts.port ?? DEFAULT_BWF_MCP_PORT;
      const cabins = opts.newSave?.startingCabins ?? (gameMode === 'coop_host' ? 1 : 0);
      const fakeSlot = opts.newSave ? `${opts.newSave.farmName}_999000111` : '鲸屿_999000111';
      const lanHost: StardewLanHostStatus | null = gameMode === 'coop_host'
        ? {
          isHost: true,
          multiplayerMode: 2,
          serverRunning: true,
          lanListening: true,
          lanPort: 24642,
          acceptIpConnections: true,
          inviteCode: 'E2E-LAN-01',
          startingCabins: cabins,
          availableFarmhandSlots: cabins,
          worldReady: true,
          saveFolderName: fakeSlot,
          languageCode: language,
        }
        : null;

      status = {
        ...status,
        state: 'launching',
        phase: 'spawning',
        errorCode: 'NONE',
        strategy: 'smapi',
        mcpPort,
        endpoint: `http://127.0.0.1:${mcpPort}/mcp`,
        gameRunning: true,
        saveLoadRequested: false,
        savePolicy,
        gameMode,
        storageMode,
        language,
        createdSaveSlot: null,
        lanHost: null,
        startedAt: Date.now(),
        message: `E2E：已通过 SMAPI 启动（${storageMode}/${language}）`,
        hint: '',
        timeoutMs: opts.timeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS,
      };
      schedule(() => {
        status = {
          ...status,
          state: 'waiting_mcp',
          phase: savePolicy === 'always_new' ? 'creating_save' : 'loading_save',
          saveLoadRequested: savePolicy !== 'manual',
          message: savePolicy === 'always_new'
            ? `E2E：正在创建新档（${gameMode}）`
            : 'E2E：等待 BWF MCP（假）',
        };
      }, stepMs);
      if (gameMode === 'coop_host') {
        schedule(() => {
          status = {
            ...status,
            state: 'waiting_mcp',
            phase: 'waiting_lan_server',
            message: 'E2E：等待联机房主 LAN 服务器（24642）',
          };
        }, stepMs * 2);
      }
      schedule(() => {
        status = {
          ...status,
          state: 'ready',
          phase: 'ready',
          errorCode: 'NONE',
          createdSaveSlot: fakeSlot,
          lanHost,
          message: gameMode === 'coop_host'
            ? `E2E：BWF MCP 与房主 LAN 已就绪（端口 24642，小屋 ${cabins}）`
            : 'E2E：BWF MCP 已就绪（假）',
        };
      }, stepMs * 3);
      return Promise.resolve({ ...status, install: { ...status.install } });
    },
    status(): StardewLaunchStatus {
      return {
        ...status,
        install: { ...status.install },
        lanHost: status.lanHost === null ? null : { ...status.lanHost },
      };
    },
    cancel(): StardewLaunchStatus {
      timers.forEach((timer) => clearTimeout(timer));
      timers.clear();
      status = { ...status, state: 'failed', phase: 'failed', errorCode: 'CANCELLED', message: 'E2E：已取消（假）' };
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
