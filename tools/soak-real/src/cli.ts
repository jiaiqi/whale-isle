#!/usr/bin/env -S tsx
/**
 * [REAL-DEVICE] soak:real —— 连真实 BWF 浸泡 N 个游戏日（T-M6-67）。
 *
 * 无头进程，不挂桌面端：直接复用 packages/game-bridge-mcp 的
 * StardewAdapter → AutodriveRunner（stepDelayMs 用生产值），另起一个只读 BwfMcpClient
 * 观察者每 30s get_state 取时钟。卡死判定/日切分/报告都是纯模块，CLI 只负责组装。
 *
 * LLM Key 只从环境变量读（WHALE_SOAK_PROVIDER / WHALE_SOAK_API_KEY / WHALE_SOAK_MODEL /
 * 可选 WHALE_SOAK_BASE_URL），绝不写入文件或日志；缺任一项自动降级 --no-llm 并在报告注明。
 *
 * 退出码：0 达标；1 有卡死或闭环不达标；2 连接/参数错误。Ctrl+C 先 stopAndWait 再写报告。
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AutodriveRunner,
  BwfMcpClient,
  LlmPlanner,
  RulePlanner,
  StardewAdapter,
  parseFarmSummary,
  parseGameState,
  parseSeedInventory,
  parseWeekday,
  seedShopStatus,
  type AutodriveEvent,
  type AutodriveOptions,
  type GameAdapter,
  type McpCallOptions,
  type McpCallResult,
  type Planner,
  type QualityEventLike,
} from '@workbench/game-bridge-mcp';
import { BUILTIN_PROVIDER_PRESETS, ModelGateway } from '@workbench/model-gateway';
import {
  ModelProviderConfigSchema,
  type DiningProfilePreset,
  type ModelProviderConfig,
  type WorkbenchRoleSlot,
} from '@workbench/shared-protocol';
import { DayTracker, type DayRecord } from './day-tracker';
import { StuckDetector, type StuckVerdict } from './stuck-detector';
import {
  appendEventLine,
  createRunDir,
  writeJsonFile,
  writeStuckPack,
  type CaptureScreen,
  type CopySave,
} from './evidence';
import {
  buildSummary,
  exitCodeFor,
  renderReport,
  type SoakLlmInfo,
  type SoakRunOptions,
  type SoakSummary,
  type SoakTokenUsage,
  type StuckEntry,
} from './report';

export const DEFAULT_ENDPOINT = 'http://127.0.0.1:18080/mcp';
export const DEFAULT_OBSERVER_MS = 30_000;

export interface SoakOptions {
  days: number;
  llm: boolean;
  onStuck: 'continue' | 'stop';
  maxHours: number;
  observerMs: number;
  endpoint: string;
  outRoot: string;
  saveDir: string | null;
}

export class SoakUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SoakUsageError';
  }
}

export const HELP_TEXT = `soak:real —— 星露谷真机浸泡（T-M6-67，[REAL-DEVICE]）

用法：pnpm soak:real -- [选项]

  --days <N>            要跑完的游戏日数（默认 1，1–112）
  --no-llm              纯规则规划器（默认有 Key 时开 LLM）
  --on-stuck <mode>     continue（默认，累计并继续）| stop（首次卡死即停）
  --max-hours <H>       现实时间上限（小时，0 = 不限）
  --observer-ms <MS>    只读观察者轮询间隔（默认 30000；0 = 关闭，退回只用事件流时钟）
  --endpoint <URL>      BWF MCP 端点（默认 ${DEFAULT_ENDPOINT}）
  --out <DIR>           现场包根目录（默认 <repo>/artifacts/soak）
  --save-dir <DIR>      存档目录（卡死现场包会拷贝；默认自动探测泡泡湾存档）
  --help                打印本帮助

LLM 环境变量：WHALE_SOAK_PROVIDER / WHALE_SOAK_API_KEY / WHALE_SOAK_MODEL，
可选 WHALE_SOAK_BASE_URL（自建/代理端点）。缺任一项自动降级 --no-llm 并在报告注明。
Key 只在内存使用，绝不写入文件或日志。
`;

/** cli.ts 上溯三层 = 仓库根（src/ → soak-real/ → tools/ → repo；dist/ 同样三层） */
export function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

/** 默认存档目录：泡泡湾_454908853（存在才启用，避免把不存在的路径写进现场包） */
export function defaultSaveDir(): string | null {
  const fromEnv = (process.env.WHALE_SOAK_SAVE_DIR ?? '').trim();
  if (fromEnv !== '') return fromEnv;
  const dir = join(homedir(), '.config', 'StardewValley', 'Saves', '泡泡湾_454908853');
  return existsSync(dir) ? dir : null;
}

