import { describe, expect, it, vi } from 'vitest';
import {
  buildPetContextMenuTemplate,
  labelForActionState,
  type PetContextMenuHandlers,
  type PetContextMenuState,
} from './pet-context-menu';

function makeHandlers(): PetContextMenuHandlers {
  return {
    onPat: vi.fn(),
    onPoke: vi.fn(),
    onPlayAction: vi.fn(),
    onPlayRandomAmbient: vi.fn(),
    onOpenQuickChat: vi.fn(),
    onToggleSleep: vi.fn(),
    onSwitchCharacter: vi.fn(),
    onSummonCharacter: vi.fn(),
    onAssemble: vi.fn(),
    onDismissOthers: vi.fn(),
    onPairChat: vi.fn(),
    onSummonEgg: vi.fn(),
    onStartEggTheater: vi.fn(),
    onSetWindowLayer: vi.fn(),
    onToggleAutodrive: vi.fn(),
    onFeedRice: vi.fn(),
    onSyncStardewAvatar: vi.fn(),
    onToggleLock: vi.fn(),
    onDock: vi.fn(),
    onResetPosition: vi.fn(),
    onHideAllPets: vi.fn(),
    onToggleVoice: vi.fn(),
    onToggleSfx: vi.fn(),
    onOpenDirector: vi.fn(),
    onOpenNotebook: vi.fn(),
    onOpenCreator: vi.fn(),
    onOpenBench: vi.fn(),
    onReloadCharacters: vi.fn(),
    onCopyWebuiUrl: vi.fn(),
    onDismissSelf: vi.fn(),
    onQuit: vi.fn(),
  };
}

function makeState(overrides: Partial<PetContextMenuState> = {}): PetContextMenuState {
  return {
    agentId: 'default',
    isDefault: true,
    characterId: 'aboutme-kimi',
    characterName: '小星',
    asleep: false,
    locked: false,
    windowLayer: 'always',
    availableActions: [
      { actionState: 'idle', label: '待机呼吸' },
      { actionState: 'happy_maid', label: '开心跳舞' },
    ],
    hasAmbientPool: true,
    switchableCharacters: [
      { id: 'aboutme-kimi', displayName: '小星' },
      { id: 'aboutme-dsh', displayName: '蓝蓝' },
    ],
    summonableCharacters: [
      { id: 'aboutme-dsh', displayName: '蓝蓝' },
    ],
    onlinePetCount: 1,
    autodriveRunning: false,
    gameLabel: '星露谷物语',
    riceBalance: 195_000,
    riceBudget: 500_000,
    voiceEnabled: true,
    sfxEnabled: false,
    webuiUrl: 'ready',
    ...overrides,
  };
}

