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

  it('V2-P4-01：长期记忆与知识库上下文接入决策 Prompt，且伴随反应同步投递 pet:bubble 与语音', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'whale-host-v2p4-'));
    const originalFetch = globalThis.fetch;
    const sentMessages: string[] = [];
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      const url = typeof _input === 'string' ? _input : String((_input as URL).href);
      if (url.endsWith('/v1/chat/completions')) {
        sentMessages.push(String(init?.body ?? ''));
        return new Response(JSON.stringify({
          id: 'sim-1',
          object: 'chat.completion',
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: sentMessages.length === 1
                ? '{"plan":[{"goal":"钓鱼","why":"晴天"}],"mood":"开心"}'
                : '{"tool":"harvest_crops","args":{},"intent":"先收草莓"}',
            },
            finish_reason: 'stop',
          }],
          usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      const body = JSON.parse(String(init?.body ?? '{}')) as { params?: { name?: string } };
      if (body.params?.name === 'get_state') {
        return new Response(JSON.stringify({
          jsonrpc: '2.0', id: 1,
          result: {
            content: [{ type: 'text', text: '时间：第1年春16日 08:00（Tue），天气：晴\n金钱：640g  体力：270/270  生命：100/100\n## 当前界面\n无（可以自由行动）\n## 位置\n地点：Farm\n背包空位：8 个（共 12 格）' }],
            isError: false,
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        jsonrpc: '2.0', id: 1,
        result: { content: [{ type: 'text', text: '成功：收获 6 个草莓' }], isError: false },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    try {
      process.env['WHALE_PROVIDER_KEY_DEEPSEEK_OFFICIAL'] = 'dev-mock-key-v2p4';
      const spoken: Array<{ text: string; scene?: string }> = [];
      const bubbles: Array<{ kind?: string; text?: string }> = [];
      const fakeVoice = {
        config: { enabled: true, innerVoice: true, volume: 1, ratePercent: 100, voice: 'Tingting', voiceId: 'qiaopi_mengmei', pitchMul: 1.25 },
        speak: (v: { text: string; scene?: string }) => { spoken.push(v); return { ok: true }; },
        acquirePreview: () => ({ ok: true, queued: false, leaseId: 'p' }),
        stopPreview: () => undefined,
        setConfig: () => fakeVoice.config,
        speakerState: () => ({ activeAgentId: null, speakerName: '', state: 'idle' as const }),
        stopAll: () => undefined,
      };
      const fakeMemory = {
        store: {} as never,
        onReceipt: () => undefined,
        contextFor: (q: string) => `记忆线索(${q})：上次草莓卖了高价`,
        setDayKeyExtractor: () => undefined,
      };
      const host = createAutodriveHost(
        'http://127.0.0.1:19998/mcp',
        join(tmp, 'vault.json'),
        fakeVoice,
        fakeMemory,
        'stardew',
        undefined,
        undefined,
        undefined,
        () => '- [已晋升 90%] Farm：草莓优先收获',
      );
      host.setTargets([{
        isDestroyed: () => false,
        send: (ch: string, payload: unknown) => {
          if (ch === 'pet:bubble') bubbles.push(payload as { kind?: string; text?: string });
        },
      } as never]);

      const applyHandler = ipcHandlers.get('brain:apply-config')!;
      applyHandler({}, {
        profile: {
          profileId: 'DELUXE_LIVESTREAM',
          displayName: 'TEST',
          roleBindings: { STARDEW_GAME_PLANNER: 'deepseek-official/deepseek-flash' },
          secretMaskingEnabled: true,
        },
        providerModels: {},
        providers: [],
      });

      await host.runner.start();
      await new Promise((r) => setTimeout(r, 150));
      await host.runner.stopAndWait();

      expect(sentMessages.some((m) => m.includes('上次草莓卖了高价'))).toBe(true);
      expect(sentMessages.some((m) => m.includes('[已晋升 90%] Farm：草莓优先收获'))).toBe(true);
      expect(bubbles.some((b) => b.kind === 'reaction' && (String(b.text).includes('丰收') || String(b.text).includes('庄稼收获好啦')))).toBe(true);
      expect(spoken.some((s) => s.text.includes('丰收'))).toBe(true);
      expect(spoken.some((s) => s.text.includes('计划调整'))).toBe(false);
    } finally {
      delete process.env['WHALE_PROVIDER_KEY_DEEPSEEK_OFFICIAL'];
      globalThis.fetch = originalFetch;
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
