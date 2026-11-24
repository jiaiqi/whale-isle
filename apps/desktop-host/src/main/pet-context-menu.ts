/**
 * 桌宠原生右键菜单模板构建（参考 dsh-pet 右键菜单并融合鲸屿特色能力）。
 *
 * 纯函数实现，不直接依赖 Electron 运行时，便于确定性单测；
 * 主进程拿到模板后直接交给 `Menu.buildFromTemplate(template).popup({ window })` 弹出，
 * 彻底突破 400×284 透明窗边界，原生适配 macOS / Windows 11 深浅主题与子菜单。
 */

export interface PetContextMenuItem {
  label?: string;
  type?: 'normal' | 'separator' | 'checkbox' | 'radio';
  enabled?: boolean;
  checked?: boolean;
  submenu?: PetContextMenuItem[];
  click?: () => void;
}

export interface PetContextMenuActionOption {
  actionState: string;
  label: string;
}

export interface PetContextMenuCharacterOption {
  id: string;
  displayName: string;
}

export type PetContextMenuWindowLayer = 'always' | 'follow-ai' | 'normal';

export interface PetContextMenuState {
  agentId: string;
  isDefault: boolean;
  characterId: string;
  characterName: string;
  asleep: boolean;
  locked: boolean;
  /** T-M6-63：桌宠窗口显示层级（原生菜单可直接切换，不需要 HTML 二级面板） */
  windowLayer: PetContextMenuWindowLayer;
  availableActions: PetContextMenuActionOption[];
  hasAmbientPool: boolean;
  /** 可用于主宠快切的角色列表（自定义置前 + 随包 9 角色） */
  switchableCharacters: PetContextMenuCharacterOption[];
  /** 可召唤同屏的其他角色列表 */
  summonableCharacters: PetContextMenuCharacterOption[];
  onlinePetCount: number;
  autodriveRunning: boolean;
  gameLabel: string;
  riceBalance: number;
  riceBudget: number;
  voiceEnabled: boolean;
  sfxEnabled: boolean;
  webuiUrl: string | null;
}

export interface PetContextMenuHandlers {
  onPat(): void;
  onPoke(): void;
  onPlayAction(actionState: string): void;
  onPlayRandomAmbient(): void;
  onOpenQuickChat(): void;
  onToggleSleep(): void;
  onSwitchCharacter(characterId: string): void;
  onSummonCharacter(characterId: string): void;
  onAssemble(): void;
  onDismissOthers(): void;
  onPairChat(): void;
  onSummonEgg(): void;
  /** T-M6-65：双宠彩蛋小剧场（专属 host/hostSkin 优先，无素材回退随机召唤） */
  onStartEggTheater(): void;
  /** T-M6-63：三档显示层级 */
  onSetWindowLayer(layer: PetContextMenuWindowLayer): void;
  onToggleAutodrive(): void;
  onFeedRice(): void;
  onSyncStardewAvatar(): void;
  onToggleLock(): void;
  onDock(edge: 'left' | 'right' | null): void;
  onResetPosition(): void;
  onHideAllPets(): void;
  onToggleVoice(): void;
  onToggleSfx(): void;
  onOpenDirector(): void;
  onOpenNotebook(): void;
  onOpenCreator(): void;
  onOpenBench(): void;
  onReloadCharacters(): void;
  onCopyWebuiUrl(): void;
  onDismissSelf(): void;
  onQuit(): void;
}

export const ACTION_STATE_LABELS: Record<string, string> = {
  idle: '待机呼吸',
  walk: '走动巡逻',
  eat_rice: '干饭开吃',
  happy_maid: '开心跳舞',
  thinking_tail_wag: '思考冒泡',
  rage_spray: '傲娇生气',
  clumsy_panic: '慌张失措',
  game_focus: '认真打游戏',
  sing_stage: '舞台唱歌',
  hungry_lazy: '懒洋洋摸鱼',
  sleep_mute: '安静入睡',
};

export function labelForActionState(actionState: string): string {
  return ACTION_STATE_LABELS[actionState] ?? actionState;
}

function buildActionSubmenu(
  state: PetContextMenuState,
  handlers: PetContextMenuHandlers,
): PetContextMenuItem[] {
  const items: PetContextMenuItem[] = state.availableActions.map((item) => ({
    label: item.label,
    click: () => handlers.onPlayAction(item.actionState),
  }));
  if (state.hasAmbientPool) {
    if (items.length > 0) items.push({ type: 'separator' });
    items.push({
      label: '随机播一条氛围动作',
      click: () => handlers.onPlayRandomAmbient(),
    });
  }
  if (items.length === 0) {
    items.push({ label: '暂无可用动作', enabled: false });
  }
  return items;
}

function buildDockSubmenu(handlers: PetContextMenuHandlers): PetContextMenuItem[] {
  return [
    { label: '贴到屏幕左侧', click: () => handlers.onDock('left') },
    { label: '贴到屏幕右侧', click: () => handlers.onDock('right') },
    { type: 'separator' },
    { label: '取消贴边', click: () => handlers.onDock(null) },
  ];
}

/** T-M6-63：三档显示层级（always / follow-ai / normal），原生 radio 子菜单。 */
function buildWindowLayerSubmenu(
  state: PetContextMenuState,
  handlers: PetContextMenuHandlers,
): PetContextMenuItem[] {
  return [
    { label: '始终置顶', type: 'radio', checked: state.windowLayer === 'always', click: () => handlers.onSetWindowLayer('always') },
    { label: 'AI 干活时置顶', type: 'radio', checked: state.windowLayer === 'follow-ai', click: () => handlers.onSetWindowLayer('follow-ai') },
    { label: '普通层级', type: 'radio', checked: state.windowLayer === 'normal', click: () => handlers.onSetWindowLayer('normal') },
  ];
}

