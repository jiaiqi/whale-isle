/**
 * 桌宠控制宿主（T-M6-51 拆分自 index.ts）。
 *
 * 职责：多宠召唤/集合/解散/彩蛋、对外 `petControlApi`（state/say/action）、
 * 相关 IPC 注册。依赖全部以 getter 注入，避免 index.ts 的初始化顺序耦合。
 */
import { ipcMain } from 'electron';
import type { PetCharacter, PetDesktopPrefs } from '@workbench/shared-protocol';
import { PetApiStateSchema } from '@workbench/shared-protocol';
import type { PetWindowManager } from './pet-window-manager';
import type { CharacterRegistry } from './character-registry';
import type { VoiceHost } from './voice-host';
import type { VoiceBindingStore } from './voice-bindings';
import { readCrossPetCharacters } from './pet-packs';

/**
 * CrossPet 角色的夜间睡衣变体映射（基础角色 → `*-pajamas`）。
 * 单一事实源：夜间换装（nightOutfit）与「同角色不并存」校验共用，避免两套正则漂移。
 */
export function pajamaVariantOf(characterId: string): string {
  return characterId.replace(/^crosspet-(deepseek|claude|gemini|gpt)$/, 'crosspet-$1-pajamas');
}

/**
 * 角色「家族」：基础角色与睡衣变体视为同一角色，绝不能同时在场。
 * 双向归一：无论传入 `crosspet-claude` 还是 `crosspet-claude-pajamas`，
 * 都得到同一个 {基础, 睡衣} 集合，避免「白天占基础、夜里开睡衣」绕过校验。
 */
export function characterFamilyOf(characterId: string): Set<string> {
  const base = characterId.replace(/-pajamas$/, '');
  return new Set([characterId, base, pajamaVariantOf(base)]);
}

/**
 * 同角色不并存：返回除 `exceptAgentId` 外、已经占用该角色（含睡衣变体）的窗口。
 * 所有「窗口取得/换成某角色」的入口都应收口到这一个判定。
 */
export function findCharacterHolder<T extends { agentId: string; characterId: string }>(
  views: readonly T[],
  characterId: string,
  options: { exceptAgentId?: string } = {},
): T | undefined {
  const family = characterFamilyOf(characterId);
  return views.find(
    (view) => view.agentId !== options.exceptAgentId && family.has(view.characterId),
  );
}

/**
 * 按角色找桌宠窗：夜间工作跟随会 summon `*-pajamas` 皮肤角色，
 * session.characterId 仍是基础角色，必须同时匹配睡衣变体（T-M6-54）。
 */
export function matchPetViewForCharacter<T extends { characterId: string }>(
  views: readonly T[],
  characterId: string,
  nightOutfit: (id: string) => string,
): T | undefined {
  return views.find((view) => view.characterId === characterId)
    ?? views.find((view) => view.characterId === nightOutfit(characterId));
}

/** 统一校验结果：ok=false 时 error 可直接回给调用方/渲染层展示。 */
export type CharacterAvailability =
  | { ok: true }
  | { ok: false; error: string; conflictAgentId?: string };

export interface PetControlHost {
  /** 召唤（含夜间睡衣解析）；已存在则聚焦并返回原 agentId。 */
  summonPet(characterId: string): Promise<{ ok: boolean; agentId?: string; error?: string }>;
  /** 随机 summon 一只 egg-* 串门彩蛋（验收台/右键共用）。 */
  summonEgg(): Promise<{ ok: boolean; agentId?: string; characterId?: string; name?: string; error?: string }>;
  /**
   * 同角色不并存校验（所有「窗口取得/换成某角色」入口统一收口）。
   * 角色不存在或已被别的窗口占用（含睡衣变体）时返回可读错误。
   */
  assertCharacterAvailable(characterId: string, options?: { exceptAgentId?: string }): CharacterAvailability;
  /** 对外本机驱动口（WebUI /api/pet 与插件 pet:control 共用） */
  petControlApi: {
    state(agentId: string): ReturnType<typeof PetApiStateSchema.parse> | null;
    say(agentId: string, text: string, request: { scene: 'normal' | 'inner' | 'p0'; wake: boolean }): { ok: boolean; error?: string };
    action(agentId: string, actionState: string, durationMs: number): { ok: boolean; error?: string };
  };
  /** 闲置退场等内部调用：关闭某个 agent 的桌宠窗 */
  closeAgent(agentId: string): boolean;
  /** 夜间睡衣解析（工作跟随单宠换装复用同一规则） */
  nightOutfit(characterId: string, hour?: number): string;
  /** 按姿态名直放（工作跟随代理/验收台；缺失回退由调用方先解析） */
  pose(agentId: string, pose: string, line?: string, source?: 'work-follow' | 'bench'): boolean;
  registerIpc(): void;
}

