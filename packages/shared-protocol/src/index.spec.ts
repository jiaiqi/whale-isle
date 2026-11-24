import { describe, expect, it } from 'vitest';
import personaFixture from '../fixtures/blue-whale-maid.json';
import {
  AudioPlaybackLeaseSchema,
  DiningProfilePresetSchema,
  NormalizedLiveEventSchema,
  PetAvatarManifestSchema,
  PetPersonaConfigSchema,
  ReflexRuleSchema,
  StardewMcpActionReceiptSchema,
  GameBridgeActionAcceptedSchema,
  GameBridgeActionRequestSchema,
  GameBridgeHealthSchema,
  TerrariaActionReceiptSchema,
  DstActionReceiptSchema,
  WorkbenchRoleSlotSchema,
  PetCustomCharacterSchema,
  statusLabelZh,
  toolLabelZh,
  WORKBENCH_STATUS_LABELS_ZH,
  WORKBENCH_TOOL_LABELS_ZH,
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

describe('多游戏桥接契约（M7：泰拉瑞亚 / 饥荒 DST）', () => {
  const ACTION_ID = 'ccccccc1-2222-4333-8444-555555555555';

  const TERRARIA_SNAPSHOT = {
    schemaVersion: 1,
    capturedAt: 1_700_000_000_000,
    clock: { dayCount: 3, isDay: true, dayPhase: 'day', timeText: '09:20 AM', hardMode: false },
    player: {
      hp: 120,
      hpMax: 140,
      mana: 40,
      manaMax: 60,
      position: { x: 1042, y: 386 },
      facing: 'right',
      buffs: [{ name: 'Well Fed', timeSeconds: 300 }],
      inventory: [{ slot: 0, itemName: 'Copper Pickaxe', stack: 1 }],
      selectedSlot: 0,
    },
    world: { biome: 'Forest', events: [], downedBosses: ['Eye of Cthulhu'] },
    nearby: {
      tiles: {
        originX: 1022,
        originY: 366,
        width: 41,
        height: 41,
        legend: { '.': 'air', '#': 'solid', '-': 'platform', '~': 'lava', T: 'tree' },
        rows: ['.'.repeat(41), '#'.repeat(41)],
      },
      npcs: [{ name: 'Green Slime', hp: 14, hpMax: 14, position: { x: 1048, y: 386 }, isHostile: true }],
      items: [],
    },
    danger: { lavaNearby: false, fallingDanger: false, threatLevel: 'caution' },
    control: { authority: 'AI_AUTOPILOT', isPlayerMovingPhysically: false },
  };

  const DST_SNAPSHOT = {
    schemaVersion: 1,
    capturedAt: 1_700_000_000_000,
    clock: { cycle: 5, phase: 'dusk', phaseProgress: 0.4, season: 'autumn', isRaining: false },
    player: {
      character: 'wilson',
      health: { current: 120, max: 150 },
      hunger: { current: 90, max: 150 },
      sanity: { current: 130, max: 200 },
      temperature: 15,
      moisture: 0,
      position: { x: 0, z: 0 },
      inventory: [
        { itemName: 'twigs', count: 6, equipped: false },
        { itemName: 'axe', count: 1, equipped: true },
      ],
    },
    nearby: {
      entities: [
        { prefab: 'evergreen', displayName: '树', position: { x: 4, z: -2 }, distance: 4.5, isResource: true },
      ],
      campfires: [{ position: { x: 0, z: 0 }, fuelPercent: 0.35 }],
    },
    threats: [{ kind: 'hound', count: 2, directionText: '东北' }],
    control: { authority: 'AI_AUTOPILOT', isPlayerMovingPhysically: false },
  };

  it('Terraria UNCERTAIN 回执可携带快照，gameId 锁定 terraria', () => {
    const receipt = TerrariaActionReceiptSchema.parse({
      actionId: ACTION_ID,
      tool: 'move_to',
      status: 'UNCERTAIN',
      reason: 'PATH_BLOCKED_PERSISTENT',
      startedAt: 1,
      completedAt: 2,
      gameId: 'terraria',
      snapshot: TERRARIA_SNAPSHOT,
    });
    expect(receipt.snapshot?.danger.threatLevel).toBe('caution');
    // gameId 字面量互斥：terraria 回执不接受 dst
    expect(
      TerrariaActionReceiptSchema.safeParse({ ...receipt, gameId: 'dst' }).success,
    ).toBe(false);
  });

  it('Terraria 快照缺 tiles / 非法 dayPhase 拒绝', () => {
    const noTiles = JSON.parse(JSON.stringify(TERRARIA_SNAPSHOT)) as Record<string, unknown>;
    delete (noTiles.nearby as Record<string, unknown>).tiles;
    expect(
      TerrariaActionReceiptSchema.safeParse({
        actionId: ACTION_ID,
        tool: 'mine',
        status: 'FAILED',
        startedAt: 1,
        completedAt: 2,
        gameId: 'terraria',
        snapshot: noTiles,
      }).success,
    ).toBe(false);
    expect(
      TerrariaActionReceiptSchema.safeParse({
        actionId: ACTION_ID,
        tool: 'mine',
        status: 'FAILED',
        startedAt: 1,
        completedAt: 2,
        gameId: 'terraria',
        snapshot: { ...TERRARIA_SNAPSHOT, clock: { ...TERRARIA_SNAPSHOT.clock, dayPhase: 'eclipse' } },
      }).success,
    ).toBe(false);
  });

  it('DST COMPLETED 回执默认无快照；非法 season / status 拒绝', () => {
    const receipt = DstActionReceiptSchema.parse({
      actionId: ACTION_ID,
      tool: 'chop_tree',
      status: 'COMPLETED',
      startedAt: 1,
      completedAt: 2,
      gameId: 'dst',
    });
    expect(receipt.snapshot).toBeUndefined();
    expect(
      DstActionReceiptSchema.safeParse({
        actionId: ACTION_ID,
        tool: 'chop_tree',
        status: 'COMPLETED',
        startedAt: 1,
        completedAt: 2,
        gameId: 'dst',
        snapshot: { ...DST_SNAPSHOT, clock: { ...DST_SNAPSHOT.clock, season: 'fall' } },
      }).success,
    ).toBe(false);
    // TIMEOUT 不是回执态（超时是工作台侧分类，不是模组回执）
    expect(
      DstActionReceiptSchema.safeParse({
        actionId: ACTION_ID,
        tool: 'chop_tree',
        status: 'TIMEOUT',
        startedAt: 1,
        completedAt: 2,
        gameId: 'dst',
      }).success,
    ).toBe(false);
  });

  it('GameBridgeActionRequest args 默认空对象；互斥拒绝形状过契约', () => {
    const req = GameBridgeActionRequestSchema.parse({ actionId: ACTION_ID, tool: 'mine' });
    expect(req.args).toEqual({});
    expect(GameBridgeActionRequestSchema.safeParse({ tool: 'mine' }).success).toBe(false);
    const reject = GameBridgeActionAcceptedSchema.parse({ accepted: false, reason: 'ACTION_IN_FLIGHT' });
    expect(reject.accepted).toBe(false);
  });

  it('GameBridgeHealth 携带控制权状态；角色槽位新增两个游戏规划器', () => {
    const health = GameBridgeHealthSchema.parse({ ok: true, gameId: 'terraria', control: 'AI_AUTOPILOT' });
    expect(health.bridgeVersion).toBe('');
    expect(WorkbenchRoleSlotSchema.options).toContain('TERRARIA_GAME_PLANNER');
    expect(WorkbenchRoleSlotSchema.options).toContain('DST_GAME_PLANNER');
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

describe('PetAvatarManifest（桌宠资产清单）', () => {
  const baseManifest = {
    petId: 'blue-whale-maid',
    renderer: 'webm-alpha',
    licenseScope: 'DEV_ONLY_NON_COMMERCIAL',
    attribution: '形象：CC BY-NC-SA 4.0（@ZipZipPipe / 原型 @上善无形）',
    actions: [
      {
        actionState: 'idle',
        clips: [{ clipId: 'idle-01', webmPath: 'webm/daiji-huxi-xiuxian.webm' }],
      },
      {
        actionState: 'rage_spray',
        clips: [
          { clipId: 'rage-01', webmPath: 'webm/pentu-paopao.webm', weight: 0.7 },
          { clipId: 'rage-02', webmPath: 'webm/yong-jingyu-weiba-paidadi.webm', weight: 0.3 },
        ],
      },
    ],
  } as const;

  it('清单默认值落位（尺寸/脚底线/默认动作/片段权重）', () => {
    const manifest = PetAvatarManifestSchema.parse(baseManifest);
    expect(manifest.width).toBe(640);
    expect(manifest.height).toBe(360);
    expect(manifest.footlineRatio).toBe(0.92);
    expect(manifest.defaultAction).toBe('idle');
    expect(manifest.actions[1]?.clips[0]?.weight).toBe(0.7);
    expect(manifest.actions[1]?.clips[1]?.loop).toBe(true);
    expect(manifest.actions[1]?.clips[1]?.fps).toBe(30);
  });

  it('非法 renderer / 越界 footlineRatio / 未登记 actionState 拒绝', () => {
    expect(PetAvatarManifestSchema.safeParse({ ...baseManifest, renderer: 'gif' }).success).toBe(false);
    expect(
      PetAvatarManifestSchema.safeParse({ ...baseManifest, footlineRatio: 1.5 }).success,
    ).toBe(false);
    expect(
      PetAvatarManifestSchema.safeParse({
        ...baseManifest,
        actions: [...baseManifest.actions, { actionState: 'fly', clips: [{ clipId: 'x', webmPath: 'y.webm' }] }],
      }).success,
    ).toBe(false);
  });

  it('actions 为空数组拒绝', () => {
    expect(PetAvatarManifestSchema.safeParse({ ...baseManifest, actions: [] }).success).toBe(false);
  });
});

describe('契约注册表', () => {
  it('版本化且 Schema 全部就位', () => {
    expect(CONTRACT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(Object.keys(CONTRACT_SCHEMAS).length).toBeGreaterThanOrEqual(19);
    for (const [name, schema] of Object.entries(CONTRACT_SCHEMAS)) {
      expect(typeof schema.safeParse, `${name} 应为 Zod Schema`).toBe('function');
    }
  });
});

describe('中文化工具/状态词表（T-M6-59）', () => {
  it('已知工具/状态返回中文；未知原样；空值给出占位', () => {
    expect(WORKBENCH_TOOL_LABELS_ZH.fish).toBe('钓鱼');
    expect(WORKBENCH_TOOL_LABELS_ZH['craft']).toBe('制作');
    expect(WORKBENCH_STATUS_LABELS_ZH.COMPLETED).toBe('已完成');
    expect(toolLabelZh('fish')).toBe('钓鱼');
    expect(toolLabelZh('new_tool')).toBe('new_tool');
    expect(toolLabelZh('')).toBe('待命');
    expect(toolLabelZh(undefined)).toBe('待命');
    expect(toolLabelZh(null)).toBe('待命');
    expect(statusLabelZh('FAILED')).toBe('失败');
    expect(statusLabelZh('WEIRD')).toBe('WEIRD');
    expect(statusLabelZh('')).toBe('—');
    expect(statusLabelZh(undefined)).toBe('—');
    expect(statusLabelZh(null)).toBe('—');
  });
});

describe('自定义角色新增字段默认值（T-M6-55）', () => {
  it('glyph.stroke 与 notebook.notes/sign 缺省安全回退', () => {
    const parsed = PetCustomCharacterSchema.parse({ name: '小海豹' });
    expect(parsed.glyph).toEqual({ fill: '', stroke: '', text: '' });
    expect(parsed.notebook).toEqual({ title: '', font: '', entries: [], notes: [], sign: '' });
  });
});
