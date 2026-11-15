import { describe, expect, it } from 'vitest';
import personaFixture from '../fixtures/blue-whale-maid.json';
import {
  AudioPlaybackLeaseSchema,
  DiningProfilePresetSchema,
  NormalizedLiveEventSchema,
  PetPersonaConfigSchema,
  ReflexRuleSchema,
  StardewMcpActionReceiptSchema,
} from './index';
import { CONTRACT_SCHEMAS, CONTRACT_VERSION } from './registry';

/** T-M0-02：契约单测——"夹具双侧 probe"纪律的 TS 侧（Python 侧见 test_protocol_models.py） */

const PERSONA = PetPersonaConfigSchema.parse(personaFixture);

describe('PetPersonaConfig（大肥鱼人设）', () => {
  it('蓝鲸女仆夹具可通过校验且默认值落位', () => {
    expect(PERSONA.id).toBe('blue-whale-maid');
    expect(PERSONA.ownerTitles).toEqual(['鱼片', '主人']);
    expect(PERSONA.innerVoiceConfig.thinkTagName).toBe('think');
    expect(PERSONA.reflexRules[0]?.cooldownMs).toBe(8000);
    expect(PERSONA.riceBowl.lowRiceWarningRatio).toBe(0.15);
    expect(PERSONA.voiceProfile.rvcIndexRate).toBe(0.75);
    expect(PERSONA.licenseScope).toBe('DEV_ONLY_NON_COMMERCIAL');
  });

  it('雷区规则缺失 presetResponses 时拒绝', () => {
    const bad = { ...(PERSONA.reflexRules[0] as object), presetResponses: [] };
    expect(ReflexRuleSchema.safeParse(bad).success).toBe(false);
  });

  it('非法 actionState / priority 拒绝', () => {
    expect(
      ReflexRuleSchema.safeParse({ ...(PERSONA.reflexRules[0] as object), priority: 'P1_CADENCE' }).success,
    ).toBe(false);
    expect(
      ReflexRuleSchema.safeParse({ ...(PERSONA.reflexRules[0] as object), actionState: 'fly' }).success,
    ).toBe(false);
  });
});

describe('AudioPlaybackLease（单端语音锁）', () => {
  const base = {
    leaseId: '11111111-2222-4333-8444-555555555555',
    sourceModule: 'persona-talk' as const,
    priority: 'P1_CADENCE' as const,
    emotionTag: 'tsundere_refuse' as const,
    textSubtitle: '哼，本鱼才没有偷懒！',
    audioUrlOrBase64: 'file:///tmp/a.ogg',
    actionState: 'happy_maid' as const,
  };
  it('ttl 下界 500ms / 上界 300000ms', () => {
    expect(AudioPlaybackLeaseSchema.safeParse({ ...base, ttlMs: 400 }).success).toBe(false);
    expect(AudioPlaybackLeaseSchema.safeParse({ ...base, ttlMs: 500 }).success).toBe(true);
    expect(AudioPlaybackLeaseSchema.safeParse({ ...base, ttlMs: 300_000 }).success).toBe(true);
    expect(AudioPlaybackLeaseSchema.safeParse({ ...base, ttlMs: 300_001 }).success).toBe(false);
  });
  it('可选 innerThoughtText', () => {
    const ok = AudioPlaybackLeaseSchema.safeParse({ ...base, ttlMs: 2000, innerThoughtText: '…白饭…' });
    expect(ok.success).toBe(true);
  });
});

describe('NormalizedLiveEvent（直播事件总线）', () => {
  const base = {
    eventId: 'aaaaaaa1-2222-4333-8444-555555555555',
    platform: 'douyin' as const,
    eventType: 'DANMAKU' as const,
    sender: { uid: 'u-1001', nickname: '路过的鱼干' },
    payload: {},
    assignedPriority: 'P1_CADENCE' as const,
    timestamp: 1_700_000_000_000,
  };
  it('默认值：mergedCount=1、grudgeTags=[]、intimacyScore=0', () => {
    const ev = NormalizedLiveEventSchema.parse(base);
    expect(ev.payload.mergedCount).toBe(1);
    expect(ev.sender.grudgeTags).toEqual([]);
    expect(ev.sender.intimacyScore).toBe(0);
  });
  it('缺 eventId / 非法 platform 拒绝', () => {
    const noId = { ...base } as Record<string, unknown>;
    delete noId.eventId;
    expect(NormalizedLiveEventSchema.safeParse(noId).success).toBe(false);
    expect(NormalizedLiveEventSchema.safeParse({ ...base, platform: 'weibo' }).success).toBe(false);
  });
});

describe('StardewMcpActionReceipt（真实执行回执）', () => {
  it('UNCERTAIN 回执 + 状态快照可通过', () => {
    const receipt = StardewMcpActionReceiptSchema.parse({
      actionId: 'bbbbbbb1-2222-4333-8444-555555555555',
      toolName: 'water_crops_batch',
      status: 'UNCERTAIN',
      failureOrUncertainReason: 'PATH_BLOCKED_BY_STONE',
      gameStateSnapshot: {
        dayOfMonth: 3,
        season: 'spring',
        timeOfDay: 930,
        staminaCurrent: 42,
        staminaMax: 270,
        healthCurrent: 88,
        gold: 512,
        locationName: 'Farm',
        isPlayerMovingPhysically: false,
      },
    });
    expect(receipt.gameStateSnapshot.season).toBe('spring');
  });
  it('非法 toolName / status 拒绝', () => {
    expect(
      StardewMcpActionReceiptSchema.safeParse({
        actionId: 'bbbbbbb1-2222-4333-8444-555555555555',
        toolName: 'hack_server',
        status: 'COMPLETED',
        gameStateSnapshot: {},
      }).success,
    ).toBe(false);
  });
});

describe('DiningProfilePreset（干饭套餐）', () => {
  it('roleBindings 仅接受 6 个合法槽位键', () => {
    const ok = DiningProfilePresetSchema.safeParse({
      profileId: 'DELUXE_LIVESTREAM',
      displayName: '🍱 豪华直播档',
      roleBindings: { MAIN_PERSONA_BRAIN: 'deepseek-official/deepseek-reasoner' },
    });
    expect(ok.success).toBe(true);
    const bad = DiningProfilePresetSchema.safeParse({
      profileId: 'DELUXE_LIVESTREAM',
      displayName: 'x',
      roleBindings: { HACK_SLOT: 'x' },
    });
    expect(bad.success).toBe(false);
  });
});

describe('契约注册表', () => {
  it('版本化且 Schema 全部就位', () => {
    expect(CONTRACT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(Object.keys(CONTRACT_SCHEMAS).length).toBeGreaterThanOrEqual(17);
    for (const [name, schema] of Object.entries(CONTRACT_SCHEMAS)) {
      expect(typeof schema.safeParse, `${name} 应为 Zod Schema`).toBe('function');
    }
  });
});