describe('pet-context-menu', () => {
  it('主桌宠菜单包含互动、点播动作、切角勾选态、多宠互动、游戏自驾、饭碗、星露谷同步与工坊入口', () => {
    const handlers = makeHandlers();
    const menu = buildPetContextMenuTemplate(makeState(), handlers);

    expect(menu[0]).toMatchObject({ label: '小星', enabled: false });
    expect(menu.find((item) => item.label === '退出鲸屿')).toBeDefined();
    expect(menu.find((item) => item.label === '启动自驾 · 星露谷物语')).toBeDefined();
    expect(menu.find((item) => item.label === '喂一碗饭 +10,000 粒（余量 39%）')).toBeDefined();
    expect(menu.find((item) => item.label === '同步当前形象到星露谷')).toBeDefined();

    const switchMenu = menu.find((item) => item.label === '切换主桌宠')?.submenu ?? [];
    expect(switchMenu.find((item) => item.label === '小星')).toMatchObject({ type: 'radio', checked: true });
    expect(switchMenu.find((item) => item.label === '蓝蓝')).toMatchObject({ type: 'radio', checked: false });
    switchMenu.find((item) => item.label === '蓝蓝')?.click?.();
    expect(handlers.onSwitchCharacter).toHaveBeenCalledWith('aboutme-dsh');

    const actionMenu = menu.find((item) => item.label === '换个动作')?.submenu ?? [];
    actionMenu.find((item) => item.label === '开心跳舞')?.click?.();
    actionMenu.find((item) => item.label === '随机播一条氛围动作')?.click?.();
    expect(handlers.onPlayAction).toHaveBeenCalledWith('happy_maid');
    expect(handlers.onPlayRandomAmbient).toHaveBeenCalledOnce();

    const multiMenu = menu.find((item) => item.label === '多宠互动')?.submenu ?? [];
    expect(multiMenu.find((item) => item.label === '让她们聊两句')?.enabled).toBe(false);
    expect(multiMenu.find((item) => item.label === '解散其他桌宠')?.enabled).toBe(false);
    multiMenu.find((item) => item.label === '彩蛋小剧场（专属优先）')?.click?.();
    expect(handlers.onStartEggTheater).toHaveBeenCalledOnce();

    const layerMenu = menu.find((item) => item.label === '显示层级')?.submenu ?? [];
    expect(layerMenu.find((item) => item.label === '始终置顶')).toMatchObject({ type: 'radio', checked: true });
    expect(layerMenu.find((item) => item.label === '普通层级')).toMatchObject({ type: 'radio', checked: false });
    layerMenu.find((item) => item.label === '普通层级')?.click?.();
    expect(handlers.onSetWindowLayer).toHaveBeenCalledWith('normal');

    const soundMenu = menu.find((item) => item.label === '声音开关')?.submenu ?? [];
    expect(soundMenu.find((item) => item.label === '语音播报')).toMatchObject({ type: 'checkbox', checked: true });
    expect(soundMenu.find((item) => item.label === '动作原声')).toMatchObject({ type: 'checkbox', checked: false });
    soundMenu.find((item) => item.label === '语音播报')?.click?.();
    expect(handlers.onToggleVoice).toHaveBeenCalledOnce();
  });

  it('睡眠态、多宠在线态与自驾运行态文案及可用性实时切换', () => {
    const handlers = makeHandlers();
    const menu = buildPetContextMenuTemplate(makeState({
      asleep: true,
      locked: true,
      onlinePetCount: 2,
      autodriveRunning: true,
      webuiUrl: null,
    }), handlers);

    expect(menu[0]?.label).toContain('安静睡眠中');
    expect(menu.find((item) => item.label === '叫醒她')).toBeDefined();
    expect(menu.find((item) => item.label === '停止自驾 · 星露谷物语')).toBeDefined();
    expect(menu.find((item) => item.label === '锁定位置')).toMatchObject({ type: 'checkbox', checked: true });
    expect(menu.find((item) => item.label === '复制 WebUI 地址')?.enabled).toBe(false);

    const multiMenu = menu.find((item) => item.label === '多宠互动')?.submenu ?? [];
    expect(multiMenu.find((item) => item.label === '让她们聊两句')?.enabled).toBe(true);
    expect(multiMenu.find((item) => item.label === '解散其他桌宠')?.enabled).toBe(true);
    multiMenu.find((item) => item.label === '让她们聊两句')?.click?.();
    expect(handlers.onPairChat).toHaveBeenCalledOnce();
  });

  it('副宠右键为精简菜单：含让这位先回去，不含退出鲸屿', () => {
    const handlers = makeHandlers();
    const menu = buildPetContextMenuTemplate(makeState({
      agentId: 'pet-2',
      isDefault: false,
      characterId: 'aboutme-dsh',
      characterName: '蓝蓝',
    }), handlers);

    expect(menu[0]?.label).toContain('蓝蓝 · 桌面伙伴');
    expect(menu.find((item) => item.label === '退出鲸屿')).toBeUndefined();
    const dismiss = menu.find((item) => item.label === '让这位先回去');
    expect(dismiss).toBeDefined();
    dismiss?.click?.();
    expect(handlers.onDismissSelf).toHaveBeenCalledOnce();
  });

  it('动作槽位中文名映射与空动作兜底', () => {
    expect(labelForActionState('eat_rice')).toBe('干饭开吃');
    expect(labelForActionState('custom_pose')).toBe('custom_pose');
    const menu = buildPetContextMenuTemplate(makeState({ availableActions: [], hasAmbientPool: false }), makeHandlers());
    const actionMenu = menu.find((item) => item.label === '换个动作')?.submenu ?? [];
    expect(actionMenu).toEqual([{ label: '暂无可用动作', enabled: false }]);
  });
});
