/**
 * [E2E-HOST] T-M6-55 ~ T-M6-59 收口回归：
 *   ① 桌宠工坊：创作中心生图工具栏（无 Key 时如实提示 + 一键跳转）、验收台参考线/轮播真实驱动桌宠窗；
 *   ② 跨 AI 跟随：8 家 CLI 钩子探测卡片 + 连通性自检 ≤1.5s；
 *   ③ OBS /obs：中文化工具/状态 + layout/theme 参数 + 当前角色名；
 *   ④ 游戏共玩：无活跃目标时不显示目标条（不伪造状态）。
 * 真实出图/真实游戏仍属人工验收项（见 docs/VERIFY.md），此文件只断言宿主真实链路。
 */
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..');
const require = createRequire(import.meta.url);
const electronBinary = require('electron') as string;
const mainEntry = join(appRoot, 'dist', 'main', 'index.js');

async function waitForWindow(
  app: import('playwright-core').ElectronApplication,
  urlPart: string,
  timeoutMs = 30_000,
): Promise<import('playwright-core').Page> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = app.windows().find((candidate) => candidate.url().includes(urlPart));
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`未找到包含 ${urlPart} 的窗口`);
}

async function waitFor(win: import('playwright-core').Page, fn: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`条件在 ${timeoutMs}ms 内未满足`);
}

describe('[E2E-HOST] T-M6-55~59 深度迭代收口', () => {
  it('创作中心生图入口 + 验收台参考线轮播 + CLI 钩子自检 + OBS 中文化参数', { timeout: 150_000 }, async () => {
    const app = await electron.launch({
      args: ['--use-mock-keychain', mainEntry],
      executablePath: electronBinary,
      env: { ...process.env, PET_STAGE_E2E: '1' },
    });
    try {
      const stage = await waitForWindow(app, 'pet-stage');
      await waitFor(stage, () => stage.evaluate(() => Boolean((window as unknown as { __petStageReady?: boolean }).__petStageReady)), 25_000);
      const director = await waitForWindow(app, 'director', 30_000);
      await director.waitForFunction(
        () => Boolean((window as unknown as { directorBridge?: { workFollowCliStatus?: unknown } }).directorBridge?.workFollowCliStatus),
        { timeout: 25_000 },
      );

      // ① 创作中心：生图供应商工具栏；本机未配置生图 Key 时如实提示并可跳转「模型服务商」
      await director.click('[data-tab="pet"]');
      await director.click('[data-open-creator]');
      await director.waitForSelector('[data-creator-center]', { timeout: 15_000 });
      await director.waitForSelector('[data-image-gen-toolbar]', { timeout: 10_000 });
      const toolbarText = await director.locator('[data-image-gen-toolbar]').innerText();
      expect(toolbarText).toContain('未检测到已配置 Key 的生图供应商');
      expect(toolbarText).toContain('不会伪造出图结果');
      await director.click('[data-gen-open-providers]');
      await director.waitForFunction(() => document.querySelector('[data-tab="providers"]')?.getAttribute('data-active') === 'true', { timeout: 10_000 });

      // ② 切到真实 pose-skin 角色后打开验收台：轮播必须真实驱动桌宠窗参考线层
      await director.click('[data-tab="pet"]');
      await director.evaluate(() => (window as unknown as {
        directorBridge: { characterSelect(id: string): Promise<{ ok: boolean }> };
      }).directorBridge.characterSelect('crosspet-claude'));
      await waitFor(stage, () => stage.evaluate(() => {
        const image = document.querySelector('#stage img') as HTMLImageElement | null;
        return image !== null && image.naturalWidth > 0;
      }), 20_000);
      await director.click('[data-open-bench]');
      await director.waitForSelector('[data-acceptance-bench]', { timeout: 15_000 });
      await director.click('[data-bench-carousel]');
      await waitFor(stage, () => stage.evaluate(() => document.getElementById('guide-layer')?.style.display === 'block'), 10_000);
      await director.waitForFunction(
        () => document.querySelector('[data-acceptance-bench]')?.textContent?.includes('停止轮播') === true,
        { timeout: 10_000 },
      );
      const benchText = await director.locator('[data-acceptance-bench]').innerText();
      expect(benchText).toContain('停止轮播');
      await director.click('[data-bench-carousel]');
      await waitFor(stage, () => stage.evaluate(() => document.getElementById('guide-layer')?.style.display === 'none'), 10_000);
      await director.click('[aria-label="关闭验收台"]');

      // ③ 跨 AI 跟随：8 家 CLI 全部列出 + 连通性自检真实闭合
      await director.click('[data-pet-studio-tab="work"]');
      await director.waitForSelector('[data-cli-hooks]', { timeout: 15_000 });
      await director.waitForSelector('[data-cli-hook="claude"]', { timeout: 15_000 });
      const cliSources = await director.locator('[data-cli-hook]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-cli-hook')));
      expect(cliSources.sort()).toEqual(['claude', 'codex', 'cursor', 'deepseek', 'gemini', 'grok', 'kimi', 'qwen'].sort());
      const selfTest = await director.evaluate(() => (window as unknown as {
        directorBridge: { workFollowSelfTest(): Promise<{ ok: boolean; elapsedMs: number; error?: string }> };
      }).directorBridge.workFollowSelfTest());
      expect(selfTest.ok, selfTest.error).toBe(true);
      expect(selfTest.elapsedMs).toBeLessThanOrEqual(1_500);
      await director.click('[data-cli-self-test]');
      await director.waitForSelector('[data-cli-self-test-result="ok"]', { timeout: 5_000 });

      // ④ OBS /obs：中文化 + layout/theme 参数 + 角色名；/api/state 如实返回
      const info = await director.evaluate(() => (window as unknown as {
        directorBridge: { webuiInfo(): Promise<{ port: number; token: string }> };
      }).directorBridge.webuiInfo());
      const obsResponse = await fetch(`http://127.0.0.1:${info.port}/obs?token=${encodeURIComponent(info.token)}&layout=compact&theme=light`);
      expect(obsResponse.status).toBe(200);
      const obsHtml = await obsResponse.text();
      expect(obsHtml).toContain('"fish":"钓鱼"');
      expect(obsHtml).toContain('"COMPLETED":"已完成"');
      expect(obsHtml).toContain("params.get('layout') === 'compact'");
      expect(obsHtml).toContain('state.characterName');
      const state = await (await fetch(`http://127.0.0.1:${info.port}/api/state?token=${encodeURIComponent(info.token)}`)).json() as { characterName?: string };
      expect((state.characterName ?? '').length).toBeGreaterThan(0);

      // ⑤ OBS 页布局/主题选择器真实存在；游戏共玩无活跃目标时不显示目标条
      await director.click('[data-tab="obs"]');
      await director.waitForSelector('[data-obs-layout]', { timeout: 10_000 });
      expect(await director.locator('[data-obs-theme]').count()).toBe(1);
      await director.click('[data-tab="stardew"]');
      await director.waitForSelector('[data-game-panel]', { timeout: 15_000 });
      expect(await director.locator('[data-objective-bar]').count()).toBe(0);
    } finally {
      // 恢复默认角色：E2E profile 是跨 spec 共享的，绝不把 crosspet-claude 留给后续用例
      const restore = app.windows().find((candidate) => candidate.url().includes('director'));
      if (restore !== undefined) {
        await restore.evaluate(() => (window as unknown as {
          directorBridge?: { characterSelect(id: string): Promise<{ ok: boolean }> };
        }).directorBridge?.characterSelect('blue-whale-maid')).catch(() => undefined);
      }
      await app.close();
    }
  }, 150_000);
});
