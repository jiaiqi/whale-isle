/**
 * V2-P4-01 [E2E-HOST] + [SIMULATION]：真实 ModelGateway HTTP / LlmPlanner / 租约 / IPC / 磁盘记忆。
 * 模型端为本地 OpenAI 协议 stub，无真实推理；游戏端为 BWF 回放或农场仿真，无真实游戏写入。
 * 显式规则代驾、默认安全暂停分别断言，禁止把回退动作冒充模型成功。
 */
import { randomUUID } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { describe, expect, it } from 'vitest';
import { BrainRuntimeConfigSchema, type BrainRuntimeConfig } from '@workbench/shared-protocol';
import { startBwfFarmSim } from '../../../tools/mock-harness/src/bwf-farm-sim';
import { startBwfHttpServer, type ReplayCall } from '../../../tools/mock-harness/src/bwf-replay-server';

type Scenario = 'model' | 'unavailable' | 'timeout' | 'illegal' | 'missing-key';
const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const mainEntry = join(appRoot, 'dist/main/index.js');
const providerId = 'p4-local-stub';

// 外部 OpenAI Chat Completions 协议夹具，不替换 fetch、gateway、planner 或宿主回执。
async function startModelStub(scenario: Scenario, marker: string) {
  const calls: Array<{ model: string; messages: Array<{ role: string; content: string }> }> = [];
  const pending: ServerResponse[] = [];
  let held = scenario === 'model';
  let responses = 0;
  const send = (res: ServerResponse): void => {
    if (scenario === 'timeout') return; // 故意不发响应，必须由宿主真实 AbortSignal 终止 HTTP
    if (scenario === 'unavailable') {
      res.writeHead(503).end(JSON.stringify({ error: { message: '本地故障注入' } }));
      return;
    }
    responses += 1;
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      id: `simulation-${responses}`, object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify({
        tool: scenario === 'illegal' ? 'unauthorized_shell' : 'harvest_crops',
        args: {}, intent: `${marker} 模型动作 ${responses}`,
      }) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 17, completion_tokens: 9, total_tokens: 26 },
    }));
  };
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.writeHead(404).end();
      return;
    }
    let body = '';
    for await (const chunk of req) body += String(chunk);
    const parsed = JSON.parse(body) as (typeof calls)[number];
    calls.push(parsed);
    if (held) pending.push(res);
    else send(res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('stub 未取得回环端口');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`, calls,
    get responses() { return responses; },
    release() { held = false; for (const res of pending.splice(0)) send(res); },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

interface ChainEvent {
  type: string; tool?: string; status?: string; summary?: string;
  planner?: string; intent?: string; mode?: string; reason?: string;
  sessionId?: string; generation?: number; seq?: number;
}
interface ChainBridge {
  brainApplyConfig(config: BrainRuntimeConfig): Promise<{ ok: boolean; mode: string; llmReady: boolean }>;
  plannerSwitch(mode: 'rule' | 'llm'): Promise<{ ok: boolean; mode: string }>;
  plannerStatus(): Promise<{ mode: string; llmReady: boolean }>;
  autodriveStatus(): Promise<{ running: boolean; sessionId: string; generation: number; events: ChainEvent[] }>;
  autodriveStop(): Promise<unknown>;
  autodriveSetHumanControl(active: boolean): Promise<{ ok: boolean; humanControl: boolean }>;
  v2MemoryQuery(input: { query: string; topN: number }): Promise<{ ok: boolean; hits: Array<{ text: string }> }>;
}
const events = (page: Page) => page.evaluate(() =>
  (window as unknown as { directorBridge: ChainBridge }).directorBridge.autodriveStatus().then((s) => s.events),
);
async function directorWindow(app: ElectronApplication): Promise<Page> {
  await expect.poll(() => app.windows().some((w) => w.url().includes('director')), { timeout: 20_000 }).toBe(true);
  const page = app.windows().find((w) => w.url().includes('director'))!;
  await page.waitForFunction(() => Boolean((window as unknown as { directorBridge?: unknown }).directorBridge));
  await page.evaluate(() => {
    localStorage.setItem('wb-tab', 'stardew');
    localStorage.setItem('wb-game', 'stardew');
    localStorage.setItem('wb-game-subtab', 'monitor');
    localStorage.removeItem('wb-stardew-auto-launch');
  });
  await page.reload();
  await page.waitForSelector('[data-autodrive-toggle]');
  // 等待正常 Dexie 配置水合结束后再经 IPC 热更新，避免后到的默认配置覆盖测试绑定。
  await page.waitForFunction(() => Boolean(document.querySelector('[data-game-panel][data-active-game="stardew"]')));
  return page;
}
async function startViaUi(page: Page): Promise<void> {
  await page.click('[data-autodrive-toggle]');
  await page.waitForSelector('[data-stardew-launch-prompt]');
  await page.click('[data-stardew-auto-launch]');
  await page.click('[data-stardew-launch-confirm]');
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as { directorBridge: ChainBridge }).directorBridge.autodriveStatus().then((s) => s.running),
  ), { timeout: 30_000 }).toBe(true);
}
function brainConfig(baseUrl: string, allowRuleStandin: boolean): BrainRuntimeConfig {
  return BrainRuntimeConfigSchema.parse({
    profile: {
      profileId: 'OFFLINE_SURVIVAL', displayName: '[SIMULATION] P4 本地模型',
      roleBindings: { STARDEW_GAME_PLANNER: `${providerId}/scripted-action` }, secretMaskingEnabled: true,
    },
    providers: [{
      id: providerId, name: '[SIMULATION] 本地 stub', category: 'LOCAL_LLM',
      activeRegion: 'LOCAL', activePlanType: 'LOCAL_GPU', apiKeyMaskedOrRef: '',
      variants: [{ region: 'LOCAL', planType: 'LOCAL_GPU', baseUrl, protocol: 'openai' }],
      discoveredModels: [{ id: 'scripted-action' }],
    }],
    allowRuleStandin, plannerTimeoutMs: 500,
  });
}

const state = `时间：第1年春16日 07:30（Tue），天气：晴
金钱：640g  体力：270/270  生命：100/100
## 当前界面
无（可以自由行动）
## 位置
地点：Farm（仿真农场）
## 背包（序号: 物品）
0: 斧头
背包空位：8 个（共 12 格）`;

describe('[E2E-HOST] [SIMULATION] V2-P4-01 单角色 LLM 链路', () => {
  it('模型 HTTP 动作受租约约束，三态事实回执分别落入可检索记忆', { timeout: 120_000 }, async () => {
    const marker = `p4${randomUUID().replaceAll('-', '')}`;
    const model = await startModelStub('model', marker);
    const calls: ReplayCall[] = [];
    let actionCount = 0;
    const summaries = [
      { text: `${marker} 收获草莓成功` },
      { text: `失败：${marker} 背包已满`, isError: true },
      { text: `不确定：${marker} 动作被打断，需要重新观察`, isError: true },
    ];
    const bwf = await startBwfHttpServer(({ tool }) => {
      if (tool === 'get_state') return { text: state };
      if (tool === 'cancel_action') return { text: '已取消动作' };
      return summaries[Math.min(actionCount++, 2)]!;
    }, { onCall: (call) => calls.push(call) });
    let app: ElectronApplication | undefined;
    try {
      app = await electron.launch({ executablePath: require('electron') as string,
        args: ['--use-mock-keychain', mainEntry],
        env: { ...process.env, PET_STAGE_E2E: '1', WHALE_E2E_GAME_OFFLINE: '1',
          WHALE_E2E_BWF_ENDPOINT: bwf.endpoint, WHALE_PROVIDER_KEY_P4_LOCAL_STUB: 'simulation-placeholder' },
      });
      const page = await directorWindow(app);
      const applied = await page.evaluate((config) =>
        (window as unknown as { directorBridge: ChainBridge }).directorBridge.brainApplyConfig(config),
      { ...brainConfig(model.baseUrl, true), plannerTimeoutMs: 15_000 });
      expect(applied).toMatchObject({ ok: true, mode: 'llm' });
      await startViaUi(page);
      await expect.poll(() => model.calls.length, { timeout: 15_000 }).toBeGreaterThan(0);
      // HTTP 尚在途时收回租约；返回的模型动作必须丢弃，不能绕过控制权校验。
      const human = await page.evaluate(() =>
        (window as unknown as { directorBridge: ChainBridge }).directorBridge.autodriveSetHumanControl(true));
      expect(human).toMatchObject({ ok: true, humanControl: true });
      const observed = calls.filter((c) => c.tool === 'get_state').length;
      model.release();
      await expect.poll(() => calls.filter((c) => c.tool === 'get_state').length,
        { timeout: 15_000 }).toBeGreaterThan(observed);
      expect(calls.filter((c) => c.tool === 'harvest_crops')).toHaveLength(0);
      await page.evaluate(() =>
        (window as unknown as { directorBridge: ChainBridge }).directorBridge.autodriveSetHumanControl(false));
      await expect.poll(async () => (await events(page)).filter((e) => e.type === 'receipt' && e.tool === 'harvest_crops').length,
        { timeout: 30_000 }).toBeGreaterThanOrEqual(3);
      await page.evaluate(() => (window as unknown as { directorBridge: ChainBridge }).directorBridge.autodriveStop());
      const history = await events(page);
      const decisions = history.filter((e) => e.type === 'decision' && e.tool === 'harvest_crops');
      expect(decisions.length).toBeGreaterThanOrEqual(3);
      expect(decisions.every((e) => e.planner === 'llm-xiaojing' && e.intent?.startsWith(marker))).toBe(true);
      expect(history.some((e) => e.type === 'brain' && e.mode === 'rule-standin')).toBe(false);
      expect(model.calls.every((c) => c.model === 'scripted-action' && c.messages.some((m) => m.role === 'system'))).toBe(true);
      const receipts = history.filter((e) => e.type === 'receipt' && e.tool === 'harvest_crops').slice(0, 3);
      expect(receipts.map((e) => e.status)).toEqual(['COMPLETED', 'FAILED', 'UNCERTAIN']);
      for (const receipt of receipts) {
        expect(receipt.sessionId).toBe(decisions[0]?.sessionId);
        expect(receipt.generation).toBe(decisions[0]?.generation);
        const memory = await page.evaluate((query) =>
          (window as unknown as { directorBridge: ChainBridge }).directorBridge.v2MemoryQuery({ query, topN: 20 }), marker);
        expect(memory.ok).toBe(true);
        expect(memory.hits.some((hit) => hit.text.includes(String(receipt.summary)))).toBe(true);
      }
      expect(calls.filter((c) => c.tool === 'harvest_crops').length).toBeGreaterThanOrEqual(3);
    } finally {
      await app?.close();
      await bwf.close();
      await model.close();
    }
  });

  it.each(['unavailable', 'timeout', 'illegal', 'missing-key'] as const)(
    '%s：显式规则代驾产生动作，证据保留失败原因', { timeout: 90_000 }, async (scenario) => {
      const marker = `fallback-${scenario}`;
      const model = await startModelStub(scenario, marker);
      const farm = await startBwfFarmSim({ seed: 11, strawberry: 12, tilled: 12, day: 1, minutes: 420 });
      let app: ElectronApplication | undefined;
      try {
        app = await electron.launch({ executablePath: require('electron') as string,
          args: ['--use-mock-keychain', mainEntry],
          env: { ...process.env, PET_STAGE_E2E: '1', WHALE_E2E_GAME_OFFLINE: '1',
            WHALE_E2E_BWF_ENDPOINT: farm.endpoint,
            WHALE_PROVIDER_KEY_P4_LOCAL_STUB: scenario === 'missing-key' ? '' : 'simulation-placeholder' },
        });
        const page = await directorWindow(app);
        const applied = await page.evaluate((config) =>
          (window as unknown as { directorBridge: ChainBridge }).directorBridge.brainApplyConfig(config),
        brainConfig(model.baseUrl, true));
        expect(applied.ok).toBe(true);
        expect(applied.llmReady).toBe(scenario !== 'missing-key');
        await startViaUi(page);
        await expect.poll(async () => (await events(page)).some((e) =>
          e.type === 'decision' && e.intent?.startsWith('规则代驾：')),
        { timeout: 25_000 }).toBe(true);
        await expect.poll(() => farm.calls.filter((c) => !['get_state', 'cancel_action'].includes(c.tool)).length,
          { timeout: 15_000 }).toBeGreaterThan(0);
        const mode = await page.evaluate(() =>
          (window as unknown as { directorBridge: ChainBridge }).directorBridge.plannerStatus());
        expect(mode.mode).toBe('rule-standin');
        expect(mode.llmReady).toBe(scenario !== 'missing-key');
        await expect.poll(async () => (await events(page)).some((e) =>
          e.type === 'receipt' && e.tool !== 'autodrive' && ['COMPLETED', 'FAILED', 'UNCERTAIN'].includes(e.status ?? '')),
        { timeout: 15_000 }).toBe(true);
        expect(farm.calls.some((c) => c.tool === 'unauthorized_shell')).toBe(false);
        expect((await events(page)).some((e) => e.type === 'decision' && e.intent?.startsWith(marker))).toBe(false);
        if (scenario === 'missing-key') expect(model.calls).toHaveLength(0);
        else expect(model.calls.length).toBeGreaterThan(0);
        if (scenario === 'illegal') expect(model.calls).toHaveLength(3);
        if (scenario !== 'missing-key') {
          expect((await events(page)).some((e) => e.type === 'brain' && e.mode === 'rule-standin' && Boolean(e.reason))).toBe(true);
        }
      } finally {
        await app?.close();
        await farm.close();
        await model.close();
      }
    },
  );

  it('旧配置默认安全暂停，故障不会未经选择切入规则代驾', { timeout: 90_000 }, async () => {
    const model = await startModelStub('unavailable', 'paused');
    const farm = await startBwfFarmSim({ seed: 11 });
    let app: ElectronApplication | undefined;
    try {
      app = await electron.launch({ executablePath: require('electron') as string,
        args: ['--use-mock-keychain', mainEntry],
        env: { ...process.env, PET_STAGE_E2E: '1', WHALE_E2E_GAME_OFFLINE: '1',
          WHALE_E2E_BWF_ENDPOINT: farm.endpoint, WHALE_PROVIDER_KEY_P4_LOCAL_STUB: 'simulation-placeholder' },
      });
      const page = await directorWindow(app);
      const config = brainConfig(model.baseUrl, false);
      delete config.allowRuleStandin;
      await page.evaluate((next) =>
        (window as unknown as { directorBridge: ChainBridge }).directorBridge.brainApplyConfig(next), config);
      await startViaUi(page);
      await expect.poll(async () => (await events(page)).some((e) => e.type === 'brain' && e.mode === 'paused'),
        { timeout: 15_000 }).toBe(true);
      expect(farm.calls.filter((c) => !['get_state', 'cancel_action'].includes(c.tool))).toHaveLength(0);
      expect((await events(page)).filter((e) => e.type === 'decision')).toHaveLength(0);
    } finally {
      await app?.close();
      await farm.close();
      await model.close();
    }
  });
});
