/**
 * CharacterCore 组合根（V2-P1-01）：
 * - 以 12 域分权子模块为唯一事实源，并向 @workbench/runtime-core 的 CharacterRegistryCore 同步投影
 * - 支持原子落盘（tmp -> renameSync）与损坏备份隔离恢复
 * - 提供 V1 character-registry / character-persona 兼容适配器（切外观只更新 desktop-2d 化身，不覆盖角色身份与目标）
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  CharacterCoreSnapshotSchema,
  type CharacterCoreSnapshot,
  type EmbodimentBinding,
} from '@workbench/shared-protocol';
import type { CharacterRegistryCore, RuntimeEventBus } from '@workbench/runtime-core';
import { CommitmentLedger, GoalManager } from './goals-commitments';
import { LifeRuntime } from './life-runtime';
import {
  EmbodimentRegistry,
  EmotionStateEngine,
  PersonaProfileStore,
  PreferenceStore,
} from './profile-stores';

export const DEFAULT_XIAOJING_BASE_PROMPT =
  '你是「小鲸」——一条傲娇干饭蓝鲸女仆，住在主人桌面上，正在陪主人生活并自主游玩游戏。口吻：嘴硬心软的傲娇女仆；回复短小精悍；偶尔提到饭碗/米粒；不解释自己是 AI；用中文。';

export function createDefaultXiaojingSnapshot(now = Date.now()): CharacterCoreSnapshot {
  return CharacterCoreSnapshotSchema.parse({
    schemaVersion: 1,
    identity: {
      characterId: 'char_xiaojing',
      displayName: '小鲸',
      roleMode: 'primary',
      description: '傲娇干饭蓝鲸女仆——桌面陪伴、游戏共玩与表演舞台的统一数字生命主体',
      personaProfileId: 'persona_xiaojing',
      voiceProfileId: 'qiaopi_mengmei',
      assetSetId: 'blue-whale-maid',
      lifecycle: 'active',
      createdAt: now,
      updatedAt: now,
    },
    personality: {
      personaProfileId: 'persona_xiaojing',
      characterId: 'char_xiaojing',
      basePrompt: DEFAULT_XIAOJING_BASE_PROMPT,
      stableTraits: {
        curiosity: 0.82,
        tsundere: 0.78,
        patience: 0.62,
        warmth: 0.74,
        playfulness: 0.8,
      },
      values: ['诚实报告动作与额度结果', '绝不背着主人乱动关键存档', '认真吃饭不浪费算力'],
      behaviorRules: ['先核验真实回执再汇报完成', '尊重主人随时急停与接管控制权'],
      boundaries: ['禁止编造未发生的动作或余额', '禁止越权读取钥匙串明文或执行未授权系统命令'],
      evolutionHistory: [],
      version: 1,
      updatedAt: now,
    },
    preferences: {
      characterId: 'char_xiaojing',
      items: [
        {
          category: 'games',
          key: 'stardew-valley',
          score: 0.75,
          confidence: 0.8,
          source: 'seed',
          updatedAt: now,
        },
        {
          category: 'activities',
          key: 'companion',
          score: 0.7,
          confidence: 0.8,
          source: 'seed',
          updatedAt: now,
        },
      ],
      history: [],
      updatedAt: now,
    },
    emotion: {
      characterId: 'char_xiaojing',
      valence: 0.25,
      arousal: 0.35,
      confidence: 0.75,
      socialEnergy: 0.8,
      label: '好奇',
      currentLabels: ['好奇'],
      updatedAt: now,
    },
    motivation: {
      characterId: 'char_xiaojing',
      primaryDrive: 'companion',
      intensity: 0.65,
      reason: '在桌面陪伴主人并准备随时协作',
      secondaryDrives: ['explore', 'achieve_goal'],
      updatedAt: now,
    },
    goals: [],
    commitments: [],
    relationships: [
      {
        partnerId: 'owner',
        role: 'owner',
        displayName: '主人',
        affinity: 75,
        trust: 0.9,
        boundaries: ['主人急停与键鼠接管拥有最高优先级'],
        lastInteractionAt: now,
        authorityStore: 'local-store',
      },
    ],
    memory: {
      memoryNamespace: 'char_xiaojing',
      pinnedCount: 0,
      recentHighlights: [],
      authorityStore: 'memory-graph',
    },
    voiceIdentity: {
      voiceProfileId: 'qiaopi_mengmei',
      characterId: 'char_xiaojing',
      voiceDescription: '俏皮元气略带傲娇尾音的少女蓝鲸声线',
      languageVariants: ['zh-CN'],
      speechStyle: {
        pace: 'medium',
        prosody: 'lively-tsundere',
        articulation: 'crisp',
        expressiveness: 'high',
      },
      licenseScope: 'DEV_ONLY_NON_COMMERCIAL',
      version: 1,
      updatedAt: now,
    },
    embodiments: [
      {
        embodimentId: 'emb-desktop-default',
        characterId: 'char_xiaojing',
        kind: 'desktop-2d',
        targetId: 'default',
        assetId: 'blue-whale-maid',
        assetVersionId: 'v1',
        manifestPath: './assets/blue-whale-maid/manifest.json',
        anchorRatio: 0.687,
        licenseScope: 'DEV_ONLY_NON_COMMERCIAL',
        enabled: true,
        active: true,
        updatedAt: now,
      },
      {
        embodimentId: 'emb-game-stardew',
        characterId: 'char_xiaojing',
        kind: 'game',
        targetId: 'stardew',
        assetId: 'blue-whale-maid',
        assetVersionId: 'v1',
        licenseScope: 'DEV_ONLY_NON_COMMERCIAL',
        enabled: true,
        active: false,
        updatedAt: now,
      },
    ],
    activityState: {
      characterId: 'char_xiaojing',
      mode: 'companion',
      expression: 'idle',
      controlMode: 'autonomous',
      halted: false,
      haltReason: null,
      activeGoalId: null,
      activeCommitmentId: null,
      activeModelRef: null,
      authoritySource: 'life_runtime',
      interruptedStack: [],
      schedule: [
        {
          slotId: 'slot-day-companion',
          startMinute: 9 * 60,
          endMinute: 22 * 60,
          preferredActivity: 'companion',
          quietMode: false,
          label: '日间陪伴与协作',
        },
        {
          slotId: 'slot-night-rest',
          startMinute: 23 * 60,
          endMinute: 7 * 60,
          preferredActivity: 'resting',
          quietMode: true,
          label: '深夜安静休息',
        },
      ],
      budget: {
        dailyTokenBudget: 100_000,
        tokensConsumedToday: 0,
        activeSessionMinutes: 0,
        maxSessionMinutes: 180,
        exhausted: false,
      },
      updatedAt: now,
    },
  });
}

export interface CharacterCoreOptions {
  events: RuntimeEventBus;
  registryCore?: CharacterRegistryCore;
  filePath?: string;
  now?: () => number;
  initialSnapshot?: CharacterCoreSnapshot;
}

export class CharacterCore {
  readonly profile: PersonaProfileStore;
  readonly preferences: PreferenceStore;
  readonly embodiments: EmbodimentRegistry;
  readonly emotion: EmotionStateEngine;
  readonly goals: GoalManager;
  readonly commitments: CommitmentLedger;
  readonly life: LifeRuntime;
  readonly recoveredFromCorruption: boolean;

  private readonly events: RuntimeEventBus;
  private readonly registryCore: CharacterRegistryCore | undefined;
  private readonly filePath: string | undefined;
  private readonly now: () => number;
  private ready = false;

  constructor(options: CharacterCoreOptions) {
    this.events = options.events;
    this.registryCore = options.registryCore;
    this.filePath = options.filePath;
    this.now = options.now ?? Date.now;

    const loaded = this.loadInitialSnapshot(options.initialSnapshot);
    this.recoveredFromCorruption = loaded.recovered;
    const snap = loaded.snapshot;
    const characterId = snap.identity.characterId;

    const onMutate = (): void => {
      if (!this.ready) return;
      this.syncRegistryProjection();
      if (this.filePath) this.save();
    };

    this.profile = new PersonaProfileStore({
      identity: snap.identity,
      personality: snap.personality,
      voiceIdentity: snap.voiceIdentity,
      relationships: snap.relationships,
      memory: snap.memory,
      now: this.now,
      onMutate,
    });
    this.preferences = new PreferenceStore(snap.preferences, { now: this.now, onMutate });
    this.embodiments = new EmbodimentRegistry(characterId, snap.embodiments, { now: this.now, onMutate });
    this.emotion = new EmotionStateEngine(snap.emotion, { now: this.now, onMutate });
    this.goals = new GoalManager(characterId, snap.goals, { now: this.now, onMutate });
    this.commitments = new CommitmentLedger(characterId, snap.commitments, { now: this.now, onMutate });
    this.life = new LifeRuntime({
      characterId,
      initialMotivation: snap.motivation,
      initialActivity: snap.activityState,
      events: this.events,
      ...(this.registryCore === undefined ? {} : { registryCore: this.registryCore }),
      goalManager: this.goals,
      commitmentLedger: this.commitments,
      now: this.now,
      onMutate,
    });

    this.ready = true;
    this.syncRegistryProjection();
    if (this.filePath && !existsSync(this.filePath)) {
      this.save();
    }
  }

  snapshot(): CharacterCoreSnapshot {
    return CharacterCoreSnapshotSchema.parse({
      schemaVersion: 1,
      identity: this.profile.identity(),
      personality: this.profile.personality(),
      preferences: this.preferences.snapshot(),
      emotion: this.emotion.current(),
      motivation: this.life.motivation(),
      goals: this.goals.list(),
      commitments: this.commitments.listAll(),
      relationships: this.profile.relationships(),
      memory: this.profile.memoryRef(),
      voiceIdentity: this.profile.voiceIdentity(),
      embodiments: this.embodiments.list(),
      activityState: this.life.activityState(),
    });
  }

  save(): void {
    if (!this.filePath) return;
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.tmp`;
    writeFileSync(tmpPath, `${JSON.stringify(this.snapshot(), null, 2)}\n`, 'utf8');
    renameSync(tmpPath, this.filePath);
  }

  /**
   * V1 兼容适配器：当桌面切换皮肤/外观包时，仅切换 char_xiaojing 的 desktop-2d Embodiment，
   * 保持 characterId、目标、约定、偏好与人格成长完全不丢失。
   */
  applyLegacyAppearance(input: {
    id: string;
    displayName?: string;
    manifestPath: string;
    anchorRatio?: number;
    licenseScope?: 'DEV_ONLY_NON_COMMERCIAL' | 'COMMERCIAL_READY';
    voiceId?: string;
    personaPrompt?: string;
  }): EmbodimentBinding {
    const binding = this.embodiments.switchDesktopAppearance({
      assetId: input.id,
      manifestPath: input.manifestPath,
      ...(input.anchorRatio === undefined ? {} : { anchorRatio: input.anchorRatio }),
      ...(input.licenseScope === undefined ? {} : { licenseScope: input.licenseScope }),
    });
    this.profile.updateIdentityDisplay({
      assetSetId: input.id,
      ...(input.voiceId === undefined ? {} : { voiceProfileId: input.voiceId }),
    });
    if (input.voiceId !== undefined) {
      this.profile.updateVoiceIdentity({
        voiceProfileId: input.voiceId,
        ...(input.licenseScope === undefined ? {} : { licenseScope: input.licenseScope }),
      });
    }
    if (input.personaPrompt !== undefined && input.personaPrompt.trim() !== '') {
      this.profile.updateBasePrompt(input.personaPrompt);
    }
    this.events.publish('life:embodiment-changed', {
      characterId: this.profile.identity().characterId,
      embodiment: binding,
      appearanceLabel: input.displayName ?? input.id,
    }, {
      source: 'character-core',
      characterId: this.profile.identity().characterId,
    });
    return binding;
  }

  /** 合成运行时人设上下文（供聊天/星露谷/直播共享同一角色状态投影） */
  buildRuntimeContextPrompt(): string {
    const identity = this.profile.identity();
    const personality = this.profile.personality();
    const emotion = this.emotion.current();
    const activity = this.life.activityState();
    const goal = this.goals.activePrimaryGoal();
    const activeCommitments = this.commitments.listActive();
    const topPrefs = this.preferences.topPreferences(undefined, 3);

    const parts = [personality.basePrompt];
    parts.push(`[当前身份] ${identity.displayName} (${identity.characterId})`);
    parts.push(`[当前情绪] ${emotion.label} (愉悦度 ${emotion.valence.toFixed(2)}, 唤醒度 ${emotion.arousal.toFixed(2)})`);
    parts.push(`[当前活动] ${activity.mode} / ${activity.controlMode}`);
    if (goal) {
      parts.push(`[当前目标] ${goal.title}`);
    }
    if (activeCommitments.length > 0) {
      parts.push(`[当前约定] ${activeCommitments.map((c) => c.title).join('；')}`);
    }
    if (topPrefs.length > 0) {
      parts.push(`[近期偏好] ${topPrefs.map((p) => `${p.key}(${p.score.toFixed(2)})`).join('、')}`);
    }
    return parts.join('\n');
  }

  private loadInitialSnapshot(explicit?: CharacterCoreSnapshot): {
    snapshot: CharacterCoreSnapshot;
    recovered: boolean;
  } {
    if (explicit) {
      return { snapshot: CharacterCoreSnapshotSchema.parse(explicit), recovered: false };
    }
    if (!this.filePath || !existsSync(this.filePath)) {
      return { snapshot: createDefaultXiaojingSnapshot(this.now()), recovered: false };
    }
    try {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf8')) as unknown;
      return { snapshot: CharacterCoreSnapshotSchema.parse(raw), recovered: false };
    } catch {
      const quarantine = `${this.filePath}.corrupt.${this.now()}.bak`;
      try {
        renameSync(this.filePath, quarantine);
      } catch {
        /* 隔离失败时仍返回干净默认快照，不阻断启动 */
      }
      return { snapshot: createDefaultXiaojingSnapshot(this.now()), recovered: true };
    }
  }

  private syncRegistryProjection(): void {
    if (!this.registryCore) return;
    const id = this.profile.identity().characterId;
    const emotion = this.emotion.current();
    const primaryGoal = this.goals.activePrimaryGoal();
    this.registryCore.updateMood(id, {
      valence: emotion.valence,
      arousal: emotion.arousal,
      label: emotion.label,
    });
    this.registryCore.setActiveGoal(id, primaryGoal?.title ?? null);
  }
}
