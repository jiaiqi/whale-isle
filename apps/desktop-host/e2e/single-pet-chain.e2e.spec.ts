/**
 * [E2E-HOST] 单桌宠全链路单一剧本（`[SIMULATION]`）：
 *   启动（假启动器）→ BWF 就绪（宿主指向测试进程里的农场仿真）→ 规则大脑发真实动作
 *   → 真实回执 → 记忆落盘（可检索）。
 *
 * 边界（AGENTS.md §2.4）：
 * - 不启动真实《星露谷物语》，不读写真实 Mods 配置：仿真端点经 `WHALE_E2E_BWF_ENDPOINT`
 *   注入，只在 `PET_STAGE_E2E=1` 时被宿主采纳；userData 落在 `e2e-profile`。
 * - 本 spec 通过即 `[E2E-HOST]` + `[SIMULATION]`，**不得**记为 `[REAL-DEVICE]`。
 * - 全程只走 preload/IPC 与真实事件流，不碰 pet-stage 气泡内部实现。
 */
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { describe, expect, it } from 'vitest';
import { startBwfFarmSim } from '../../../tools/mock-harness/src/bwf-farm-sim';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..');
const repoRoot = join(appRoot, '..', '..');
const require = createRequire(import.meta.url);
const electronBinary = require('electron') as string;
const mainEntry = join(appRoot, 'dist', 'main', 'index.js');
const artifactsDir = join(repoRoot, 'artifacts');

interface ReceiptLike {
  type?: string;
  tool?: string;
  status?: string;
  summary?: string;
}

interface ChainBridge {
  plannerSwitch(mode: 'rule' | 'llm'): Promise<{ ok: boolean; error?: string; mode?: string }>;
  autodriveStatus(): Promise<{ running: boolean }>;
  autodriveStop(): Promise<{ ok: boolean }>;
  onAutodriveEvent(handler: (event: ReceiptLike) => void): void;
  v2MemoryQuery(input: { query: string; topN?: number }): Promise<{ ok: boolean; hits: Array<{ text: string }> }>;
}

async function waitForWindow(
  app: import('playwright-core').ElectronApplication,
  urlPart: string,
  timeoutMs = 20_000,
): Promise<import('playwright-core').Page> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = app.windows().find((candidate) => candidate.url().includes(urlPart));
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`未找到包含 ${urlPart} 的窗口`);
}

