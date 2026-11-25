/**
 * Whale Isle V2 统一角色内核（CharacterCore）：
 * - AI 是主体，桌宠/游戏化身/直播舞台是同一个 Character Identity 的不同表现
 * - 统一管理：身份、情绪状态（MoodState）、表现状态（ExpressionState）、控制权（ControlMode）与紧急停止（Halt）
 * - 所有状态跃迁自动向 RuntimeEventBus 广播标准事件
 */
import { z } from 'zod';
import { WhaleError } from './errors';
import type { RuntimeEventBus } from './event-bus';

export const ExpressionStateSchema = z.enum([
  'idle',
  'listening',
  'thinking',
  'speaking',
  'singing',
  'dancing',
  'gaming',
  'reacting',
  'resting',
]);
export type ExpressionState = z.infer<typeof ExpressionStateSchema>;

export const ControlModeSchema = z.enum([
  'autonomous',
  'coop',
  'command',
  'manual_takeover',
]);
export type ControlMode = z.infer<typeof ControlModeSchema>;

export const MoodStateSchema = z.object({
  valence: z.number().min(-1).max(1).default(0.25),
  arousal: z.number().min(0).max(1).default(0.35),
  label: z.string().min(1).default('平静'),
  updatedAt: z.number().default(0),
});
export type MoodState = z.output<typeof MoodStateSchema>;

export const CharacterIdentitySchema = z.object({
  characterId: z.string().min(1),
  displayName: z.string().min(1),
  roleMode: z.enum(['primary', 'passive']).default('passive'),
  personaId: z.string().min(1),
  voiceProfileId: z.string().min(1),
  embodimentKinds: z.array(z.enum(['desktop-2d', 'live2d', 'vrm-3d', 'game', 'stage'])).default(['desktop-2d']),
  createdAt: z.number().default(0),
});
export type CharacterIdentity = z.output<typeof CharacterIdentitySchema>;
export type CharacterIdentityInput = z.input<typeof CharacterIdentitySchema>;

export interface CharacterRuntimeState {
  identity: CharacterIdentity;
  expression: ExpressionState;
  mood: MoodState;
  controlMode: ControlMode;
  halted: boolean;
  haltReason: string | null;
  activeGoal: string | null;
  lastEventAt: number;
}

export const DEFAULT_XIAOJING_IDENTITY: CharacterIdentity = CharacterIdentitySchema.parse({
  characterId: 'char_xiaojing',
  displayName: '小鲸',
  roleMode: 'primary',
  personaId: 'blue-whale-maid',
  voiceProfileId: 'qiaopi_mengmei',
  embodimentKinds: ['desktop-2d', 'game', 'stage'],
});

export class CharacterRegistryCore {
  private readonly states = new Map<string, CharacterRuntimeState>();
  private primaryCharacterId: string;
  private readonly now: () => number;

  constructor(
    private readonly events: RuntimeEventBus,
    options: { primaryIdentity?: Partial<CharacterIdentityInput>; now?: () => number } = {},
  ) {
    this.now = options.now ?? Date.now;
    const primary = CharacterIdentitySchema.parse({
      ...DEFAULT_XIAOJING_IDENTITY,
      ...(options.primaryIdentity ?? {}),
      roleMode: 'primary',
      createdAt: options.primaryIdentity?.createdAt ?? this.now(),
    });
    this.primaryCharacterId = primary.characterId;
    this.states.set(primary.characterId, this.initialState(primary));
  }

  private initialState(identity: CharacterIdentity): CharacterRuntimeState {
    const t = this.now();
    return {
      identity,
      expression: 'idle',
      mood: { valence: 0.25, arousal: 0.35, label: '好奇', updatedAt: t },
      controlMode: 'autonomous',
      halted: false,
      haltReason: null,
      activeGoal: null,
      lastEventAt: t,
    };
  }

  registerCharacter(input: CharacterIdentityInput): CharacterRuntimeState {
    const parsed = CharacterIdentitySchema.parse({
      ...input,
      createdAt: input.createdAt ?? this.now(),
    });
    if (parsed.roleMode === 'primary' && parsed.characterId !== this.primaryCharacterId) {
      this.primaryCharacterId = parsed.characterId;
    }
    const state = this.initialState(parsed);
    this.states.set(parsed.characterId, state);
    this.events.publish('character:registered', { character: state }, {
      source: 'character-core',
      characterId: parsed.characterId,
    });
    return structuredClone(state);
  }