export function buildPetContextMenuTemplate(
  state: PetContextMenuState,
  handlers: PetContextMenuHandlers,
): PetContextMenuItem[] {
  const ricePct = state.riceBudget > 0
    ? Math.max(0, Math.min(100, Math.round((state.riceBalance / state.riceBudget) * 100)))
    : 0;

  if (!state.isDefault) {
    return [
      { label: `${state.characterName} · 桌面伙伴${state.asleep ? '（睡眠中）' : ''}`, enabled: false },
      { type: 'separator' },
      { label: '摸摸头', click: () => handlers.onPat() },
      { label: '戳一下', click: () => handlers.onPoke() },
      { label: '换个动作', submenu: buildActionSubmenu(state, handlers) },
      { label: state.asleep ? '叫醒她' : '安静入睡', click: () => handlers.onToggleSleep() },
      { type: 'separator' },
      { label: '锁定位置', type: 'checkbox', checked: state.locked, click: () => handlers.onToggleLock() },
      { label: '显示层级', submenu: buildWindowLayerSubmenu(state, handlers) },
      { label: '贴边停靠', submenu: buildDockSubmenu(handlers) },
      { label: '让这位先回去', click: () => handlers.onDismissSelf() },
      { type: 'separator' },
      { label: '我们的小本子', click: () => handlers.onOpenNotebook() },
      { label: '打开中控台', click: () => handlers.onOpenDirector() },
    ];
  }

  const switchSubmenu: PetContextMenuItem[] = state.switchableCharacters.length > 0
    ? state.switchableCharacters.map((character) => ({
        label: character.displayName,
        type: 'radio',
        checked: character.id === state.characterId,
        click: () => handlers.onSwitchCharacter(character.id),
      }))
    : [{ label: '暂无可切换角色', enabled: false }];

  const summonSubmenu: PetContextMenuItem[] = state.summonableCharacters.length > 0
    ? state.summonableCharacters.map((character) => ({
        label: character.displayName,
        click: () => handlers.onSummonCharacter(character.id),
      }))
    : [{ label: '暂无可召唤伙伴', enabled: false }];

  return [
    { label: `${state.characterName}${state.asleep ? ' · 安静睡眠中' : ''}`, enabled: false },
    { type: 'separator' },
    { label: '摸摸头', click: () => handlers.onPat() },
    { label: '戳一下', click: () => handlers.onPoke() },
    { label: '换个动作', submenu: buildActionSubmenu(state, handlers) },
    { label: '聊一句（快捷浮窗）', click: () => handlers.onOpenQuickChat() },
    { label: state.asleep ? '叫醒她' : '安静入睡', click: () => handlers.onToggleSleep() },
    { type: 'separator' },
    { label: '切换主桌宠', submenu: switchSubmenu },
    { label: '叫她出来同屏', submenu: summonSubmenu },
    {
      label: '多宠互动',
      submenu: [
        { label: '集合排排站', click: () => handlers.onAssemble() },
        { label: '让她们聊两句', enabled: state.onlinePetCount >= 2, click: () => handlers.onPairChat() },
        { label: '彩蛋小剧场（专属优先）', click: () => handlers.onStartEggTheater() },
        { label: '随机召唤串门彩蛋', click: () => handlers.onSummonEgg() },
        { type: 'separator' },
        { label: '解散其他桌宠', enabled: state.onlinePetCount > 1, click: () => handlers.onDismissOthers() },
      ],
    },
    { type: 'separator' },
    {
      label: state.autodriveRunning
        ? `停止自驾 · ${state.gameLabel}`
        : `启动自驾 · ${state.gameLabel}`,
      click: () => handlers.onToggleAutodrive(),
    },
    {
      label: `喂一碗饭 +10,000 粒（余量 ${ricePct}%）`,
      click: () => handlers.onFeedRice(),
    },
    {
      label: '同步当前形象到星露谷',
      click: () => handlers.onSyncStardewAvatar(),
    },
    { type: 'separator' },
    { label: '锁定位置', type: 'checkbox', checked: state.locked, click: () => handlers.onToggleLock() },
    { label: '显示层级', submenu: buildWindowLayerSubmenu(state, handlers) },
    { label: '贴边停靠', submenu: buildDockSubmenu(handlers) },
    { label: '回到默认位置', click: () => handlers.onResetPosition() },
    { label: '暂藏全部桌宠', click: () => handlers.onHideAllPets() },
    {
      label: '声音开关',
      submenu: [
        { label: '语音播报', type: 'checkbox', checked: state.voiceEnabled, click: () => handlers.onToggleVoice() },
        { label: '动作原声', type: 'checkbox', checked: state.sfxEnabled, click: () => handlers.onToggleSfx() },
      ],
    },
    { type: 'separator' },
    { label: '打开中控台', click: () => handlers.onOpenDirector() },
    { label: '我们的小本子', click: () => handlers.onOpenNotebook() },
    { label: '创作中心', click: () => handlers.onOpenCreator() },
    { label: '桌宠验收台', click: () => handlers.onOpenBench() },
    { label: '重新载入角色', click: () => handlers.onReloadCharacters() },
    { label: '复制 WebUI 地址', enabled: state.webuiUrl !== null, click: () => handlers.onCopyWebuiUrl() },
    { type: 'separator' },
    { label: '退出鲸屿', click: () => handlers.onQuit() },
  ];
}