export function defaultSoakOptions(): SoakOptions {
  return {
    days: 1,
    llm: true,
    onStuck: 'continue',
    maxHours: 0,
    observerMs: DEFAULT_OBSERVER_MS,
    endpoint: DEFAULT_ENDPOINT,
    outRoot: join(repoRoot(), 'artifacts', 'soak'),
    saveDir: defaultSaveDir(),
  };
}

const VALUE_FLAGS = new Set([
  '--days',
  '--on-stuck',
  '--max-hours',
  '--observer-ms',
  '--endpoint',
  '--out',
  '--save-dir',
]);

function numberFlag(name: string, value: string, min: number, max: number, integer: boolean): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max || (integer && !Number.isInteger(parsed))) {
    throw new SoakUsageError(`${name} 必须是 ${min}–${max} 之间的${integer ? '整数' : '数字'}，收到：${value}`);
  }
  return parsed;
}

export function parseArgs(argv: readonly string[]): SoakOptions {
  const options = defaultSoakOptions();
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index] ?? '';
    if (raw === '' || raw === '--') continue; // pnpm run 会把 -- 原样透传
    if (raw === '--no-llm') {
      options.llm = false;
      continue;
    }
    if (raw === '--llm') {
      options.llm = true;
      continue;
    }
    const equalsAt = raw.indexOf('=');
    const name = equalsAt >= 0 ? raw.slice(0, equalsAt) : raw;
    if (!VALUE_FLAGS.has(name)) throw new SoakUsageError(`无法识别的参数：${raw}（--help 查看用法）`);
    let value = equalsAt >= 0 ? raw.slice(equalsAt + 1) : undefined;
    if (value === undefined) {
      index += 1;
      value = argv[index];
    }
    if (value === undefined || value === '') throw new SoakUsageError(`${name} 缺少取值`);
    switch (name) {
      case '--days':
        options.days = numberFlag(name, value, 1, 112, true);
        break;
      case '--on-stuck':
        if (value !== 'continue' && value !== 'stop') {
          throw new SoakUsageError(`--on-stuck 只能是 continue | stop，收到：${value}`);
        }
        options.onStuck = value;
        break;
      case '--max-hours':
        options.maxHours = numberFlag(name, value, 0, 24 * 14, false);
        break;
      case '--observer-ms':
        options.observerMs = numberFlag(name, value, 0, 60 * 60_000, true);
        break;
      case '--endpoint':
        if (!/^https?:\/\//.test(value)) throw new SoakUsageError(`--endpoint 必须是 http(s) URL，收到：${value}`);
        options.endpoint = value;
        break;
      case '--out':
        options.outRoot = resolve(value);
        break;
      case '--save-dir':
        options.saveDir = resolve(value);
        break;
      default:
        throw new SoakUsageError(`无法识别的参数：${raw}`);
    }
  }
  return options;
}

// ---------------------------------------------------------------------------
// LLM 组装（Key 只在内存里；报告只写 provider/model）
// ---------------------------------------------------------------------------

export type ReasoningEffortLevel = 'minimal' | 'low' | 'medium' | 'high';

const REASONING_EFFORT_LEVELS = new Set<string>(['minimal', 'low', 'medium', 'high']);

export interface LlmConfig {
  provider: string;
  apiKey: string;
  model: string;
  baseUrl?: string;
  reasoningEffort?: ReasoningEffortLevel;
}

export interface LlmResolution {
  mode: 'llm' | 'rule';
  config?: LlmConfig;
  reason?: string;
}

export function resolveLlm(
  env: Record<string, string | undefined>,
  options: { noLlm: boolean },
): LlmResolution {
  if (options.noLlm) return { mode: 'rule', reason: '--no-llm' };
  const provider = (env.WHALE_SOAK_PROVIDER ?? '').trim();
  const apiKey = (env.WHALE_SOAK_API_KEY ?? '').trim();
  const model = (env.WHALE_SOAK_MODEL ?? '').trim();
  const baseUrl = (env.WHALE_SOAK_BASE_URL ?? '').trim();
  const rawEffort = (env.WHALE_SOAK_REASONING_EFFORT ?? '').trim().toLowerCase();
  const reasoningEffort = REASONING_EFFORT_LEVELS.has(rawEffort)
    ? (rawEffort as ReasoningEffortLevel)
    : undefined;
  const missing: string[] = [];
  if (provider === '') missing.push('WHALE_SOAK_PROVIDER');
  if (apiKey === '') missing.push('WHALE_SOAK_API_KEY');
  if (model === '') missing.push('WHALE_SOAK_MODEL');
  if (missing.length > 0) {
    return { mode: 'rule', reason: `缺少环境变量 ${missing.join(' / ')}，自动降级 --no-llm` };
  }
  return {
    mode: 'llm',
    config: {
      provider,
      apiKey,
      model,
      ...(baseUrl === '' ? {} : { baseUrl }),
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    },
  };
}

