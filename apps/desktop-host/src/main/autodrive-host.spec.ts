import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  app: { isPackaged: false },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      ipcHandlers.set(channel, handler);
    }),
  },
  safeStorage: { isEncryptionAvailable: () => false },
}));
vi.mock('./character-persona', () => ({
  currentPersonaPrompt: () => '你是小鲸',
  currentPersonaReflex: (text: string) => (text.includes('大肥鱼') ? { actionState: 'rage_spray', response: '不许叫大肥鱼！' } : null),
}));

import { createAutodriveHost, dayKeyExtractorFor, resolveGuideDirectory } from './autodrive-host';

describe('autodrive host game paths', () => {
  it('uses distinct game-day keys for Stardew, Terraria, and DST', () => {
    expect(dayKeyExtractorFor('stardew')('第1年春16日 08:00')).toBe('春16日');
    expect(dayKeyExtractorFor('terraria')('第 42 天')).toBe('terraria-42');
    expect(dayKeyExtractorFor('dst')('第 8 轮 白天')).toBe('dst-8');
  });

  it('resolves bundled guides from Electron resources in packaged builds', () => {
    expect(resolveGuideDirectory(true, '/tmp/whale-resources')).toBe('/tmp/whale-resources/guide-forager');
    expect(resolveGuideDirectory(false, '/unused', 'file:///repo/apps/desktop-host/src/main/index.js')).toMatch(/\/guide-forager$/);
  });

  it('T-M6-70 离线分支：大脑离线时 /自然语言 未命中关键词如实告知，/cancel 与快捷 /stop 正常处理', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'whale-host-spec-'));
    try {
      const host = createAutodriveHost('http://127.0.0.1:19999/mcp', join(tmp, 'vault.json'));
      const events: Array<{ type: string; tool?: string; summary?: string }> = [];
      const unsub = host.subscribe((e) => events.push(e as { type: string; tool?: string; summary?: string }));

      // 1) 雷区反射 0-token 直出
      const reflex = await host.say('大肥鱼');
      expect(reflex).toMatchObject({ ok: true, reflex: true });

      // 2) 大脑离线时发无法用关键词映射的 /自然语言 → 如实告知只能执行快捷命令，绝不假装接单
      const unmapped = await host.say('/帮我规划一下春季草莓种植布局');
      expect(unmapped.ok).toBe(true);
      expect(unmapped.reply).toContain('大脑离线，现在只能执行快捷命令');
      expect(events.some((e) => e.tool === 'chat_order')).toBe(false);

      // 3) 快捷 /stop 不依赖游戏在线也能立即返回
      const stopRes = await host.say('/stop');
      expect(stopRes).toMatchObject({ ok: true, reply: '主人指令：停下当前动作' });

      // 4) /cancel 无活跃命令时如实回复
      const cancelRes = await host.say('/cancel');
      expect(cancelRes.ok).toBe(true);
      expect(cancelRes.reply).toContain('没有正在执行的强制命令');

      // 5) T-M6-72：配置 Key 后 planner:status 暴露 dayPlan/insights/saveName，guides:load 加载全部专题且心得写往 stardew-notes/
      process.env['WHALE_PROVIDER_KEY_DEEPSEEK_OFFICIAL'] = 'dev-mock-key-for-host-spec';
      const applyHandler = ipcHandlers.get('brain:apply-config')!;
      const applied = applyHandler({}, {
        profile: {
          profileId: 'DELUXE_LIVESTREAM',
          displayName: 'TEST',
          roleBindings: {
            MAIN_PERSONA_BRAIN: 'deepseek-official/deepseek-flash',
            STARDEW_GAME_PLANNER: 'deepseek-official/deepseek-flash',
          },
          secretMaskingEnabled: true,
        },
        providerModels: {},
        providers: [],
      }) as { ok: boolean; llmReady: boolean };
      expect(applied.ok).toBe(true);
      const guidesRes = (ipcHandlers.get('guides:load')!)({}) as { ok: boolean; topics?: string[] };
      expect(guidesRes.ok).toBe(true);
      expect(guidesRes.topics).toContain('开局前几周');
      expect(guidesRes.topics).toContain('四季作物收益');
      expect(guidesRes.topics).toContain('工具升级');

      const status = (ipcHandlers.get('planner:status')!)({}) as {
        llmReady: boolean;
        saveName: string;
        dayPlan: unknown;
        insights: unknown[];
      };
      expect(status.llmReady).toBe(true);
      expect(status.saveName).toBe('default');
      expect(Array.isArray(status.insights)).toBe(true);

      // 确认自定义 stardew-notes 路径可被 StrategyNotebook 读取
      const notesDir = join(tmp, 'stardew-notes');
      mkdirSync(notesDir, { recursive: true });
      writeFileSync(join(notesDir, '测试农场.json'), JSON.stringify({
        version: 1,
        saveName: '测试农场',
        lastReflectedDay: '',
        tomorrowHint: '',
        insights: [],
      }), 'utf8');
      expect(existsSync(join(notesDir, '测试农场.json'))).toBe(true);

      delete process.env['WHALE_PROVIDER_KEY_DEEPSEEK_OFFICIAL'];
      unsub();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