export function createPetControlHost(options: {
  manager: () => PetWindowManager | null;
  characters: () => CharacterRegistry;
  /** 随包 CrossPet 角色（夜间睡衣/彩蛋选择用；注入便于测试） */
  crossPetCharacters: () => PetCharacter[];
  /** userData 自定义角色里 egg:true 的彩蛋（与 CrossPet egg-* 一起随机串门） */
  customEggs?: () => PetCharacter[];
  getPrefs: () => PetDesktopPrefs;
  switchDefaultCharacter: (id: string) => void;
  voice: () => VoiceHost | null;
  voiceBindings: () => VoiceBindingStore | null;
  asleepAgents: Set<string>;
  openNotebook: () => void;
}): PetControlHost {
  /** 夜间 22:00–07:00 自动换睡衣：CrossPet 基础角色有对应皮肤时优先。 */
  const nightOutfit = (characterId: string, hour = new Date().getHours()): string => {
    if (hour >= 22 || hour < 7) {
      const pajamas = options.crossPetCharacters().find(
        (character) => character.id === pajamaVariantOf(characterId),
      );
      if (pajamas !== undefined) return pajamas.id;
    }
    return characterId;
  };

  /** 角色是否在注册表里（未同步的 crosspet-* 绝不能开成一只「假桌宠」）。 */
  const characterExists = (characterId: string): boolean =>
    options.characters().list().some((character) => character.id === characterId);

  const assertCharacterAvailable: PetControlHost['assertCharacterAvailable'] = (characterId, opts = {}) => {
    const manager = options.manager();
    if (manager === null) return { ok: false, error: '桌宠窗未就绪' };
    if (!characterExists(characterId)) return { ok: false, error: `角色不存在：${characterId}` };
    const holder = findCharacterHolder(manager.list(), characterId, { exceptAgentId: opts.exceptAgentId });
    if (holder !== undefined) {
      return { ok: false, error: `该角色已在场（${holder.agentId}），不能重复出现`, conflictAgentId: holder.agentId };
    }
    return { ok: true };
  };

  const summonPet = async (characterId: string): Promise<{ ok: boolean; agentId?: string; error?: string }> => {
    const manager = options.manager();
    if (manager === null) return { ok: false, error: '桌宠窗未就绪' };
    const target = nightOutfit(characterId);
    // 角色必须真实存在：work-follow 的 multi 模式按 AI 来源映射 crosspet-*，
    // 素材包未同步时这些 id 不在注册表，过去会开出一只「渲染成主宠的假桌宠」。
    if (!characterExists(target)) return { ok: false, error: `角色不存在：${target}` };
    // 同角色不并存（含睡衣变体）：已有一只在场就聚焦它，绝不新开第二只。
    const existing = findCharacterHolder(manager.list(), target);
    if (existing !== undefined) {
      manager.sendAgent(existing.agentId, 'pet:summoned');
      return { ok: true, agentId: existing.agentId };
    }
    const agentId = `pet-${target.replace(/[^A-Za-z0-9._-]/g, '').slice(-24)}-${Date.now().toString(36).slice(-4)}`;
    const opened = await manager.open(agentId, target);
    if (!opened.ok) return { ok: false, error: opened.error ?? '桌宠窗未就绪' };
    manager.assemble(manager.list().map((view) => view.agentId));
    return { ok: true, agentId };
  };

  const summonEgg = async (): Promise<{ ok: boolean; agentId?: string; characterId?: string; name?: string; error?: string }> => {
    const eggs = [
      ...options.crossPetCharacters().filter((character) => character.displayName.includes('串门彩蛋')),
      ...(options.customEggs?.() ?? []),
    ];
    if (eggs.length === 0) return { ok: false, error: '未找到彩蛋素材（CrossPet 串门彩蛋或 userData 里 egg:true 的自定义角色）' };
    const egg = eggs[Math.floor(Math.random() * eggs.length)]!;
    const result = await summonPet(egg.id);
    return result.ok ? { ok: true, agentId: result.agentId, characterId: egg.id, name: egg.displayName } : result;
  };

  const characterOf = (agentId: string): PetCharacter | undefined => {
    const view = options.manager()?.get(agentId);
    if (view === undefined || view === null) return undefined;
    return options.characters().list().find((item) => item.id === view.characterId);
  };

  const petControlApi: PetControlHost['petControlApi'] = {
    state(agentId) {
      const view = options.manager()?.get(agentId);
      if (view === undefined || view === null) return null;
      const character = characterOf(agentId);
      return PetApiStateSchema.parse({
        agentId: view.agentId,
        characterId: view.characterId,
        displayName: character?.displayName ?? '',
        sleeping: options.asleepAgents.has(view.agentId),
        speaking: false,
        visible: view.visible,
        bounds: view.bounds,
      });
    },
    say(agentId, text, request) {
      const manager = options.manager();
      const view = manager?.get(agentId);
      if (manager === null || view === undefined || view === null) return { ok: false, error: `桌宠不存在：${agentId}` };
      if (options.asleepAgents.has(agentId) && !request.wake) return { ok: false, error: '桌宠正在安静睡眠（wake=true 可叫醒）' };
      if (request.wake) {
        options.asleepAgents.delete(agentId);
        manager.sendAgent(agentId, 'pet:wake');
      }
      const character = characterOf(agentId);
      const voice = options.voice();
      const bindings = options.voiceBindings();
      void voice?.speak({
        text,
        scene: request.scene,
        agentId,
        ...(character === undefined ? {} : {
          characterId: character.id,
          speakerName: character.displayName,
          voiceId: (bindings?.resolve(character.id) ?? character.voiceId),
          ratePercent: character.voiceRatePercent,
          pitchMul: character.voicePitchMul,
        }),
      });
      manager.sendAgent(agentId, 'pet:say', { text });
      return { ok: true };
    },
    action(agentId, actionState, durationMs) {
      const manager = options.manager();
      const view = manager?.get(agentId);
      if (manager === null || view === undefined || view === null) return { ok: false, error: `桌宠不存在：${agentId}` };
      manager.sendAgent(agentId, 'pet:preview', { action: actionState, clipId: null });
      setTimeout(() => manager.sendAgent(agentId, 'pet:preview', { action: 'idle', clipId: null }), Math.max(500, Math.min(60_000, durationMs)));
      return { ok: true };
    },
  };

  const host: PetControlHost = {
    summonPet,
    summonEgg,
    assertCharacterAvailable,
    petControlApi,
    closeAgent: (agentId) => options.manager()?.close(agentId) ?? false,
    nightOutfit,
    pose(agentId, pose, line, source) {
      const manager = options.manager();
      const view = manager?.get(agentId);
      if (manager === null || view === undefined || view === null) return false;
      manager.sendAgent(agentId, 'pet:pose', {
        pose,
        ...(line === undefined || line === '' ? {} : { line }),
        ...(source === undefined ? {} : { source }),
      });
      return true;
    },
    registerIpc() {
      ipcMain.handle('pet:summon', async (_event, characterId: string) => summonPet(String(characterId)));
      ipcMain.handle('pet:flee', (_event, agentId: string) => {
        const view = options.manager()?.get(String(agentId));
        if (view === undefined || view === null) return { ok: false };
        const fled = options.manager()?.close(view.agentId) ?? false;
        return { ok: fled, fled };
      });
      ipcMain.handle('pet:assemble', () => {
        const manager = options.manager();
        const ids = manager?.list().map((view) => view.agentId) ?? [];
        return { ok: true, windows: manager?.assemble(ids) ?? [] };
      });
      ipcMain.handle('pet:dismiss', () => ({ ok: true, closed: options.manager()?.dismissAll('default') ?? 0 }));
      ipcMain.handle('pet:open-notebook', () => {
        options.openNotebook();
        return { ok: true };
      });
      ipcMain.handle('pet:egg-summon', () => summonEgg());
    },
  };
  return host;
}

export { readCrossPetCharacters };