describe('[E2E-HOST] 单桌宠全链路（启动 → 就绪 → 动作 → 回执 → 记忆）', () => {
  it('仿真 BWF 上跑通一条最小链路，且记忆可检索', { timeout: 240_000 }, async () => {
    // 活农场仿真：有成熟草莓与已开垦地，规则大脑第一个动作就能落到真实工具调用上
    const sim = await startBwfFarmSim({ seed: 11, strawberry: 12, tilled: 12, day: 1, minutes: 7 * 60 });
    const app = await electron.launch({
      args: ['--use-mock-keychain', mainEntry],
      executablePath: electronBinary,
      env: {
        ...process.env,
        PET_STAGE_E2E: '1',
        WHALE_E2E_GAME_OFFLINE: '1',
        WHALE_E2E_BWF_ENDPOINT: sim.endpoint,
      },
    });
    try {
      const director = await waitForWindow(app, 'director');
      await director.waitForFunction(
        () => Boolean((window as unknown as { directorBridge?: unknown }).directorBridge),
        { timeout: 20_000 },
      );
      // 固定到星露谷共玩页，并清掉「以后自动启动」的历史勾选，保证走「先启动游戏」提示分支
      await director.evaluate(() => {
        localStorage.setItem('wb-tab', 'stardew');
        localStorage.setItem('wb-game', 'stardew');
        localStorage.setItem('wb-game-subtab', 'monitor');
        localStorage.removeItem('wb-stardew-auto-launch');
      });
      await director.reload();
      await director.waitForFunction(
        () => Boolean((window as unknown as { directorBridge?: unknown }).directorBridge),
        { timeout: 20_000 },
      );
      await director.waitForSelector('[data-game-panel][data-active-game="stardew"]', { timeout: 15_000 });

      // 规则大脑：不依赖任何模型 Key，动作由真实规则规划器发出
      const mode = await director.evaluate(() =>
        (window as unknown as { directorBridge: ChainBridge }).directorBridge.plannerSwitch('rule'),
      );
      expect(mode.ok).toBe(true);
      expect(mode.mode).toBe('rule');

      // 订阅真实事件流（回执证据）
      await director.evaluate(() => {
        const bridge = (window as unknown as { directorBridge: ChainBridge }).directorBridge;
        const w = window as unknown as { __e2eAuto: ReceiptLike[] };
        w.__e2eAuto = [];
        bridge.onAutodriveEvent((event) => w.__e2eAuto.push(event));
      });

      // ① 启动：游戏「未运行」→ 点顶栏「启动」→ 勾选「以后自动启动」→ 确认代启动
      // 勾选是必需的：确认分支回到 start() 时会重新查游戏健康，未勾选会再次弹回本提示。
      await director.click('[data-autodrive-toggle]');
      await director.waitForSelector('[data-stardew-launch-prompt]', { timeout: 20_000 });
      await director.click('[data-stardew-auto-launch]');
      await director.click('[data-stardew-launch-confirm]');

      // ② 就绪：自动驾驶真正跑起来（宿主 ping 的是仿真 BWF，不是真实端口）
      await expect.poll(
        () => director.evaluate(() =>
          (window as unknown as { directorBridge: ChainBridge }).directorBridge.autodriveStatus().then((s) => s.running),
        ),
        { timeout: 120_000, interval: 500 },
      ).toBe(true);

      // ③ 动作：仿真侧真的收到了 MCP 工具调用（至少一次 get_state + 至少一次真实动作）
      await expect.poll(
        () => sim.calls.filter((call) => call.tool === 'get_state').length,
        { timeout: 60_000, interval: 500 },
      ).toBeGreaterThan(0);
      await expect.poll(
        () => sim.calls.filter((call) => call.tool !== 'get_state').length,
        { timeout: 120_000, interval: 500 },
      ).toBeGreaterThan(0);

      // ④ 回执：规则大脑的动作产出真实三态回执（COMPLETED / FAILED / UNCERTAIN），不是台词自吹
      await expect.poll(
        () => director.evaluate(() =>
          (window as unknown as { __e2eAuto: ReceiptLike[] }).__e2eAuto
            .filter((event) => event.type === 'receipt' && event.tool !== 'autodrive').length,
        ),
        { timeout: 120_000, interval: 500 },
      ).toBeGreaterThan(0);

      const receipt = await director.evaluate(() => {
        const list = (window as unknown as { __e2eAuto: ReceiptLike[] }).__e2eAuto;
        return list.find((event) => event.type === 'receipt' && event.tool !== 'autodrive') ?? null;
      });
      expect(receipt).not.toBeNull();
      expect(['COMPLETED', 'FAILED', 'UNCERTAIN']).toContain(String(receipt?.status));
      expect(String(receipt?.summary ?? '').length).toBeGreaterThan(0);

      // ⑤ 记忆：回执经 memoryHost.onReceipt 落盘，能被词法检索命中
      const query = String(receipt?.summary ?? '').slice(0, 12);
      await expect.poll(
        () => director.evaluate(async (q) => {
          const res = await (window as unknown as { directorBridge: ChainBridge }).directorBridge
            .v2MemoryQuery({ query: q, topN: 5 });
          return res.ok ? res.hits.length : -1;
        }, query),
        { timeout: 30_000, interval: 500 },
      ).toBeGreaterThan(0);

      // ⑥ 停：停止自动驾驶后 runner 不再运行
      await director.evaluate(() =>
        (window as unknown as { directorBridge: ChainBridge }).directorBridge.autodriveStop(),
      );
      await expect.poll(
        () => director.evaluate(() =>
          (window as unknown as { directorBridge: ChainBridge }).directorBridge.autodriveStatus().then((s) => s.running),
        ),
        { timeout: 30_000, interval: 500 },
      ).toBe(false);

      mkdirSync(artifactsDir, { recursive: true });
      await director.screenshot({ path: join(artifactsDir, 'single-pet-chain-e2e.png') });
    } finally {
      await app.close();
      await sim.close();
    }
  });
});
