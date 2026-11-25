import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CharacterRegistryCore, RuntimeEventBus, WhaleError } from '@workbench/runtime-core';
import {
  CharacterCore,
  createDefaultXiaojingSnapshot,
} from './index';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'whale-char-core-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('CharacterCore 12-domain & LifeRuntime (V2-P1-01)', () => {
  it('preserves char_xiaojing identity, goals, commitments, and personality across model & appearance switches', () => {
    let tick = 10_000;
    const bus = new RuntimeEventBus({ now: () => ++tick });
    const registry = new CharacterRegistryCore(bus, { now: () => ++tick });
    const dir = makeTempDir();
    const filePath = join(dir, 'v2-character-core.json');

    const core = new CharacterCore({
      events: bus,
      registryCore: registry,
      filePath,
      now: () => ++tick,
    });

    expect(core.recoveredFromCorruption).toBe(false);
    expect(core.profile.identity().characterId).toBe('char_xiaojing');
    expect(core.emotion.canElevateToolPermission()).toBe(false);

    const goal = core.goals.addGoal({
      title: '完成星露谷春季第一批防风草浇水',
      horizon: 'short_term',
      origin: 'shared',
      priority: 85,
      relatedActivity: 'gaming',
    });
    const commitment = core.commitments.create({
      partnerId: 'owner',
      partnerName: '主人',
      title: '下矿前先整理背包',
      detail: '留出至少 4 个空位再进矿洞',
    });

    // 切换模型
    const bound = core.life.bindModel('deepseek-chat');
    expect(bound.activeModelRef).toBe('deepseek-chat');
    core.life.bindModel('   ');
    expect(core.life.activityState().activeModelRef).toBeNull();
    core.life.bindModel('minimax-m3');

    // 切换桌面外观（兼容 V1 skin 切换）
    const appearance = core.applyLegacyAppearance({
      id: 'aboutme-dsh1',
      displayName: '蓝蓝·活力装',
      manifestPath: 'pet-characters/dsh1/manifest.json',
      anchorRatio: 0.72,
      licenseScope: 'DEV_ONLY_NON_COMMERCIAL',
      voiceId: 'qiaopi_mengmei',
      personaPrompt: '活力装小鲸继续陪主人！',
    });

    expect(appearance.assetId).toBe('aboutme-dsh1');
    expect(core.profile.identity().characterId).toBe('char_xiaojing');
    expect(core.goals.list({ status: 'active' })).toHaveLength(1);
    expect(core.goals.activePrimaryGoal()?.goalId).toBe(goal.goalId);
    expect(core.commitments.listActive()).toHaveLength(1);
    expect(core.commitments.listActive()[0]?.commitmentId).toBe(commitment.commitmentId);
    expect(core.life.activityState().activeModelRef).toBe('minimax-m3');

    // 跨实例磁盘重加载验证
    const reloaded = new CharacterCore({
      events: new RuntimeEventBus(),
      filePath,
      now: () => ++tick,
    });
    expect(reloaded.profile.identity().characterId).toBe('char_xiaojing');
    expect(reloaded.embodiments.getActive('desktop-2d')?.assetId).toBe('aboutme-dsh1');
    expect(reloaded.goals.list()).toHaveLength(1);
    expect(reloaded.commitments.listAll()).toHaveLength(1);
    expect(reloaded.life.activityState().activeModelRef).toBe('minimax-m3');
  });

  it('evolves traits, preferences, emotions, relationships, memory refs, and voice identity cleanly', () => {
    let tick = 20_000;
    const bus = new RuntimeEventBus({ now: () => ++tick });
    const registry = new CharacterRegistryCore(bus, { now: () => ++tick });
    const core = new CharacterCore({
      events: bus,
      registryCore: registry,
      now: () => ++tick,
    });

    const evolved = core.profile.evolveTrait('curiosity', 0.12, '发现星露谷新鱼点', 'ev-fish-1');
    expect(evolved.stableTraits.curiosity).toBeCloseTo(0.94, 4);
    expect(evolved.evolutionHistory).toHaveLength(1);
    expect(evolved.version).toBeGreaterThan(1);

    const clamped = core.profile.evolveTrait('new_trait', 2, '边界上限测试');
    expect(clamped.stableTraits.new_trait).toBe(1);

    expect(() => core.profile.evolveTrait('', 0.1, 'bad')).toThrow(WhaleError);
    expect(() => core.profile.updateBasePrompt('   ')).toThrow(WhaleError);

    core.profile.updateIdentityDisplay({ displayName: '小鲸鱼', description: 'V2 主角' });
    expect(core.profile.identity().displayName).toBe('小鲸鱼');

    core.profile.updateVoiceIdentity({
      voiceDescription: '清亮元气女仆声',
      preferredProviderId: 'cloud-tts',
      providerVoiceRef: 'xiaojing-v2',
      speechStyle: { pace: 'fast', prosody: 'excited', articulation: 'crisp', expressiveness: 'high' },
      singingStyle: { timbre: 'sweet', phrasing: 'smooth', genres: ['pop'] },
    });
    expect(core.profile.voiceIdentity().preferredProviderId).toBe('cloud-tts');

    core.profile.upsertRelationshipRef({
      partnerId: 'owner',
      role: 'owner',
      displayName: '主人',
      affinity: 90,
      trust: 0.95,
      boundaries: ['不背着主人卖稀有物品'],
    });
    core.profile.upsertRelationshipRef({
      partnerId: 'viewer-101',
      role: 'viewer',
      displayName: '烤鱼干',
      affinity: 15,
    });
    expect(core.profile.relationships()).toHaveLength(2);

    core.profile.updateMemoryRef({
      lastConsolidatedAt: tick,
      pinnedCount: 3,
      recentHighlights: ['海滩钓到比目鱼'],
    });
    expect(core.profile.memoryRef().pinnedCount).toBe(3);

    // 偏好演化
    core.preferences.recordExperience({
      category: 'games',
      key: 'stardew-valley',
      delta: 0.15,
      source: 'gameplay',
      reason: '丰收卖出好价钱',
    });
    core.preferences.recordExperience({
      category: 'music',
      key: 'city-pop',
      delta: 0.6,
      source: 'singing',
      reason: '唱歌心情好',
      confidence: 0.85,
    });
    expect(core.preferences.topPreferences('music', 2)[0]?.key).toBe('city-pop');
    expect(core.preferences.topPreferences(undefined, 2)).toHaveLength(2);
    expect(() => core.preferences.recordExperience({
      category: 'games',
      key: '',
      delta: 0.1,
      source: 'x',
      reason: 'y',
    })).toThrow(WhaleError);

    // 情绪刺激与 TTL 自然回落
    core.emotion.applyStimulus({
      deltaValence: 0.4,
      deltaArousal: 0.3,
      label: '雀跃',
      ttlMs: 1000,
    });
    expect(core.emotion.current().label).toBe('雀跃');
    tick += 5_000;
    expect(core.emotion.current().label).toBe('平静');

    // 同步到 RuntimeContextPrompt 与 CharacterRegistryCore
    const prompt = core.buildRuntimeContextPrompt();
    expect(prompt).toContain('小鲸鱼');
    expect(prompt).toContain('stardew-valley');
    expect(registry.primaryState().mood.label).toBe('平静');
  });

  it('arbitrates goals, commitments, interruptions, schedule, budget, and emergency halt in LifeRuntime', () => {
    let tick = 30_000;
    const bus = new RuntimeEventBus({ now: () => ++tick });
    const registry = new CharacterRegistryCore(bus, { now: () => ++tick });
    const core = new CharacterCore({
      events: bus,
      registryCore: registry,
      now: () => ++tick,
    });

    // 目标优先级排序与更新
    const longGoal = core.goals.addGoal({ title: '长期收集社区中心', horizon: 'long_term', priority: 40 });
    const actionGoal = core.goals.addGoal({ title: '给防风草浇水', horizon: 'action', priority: 90 });
    const tieGoal = core.goals.addGoal({ title: '共同目标测试', horizon: 'shared', priority: 90 });
    expect(core.goals.activePrimaryGoal()?.goalId).toBe(actionGoal.goalId);

    core.goals.updateGoal(actionGoal.goalId, { status: 'completed', progress: 1 });
    expect(core.goals.activePrimaryGoal()?.goalId).toBe(tieGoal.goalId);
    core.goals.updateGoal(longGoal.goalId, { title: '社区中心献祭', description: '收集包', priority: 55, relatedActivity: 'gaming' });
    expect(() => core.goals.updateGoal('missing', { status: 'completed' })).toThrow(WhaleError);

    // 约定账本流转
    const c1 = core.commitments.create({ partnerId: 'owner', title: '陪练钓鱼', detail: '去海滩' });
    const c2 = core.commitments.create({ partnerId: 'owner', title: '晚点唱歌' });
    core.commitments.renegotiate(c1.commitmentId, { title: '先钓鱼半小时', detail: '再回农场', dueAt: tick + 1000, note: '主人同意' });
    core.commitments.fulfill(c1.commitmentId, '已完成');
    core.commitments.cancel(c2.commitmentId, '今天太晚了');
    expect(core.commitments.listActive()).toHaveLength(0);
    expect(() => core.commitments.fulfill('missing')).toThrow(WhaleError);

    // LifeRuntime 动机与活动切换 / 中断恢复
    core.life.setMotivation({ primaryDrive: 'achieve_goal', intensity: 0.9, reason: '想快点钓鱼', secondaryDrives: ['explore'] });
    expect(core.life.motivation().primaryDrive).toBe('achieve_goal');

    const g1 = core.life.selectActivity({ mode: 'gaming', reason: '开始星露谷', source: 'life_runtime' });
    expect(g1.accepted).toBe(true);
    expect(registry.primaryState().expression).toBe('gaming');

    const interrupted = core.life.interruptFor({ mode: 'companion', expression: 'speaking', reason: '回应主人提问', source: 'user_command' });
    expect(interrupted.accepted).toBe(true);
    expect(core.life.activityState().interruptedStack).toHaveLength(1);

    const restored = core.life.resumeInterrupted('回答完毕');
    expect(restored.resumed).toBe(true);
    expect(restored.state.mode).toBe('gaming');

    // 无中断栈时恢复返回 false
    expect(core.life.resumeInterrupted().resumed).toBe(false);

    // 手动接管期间拒绝自主切入游戏
    core.life.setControlMode('manual_takeover', '用户接管');
    const blockedByTakeover = core.life.selectActivity({ mode: 'gaming', reason: '自主继续玩', source: 'life_runtime' });
    expect(blockedByTakeover.accepted).toBe(false);
    if (!blockedByTakeover.accepted) expect(blockedByTakeover.reason).toBe('MANUAL_TAKEOVER_ACTIVE');

    // 恢复自主后测试预算耗尽拒批
    core.life.setControlMode('autonomous', '交还 AI');
    core.life.updateBudget({ dailyTokenBudget: 1000, tokensConsumedToday: 1000 });
    const blockedByBudget = core.life.selectActivity({ mode: 'streaming', reason: '想开播', source: 'life_runtime' });
    expect(blockedByBudget.accepted).toBe(false);
    if (!blockedByBudget.accepted) expect(blockedByBudget.reason).toBe('BUDGET_EXHAUSTED');

    // 急停暂停活跃目标并拒绝后续自主切换，直到 resume
    const halted = core.life.emergencyHalt('安全急停');
    expect(halted.halted).toBe(true);
    expect(halted.mode).toBe('halted');
    expect(registry.primaryState().halted).toBe(true);

    const blockedByHalt = core.life.selectActivity({ mode: 'companion', reason: '尝试恢复', source: 'life_runtime' });
    expect(blockedByHalt.accepted).toBe(false);
    if (!blockedByHalt.accepted) expect(blockedByHalt.reason).toBe('CHARACTER_HALTED');

    const resumed = core.life.resume('autonomous');
    expect(resumed.halted).toBe(false);
    expect(resumed.mode).toBe('companion');
    expect(registry.primaryState().halted).toBe(false);

    // 日程评估（日间、深夜跨午夜、未命中时段）
    const noon = new Date(2026, 10, 25, 14, 0, 0);
    expect(core.life.evaluateSchedule(noon)).toMatchObject({ recommendedActivity: 'companion', quietMode: false });
    const midnight = new Date(2026, 10, 26, 1, 30, 0);
    expect(core.life.evaluateSchedule(midnight)).toMatchObject({ recommendedActivity: 'resting', quietMode: true });
    const gapMorning = new Date(2026, 10, 26, 8, 0, 0);
    expect(core.life.evaluateSchedule(gapMorning)).toMatchObject({ recommendedActivity: 'companion', slotLabel: null });
  });

  it('quarantines corrupted snapshot files and recovers with default xiaojing snapshot', () => {
    const dir = makeTempDir();
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, 'v2-character-core.json');
    writeFileSync(filePath, '{ broken json !!!', 'utf8');

    const core = new CharacterCore({
      events: new RuntimeEventBus(),
      filePath,
      now: () => 123456,
    });
    expect(core.recoveredFromCorruption).toBe(true);
    expect(core.profile.identity().characterId).toBe('char_xiaojing');
    expect(existsSync(filePath)).toBe(true);
    const files = readdirSync(dir);
    expect(files.some((f) => f.includes('.corrupt.'))).toBe(true);

    // 支持传入 explicit initialSnapshot
    const explicit = new CharacterCore({
      events: new RuntimeEventBus(),
      initialSnapshot: createDefaultXiaojingSnapshot(999),
    });
    expect(explicit.recoveredFromCorruption).toBe(false);
    expect(explicit.snapshot().identity.createdAt).toBe(999);
    explicit.save(); // 无 filePath 时安全无操作

    // 无 registryCore / 空目标 / 空约定时的默认 prompt 与分支覆盖
    const barePrompt = explicit.buildRuntimeContextPrompt();
    expect(barePrompt).toContain('char_xiaojing');
    explicit.applyLegacyAppearance({
      id: 'minimal-skin',
      manifestPath: 'pet-characters/min/manifest.json',
    });
    expect(explicit.embodiments.getActive('desktop-2d')?.assetId).toBe('minimal-skin');
    expect(explicit.embodiments.getActive('vrm-3d')).toBeNull();
  });

  it('covers optional update patches, goal filters, control modes, and edge branches', () => {
    let tick = 40_000;
    const bus = new RuntimeEventBus({ now: () => ++tick });
    const registry = new CharacterRegistryCore(bus, { now: () => ++tick });
    const core = new CharacterCore({
      events: bus,
      registryCore: registry,
      now: () => ++tick,
    });

    // profile-stores 可选分支覆盖
    core.profile.updateIdentityDisplay({});
    core.profile.updateIdentityDisplay({
      displayName: '小鲸2',
      description: 'desc',
      assetSetId: 'asset-2',
      voiceProfileId: 'voice-2',
    });
    core.profile.updateVoiceIdentity({});
    core.profile.updateVoiceIdentity({ licenseScope: 'COMMERCIAL_READY' });
    core.profile.updateMemoryRef({});
    core.profile.upsertRelationshipRef({
      partnerId: 'owner',
      role: 'owner',
      displayName: '主人V2',
      lastInteractionAt: tick,
    });

    // embodiments 更新已有绑定与非激活绑定
    core.embodiments.upsert({
      embodimentId: 'emb-game-stardew',
      characterId: 'char_xiaojing',
      kind: 'game',
      targetId: 'stardew',
      assetId: 'stardew-pixel-v2',
      enabled: true,
      active: true,
    });
    expect(core.embodiments.getActive('game')?.assetId).toBe('stardew-pixel-v2');
    core.embodiments.upsert({
      embodimentId: 'emb-stage-obs',
      characterId: 'char_xiaojing',
      kind: 'stage',
      targetId: 'obs',
      assetId: 'stage-v1',
      enabled: true,
      active: false,
    });

    // emotion 无 ttl 刺激与显式 currentLabels
    core.emotion.applyStimulus({ deltaValence: 0.1, deltaArousal: 0.1, label: '开心' });
    core.emotion.update({ currentLabels: ['开心', '元气'], confidence: 0.9, socialEnergy: 0.8 });
    core.emotion.update({});

    // goals 过滤、无激活目标、空暂停/恢复
    expect(core.goals.activePrimaryGoal()).toBeNull();
    expect(core.goals.pauseActiveGoals()).toEqual([]);
    expect(core.goals.resumePausedGoals()).toEqual([]);

    const gA = core.goals.addGoal({
      goalId: 'g-a',
      title: '行动目标',
      description: 'desc',
      horizon: 'action',
      origin: 'user',
      priority: 70,
      relatedActivity: 'gaming',
      parentGoalId: 'root',
    });
    core.goals.updateGoal(gA.goalId, { progress: 0.5 });
    expect(core.goals.list({ horizon: 'action' })).toHaveLength(1);
    expect(core.goals.list({ status: 'paused' })).toHaveLength(0);

    // commitments 可选参数全覆盖
    const c = core.commitments.create({
      commitmentId: 'c-1',
      partnerId: 'owner',
      partnerName: '主人',
      title: '约定1',
      detail: '详情',
      dueAt: tick + 5000,
    });
    core.commitments.renegotiate(c.commitmentId, {});
    expect(core.commitments.listActive()).toHaveLength(1);

    // life-runtime 控制模式与预算会话超时分支
    core.life.setMotivation({});
    core.life.setControlMode('command', '直接指令');
    expect(core.life.evaluateSchedule(new Date(2026, 10, 25, 14, 0, 0)).canAutoSwitch).toBe(false);
    core.life.setControlMode('autonomous', '恢复');
    core.life.selectActivity({
      mode: 'creative',
      expression: 'thinking',
      reason: '创作',
      source: 'life_runtime',
      goalId: gA.goalId,
      commitmentId: c.commitmentId,
    });
    core.life.updateBudget({ activeSessionMinutes: 200, maxSessionMinutes: 180 });
    expect(core.life.activityState().budget.exhausted).toBe(true);
    core.life.updateBudget({});
    const forcedDuringExhausted = core.life.selectActivity({
      mode: 'gaming',
      reason: '用户强制启动',
      source: 'user_command',
      force: true,
    });
    expect(forcedDuringExhausted.accepted).toBe(true);

    // 急停时 interruptFor 走 halted 分支
    core.life.emergencyHalt('测试急停');
    const haltedInterrupt = core.life.interruptFor({ mode: 'companion', reason: '急停中打断' });
    expect(haltedInterrupt.accepted).toBe(false);
    core.life.resume('manual_takeover');
    expect(core.life.activityState().authoritySource).toBe('manual_takeover');
  });
});