  get(characterId: string): CharacterRuntimeState {
    const state = this.states.get(characterId);
    if (!state) {
      throw new WhaleError('CHARACTER_NOT_FOUND', `未找到角色：${characterId}`, {
        recoverable: true,
        context: { characterId },
      });
    }
    return structuredClone(state);
  }

  primaryState(): CharacterRuntimeState {
    return this.get(this.primaryCharacterId);
  }

  list(): CharacterRuntimeState[] {
    return [...this.states.values()].map((state) => structuredClone(state));
  }

  setExpression(characterId: string, expression: ExpressionState, reason?: string): CharacterRuntimeState {
    const state = this.mustMutable(characterId);
    const parsed = ExpressionStateSchema.parse(expression);
    const prev = state.expression;
    state.expression = parsed;
    state.lastEventAt = this.now();
    this.events.publish(
      'character:expression',
      { prev, next: parsed, ...(reason === undefined ? {} : { reason }) },
      { source: 'character-core', characterId },
    );
    return structuredClone(state);
  }

  updateMood(
    characterId: string,
    patch: Partial<Pick<MoodState, 'valence' | 'arousal' | 'label'>>,
  ): CharacterRuntimeState {
    const state = this.mustMutable(characterId);
    const t = this.now();
    state.mood = MoodStateSchema.parse({
      valence: patch.valence ?? state.mood.valence,
      arousal: patch.arousal ?? state.mood.arousal,
      label: patch.label ?? state.mood.label,
      updatedAt: t,
    });
    state.lastEventAt = t;
    this.events.publish('character:mood', { mood: state.mood }, {
      source: 'character-core',
      characterId,
    });
    return structuredClone(state);
  }

  setControlMode(characterId: string, mode: ControlMode, reason?: string): CharacterRuntimeState {
    const state = this.mustMutable(characterId);
    const parsed = ControlModeSchema.parse(mode);
    const prev = state.controlMode;
    state.controlMode = parsed;
    state.lastEventAt = this.now();
    this.events.publish(
      'character:control-mode',
      { prev, next: parsed, ...(reason === undefined ? {} : { reason }) },
      { source: 'character-core', characterId },
    );
    return structuredClone(state);
  }

  setActiveGoal(characterId: string, goal: string | null): CharacterRuntimeState {
    const state = this.mustMutable(characterId);
    state.activeGoal = goal === null ? null : goal.trim().slice(0, 200);
    state.lastEventAt = this.now();
    this.events.publish('character:goal', { activeGoal: state.activeGoal }, {
      source: 'character-core',
      characterId,
    });
    return structuredClone(state);
  }

  /** P0 紧急停止：立即切入 manual_takeover，强制表达式回到 idle 并广播急停事件 */
  emergencyHalt(reason = '用户触发紧急停止', characterId = this.primaryCharacterId): CharacterRuntimeState {
    const state = this.mustMutable(characterId);
    state.halted = true;
    state.haltReason = reason;
    state.controlMode = 'manual_takeover';
    state.expression = 'idle';
    state.lastEventAt = this.now();
    this.events.publish('character:halt', { reason, halted: true }, {
      source: 'character-core',
      characterId,
    });
    return structuredClone(state);
  }

  resume(mode: ControlMode = 'autonomous', characterId = this.primaryCharacterId): CharacterRuntimeState {
    const state = this.mustMutable(characterId);
    state.halted = false;
    state.haltReason = null;
    state.controlMode = ControlModeSchema.parse(mode);
    state.lastEventAt = this.now();
    this.events.publish('character:resume', { mode: state.controlMode }, {
      source: 'character-core',
      characterId,
    });
    return structuredClone(state);
  }

  private mustMutable(characterId: string): CharacterRuntimeState {
    const state = this.states.get(characterId);
    if (!state) {
      throw new WhaleError('CHARACTER_NOT_FOUND', `未找到角色：${characterId}`, {
        recoverable: true,
        context: { characterId },
      });
    }
    return state;
  }
}