/** 把环境变量配置拼成一份最小可用的 ModelProviderConfig（预设 + 可选自建端点覆盖） */
export function buildProviderConfig(config: LlmConfig, preset: ModelProviderConfig | undefined): ModelProviderConfig {
  const variant = config.baseUrl === undefined
    ? undefined
    : {
      region: 'CN' as const,
      planType: 'PAY_AS_YOU_GO' as const,
      baseUrl: config.baseUrl,
      isFullUrl: false,
      protocol: 'openai' as const,
    };
  if (preset !== undefined) {
    return ModelProviderConfigSchema.parse({
      ...preset,
      activeModelId: config.model,
      ...(variant === undefined ? {} : { variants: [variant] }),
    });
  }
  return ModelProviderConfigSchema.parse({
    id: config.provider,
    name: config.provider,
    category: 'AGGREGATOR_LLM',
    variants: [variant],
    apiKeyMaskedOrRef: '',
    activeModelId: config.model,
    discoveredModels: [{ id: config.model }],
  });
}

export interface PlannerBundle {
  planner: Planner;
  llm: SoakLlmInfo;
}

export interface PlannerDeps {
  fetchImpl?: ConstructorParameters<typeof ModelGateway>[0]['fetchImpl'];
  guidesDir?: string;
  notesDir?: string;
  onUsage?: ConstructorParameters<typeof ModelGateway>[0]['onUsage'];
}

/** 读取 guide-forager 目录下全部 Markdown 攻略（目录不存在或异常返回空映射，不阻塞启动） */
export function loadGuideFiles(dir: string = join(repoRoot(), 'guide-forager')): Record<string, string> {
  if (!existsSync(dir)) return {};
  try {
    const guides: Record<string, string> = {};
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.md') || file.startsWith('.')) continue;
      const topic = file.slice(0, -3).trim();
      if (topic === '') continue;
      const body = readFileSync(join(dir, file), 'utf8').trim();
      if (body !== '') guides[topic] = body;
    }
    return guides;
  } catch {
    return {};
  }
}

