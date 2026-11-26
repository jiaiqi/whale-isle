/**
 * [E2E-HOST] V2-P3-04F Digital Life L1 全链路：
 *   能力矩阵门禁（未授权/未实测拒绝）→ 声明已实测 → 规划会话 → 启动 →
 *   真实 runner 读取本地仿真站点（[SIMULATION] social-site-sim，不访问公网）→
 *   计数达预算自动收官 → 无供应商 Key 时内容理解诚实报错（不编造理解结果）→
 *   pet-stage 思考泡投影（复用 pet:bubble 通道）。
 * 真实模型理解联调属 [REAL-DEVICE]（需真实供应商 Key）。
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright-core';
import { describe, expect, it } from 'vitest';
import { candidatesFromFixture, startSocialSiteSim } from '../../../tools/mock-harness/src/social-site-sim';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..');
const require = createRequire(import.meta.url);
const electronBinary = require('electron') as string;
const mainEntry = join(appRoot, 'dist', 'main', 'index.js');

interface SocialBridge {
  v2Resume(mode?: string): Promise<unknown>;
  v2SocialSnapshot(): Promise<{
    sessions: Array<{ sessionId: string; status: string; itemsViewed: number; stopReason?: string }>;
    capabilities: Array<{ platform: string; capability: string; lastVerifiedAt: number }>;
    autonomyLevel: string;
  }>;
  v2SocialCapabilityUpsert(input: unknown): Promise<{ ok: boolean }>;
  v2SocialPlan(input: unknown): Promise<{ ok: boolean; session?: { sessionId: string; status: string }; error?: string }>;
  v2SocialStart(sessionId: string): Promise<{ ok: boolean; session?: { status: string }; error?: string }>;
  v2SocialRecordViewed?(input: unknown): Promise<{ ok: boolean; session?: { status: string; itemsViewed: number; stopReason?: string }; error?: string }>;
  v2AutoProfileEnsure(input: { profileId?: string; characterId: string; accountId: string }): Promise<{ ok: boolean }>;
  v2AutoBrowserExec(input: { taskId: string; characterId: string; profileId: string; url: string; action: string }): Promise<{
    ok: boolean;
    runner: { status: string; pageTextChars: number };
  }>;
}

async function waitForDirector(app: import('playwright-core').ElectronApplication, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = app.windows().find((w) => w.url().includes('director'));
    if (found) {
      const ready = await found.evaluate(() => Boolean((window as unknown as { directorBridge?: unknown }).directorBridge));
      if (ready) return found;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('director window not ready within timeout');
}

describe('[E2E-HOST] V2-P3-04F Digital Life L1 全链路', () => {
  it('能力门禁 → 规划 → 启动 → 仿真站读取 → 预算收官 → 无 Key 诚实报错 → 桌宠投影', { timeout: 120_000 }, async () => {
    const sim = await startSocialSiteSim();
    const candidates = candidatesFromFixture(sim.origin);
    const app = await electron.launch({
      args: ['--use-mock-keychain', mainEntry],
      executablePath: electronBinary,
      env: { ...process.env, PET_STAGE_E2E: '1', WHALE_DISABLE_INPUT_MONITOR: '1' },
    });
    try {
      const director = await waitForDirector(app);
      await director.evaluate(() => (window as unknown as { directorBridge: SocialBridge & { v2Resume(m?: string): Promise<unknown> } }).directorBridge.v2Resume('autonomous'));

      // ① 能力矩阵门禁：未声明能力时规划被拒（PERMISSION_DENIED 如实回报）
      const denied = await director.evaluate(() =>
        (window as unknown as { directorBridge: SocialBridge }).directorBridge.v2SocialPlan({
          platform: 'generic_web',
          objective: '逛逛仿真社区',
        }),
      );
      expect(denied.ok).toBe(false);
      expect(denied.error).toContain('未授权');

      // ② 未实测（lastVerifiedAt=0）同样被拒
      const unverified = await director.evaluate(async () => {
        const bridge = (window as unknown as { directorBridge: SocialBridge }).directorBridge;
        await bridge.v2SocialCapabilityUpsert({
          platform: 'generic_web', capability: 'read_public', channel: 'browser_ui', allowed: true, lastVerifiedAt: 0,
        });
        return bridge.v2SocialPlan({ platform: 'generic_web', objective: '逛逛仿真社区' });
      });
      expect(unverified.ok).toBe(false);
      expect(unverified.error).toContain('未实测');

      // ③ 声明已实测 → 规划 → 启动
      const planned = await director.evaluate(async () => {
        const bridge = (window as unknown as { directorBridge: SocialBridge }).directorBridge;
        await bridge.v2SocialCapabilityUpsert({
          platform: 'generic_web', capability: 'read_public', channel: 'browser_ui', allowed: true, lastVerifiedAt: Date.now(),
        });
        const plan = await bridge.v2SocialPlan({ platform: 'generic_web', objective: '读两篇仿真文章', maxItems: 2 });
        if (!plan.ok || !plan.session) return { plan };
        const started = await bridge.v2SocialStart(plan.session.sessionId);
        return { plan, started };
      });
      expect(planned.plan.ok).toBe(true);
      expect(planned.started?.session?.status).toBe('active');
      const sessionId = planned.plan.session!.sessionId;

      // ④ 真实 runner 读取本地仿真站点（Electron 隐藏窗口，不访问公网）
      const read = await director.evaluate(async (url) => {
        const bridge = (window as unknown as { directorBridge: SocialBridge }).directorBridge;
        await bridge.v2AutoProfileEnsure({ profileId: 'e2e-social-prof', characterId: 'char_xiaojing', accountId: 'e2e-social-acct' });
        return bridge.v2AutoBrowserExec({
          taskId: 'e2e-social-read', characterId: 'char_xiaojing', profileId: 'e2e-social-prof', url, action: 'read',
        });
      }, candidates[0]!.url);
      expect(read.ok).toBe(true);
      expect(read.runner.pageTextChars).toBeGreaterThan(10);

      // ⑤ 记录浏览 ×2 → 达 maxItems 自动按 budget_exhausted 收官
      const viewed = await director.evaluate(async ({ sid, cands }) => {
        const bridge = (window as unknown as { directorBridge: SocialBridge }).directorBridge;
        const first = await bridge.v2SocialRecordViewed!({ sessionId: sid, candidate: cands[0] });
        const second = await bridge.v2SocialRecordViewed!({ sessionId: sid, candidate: cands[1] });
        return { first, second };
      }, { sid: sessionId, cands: candidates.slice(0, 2) });
      expect(viewed.first.session?.itemsViewed).toBe(1);
      expect(viewed.second.session?.status).toBe('completed');
      expect(viewed.second.session?.stopReason).toBe('budget_exhausted');

      // ⑥ 无供应商 Key：内容理解诚实报错（不编造理解结果，安全暂停）
      const understood = await director.evaluate(async ({ sid, item }) => {
        const bridge = (window as unknown as { directorBridge: SocialBridge & { v2SocialUnderstand(i: unknown): Promise<{ ok: boolean; error?: string }> } }).directorBridge;
        return bridge.v2SocialUnderstand({ sessionId: sid, item, textContent: '仿真正文' });
      }, { sid: sessionId, item: { platform: 'generic_web', url: candidates[0]!.url, title: candidates[0]!.title, contentKind: 'text', authorAlias: '' } });
      expect(understood.ok).toBe(false);
      expect(understood.error).toContain('网关未就绪');

      // ⑦ 快照如实反映收官会话与能力矩阵
      const snapshot = await director.evaluate(() =>
        (window as unknown as { directorBridge: SocialBridge }).directorBridge.v2SocialSnapshot(),
      );
      expect(snapshot.autonomyLevel).toBe('l1_readonly');
      expect(snapshot.capabilities.some((c) => c.platform === 'generic_web' && c.lastVerifiedAt > 0)).toBe(true);
      const done = snapshot.sessions.find((s) => s.sessionId === sessionId);
      expect(done?.status).toBe('completed');

      // ⑧ pet-stage 思考泡投影（pet:bubble 通道；气泡存活 12s，轮询断言）
      const petPage = app.windows().find((w) => w.url().includes('pet-stage'));
      if (petPage) {
        const deadline = Date.now() + 12_000;
        let bubbleText = '';
        while (Date.now() < deadline) {
          bubbleText = await petPage.evaluate(() => document.body.innerText).catch(() => '');
          if (bubbleText.includes('在读：') || bubbleText.includes('收官')) break;
          await new Promise((r) => setTimeout(r, 200));
        }
        expect(bubbleText).toMatch(/在读：|收官/);
      }
    } finally {
      await app.close();
      await sim.close();
    }
  });
});
