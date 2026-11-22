/**
 * [SIMULATION] Gate 4 · 回环沙盒端到端（AGENTS §3.3）：
 *   骂「大肥鱼」→ 护栏放行（平台词表不拦人设雷区）→ persona 0-token 喷水反射
 *   → 单端语音锁获取/播放完成释放（active ≤ 1 不变式）→ 常客记仇账本落 SQLite。
 * 全链路不依赖 Electron/Python/网络，verify:gate 直接调用；<15s（实测 ~60ms）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { NormalizedLiveEventSchema, PetPersonaConfigSchema } from '@workbench/shared-protocol';
import { LiveEventHub } from '@workbench/live-stream-hub';
import { createReflexInterceptor } from '@workbench/persona-brain';
import { SqliteStore } from '@workbench/local-store';
import { AudioLeaseManager, type AudioPlaybackReceipt } from '../src/renderer/pet-stage/audio-lease';

const PERSONA = PetPersonaConfigSchema.parse({
  id: 'blue-whale-maid',
  name: '小鲸（大肥鱼）',
  title: '傲娇干饭蓝鲸女仆',
  licenseScope: 'DEV_ONLY_NON_COMMERCIAL',
  avatarManifestPath: 'assets/pets/blue-whale-maid/manifest.json',
  systemPromptTemplate: '你是{name}。',
  reflexRules: [
    {
      id: 'taboo-fat-fish',
      triggerRegex: '(大肥鱼|胖鱼|肥鲸|水桶腰)',
      priority: 'P0_INTERRUPT',
      actionState: 'rage_spray',
      emotionTag: 'rage_spray',
      ledgerGrudgeTag: '叫我大肥鱼的坏蛋',
      presetResponses: ['才不是大肥鱼！噗——（喷水抗议）'],
    },
  ],
  innerVoiceConfig: { enabled: true, derailmentPrompts: [] },
  riceBowl: { dailyRiceGrainBudget: 500000, consumedRiceGrainsToday: 0, activeSideDishes: [] },
  stardewWeights: {
    lazyDefault: { farmingProfit: 0.3, npcGossipAndTrashCan: 0.85, miningCombat: 0.2, slackingAndScenery: 0.9, minStaminaThreshold: 0.45 },
    seriousForOwner: { farmingProfit: 0.95, npcGossipAndTrashCan: 0.3, miningCombat: 0.75, slackingAndScenery: 0.1, minStaminaThreshold: 0.15 },
  },
  voiceProfile: { ttsVoicePackId: 'qiaopi_mengmei', rvcModelPath: '' },
});

const DANMAKU = NormalizedLiveEventSchema.parse({
  eventId: '11111111-1111-4111-8111-111111111111',
  platform: 'douyin',
  eventType: 'DANMAKU',
  sender: { uid: 'gate4-viewer', nickname: '测试观众', intimacyScore: 0, grudgeTags: [] },
  payload: { rawText: '大肥鱼今天又胖了吧', mergedCount: 1 },
  assignedPriority: 'P1_CADENCE',
  timestamp: 1_700_000_000_000,
});

describe('[SIMULATION] Gate 4 回环沙盒', () => {
  let store: SqliteStore | null = null;
  afterEach(() => {
    store?.close();
    store = null;
  });

  it('骂大肥鱼 → 0-token 喷水 → 语音锁释放 → 记仇账本落盘（<15s）', async () => {
    const startedAt = performance.now();

    // ① 弹幕中枢：合法事件被接收（人设雷区不属于平台违禁词）
    const hub = new LiveEventHub({ now: () => 1_700_000_000_000 });
    const outcome = hub.ingest(DANMAKU);
    expect(outcome.status).toBe('accepted');
    hub.dispose();

    // ② persona 雷区反射：P0 直出、结构性 0 token
    const reflex = createReflexInterceptor(PERSONA, { rng: () => 0 });
    const hit = reflex.intercept(DANMAKU.payload.rawText ?? '');
    expect(hit).not.toBeNull();
    expect(hit?.priority).toBe('P0_INTERRUPT');
    expect(hit?.actionState).toBe('rage_spray');
    expect(hit?.consumedMainBrainTokens).toBe(false);
    expect(hit?.response.length).toBeGreaterThan(0);

    // ③ 单端语音锁：获取 → 播放完成回执 → 释放；任何时刻 active ≤ 1
    const receipts: AudioPlaybackReceipt[] = [];
    let maxActive = 0;
    const lease = new AudioLeaseManager({
      adapter: {
        play: () => new Promise<void>((resolve) => setTimeout(resolve, 25)),
        abort: () => undefined,
      },
      onReceipt: (receipt) => receipts.push(receipt),
      onActiveChange: (active) => {
        maxActive = Math.max(maxActive, active);
      },
    });
    expect(lease.acquire({ leaseId: '22222222-2222-4222-8222-222222222222', priority: 'P0_INTERRUPT', ttlMs: 2000, durationMs: 400 })).toBe('granted');
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(maxActive).toBe(1);
    expect(lease.activeCount()).toBe(0);
    expect(receipts.map((r) => r.status)).toEqual(['COMPLETED']);

    // ④ 常客记仇账本：SQLite 落盘 + 0 token 断言（反射不烧主脑）
    store = new SqliteStore(':memory:');
    store.upsertViewer({
      platform: 'douyin',
      uid: 'gate4-viewer',
      nickname: '测试观众',
      intimacyScore: 0,
    });
    store.addGrudgeTag('douyin', 'gate4-viewer', hit?.ledgerGrudgeTag ?? '');
    const viewer = store.getViewer('douyin', 'gate4-viewer');
    expect(viewer?.grudgeTags).toContain('叫我大肥鱼的坏蛋');
    const zero = store.getTokenSummary();
    expect(zero.inputTokens + zero.outputTokens).toBe(0);

    // ⑤ 一次真实规划器用量：1 token = 1 粒米 记账
    store.recordTokenUsage({
      slot: 'STARDEW_GAME_PLANNER',
      providerId: 'deepseek-official',
      modelId: 'deepseek-flash',
      inputTokens: 500,
      cachedInputTokens: 0,
      outputTokens: 100,
      purpose: 'gate4',
    } as Parameters<SqliteStore['recordTokenUsage']>[0]);
    const summary = store.getTokenSummary('STARDEW_GAME_PLANNER');
    expect(summary.riceGrains).toBe(600);

    expect(performance.now() - startedAt).toBeLessThan(15_000);
  });
});