/** 组装规划器：LLM 可用则 LlmPlanner（规则兜底仍接 RulePlanner），否则纯规则 */
export function createPlanner(resolution: LlmResolution, deps: PlannerDeps = {}): PlannerBundle {
  const config = resolution.config;
  if (resolution.mode === 'rule' || config === undefined) {
    return {
      planner: new RulePlanner(),
      llm: { mode: 'rule', ...(resolution.reason === undefined ? {} : { degradedReason: resolution.reason }) },
    };
  }
  const preset = BUILTIN_PROVIDER_PRESETS.find((item) => item.id === config.provider);
  if (preset === undefined && config.baseUrl === undefined) {
    return {
      planner: new RulePlanner(),
      llm: { mode: 'rule', degradedReason: `未知供应商预设 ${config.provider}（自建端点请提供 WHALE_SOAK_BASE_URL）` },
    };
  }
  try {
    const provider = buildProviderConfig(config, preset);
    const profile: DiningProfilePreset = {
      profileId: 'BUDGET_SLACKING',
      displayName: 'soak 真机浸泡档',
      roleBindings: { STARDEW_GAME_PLANNER: `${provider.id}/${config.model}` },
      secretMaskingEnabled: true,
    };
    const gateway = new ModelGateway({
      profile,
      keys: { [provider.id]: config.apiKey },
      providers: [provider],
      ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
      ...(deps.onUsage === undefined ? {} : { onUsage: deps.onUsage }),
    });
    const guides = loadGuideFiles(deps.guidesDir ?? join(repoRoot(), 'guide-forager'));
    const reasoningEffort = config.reasoningEffort ?? (provider.id === 'minimax' ? 'low' : undefined);
    const planner = new LlmPlanner({
      chat: (slot, messages, opts) =>
        gateway
          .chat(slot as WorkbenchRoleSlot, messages, {
            ...(opts?.maxTokens === undefined ? {} : { maxTokens: opts.maxTokens }),
            ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
          })
          .then((receipt) => ({ content: receipt.content })),
      slot: 'STARDEW_GAME_PLANNER',
      fallbackPlanner: new RulePlanner(),
      recentReceipts: [],
      ...(Object.keys(guides).length > 0 ? { guides } : {}),
      ...(deps.notesDir === undefined ? {} : { notesDir: deps.notesDir }),
    });
    return { planner, llm: { mode: 'llm', provider: provider.id, model: config.model } };
  } catch (error) {
    return {
      planner: new RulePlanner(),
      llm: { mode: 'rule', degradedReason: `LLM 初始化失败：${errorMessage(error)}` },
    };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 从真实 `get_state` 原文解析「当天每个闭环项是否真的有机会可做」。
 * 只做证据判断，不猜：状态里没写的字段一律当作「没有机会」（不算失败），
 * 但账本侧的 N/A 只会在观察者确实拿到过状态时启用（见 day-tracker 的 sawFacts）。
 */
export function parseDayOpportunity(
  raw: string,
  snapshot: { clockMinutes: number; money: number; festival: string | null },
): { mail: boolean; water: boolean; harvest: boolean; buySeeds: boolean; plant: boolean } {
  const farm = parseFarmSummary(raw);
  const seeds = parseSeedInventory(raw);
  const unread = /(\d+)\s*封未读信件/.exec(raw);
  const shop = seedShopStatus(snapshot.clockMinutes, parseWeekday(raw), snapshot.festival);
  const emptyTilled = farm.emptyTilled ?? 0;
  return {
    mail: unread !== null && Number(unread[1]) > 0,
    water: (farm.needsWater ?? 0) > 0,
    harvest: (farm.harvestable ?? 0) > 0,
    // 买种：有可播种空地 + 钱够最便宜的种子（防风草 20g）+ 商店营业中
    buySeeds: emptyTilled > 0 && snapshot.money >= 20 && shop.open,
    // 播种：有可播种空地 + 背包里已有当季种子
    plant: emptyTilled > 0 && seeds.length > 0,
  };
}

// ---------------------------------------------------------------------------
// 浸泡会话
// ---------------------------------------------------------------------------

export interface ObserverClient {
  callTool(tool: string, args?: Record<string, unknown>, opts?: McpCallOptions): Promise<McpCallResult>;
}

export interface RunnerLike {
  start(): Promise<void>;
  stopAndWait(): Promise<void>;
  isRunning?(): boolean;
  setPlanner?(planner: Planner): void;
}

export interface SoakSessionDeps {
  options: SoakOptions;
  adapter: GameAdapter;
  planner: Planner;
  llm: SoakLlmInfo;
  /** 只读观察者；null = 关闭（--observer-ms=0） */
  observer: ObserverClient | null;
  /** runner 参数覆盖（测试注入 stepDelayMs/sleep；生产保持默认） */
  runnerOptions?: Omit<Partial<AutodriveOptions>, 'now'>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  captureScreen?: CaptureScreen;
  copySave?: CopySave;
  /** 卡死判定器（测试注入更短的阈值；生产用默认四条规则） */
  detector?: StuckDetector;
  /** 测试注入 */
  runId?: string;
  outRoot?: string;
  createRunner?: (onEvent: (event: AutodriveEvent) => void) => RunnerLike;
  fetchSettings?: () => Promise<{ ok: boolean; text?: string; error?: string }>;
  readGitHead?: () => string | null;
  getTokenUsage?: () => SoakTokenUsage;
}

export interface SoakResult {
  exitCode: 0 | 1 | 2;
  summary: SoakSummary;
  runDir: string;
  reportPath: string;
  summaryPath: string;
}

const EVENT_BUFFER = 200;
const RECEIPT_BUFFER = 12;
const WAIT_TICK_MS = 200;

export function formatRunId(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/** 读 .git/HEAD + refs（git 二进制不可用时也能记录 commit） */
export function readGitHead(root: string = repoRoot()): string | null {
  try {
    const gitDir = join(root, '.git');
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref: ')) return head === '' ? null : head;
    const ref = head.slice('ref: '.length).trim();
    const direct = join(gitDir, ref);
    if (existsSync(direct)) return readFileSync(direct, 'utf8').trim();
    const packed = join(gitDir, 'packed-refs');
    if (existsSync(packed)) {
      for (const line of readFileSync(packed, 'utf8').split('\n')) {
        const parts = line.trim().split(' ');
        if (parts.length === 2 && parts[1] === ref) return parts[0] ?? null;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** BWF /settings 快照（3s 超时；失败只记录错误，不阻塞浸泡） */
export async function fetchBwfSettings(
  endpoint: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; text?: string; error?: string }> {
  const url = endpoint.replace(/\/mcp\/?$/, '/settings');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3_000);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    const text = await response.text();
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
    return { ok: true, text };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  } finally {
    clearTimeout(timer);
  }
}

export interface ReceiptCounts {
  completed: number;
  failed: number;
  timeout: number;
  uncertain: number;
  error: number;
}

/** 回执状态计数（报告与进度日志共用；单列函数便于单测五条分支） */
export function addReceiptCount(counts: ReceiptCounts, status: 'COMPLETED' | 'FAILED' | 'UNCERTAIN' | 'TIMEOUT' | 'ERROR'): void {
  switch (status) {
    case 'COMPLETED':
      counts.completed += 1;
      return;
    case 'FAILED':
      counts.failed += 1;
      return;
    case 'TIMEOUT':
      counts.timeout += 1;
      return;
    case 'ERROR':
      counts.error += 1;
      return;
    case 'UNCERTAIN':
      counts.uncertain += 1;
  }
}

/** 失败次数最高的签名（进度日志用；并列时保持 Map 插入顺序） */
export function topFailure(failures: ReadonlyMap<string, number>): [string, number] | undefined {
  return [...failures.entries()].sort((a, b) => b[1] - a[1])[0];
}

export class SoakSession {
  private readonly options: SoakOptions;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (line: string) => void;
  private readonly detector: StuckDetector;
  private readonly tracker = new DayTracker();
  private readonly stucks: StuckEntry[] = [];
  private readonly notes: string[] = [];
  private readonly recentEvents: unknown[] = [];
  private readonly recentReceipts: string[] = [];
  /** 全量事件的三元投影，供 metrics.ts 汇总质量指标 */
  private readonly qualityEvents: QualityEventLike[] = [];
  private readonly receipts: ReceiptCounts = { completed: 0, failed: 0, timeout: 0, uncertain: 0, error: 0 };
  private readonly llmPlanner: LlmPlanner | null;

  private runner: RunnerLike | null = null;
  private runDir = '';
  private startedAt: number | null = null;
  private lastStateText = '';
  private lastObserveAt = 0;
  private lastProgressAt = 0;
  private stuckIndex = 0;
  private observerErrors = 0;
  private stopRequested = false;
  private interruptReason: 'signal' | 'on-stuck' | 'timeout' | 'days' | 'runner-exit' | null = null;

  constructor(private readonly deps: SoakSessionDeps) {
    this.options = deps.options;
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)));
    this.log = deps.log ?? ((line) => console.log(line));
    this.detector = deps.detector ?? new StuckDetector();
    this.llmPlanner = deps.planner instanceof LlmPlanner ? deps.planner : null;
    if (this.options.observerMs <= 0) {
      this.notes.push('观察者已关闭（--observer-ms=0）：时钟只来自 runner 的 state 事件，长动作期间不判定 clock-stall');
    }
    if (this.options.saveDir === null) {
      this.notes.push('未找到存档目录：卡死现场包只写 save.err，不拷贝存档（可用 --save-dir 指定）');
    }
  }

  get stopRequestedFlag(): boolean {
    return this.stopRequested;
  }

  /** 请求停止（SIGINT / --on-stuck=stop）：stopAndWait 后照常写报告 */
  requestStop(reason: 'signal' | 'on-stuck' = 'signal'): void {
    if (!this.stopRequested) {
      this.stopRequested = true;
      this.interruptReason = reason;
    }
  }

  async run(): Promise<SoakResult> {
    const startedAt = this.now();
    this.startedAt = startedAt;
    const runId = this.deps.runId ?? formatRunId(new Date(startedAt));
    this.runDir = createRunDir(this.deps.outRoot ?? this.options.outRoot, runId);
    const eventsFile = join(this.runDir, 'events.jsonl');
    const meta: Record<string, unknown> = {
      runId,
      startedAt: new Date(startedAt).toISOString(),
      options: { ...this.options, saveDir: this.options.saveDir === null ? null : '已配置（路径不写入现场包）' },
      llm: this.deps.llm,
      node: process.version,
      platform: process.platform,
      gitHead: (this.deps.readGitHead ?? (() => readGitHead()))(),
      bwfSettings: null as unknown,
    };
    if (this.deps.fetchSettings !== undefined) {
      try {
        const settings = await this.deps.fetchSettings();
        meta.bwfSettings = settings.ok === true
          ? { ok: true, text: (settings.text ?? '').slice(0, 4_000) }
          : { ok: false, error: settings.error ?? '未知错误' };
      } catch (error) {
        meta.bwfSettings = { ok: false, error: errorMessage(error) };
      }
    }
    writeJsonFile(join(this.runDir, 'meta.json'), meta);

    this.log(
      `[soak] 开始：${this.options.days} 个游戏日 · 端点 ${this.options.endpoint} · `
      + `LLM ${this.deps.llm.mode === 'llm' ? `${this.deps.llm.provider}/${this.deps.llm.model}` : '关（规则）'} · `
      + `观察者 ${this.options.observerMs > 0 ? `${this.options.observerMs}ms` : '关闭'} · 现场包 ${this.runDir}`,
    );

    const onEvent = (event: AutodriveEvent): void => this.handleEvent(event, this.now(), eventsFile);
    let startError: string | null = null;
    try {
      this.runner = this.deps.createRunner?.(onEvent)
        ?? new AutodriveRunner(onEvent, {
          stepDelayMs: 3_000,
          errorDelayMs: 8_000,
          now: this.now,
          ...this.deps.runnerOptions,
        }, this.deps.adapter);
      this.runner.setPlanner?.(this.deps.planner);
      this.llmPlanner?.bindCallbacks({
        onInsight: (ev) => {
          appendEventLine(eventsFile, { type: 'insight', ...ev }, this.now());
          this.tracker.markInsight(ev.action);
        },
      });
      await this.runner.start();
    } catch (error) {
      startError = errorMessage(error);
      this.notes.push(`runner 启动失败：${startError}`);
      this.log(`[soak] 连接失败：${startError}`);
    }

    if (startError === null) {
      await this.waitLoop();
      await this.runner?.stopAndWait();
    }

    const endedAt = this.now();
    // 跑满计划游戏日时丢弃下一日的进行中残片（--days 1 的报告就该只有 1 天）；
    // 中断/超时/连接失败则把进行中的当天按部分日记录，方便复盘。
    if (this.interruptReason !== 'days') this.tracker.finish(endedAt);
    const runOptions: SoakRunOptions = {
      days: this.options.days,
      onStuck: this.options.onStuck,
      maxHours: this.options.maxHours,
      observerMs: this.options.observerMs,
      endpoint: this.options.endpoint,
    };
    if (this.observerErrors > 0) this.notes.push(`观察者 get_state 失败 ${this.observerErrors} 次（不影响事件流判定）`);
    const summary = buildSummary({
      runId,
      startedAt,
      endedAt,
      options: runOptions,
      llm: this.deps.llm,
      days: this.tracker.days,
      stucks: this.stucks,
      failureCounts: this.detector.failureCounts(),
      interrupted: this.interruptReason === 'signal'
        || this.interruptReason === 'on-stuck'
        || this.interruptReason === 'runner-exit',
      notes: this.notes,
      events: this.qualityEvents,
      ...(this.deps.getTokenUsage === undefined ? {} : { tokensUsed: this.deps.getTokenUsage() }),
    });
    const reportPath = join(this.runDir, 'report.md');
    const summaryPath = join(this.runDir, 'summary.json');
    writeFileSync(reportPath, renderReport(summary), 'utf8');
    writeJsonFile(summaryPath, summary);
    writeJsonFile(join(this.runDir, 'meta.json'), {
      ...meta,
      endedAt: summary.endedAt,
      days: summary.totals.days,
      stuck: summary.totals.stuck,
      interrupted: summary.interrupted,
    });

    this.log(
      `[soak] 结束：完成 ${summary.totals.days}/${summary.options.days} 游戏日 · 卡死 ${summary.totals.stuck} · `
      + `回执成功率 ${summary.totals.successRate === null ? '—' : `${Math.round(summary.totals.successRate * 100)}%`} · 报告 ${reportPath}`,
    );

    return {
      exitCode: startError === null ? exitCodeFor(summary) : 2,
      summary,
      runDir: this.runDir,
      reportPath,
      summaryPath,
    };
  }

  private async waitLoop(): Promise<void> {
    while (true) {
      if (this.stopRequested) return; // requestStop 已同时写入 interruptReason
      if (this.tracker.days.length >= this.options.days) {
        this.interruptReason = 'days';
        return;
      }
      const elapsed = this.now() - (this.startedAt ?? this.now());
      if (this.options.maxHours > 0 && elapsed >= this.options.maxHours * 3_600_000) {
        this.interruptReason = 'timeout';
        this.log(`[soak] 达到现实上限 ${this.options.maxHours}h，停止`);
        return;
      }
      if (this.runner?.isRunning !== undefined && this.runner.isRunning() === false) {
        this.interruptReason = 'runner-exit';
        this.log('[soak] runner 已自行停止，结束浸泡');
        return;
      }
      await this.observeTick();
      await this.sleep(WAIT_TICK_MS);
    }
  }

  private async observeTick(): Promise<void> {
    const { observerMs } = this.options;
    const observer = this.deps.observer;
    if (observer === null || observerMs <= 0) return;
    const ts = this.now();
    if (ts - this.lastObserveAt < observerMs) return;
    this.lastObserveAt = ts;
    let result: McpCallResult;
    try {
      result = await observer.callTool('get_state', {}, { timeoutMs: 20_000 });
    } catch (error) {
      this.observerErrors += 1;
      void error;
      return;
    }
    if (result.kind !== 'ok') {
      this.observerErrors += 1;
      return;
    }
    const snapshot = parseGameState(result.text);
    const clock = snapshot.gameClock === '未知' ? null : snapshot.gameClock;
    this.lastStateText = result.text;
    this.detector.setStateText(result.text);
    const verdict = this.detector.onClock(clock, result.text, ts);
    const finalized = this.tracker.observe({
      clock,
      money: snapshot.money,
      stamina: snapshot.stamina,
      weather: snapshot.weather,
      location: snapshot.location,
      raw: result.text,
      opportunity: parseDayOpportunity(result.text, snapshot),
    }, ts);
    if (finalized !== null) this.onDayFinalized(finalized);
    if (verdict !== null) this.handleStuck(verdict, ts);
  }

  private handleEvent(event: AutodriveEvent, ts: number, eventsFile: string): void {
    appendEventLine(eventsFile, event, ts);
    this.recentEvents.push(event);
    if (this.recentEvents.length > EVENT_BUFFER) this.recentEvents.splice(0, this.recentEvents.length - EVENT_BUFFER);

    if (event.type === 'decision') {
      this.qualityEvents.push({ type: 'decision', tool: event.tool });
    } else if (event.type === 'receipt') {
      this.qualityEvents.push({ type: 'receipt', tool: event.tool, status: event.status });
    } else if (event.type === 'watchdog') {
      this.qualityEvents.push({ type: 'watchdog' });
    }

    if (event.type === 'receipt') {
      if (event.tool !== 'autodrive') this.countReceipt(event.status);
      this.recentReceipts.push(`${event.status} ${event.tool}: ${event.summary}`);
      if (this.recentReceipts.length > RECEIPT_BUFFER) this.recentReceipts.splice(0, this.recentReceipts.length - RECEIPT_BUFFER);
      this.llmPlanner?.setRecentReceipts(this.recentReceipts);
    }

    const verdict = this.detector.onEvent(event, ts);
    const finalized = this.tracker.ingest(event, ts);
    if ((event.type === 'decision' || event.type === 'receipt') && this.llmPlanner !== null && this.tracker.today !== null) {
      const today = this.tracker.today;
      const shortDayKey = `${today.season}${today.dayKey.split('-').pop() ?? ''}`;
      if (this.llmPlanner.notebook.hasReflectedDay(shortDayKey)) this.tracker.markReflected();
    }
    if (finalized !== null) this.onDayFinalized(finalized);
    if (verdict !== null) this.handleStuck(verdict, ts);
    this.maybeProgress(ts);
  }

  private onDayFinalized(record: DayRecord): void {
    const totals = this.tracker.days.length;
    this.log(
      `[soak] 游戏日完成：${record.dayKey}（金币 ${record.moneyStart}g → ${record.moneyEnd}g，`
      + `卡死 ${record.stuckCount}，累计 ${totals}/${this.options.days}）`,
    );
  }

  private handleStuck(verdict: StuckVerdict, ts: number): void {
    this.tracker.markStuck();
    this.stuckIndex += 1;
    const pack = writeStuckPack(
      {
        runDir: this.runDir,
        saveDir: this.options.saveDir,
        ...(this.deps.captureScreen === undefined ? {} : { captureScreen: this.deps.captureScreen }),
        ...(this.deps.copySave === undefined ? {} : { copySave: this.deps.copySave }),
      },
      {
        index: this.stuckIndex,
        verdict,
        events: this.recentEvents,
        stateText: this.lastStateText,
        planner: this.plannerSnapshot(),
        dayKey: this.tracker.today?.dayKey ?? null,
        clock: verdict.clock,
      },
    );
    this.stucks.push({ ...verdict, dir: pack.dir });
    this.log(
      `[卡死] ${verdict.kind} ${verdict.signature} → ${pack.dir}`
      + `${pack.errors.length > 0 ? `（${pack.errors.length} 个文件写入失败，见 *.err）` : ''}`,
    );
    if (this.options.onStuck === 'stop') {
      this.log('[soak] --on-stuck=stop：首次卡死即停止');
      this.requestStop('on-stuck');
    }
  }

  private plannerSnapshot(): unknown {
    try {
      return this.deps.planner.debugSnapshot?.() ?? { planner: this.deps.planner.name };
    } catch (error) {
      return { planner: this.deps.planner.name, error: errorMessage(error) };
    }
  }

  private countReceipt(status: 'COMPLETED' | 'FAILED' | 'UNCERTAIN' | 'TIMEOUT' | 'ERROR'): void {
    addReceiptCount(this.receipts, status);
  }

  private maybeProgress(ts: number): void {
    if (ts - this.lastProgressAt < 60_000) return;
    this.lastProgressAt = ts;
    const today = this.tracker.today;
    const total = this.receipts.completed + this.receipts.failed + this.receipts.timeout
      + this.receipts.uncertain + this.receipts.error;
    const rate = total === 0 ? '—' : `${Math.round((this.receipts.completed / total) * 100)}%`;
    const top = topFailure(this.detector.failureCounts());
    this.log(
      `[soak] 进行中：${today?.dayKey ?? '—'} 金币 ${today?.moneyEnd ?? '—'}g · 成功率 ${rate}（${this.receipts.completed}/${total}）`
      + ` · 日 ${this.tracker.days.length}/${this.options.days} · 卡死 ${this.stucks.length}`
      + `${top === undefined ? '' : ` · 主签名 ${top[0]}×${top[1]}`}`,
    );
  }

  /** 兼容旧签名：只读 getter 供 signal handler 判断二次 Ctrl+C */
  get stopRequestedNow(): boolean {
    return this.stopRequested;
  }
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  env: Record<string, string | undefined> = process.env,
): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(HELP_TEXT);
    return 0;
  }
  let options: SoakOptions;
  try {
    options = parseArgs(argv);
  } catch (error) {
    if (error instanceof SoakUsageError) {
      console.error(`[soak] 参数错误：${error.message}\n`);
      console.error(HELP_TEXT);
      return 2;
    }
    throw error;
  }

  const runId = formatRunId(new Date());
  const tokenTotals: SoakTokenUsage = { input: 0, cachedInput: 0, output: 0, total: 0 };
  const resolution = resolveLlm(env, { noLlm: !options.llm });
  const bundle = createPlanner(resolution, {
    notesDir: join(options.outRoot, runId, 'notes'),
    onUsage: (usage) => {
      tokenTotals.input += usage.inputTokens;
      tokenTotals.cachedInput += usage.cachedInputTokens;
      tokenTotals.output += usage.outputTokens;
      tokenTotals.total += usage.inputTokens + usage.outputTokens;
    },
  });
  if (bundle.llm.mode === 'llm') {
    console.log(`[soak] LLM：开（${bundle.llm.provider}/${bundle.llm.model}）`);
  } else {
    console.log(`[soak] LLM：关（规则规划器）${bundle.llm.degradedReason === undefined ? '' : ` —— ${bundle.llm.degradedReason}`}`);
  }

  const adapter = new StardewAdapter(options.endpoint);
  const observer = options.observerMs > 0 ? new BwfMcpClient(options.endpoint) : null;
  const session = new SoakSession({
    runId,
    options,
    adapter,
    planner: bundle.planner,
    llm: bundle.llm,
    observer,
    fetchSettings: () => fetchBwfSettings(options.endpoint),
    ...(bundle.llm.mode === 'llm' ? { getTokenUsage: () => ({ ...tokenTotals }) } : {}),
  });

  const onSigint = (): void => {
    if (session.stopRequestedNow) {
      console.error('[soak] 再次 Ctrl+C：强制退出（不写报告）');
      process.exit(130);
    }
    console.error('[soak] 收到 Ctrl+C：先 stopAndWait，再写报告…');
    session.requestStop('signal');
  };
  process.on('SIGINT', onSigint);
  try {
    const result = await session.run();
    console.log(`[soak] 报告：${result.reportPath}`);
    console.log(
      result.summary.pass
        ? '[soak] 结论：✅ 达标'
        : `[soak] 结论：❌ 未达标（${result.summary.reasons.join('；')}）`,
    );
    return result.exitCode;
  } finally {
    process.off('SIGINT', onSigint);
  }
}

const entry = process.argv[1];
if (entry !== undefined && resolve(entry) === fileURLToPath(import.meta.url)) {
  main()
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      console.error(`[soak] 未捕获异常：${errorMessage(error)}`);
      process.exit(2);
    });
}
