/**
 * T-M6-67 soak:real CLI：参数解析、LLM 组装/降级、会话主循环（达标/卡死/超时/中断/观察者）、
 * 现场包与报告落盘、退出码 0/1/2。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LlmPlanner,
  RulePlanner,
  StardewAdapter,
  type Planner,
  type PlannerDecision,
} from '@workbench/game-bridge-mcp';
import {
  addReceiptCount,
  buildProviderConfig,
  createPlanner,
  defaultSaveDir,
  defaultSoakOptions,
  fetchBwfSettings,
  formatRunId,
  main,
  parseArgs,
  parseDayOpportunity,
  readGitHead,
  resolveLlm,
  SoakSession,
  SoakUsageError,
  topFailure,
  type ObserverClient,
  type SoakOptions,
  type SoakSessionDeps,
} from './cli';
import { StuckDetector } from './stuck-detector';

// ---------------------------------------------------------------------------
// 假 BWF（HTTP MCP 单请求）与状态文本
// ---------------------------------------------------------------------------

interface McpReply {
  text: string;
  isError?: boolean;
}

function fakeBwf(handler: (tool: string) => McpReply): typeof fetch {
  return (async (_input: unknown, init?: { body?: string }) => {
    const payload = JSON.parse(String(init?.body ?? '{}')) as { params?: { name?: string } };
    const tool = payload.params?.name ?? 'get_state';
    const reply = handler(tool);
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: { content: [{ type: 'text', text: reply.text }], isError: reply.isError === true },
      }),
    };
  }) as unknown as typeof fetch;
}

function stateText(clock: string, extra: { weather?: string; money?: number; stamina?: number } = {}): string {
  return `## 基本状态
时间：${clock}，天气：${extra.weather ?? '晴'}，明天天气：晴
金钱：${extra.money ?? 640}g  体力：${extra.stamina ?? 270}/270  生命：100/100
## 当前界面
无（可以自由行动）
## 位置
地点：Farm（泡泡湾农场），室外
## 背包
（空）`;
}

const DAY16 = '第1年春16日 07:00';
const DAY17 = '第1年春17日 06:00';

function alwaysAct(tool: string): Planner {
  return {
    name: 'test-always',
    async decide(): Promise<PlannerDecision> {
      return { kind: 'act', tool, args: {}, intent: tool };
    },
  };
}

function sequencePlanner(items: Array<{ tool: string; args?: Record<string, unknown> }>): Planner {
  let index = 0;
  return {
    name: 'test-sequence',
    async decide(): Promise<PlannerDecision> {
      const item = items[Math.min(index, items.length - 1)];
      index += 1;
      if (item === undefined) return { kind: 'wait', seconds: 1, reason: '序列结束' };
      return { kind: 'act', tool: item.tool, args: item.args ?? {}, intent: item.tool };
    },
  };
}

const fastRunnerOptions = {
  stepDelayMs: 0,
  errorDelayMs: 0,
  sleep: async (): Promise<void> => { await new Promise((resolveTick) => setImmediate(resolveTick)); },
};

const pacedRunnerOptions = {
  stepDelayMs: 0,
  errorDelayMs: 0,
  sleep: async (): Promise<void> => { await new Promise((resolveTick) => setTimeout(resolveTick, 2)); },
};

function baseOptions(overrides: Partial<SoakOptions> = {}): SoakOptions {
  return {
    days: 1,
    llm: false,
    onStuck: 'continue',
    maxHours: 0,
    observerMs: 0,
    endpoint: 'http://fake/mcp',
    outRoot: mkdtempSync(join(tmpdir(), 'soak-out-')),
    saveDir: null,
    ...overrides,
  };
}

function makeSession(overrides: Partial<SoakSessionDeps> & { options: SoakOptions }): SoakSession {
  return new SoakSession({
    adapter: new StardewAdapter('http://fake/mcp', fakeBwf(() => ({ text: stateText(DAY16) }))),
    planner: alwaysAct('water_crops'),
    llm: { mode: 'rule', degradedReason: '--no-llm' },
    observer: null,
    log: () => {},
    runId: 'run-test',
    runnerOptions: fastRunnerOptions,
    sleep: async (): Promise<void> => { await new Promise((resolveTick) => setTimeout(resolveTick, 5)); },
    ...overrides,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 每日闭环机会解析
// ---------------------------------------------------------------------------

describe('parseDayOpportunity', () => {
  const snapshot = (over: { clockMinutes?: number; money?: number; festival?: string | null } = {}) => ({
    clockMinutes: over.clockMinutes ?? 12 * 60,
    money: over.money ?? 1000,
    festival: over.festival ?? null,
  });

  it('农场概况全 0、无未读信、无空地 → 五项全无机会', () => {
    const raw = '（农场概况：共 0 株作物，需浇水 0，可收获 0）\n## 背包\n22: 稻苗 x3 [种子]';
    expect(parseDayOpportunity(raw, snapshot())).toEqual({
      mail: false, water: false, harvest: false, buySeeds: false, plant: false,
    });
  });

  it('需浇水/可收获/未读信/空地/种子各自触发对应机会', () => {
    const raw = [
      '（农场概况：共 1 株作物，需浇水 1，可收获 1）',
      '空耕地 3 格（可播种）：(1,1) (2,1) (3,1)',
      '你还有 2 封未读信件',
      '## 背包',
      '22: 稻苗 x3 [种子]',
    ].join('\n');
    expect(parseDayOpportunity(raw, snapshot())).toEqual({
      mail: true, water: true, harvest: true, buySeeds: true, plant: true,
    });
  });

  it('没有空地时不买种不播种，哪怕钱够且背包有种子', () => {
    const raw = '（农场概况：共 2 株作物，需浇水 0，可收获 0）\n## 背包\n22: 稻苗 x3 [种子]';
    const opp = parseDayOpportunity(raw, snapshot());
    expect(opp.buySeeds).toBe(false);
    expect(opp.plant).toBe(false);
  });

  it('商店打烊（17:00 后）不买种，但播种不受营业时间影响', () => {
    const raw = [
      '（农场概况：共 1 株作物，需浇水 0，可收获 0）',
      '空耕地 2 格（可播种）：(1,1) (2,1)',
      '## 背包',
      '22: 稻苗 x3 [种子]',
    ].join('\n');
    const evening = parseDayOpportunity(raw, snapshot({ clockMinutes: 18 * 60 }));
    expect(evening.buySeeds).toBe(false);
    expect(evening.plant).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 参数 / LLM 配置
// ---------------------------------------------------------------------------

describe('parseArgs', () => {
  it('默认值：1 天、LLM 开、观察者 30s、18080 端点、artifacts/soak', () => {
    const options = parseArgs([]);
    expect(options).toMatchObject({
      days: 1,
      llm: true,
      onStuck: 'continue',
      maxHours: 0,
      observerMs: 30_000,
      endpoint: 'http://127.0.0.1:18080/mcp',
    });
    expect(options.outRoot.endsWith(join('artifacts', 'soak'))).toBe(true);
  });

  it('支持 --k=v 与 --k v 两种写法', () => {    const options = parseArgs([
      '--days', '2', '--no-llm', '--on-stuck=stop', '--max-hours', '3',
      '--observer-ms=1000', '--endpoint', 'http://127.0.0.1:9999/mcp',
      '--out=./tmp-out', '--save-dir', './tmp-save',
    ]);
    expect(options).toMatchObject({
      days: 2,
      llm: false,
      onStuck: 'stop',
      maxHours: 3,
      observerMs: 1_000,
      endpoint: 'http://127.0.0.1:9999/mcp',
      outRoot: resolve('tmp-out'),
      saveDir: resolve('tmp-save'),
    });
    expect(parseArgs(['--no-llm', '--llm']).llm).toBe(true);
    expect(parseArgs(['', '--days', '2']).days).toBe(2); // 空参数跳过
    expect(parseArgs(['--', '--days', '3']).days).toBe(3); // pnpm 透传的 -- 也跳过
  });

  it('非法参数抛 SoakUsageError（退出码 2 的入口）', () => {
    const cases: string[][] = [
      ['--wat'],
      ['--days', '0'],
      ['--days', '1.5'],
      ['--days', 'abc'],
      ['--on-stuck', 'maybe'],
      ['--observer-ms', '-1'],
      ['--max-hours', '999'],
      ['--endpoint', 'ftp://x'],
      ['--days'],
      ['--days='],
    ];
    for (const argv of cases) {
      expect(() => parseArgs(argv), argv.join(' ')).toThrow(SoakUsageError);
    }
  });

  it('defaultSoakOptions 读 WHALE_SOAK_SAVE_DIR 覆盖存档目录', () => {
    const previous = process.env.WHALE_SOAK_SAVE_DIR;
    process.env.WHALE_SOAK_SAVE_DIR = '/tmp/soak-save-dir';
    try {
      expect(defaultSaveDir()).toBe('/tmp/soak-save-dir');
    } finally {
      if (previous === undefined) delete process.env.WHALE_SOAK_SAVE_DIR;
      else process.env.WHALE_SOAK_SAVE_DIR = previous;
    }
    expect(defaultSoakOptions().days).toBe(1);
  });
});

describe('resolveLlm / createPlanner', () => {
  it('--no-llm 与缺环境变量都降级为规则并给出原因', () => {
    expect(resolveLlm({}, { noLlm: true })).toEqual({ mode: 'rule', reason: '--no-llm' });
    const missing = resolveLlm({ WHALE_SOAK_PROVIDER: 'deepseek-official' }, { noLlm: false });
    expect(missing.mode).toBe('rule');
    expect(missing.reason).toContain('WHALE_SOAK_API_KEY');
    expect(missing.reason).toContain('WHALE_SOAK_MODEL');
    expect(missing.reason).toContain('自动降级');
  });

  it('三项环境变量齐全时给出 LLM 配置（含自建端点）', () => {
    const resolution = resolveLlm({
      WHALE_SOAK_PROVIDER: 'deepseek-official',
      WHALE_SOAK_API_KEY: 'sk-test',
      WHALE_SOAK_MODEL: 'deepseek-chat',
      WHALE_SOAK_BASE_URL: 'https://proxy.example.com/v1',
    }, { noLlm: false });
    expect(resolution).toEqual({
      mode: 'llm',
      config: {
        provider: 'deepseek-official',
        apiKey: 'sk-test',
        model: 'deepseek-chat',
        baseUrl: 'https://proxy.example.com/v1',
      },
    });
  });

  it('buildProviderConfig：预设 + 端点覆盖 / 未知供应商 + 自建端点', () => {
    const overridden = buildProviderConfig(
      { provider: 'deepseek-official', apiKey: 'k', model: 'deepseek-chat', baseUrl: 'https://proxy.example.com/v1' },
      {
        id: 'deepseek-official', name: 'DeepSeek', category: 'OFFICIAL_LLM',
        activeRegion: 'CN', activePlanType: 'PAY_AS_YOU_GO', protocol: 'openai',
        variants: [{ region: 'CN', planType: 'PAY_AS_YOU_GO', baseUrl: 'https://api.deepseek.com/v1', isFullUrl: false, protocol: 'openai' }],
        apiKeyMaskedOrRef: '', activeModelId: '', discoveredModels: [],
      },
    );
    expect(overridden.activeModelId).toBe('deepseek-chat');
    expect(overridden.variants).toEqual([
      { region: 'CN', planType: 'PAY_AS_YOU_GO', baseUrl: 'https://proxy.example.com/v1', isFullUrl: false, protocol: 'openai' },
    ]);
    const custom = buildProviderConfig(
      { provider: 'my-proxy', apiKey: 'k', model: 'm', baseUrl: 'https://my.example.com/v1' },
      undefined,
    );
    expect(custom).toMatchObject({ id: 'my-proxy', name: 'my-proxy', category: 'AGGREGATOR_LLM', activeModelId: 'm' });
    expect(custom.variants[0]?.baseUrl).toBe('https://my.example.com/v1');
  });

  it('LLM 规划器真实经 ModelGateway 出网（假 fetch），失败/未知预设降级', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: '{"tool":"wait","args":{},"intent":"等一会儿"}' } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
      };
    }) as unknown as NonNullable<Parameters<typeof createPlanner>[1]>['fetchImpl'];

    const bundle = createPlanner({
      mode: 'llm',
      config: { provider: 'deepseek-official', apiKey: 'sk-test', model: 'deepseek-chat' },
    }, { fetchImpl });
    expect(bundle.llm).toMatchObject({ mode: 'llm', provider: 'deepseek-official', model: 'deepseek-chat' });
    expect(bundle.planner).toBeInstanceOf(LlmPlanner);

    const decision = await bundle.planner.decide({
      raw: `## 基本状态\n时间：${DAY16}\n## 当前界面\n无（可以自由行动）`,
      gameClock: DAY16,
      clockMinutes: 7 * 60,
      stamina: 270,
      staminaMax: 270,
      money: 640,
      location: 'Farm',
      menu: '',
      season: '春',
      day: 16,
      freeSlots: 5,
      posX: 1,
      posY: 1,
      weather: '晴',
      health: 100,
      healthMax: 100,
      birthday: null,
      festival: null,
    });
    expect(['act', 'wait']).toContain(decision.kind);
    expect(calls.some((url) => url.includes('api.deepseek.com'))).toBe(true);

    const unknown = createPlanner({
      mode: 'llm',
      config: { provider: 'no-such-provider', apiKey: 'k', model: 'm' },
    });
    expect(unknown.planner).toBeInstanceOf(RulePlanner);
    expect(unknown.llm.mode).toBe('rule');
    expect(unknown.llm.degradedReason).toContain('WHALE_SOAK_BASE_URL');

    const custom = createPlanner({
      mode: 'llm',
      config: { provider: 'my-proxy', apiKey: 'k', model: 'm', baseUrl: 'https://my.example.com/v1' },
    });
    expect(custom.llm).toMatchObject({ mode: 'llm', provider: 'my-proxy', model: 'm' });

    const rule = createPlanner({ mode: 'rule', reason: '--no-llm' });
    expect(rule.planner).toBeInstanceOf(RulePlanner);
  });

  it('LLM 初始化失败（非法端点）降级为规则', () => {
    const bundle = createPlanner({
      mode: 'llm',
      config: { provider: 'deepseek-official', apiKey: 'k', model: 'm', baseUrl: 'not-a-url' },
    });
    expect(bundle.llm.mode).toBe('rule');
    expect(bundle.llm.degradedReason).toContain('LLM 初始化失败');
  });
});

// ---------------------------------------------------------------------------
// 会话主循环
// ---------------------------------------------------------------------------

describe('SoakSession', () => {
  it('完整 1 个游戏日：闭环全勾、报告达标、退出码 0', async () => {
    const options = baseOptions();
    let slept = false;
    const adapter = new StardewAdapter(options.endpoint, fakeBwf((tool) => {
      if (tool === 'get_state') return { text: stateText(slept ? DAY17 : DAY16) };
      if (tool === 'sleep') {
        slept = true;
        return { text: '睡了一觉，第 17 天' };
      }
      return { text: `完成 ${tool}` };
    }));
    const planner = sequencePlanner([
      { tool: 'read_mail' },
      { tool: 'water_crops' },
      { tool: 'harvest_crops' },
      { tool: 'ship_items' },
      { tool: 'buy', args: { item: '防风草种子' } },
      { tool: 'plant_seeds' },
      { tool: 'sleep' },
    ]);
    const result = await makeSession({
      options,
      adapter,
      planner,
      fetchSettings: async () => ({ ok: true, text: '{"showHud":true}' }),
    }).run();

    expect(result.exitCode).toBe(0);
    expect(result.summary.pass).toBe(true);
    expect(result.summary.days).toHaveLength(1);
    expect(result.summary.days[0]).toMatchObject({
      dayKey: 'Y1-春-16',
      loop: { mail: true, water: true, harvest: true, ship: true, buySeeds: true, plant: true, sleptBefore2am: true },
    });
    expect(existsSync(result.reportPath)).toBe(true);
    expect(result.summary.quality.receipts).toBeGreaterThan(0);
    expect(result.summary.quality.decisions).toBeGreaterThan(0);
    expect(readFileSync(result.reportPath, 'utf8')).toContain('✅ 达标');
    expect(readFileSync(result.reportPath, 'utf8')).toContain('| 质量（metrics.ts） |');
    const summary = JSON.parse(readFileSync(result.summaryPath, 'utf8')) as { pass: boolean };
    expect(summary.pass).toBe(true);
    const meta = JSON.parse(readFileSync(join(result.runDir, 'meta.json'), 'utf8')) as Record<string, unknown>;
    expect(meta['bwfSettings']).toMatchObject({ ok: true });
    expect(typeof meta['endedAt']).toBe('string');
    const events = readFileSync(join(result.runDir, 'events.jsonl'), 'utf8').trim().split('\n');
    expect(events.length).toBeGreaterThan(5);
  });

  it('连接失败：退出码 2、报告照写、现场包记录 /settings 失败', async () => {
    const options = baseOptions();
    const adapter = new StardewAdapter(
      options.endpoint,
      (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch,
    );
    const result = await makeSession({
      options,
      adapter,
      fetchSettings: async () => ({ ok: false, error: 'ECONNREFUSED' }),
    }).run();

    expect(result.exitCode).toBe(2);
    expect(result.summary.totals.days).toBe(0);
    expect(result.summary.notes.join('\n')).toContain('runner 启动失败');
    expect(existsSync(result.reportPath)).toBe(true);
    const meta = JSON.parse(readFileSync(join(result.runDir, 'meta.json'), 'utf8')) as Record<string, unknown>;
    expect(meta['bwfSettings']).toMatchObject({ ok: false });
  });

  it('重复失败 → repeat-failure 现场包；--on-stuck=stop 立即停并退出 1', async () => {
    const options = baseOptions({ onStuck: 'stop' });
    const adapter = new StardewAdapter(options.endpoint, fakeBwf((tool) => (
      tool === 'get_state'
        ? { text: stateText('第1年春16日 10:00') }
        : { text: '背包里没有鱼竿', isError: true }
    )));
    const planner: Planner = {
      name: 'stuck-test',
      async decide(): Promise<PlannerDecision> {
        return { kind: 'act', tool: 'fish', args: { casts: 5 }, intent: '钓鱼' };
      },
      debugSnapshot(): Record<string, unknown> {
        throw new Error('snapshot 爆炸');
      },
    };
    const result = await makeSession({
      options,
      adapter,
      planner,
      captureScreen: () => ({ ok: false, error: '无屏幕录制权限' }),
    }).run();

    expect(result.exitCode).toBe(1);
    expect(result.summary.pass).toBe(false);
    expect(result.summary.interrupted).toBe(true);
    expect(result.summary.stucks.length).toBeGreaterThan(0);
    const first = result.summary.stucks[0];
    expect(first).toBeDefined();
    expect(['repeat-failure', 'sentinel']).toContain(first!.kind);
    const dir = join(result.runDir, first!.dir);
    expect(existsSync(join(dir, 'verdict.json'))).toBe(true);
    expect(readFileSync(join(dir, 'screen.err'), 'utf8')).toContain('无屏幕录制权限');
    expect(readFileSync(join(dir, 'save.err'), 'utf8')).toContain('--save-dir');
    const plannerJson = JSON.parse(readFileSync(join(dir, 'planner.json'), 'utf8')) as Record<string, unknown>;
    expect(plannerJson).toMatchObject({ planner: 'stuck-test', error: 'snapshot 爆炸' });
    expect(result.summary.reasons.join('\n')).toContain('卡死');
  });

  it('--max-hours 到点停止（不算中断）：退出码 1、日不足', async () => {
    const options = baseOptions({ days: 2, maxHours: 0.0003 }); // ≈1.08s
    const adapter = new StardewAdapter(options.endpoint, fakeBwf((tool) => (
      tool === 'get_state' ? { text: stateText('第1年春16日 10:00') } : { text: '完成' }
    )));
    const result = await makeSession({
      options,
      adapter,
      planner: alwaysAct('water_crops'),
      runnerOptions: pacedRunnerOptions,
    }).run();

    expect(result.exitCode).toBe(1);
    expect(result.summary.interrupted).toBe(false);
    expect(result.summary.reasons.join('\n')).toContain('游戏日不足');
    expect(result.summary.reasons.join('\n')).toContain('闭环不完整');
    expect(result.summary.totals.days).toBe(1); // 超时把当天按部分日落账
    expect(result.summary.totals.loopCompleteDays).toBe(0);
    expect(result.summary.notes.join('\n')).toContain('未找到存档目录');
  });

  it('Ctrl+C（requestStop）：先停再写报告，interrupted=true', async () => {
    const options = baseOptions();
    const adapter = new StardewAdapter(options.endpoint, fakeBwf((tool) => (
      tool === 'get_state' ? { text: stateText('第1年春16日 10:00') } : { text: '完成' }
    )));
    const session = makeSession({ options, adapter, planner: alwaysAct('water_crops'), runnerOptions: pacedRunnerOptions });
    setTimeout(() => session.requestStop('signal'), 100);
    const result = await session.run();
    expect(result.exitCode).toBe(1);
    expect(result.summary.interrupted).toBe(true);
    expect(result.summary.reasons.join('\n')).toContain('运行被中断');
  });

  it('观察者提供天气与跨日：雨天自动算浇水；观察者失败留痕', async () => {
    const options = baseOptions({ observerMs: 10 });
    const adapter = new StardewAdapter(options.endpoint, fakeBwf((tool) => (
      tool === 'get_state' ? { text: stateText(DAY16) } : { text: '完成' }
    )));
    let polls = 0;
    const observer: ObserverClient = {
      async callTool() {
        polls += 1;
        if (polls === 1) return { kind: 'timeout', timeoutMs: 1_000 };
        if (polls === 2) return { kind: 'ok', text: stateText(DAY16, { weather: '下雨' }), isError: false };
        return { kind: 'ok', text: stateText(DAY17, { weather: '下雨' }), isError: false };
      },
    };
    const result = await makeSession({
      options,
      adapter,
      planner: alwaysAct('water_crops'),
      observer,
      runnerOptions: pacedRunnerOptions,
    }).run();

    expect(result.exitCode).toBe(1); // 只做了浇水（雨天），闭环不全 → 不达标
    expect(result.summary.days[0]).toMatchObject({ dayKey: 'Y1-春-16', weather: '下雨' });
    expect(result.summary.days[0]?.loop.water).toBe(true);
    expect(result.summary.notes.join('\n')).toContain('观察者 get_state 失败 1 次');
  });

  it('runner 自行停止 → runner-exit（算中断）；fetchSettings 抛异常只记录', async () => {
    const logs: string[] = [];
    const result = await makeSession({
      options: baseOptions(),
      log: (line) => logs.push(line),
      createRunner: () => ({
        start: async () => {},
        stopAndWait: async () => {},
        isRunning: () => false,
      }),
      fetchSettings: async () => { throw new Error('settings 爆炸'); },
    }).run();
    expect(result.exitCode).toBe(1);
    expect(result.summary.interrupted).toBe(true);
    expect(logs.join('\n')).toContain('runner 已自行停止');
    const meta = JSON.parse(readFileSync(join(result.runDir, 'meta.json'), 'utf8')) as Record<string, unknown>;
    expect(meta['bwfSettings']).toMatchObject({ ok: false, error: 'settings 爆炸' });
  });

  it('LLM 规划器会话：回执持续回灌 recentReceipts', async () => {
    const options = baseOptions({ maxHours: 0.0002 });
    const planner = new LlmPlanner({
      chat: async () => ({ content: '{"tool":"water_crops","args":{},"intent":"浇水"}' }),
      slot: 'STARDEW_GAME_PLANNER',
    });
    const adapter = new StardewAdapter(options.endpoint, fakeBwf((tool) => (
      tool === 'get_state' ? { text: stateText('第1年春16日 10:00') } : { text: '完成' }
    )));
    const result = await makeSession({
      options,
      adapter,
      planner,
      runnerOptions: pacedRunnerOptions,
    }).run();
    expect(result.exitCode).toBe(1);
    expect(result.summary.totals.receipts.completed).toBeGreaterThan(0);
  });

  it('观察者时钟停滞 → clock-stall 现场包（含观察者状态原文）', async () => {
    const options = baseOptions({ days: 5, observerMs: 1, onStuck: 'stop' });
    const observer: ObserverClient = {
      async callTool() {
        return { kind: 'ok', text: stateText('第1年春16日 10:00'), isError: false };
      },
    };
    const result = await makeSession({
      options,
      observer,
      detector: new StuckDetector({ clockStallMs: 50 }),
      // 没有 runner 事件，时钟只来自观察者，确保走 observeTick 的判定分支
      createRunner: () => ({ start: async () => {}, stopAndWait: async () => {}, isRunning: () => true }),
    }).run();

    expect(result.exitCode).toBe(1);
    expect(result.summary.interrupted).toBe(true);
    const first = result.summary.stucks[0];
    expect(first?.kind).toBe('clock-stall');
    expect(first?.signature).toContain('clock-stall');
    const packDir = join(result.runDir, first?.dir ?? '');
    expect(readFileSync(join(packDir, 'state.txt'), 'utf8')).toContain('第1年春16日 10:00');
  });

  it('观察者抛异常只计数不打断；getter 暴露停止状态', async () => {
    const options = baseOptions({ days: 5, observerMs: 1 });
    const observer: ObserverClient = {
      async callTool() {
        throw new Error('观察者炸了');
      },
    };
    const session = makeSession({ options, observer });
    expect(session.stopRequestedFlag).toBe(false);
    setTimeout(() => session.requestStop('signal'), 60);
    const result = await session.run();
    expect(session.stopRequestedNow).toBe(true);
    expect(result.summary.notes.join('\n')).toContain('观察者 get_state 失败');
  });

  it('未注入 now/sleep/log 时用生产默认值', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const options = baseOptions();
    const session = new SoakSession({
      options,
      adapter: new StardewAdapter(options.endpoint, fakeBwf(() => ({ text: stateText(DAY16) }))),
      planner: alwaysAct('water_crops'),
      llm: { mode: 'rule', degradedReason: '--no-llm' },
      observer: null,
      runId: 'run-defaults',
      createRunner: () => ({ start: async () => {}, stopAndWait: async () => {}, isRunning: () => false }),
    });
    const result = await session.run();
    expect(result.exitCode).toBe(1);
    expect(log.mock.calls.join('\n')).toContain('[soak] 开始');
  });
});

// ---------------------------------------------------------------------------
// 入口 / 工具函数
// ---------------------------------------------------------------------------

describe('main 与辅助函数', () => {
  it('--help 返回 0；参数错误返回 2', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await main(['--help'], {})).toBe(0);
    expect(log.mock.calls.join('\n')).toContain('soak:real');
    expect(await main(['--days', '0'], {})).toBe(2);
    expect(error.mock.calls.join('\n')).toContain('参数错误');
  });

  it('端点不可达：LLM 降级提示 + 退出码 2；有 Key 时走 LLM 分支', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const outRoot = mkdtempSync(join(tmpdir(), 'soak-main-'));
    const base = ['--days', '1', '--observer-ms', '0', '--endpoint', 'http://127.0.0.1:1/mcp', '--out', outRoot];
    expect(await main(base, {})).toBe(2);
    expect(await main(base, {
      WHALE_SOAK_PROVIDER: 'deepseek-official',
      WHALE_SOAK_API_KEY: 'sk-test',
      WHALE_SOAK_MODEL: 'deepseek-chat',
    })).toBe(2);
  });

  it('fetchBwfSettings：自动去 /mcp、HTTP 错误与网络异常都不抛', async () => {
    const okFetch = (async (url: string) => ({
      ok: true,
      status: 200,
      text: async () => `settings@${url}`,
    })) as unknown as typeof fetch;
    expect(await fetchBwfSettings('http://h:1/mcp', okFetch)).toEqual({ ok: true, text: 'settings@http://h:1/settings' });

    const badStatus = (async () => ({ ok: false, status: 500, text: async () => '' })) as unknown as typeof fetch;
    expect(await fetchBwfSettings('http://h:1/mcp', badStatus)).toEqual({ ok: false, error: 'HTTP 500' });

    const boom = (async () => { throw new Error('网络不可达'); }) as unknown as typeof fetch;
    expect(await fetchBwfSettings('http://h:1/mcp', boom)).toEqual({ ok: false, error: '网络不可达' });
  });

  it('readGitHead：detached / 直接 ref / packed-refs / 缺失', () => {
    const root = mkdtempSync(join(tmpdir(), 'soak-git-'));
    expect(readGitHead(root)).toBeNull();

    mkdirSync(join(root, '.git'), { recursive: true });
    writeFileSync(join(root, '.git', 'HEAD'), 'abc123\n');
    expect(readGitHead(root)).toBe('abc123');

    writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    mkdirSync(join(root, '.git', 'refs', 'heads'), { recursive: true });
    writeFileSync(join(root, '.git', 'refs', 'heads', 'main'), 'def456\n');
    expect(readGitHead(root)).toBe('def456');

    writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/feature\n');
    writeFileSync(join(root, '.git', 'packed-refs'), '# pack-refs with: peeled fully-peeled\nfedcba refs/heads/feature\n');
    expect(readGitHead(root)).toBe('fedcba');

    writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/gone\n');
    expect(readGitHead(root)).toBeNull();
  });

  it('formatRunId 生成 YYYYMMDD-HHmmss', () => {
    expect(formatRunId(new Date(2026, 4, 1, 7, 8, 9))).toBe('20260501-070809');
  });

  it('addReceiptCount 覆盖五种状态；topFailure 取次数最多', () => {
    const counts = { completed: 0, failed: 0, timeout: 0, uncertain: 0, error: 0 };
    for (const status of ['COMPLETED', 'FAILED', 'TIMEOUT', 'UNCERTAIN', 'ERROR'] as const) {
      addReceiptCount(counts, status);
    }
    expect(counts).toEqual({ completed: 1, failed: 1, timeout: 1, uncertain: 1, error: 1 });

    expect(topFailure(new Map())).toBeUndefined();
    const top = topFailure(new Map([['a|1|x', 1], ['b|2|y', 4], ['c|3|z', 2]]));
    expect(top).toEqual(['b|2|y', 4]);
  });
});
