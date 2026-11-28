/**
 * Obsidian Tide 三游戏共玩与星露谷监控工作区（从 App.tsx Strangler 拆出）
 * 保留所有既有 E2E 选择器（[data-game-panel] / [data-game-select] / [data-game-subtab] / [data-mods-page] 等）。
 */
import { Brain, Monitor, ShieldCheck, Target, Zap } from 'lucide-react';
import { GAME_OPTIONS, type AutodriveEventView, type GameHealthView, type GameId, type StardewLaunchPrefsView } from '../bridge';
import { ModsPanel } from '../mods-panel';
import { TerrariaPanel } from '../terraria-panel';
import { DstPanel, type DstPanelEvent } from '../dst-panel';
import {
  GameConnectionBanner,
  GameCurrentActionCard,
  GameDecisionTimeline,
  GameDiagnostics,
  GameGoalChain,
  GameMetricsCard,
  GameQualityCard,
  GameQuickCommands,
  GameReceiptTimeline,
  type ReceiptFilter,
} from '../game-panel';

export const STARDEW_GOALS = ['读信 / 浇水 / 播种', '11:00 海滩钓鱼', '17:30 镇上采集', '18:30 前回家', '睡觉防晕倒'] as const;
export const STARDEW_QUICK: ReadonlyArray<readonly [string, string]> = [
  ['钓鱼', '/fish 5'],
  ['去海滩', '/goto Beach'],
  ['睡觉', '/sleep'],
  ['汇报状态', '/state'],
];

export interface AvatarSyncViewState {
  enabled: boolean;
  liveliness: boolean;
  modInstalled: boolean;
  modCompiled: boolean;
  modNeedsUpdate: boolean;
  syncedCharacterId: string | null;
  syncedDisplayName: string | null;
  syncedSpriteReady: boolean;
  syncedSpriteTier: '1x' | '2x' | '4x' | null;
  syncedSpriteSize: { width: number; height: number } | null;
}

export interface GameWorkspaceViewProps {
  activeGame: GameId;
  gameSubtab: 'monitor' | 'mods';
  gameEnabled: Record<GameId, boolean>;
  modsEnabled: boolean;
  events: AutodriveEventView[];
  running: boolean;
  brainMode: string;
  guidesCount: number;
  objective: string | null;
  chatFilter: ReceiptFilter;
  bwfHud: boolean;
  dockToGame?: boolean;
  bwfPort: number;
  editingBwfPort: boolean;
  bwfPortDraft: string;
  avatarSync: AvatarSyncViewState | null;
  stardewPrefs?: StardewLaunchPrefsView | null;
  onLaunchPrefsChanged?: (prefs: StardewLaunchPrefsView) => void;
  dayPlan: {
    dayKey: string;
    items: Array<{ goal: string; why: string; status: string; addedAt?: string; completedAt?: string }>;
    mood?: string;
    updateWhy?: string;
    history?: Array<{ atClock: string; atTs: number; kind: 'morning' | 'update'; summary: string; why?: string }>;
  } | null;
  insights: Array<{ id: string; source: string; claim: string; when: string; verdict: string; why: string; hits: number; updatedDay: string }>;
  stardewHealth: { report: GameHealthView | null; probing: boolean; reprobe: () => void };
  sessionId: string | undefined;
  onSelectGame: (gameId: GameId) => void;
  onSetGameSubtab: (sub: 'monitor' | 'mods') => void;
  onSetChatFilter: (filter: ReceiptFilter) => void;
  onToggleBwfHud: () => void;
  onToggleDockToGame?: () => void;
  onSetEditingBwfPort: (editing: boolean) => void;
  onSetBwfPortDraft: (draft: string) => void;
  onSaveBwfPort: () => void;
  onToggleAvatarSync: () => void;
  onToggleAvatarLiveliness: () => void;
  onInstallAvatarMod: () => void;
  onUninstallAvatarMod: () => void;
  onSyncAvatarNow: () => void;
  onOpenPixelCreator: () => void;
  onCancelObjective: () => void;
  onSendText: (text: string) => void;
}

export function GameWorkspaceView(props: GameWorkspaceViewProps): React.JSX.Element {
  const {
    activeGame,
    gameSubtab,
    gameEnabled,
    modsEnabled,
    events,
    running,
    brainMode,
    guidesCount,
    objective,
    chatFilter,
    bwfHud,
    dockToGame = true,
    bwfPort,
    editingBwfPort,
    bwfPortDraft,
    avatarSync,
    stardewPrefs,
    onLaunchPrefsChanged,
    dayPlan,
    insights,
    stardewHealth,
    sessionId,
    onSelectGame,
    onSetGameSubtab,
    onSetChatFilter,
    onToggleBwfHud,
    onToggleDockToGame,
    onSetEditingBwfPort,
    onSetBwfPortDraft,
    onSaveBwfPort,
    onToggleAvatarSync,
    onToggleAvatarLiveliness,
    onInstallAvatarMod,
    onUninstallAvatarMod,
    onSyncAvatarNow,
    onOpenPixelCreator,
    onCancelObjective,
    onSendText,
  } = props;

  const latestState = [...events].reverse().find((e) => e.type === 'state');
  const receipts = events.filter((e) => e.type === 'receipt');
  const decisions = events.filter((e) => e.type === 'decision');
  const watchdog = events.filter((e) => e.type === 'watchdog');
  const lastDecision = decisions[decisions.length - 1];

  return (
    <section data-game-panel data-active-game={activeGame} data-active-subtab={gameSubtab} className="h-full overflow-y-auto">
      <header className="mx-auto flex max-w-[1320px] flex-wrap items-center justify-between gap-2 px-6 pb-2 pt-4">
        <div className="seg-tabs" role="tablist" aria-label="选择共玩游戏">
          {GAME_OPTIONS.map((game) => (
            <button
              key={game.id}
              type="button"
              role="tab"
              data-game-select={game.id}
              data-selected={activeGame === game.id ? 'true' : 'false'}
              aria-selected={activeGame === game.id}
              disabled={!gameEnabled[game.id]}
              title={gameEnabled[game.id] ? game.label : `请先在「插件与权限」启用${game.label}`}
              className={`seg-tab${activeGame === game.id ? ' on' : ''}`}
              onClick={() => onSelectGame(game.id)}
            >
              {game.shortLabel}
            </button>
          ))}
        </div>
        {activeGame === 'stardew' && modsEnabled && (
          <div className="seg-tabs" role="tablist" aria-label="星露谷页面">
            <button
              type="button"
              role="tab"
              data-game-subtab="monitor"
              aria-selected={gameSubtab === 'monitor'}
              className={`seg-tab${gameSubtab === 'monitor' ? ' on' : ''}`}
              onClick={() => onSetGameSubtab('monitor')}
            >共玩监控</button>
            <button
              type="button"
              role="tab"
              data-game-subtab="mods"
              aria-selected={gameSubtab === 'mods'}
              className={`seg-tab${gameSubtab === 'mods' ? ' on' : ''}`}
              onClick={() => onSetGameSubtab('mods')}
            >Mod 管理</button>
          </div>
        )}
      </header>
      {gameSubtab === 'mods' && activeGame === 'stardew' && modsEnabled && (
        <div data-mods-page className="mx-auto max-w-[1320px] px-6 pb-6"><ModsPanel /></div>
      )}
      {gameSubtab === 'monitor' && activeGame === 'terraria' && gameEnabled.terraria && (
        <div className="mx-auto max-w-[1320px] px-6 py-3"><TerrariaPanel events={events} running={running} /></div>
      )}
      {gameSubtab === 'monitor' && activeGame === 'dst' && gameEnabled.dst && (
        <div className="mx-auto max-w-[1320px] px-6 py-3">
          <DstPanel
            bridge={{
              dstState: () => window.directorBridge.gameDstState(),
              dstStart: () => window.directorBridge.autodriveStart('dst'),
              dstStop: () => window.directorBridge.autodriveStop(),
              dstDirective: (tool, args, intent) => window.directorBridge.autodriveDirective(tool, args, intent, sessionId),
              onDstEvent: (handler) => window.directorBridge.onAutodriveEvent((event) => {
                if (event.type === 'state' || event.type === 'decision' || event.type === 'receipt' || event.type === 'watchdog') handler(event as DstPanelEvent);
              }),
            }}
            endpoint="http://127.0.0.1:18100"
          />
        </div>
      )}
      {gameSubtab === 'monitor' && activeGame === 'stardew' && gameEnabled.stardew && (
        <div className="mx-auto max-w-[1320px] px-6 py-3">
          <GameConnectionBanner
            gameId="stardew"
            report={stardewHealth.report}
            probing={stardewHealth.probing}
            onReprobe={stardewHealth.reprobe}
            {...(onLaunchPrefsChanged === undefined ? {} : { onPrefsChanged: onLaunchPrefsChanged })}
          />
          <div className="card mb-4 flex flex-wrap items-center gap-2 px-4 py-2.5">
            <span className="pill pill-violet"><Brain size={11} />{brainMode === 'llm' ? '智能决策' : '本地规则兜底'}</span>
            {stardewPrefs && (
              <span
                data-stardew-storage-badge={stardewPrefs.storageMode}
                className={`pill ${stardewPrefs.storageMode === 'isolated' ? 'pill-green' : 'pill-amber'}`}
                title="鲸屿隔离目录仅注入 XDG，不触碰 ~/.config/StardewValley 个人存档；语言跟随中控台（当前中文）"
              >
                <ShieldCheck size={11} />
                {stardewPrefs.storageMode === 'isolated' ? '隔离存档' : '常规目录'} · {stardewPrefs.language}
              </span>
            )}
            <span className="pill">78 个可用动作</span>
            <span className="pill pill-amber">30 粒米 / 回执</span>
            <span className="pill pill-green">攻略 {guidesCount} 专题</span>
            <button
              data-bwf-hud={bwfHud ? 'on' : 'off'}
              onClick={onToggleBwfHud}
              title="游戏画面左上角的 MCP 提示信息（连接/思考/执行状态）——默认关闭不显示"
              className={`pill cursor-pointer${bwfHud ? ' pill-green' : ''}`}
            >
              <Monitor size={11} />游戏内提示 {bwfHud ? '开' : '关'}
            </button>
            <button
              type="button"
              data-dock-to-game={dockToGame ? 'on' : 'off'}
              onClick={onToggleDockToGame}
              title="开启后：打开星露谷自动将桌宠停靠到游戏窗口右下角（手拖移开后本局不再拉回）"
              className={`pill cursor-pointer${dockToGame ? ' pill-green' : ''}`}
            >
              <Monitor size={11} />桌宠贴边游戏 {dockToGame ? '开' : '关'}
            </button>
            {editingBwfPort ? (
              <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px]" style={{ border: '1px solid var(--blue-line)', background: 'var(--inset)' }} data-bwf-port-editor>
                <span style={{ color: 'var(--text-3)' }}>MCP :</span>
                <input
                  type="number"
                  min={1024}
                  max={65535}
                  value={bwfPortDraft}
                  onChange={(event) => onSetBwfPortDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') onSaveBwfPort();
                    if (event.key === 'Escape') { onSetEditingBwfPort(false); onSetBwfPortDraft(String(bwfPort)); }
                  }}
                  className="mono w-16 bg-transparent text-[11px] outline-none"
                  style={{ color: 'var(--text-1)' }}
                  autoFocus
                />
                <button type="button" className="cursor-pointer font-semibold" style={{ color: 'var(--blue)' }} onClick={onSaveBwfPort}>保存</button>
                <button type="button" className="cursor-pointer" style={{ color: 'var(--text-3)' }} onClick={() => { onSetEditingBwfPort(false); onSetBwfPortDraft(String(bwfPort)); }}>取消</button>
              </span>
            ) : (
              <button
                type="button"
                data-bwf-port={bwfPort}
                onClick={() => { onSetBwfPortDraft(String(bwfPort)); onSetEditingBwfPort(true); }}
                title="点击修改星露谷 BWF MCP 端口（默认 18088，避开 Amazon Quick 等占用的 18080；保存时自动同步写入 BWF config.json）"
                className="pill mono cursor-pointer"
              >
                MCP :{bwfPort}
              </button>
            )}
            <button
              data-avatar-sync={avatarSync?.enabled === true ? 'on' : 'off'}
              onClick={onToggleAvatarSync}
              title="开启后：当前桌宠角色/皮肤会实时同步成星露谷玩家外观（原版预设兜底 + 1×/2×/4× 精灵表覆盖）"
              className={`pill cursor-pointer${avatarSync?.enabled === true ? ' pill-green' : ''}`}
            >
              <Monitor size={11} />同步桌宠形象进游戏 {avatarSync?.enabled === true ? '开' : '关'}
            </button>
            {avatarSync !== null && !avatarSync.modInstalled && (
              <button data-avatar-install onClick={onInstallAvatarMod} className="pill cursor-pointer" title="把 WhaleIsleAvatar SMAPI Mod 复制进星露谷 Mods 目录">
                安装 Mod
              </button>
            )}
            {avatarSync !== null && avatarSync.modInstalled && avatarSync.modNeedsUpdate && (
              <button data-avatar-upgrade onClick={onInstallAvatarMod} className="pill pill-amber cursor-pointer" title="仓库已有新版 WhaleIsleAvatar（支持 2×/4× 高清与灵动动画），点击覆盖升级">
                升级 Mod
              </button>
            )}
            {avatarSync !== null && avatarSync.modInstalled && !avatarSync.modNeedsUpdate && (
              <span
                data-avatar-mod-status
                className={`pill${avatarSync.modCompiled ? '' : ' pill-amber'}`}
                style={{ fontSize: 9.5 }}
                title={avatarSync.modCompiled
                  ? 'WhaleIsleAvatar 已安装到星露谷 Mods 目录（游戏启动时加载）'
                  : 'Mod 文件已复制但 WhaleIsleAvatar.dll 未编译：重新打包或运行 dotnet build 后再安装'}
              >
                {avatarSync.modCompiled ? 'Mod 已安装' : 'Mod 未编译'}
              </span>
            )}
            {avatarSync !== null && avatarSync.modInstalled && (
              <button data-avatar-uninstall onClick={onUninstallAvatarMod} className="pill cursor-pointer" title="从星露谷 Mods 目录移除 WhaleIsleAvatar（需重启游戏后完全生效）">
                卸载 Mod
              </button>
            )}
            {avatarSync?.enabled === true && avatarSync.modInstalled && (
              <button
                data-avatar-liveliness={avatarSync.liveliness ? 'on' : 'off'}
                onClick={onToggleAvatarLiveliness}
                className={`pill cursor-pointer${avatarSync.liveliness ? ' pill-violet' : ''}`}
                title="脚底柔和投影 + 待机微呼吸 + 行走轻弹跳与微倾 + 动作弹性（实时热切换）"
              >
                <Zap size={10} />灵动动画 {avatarSync.liveliness ? '开' : '关'}
              </button>
            )}
            {avatarSync?.enabled === true && avatarSync.modInstalled && avatarSync.syncedCharacterId !== null && (
              <span
                data-avatar-synced
                className="pill"
                style={{ fontSize: 9.5 }}
                title={avatarSync.syncedSpriteSize !== null
                  ? `星露谷 Mod 目录当前生效：${avatarSync.syncedSpriteSize.width}×${avatarSync.syncedSpriteSize.height}`
                  : '星露谷 Mod 目录 active-avatar.json 当前生效的角色'}
              >
                游戏内：{avatarSync.syncedDisplayName ?? avatarSync.syncedCharacterId} · {avatarSync.syncedSpriteReady
                  ? (avatarSync.syncedSpriteTier === '4x' ? '4× 高清 Q 版' : avatarSync.syncedSpriteTier === '2x' ? '2× 精致像素' : '1× 像素表')
                  : '原版预设'}
              </span>
            )}
            {avatarSync?.enabled === true && avatarSync.modInstalled && avatarSync.syncedCharacterId === null && (
              <span data-avatar-synced className="pill" style={{ fontSize: 9.5 }} title="还没有写入过 active-avatar.json：切换一次桌宠或点「同步当前」">等待首次同步</span>
            )}
            {avatarSync?.enabled === true && avatarSync.modInstalled && (
              <button data-avatar-sync-now onClick={onSyncAvatarNow} className="pill cursor-pointer" title="把当前桌宠角色立即写入星露谷 Mod 目录">
                同步当前
              </button>
            )}
            <button data-avatar-resolution onClick={onOpenPixelCreator} className="pill cursor-pointer" title="打开创作中心调整星露谷精灵表清晰度（1× / 2× / 4×）">
              调清晰度
            </button>
            <div className="flex-1" />
            <span className={`pill ${running ? 'pill-green' : ''}`} style={{ fontSize: 10 }}>{running ? '自动驾驶中' : '待命'}</span>
          </div>

          {objective !== null && (
            <div data-objective-bar className="mb-4 flex flex-wrap items-center gap-2 rounded-xl px-4 py-2.5" style={{ border: '1px solid var(--violet-line)', background: 'var(--violet-dim)' }}>
              <span className="flex items-center gap-1.5 text-[11px] font-semibold" style={{ color: 'var(--violet)' }}>
                <Target size={12} />当前多步目标
              </span>
              <span className="min-w-0 flex-1 truncate text-[11.5px]" style={{ color: 'var(--text-1)' }}>{objective}</span>
              <button type="button" className="btn-pill ghost" data-objective-cancel onClick={onCancelObjective}>
                取消目标
              </button>
            </div>
          )}
          <div className="grid grid-cols-[1.18fr_0.98fr_0.84fr] gap-4">
            <section className="flex flex-col gap-3">
              <GameCurrentActionCard
                decision={lastDecision}
                metrics={[
                  ['时间', latestState?.clock ?? '—'],
                  ['体力', latestState?.stamina != null ? `${latestState.stamina}/${latestState.staminaMax ?? '—'}` : '—'],
                  ['金钱', latestState?.money != null ? `${latestState.money}g` : '—'],
                ]}
                idleHint="等待自动驾驶启动…"
              />
              <GameDecisionTimeline decisions={decisions} objectiveActive={objective !== null} />
              <div className="card px-4 py-3.5" data-day-plan-panel>
                <div className="mb-1.5 flex items-center justify-between gap-2 text-[11px]" style={{ color: 'var(--text-2)' }}>
                  <div className="flex items-center gap-1.5">
                    <span>当日 Todo List（{dayPlan?.dayKey ?? '未生成'}）</span>
                    {dayPlan !== null && dayPlan.items.length > 0 && (
                      <span className="pill pill-green mono" style={{ fontSize: 9 }}>
                        {dayPlan.items.filter((i) => i.status === 'done').length}/{dayPlan.items.length} 完成
                      </span>
                    )}
                  </div>
                  {dayPlan?.mood !== undefined && <span className="truncate text-[9.5px]" style={{ color: 'var(--violet)' }}>{dayPlan.mood}</span>}
                </div>
                {dayPlan?.updateWhy !== undefined && (
                  <div className="mb-2 rounded-md px-2 py-1 text-[10px]" style={{ color: 'var(--amber)', background: 'var(--inset)' }}>
                    最近调整原因：{dayPlan.updateWhy}
                  </div>
                )}
                {dayPlan !== null && dayPlan.items.length > 0 ? (
                  <div className="flex flex-col gap-1.5">
                    {dayPlan.items.map((item, idx) => (
                      <div key={`${item.goal}:${idx}`} data-day-plan-item={item.status} className="rounded-lg px-2.5 py-1.5 text-[10.5px]" style={{ background: 'var(--surface-2)', border: '1px solid var(--stroke)' }}>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="mono font-bold" style={{
                            color: item.status === 'done' ? 'var(--green)' : item.status === 'in_progress' ? 'var(--blue)' : 'var(--text-3)',
                          }}>{item.status === 'done' ? '☑' : item.status === 'in_progress' ? '▶' : '☐'}</span>
                          <span className="rounded px-1 py-px text-[9px]" style={{
                            color: item.status === 'done' ? 'var(--green)' : item.status === 'in_progress' ? 'var(--blue)' : 'var(--text-3)',
                            background: 'var(--inset)',
                          }}>{item.status === 'done' ? '已完成' : item.status === 'in_progress' ? '进行中' : '待办'}</span>
                          <span className={item.status === 'done' ? 'line-through opacity-75' : ''} style={{ color: 'var(--text-1)' }}>{item.goal}</span>
                          {item.status === 'done' && item.completedAt !== undefined && item.completedAt !== '' && (
                            <span className="mono ml-auto rounded px-1 py-px text-[9px]" style={{ color: 'var(--green)', background: 'var(--inset)' }}>
                              ✓ {item.completedAt}
                            </span>
                          )}
                          {item.status !== 'done' && item.addedAt !== undefined && item.addedAt !== '' && (
                            <span className="mono ml-auto text-[9px]" style={{ color: 'var(--text-3)' }}>建 {item.addedAt}</span>
                          )}
                        </div>
                        {item.why !== '' && <div className="mt-0.5 text-[9.5px]" style={{ color: 'var(--text-3)' }}>{item.why}</div>}
                      </div>
                    ))}
                  </div>
                ) : (
                  <span className="text-[10.5px]" style={{ color: 'var(--text-3)' }}>开启 LLM 大脑启动后，小鲸起床会自动拟定今日计划。</span>
                )}
                {dayPlan?.history !== undefined && dayPlan.history.length > 0 && (
                  <div className="mt-2.5 pt-2" style={{ borderTop: '1px dashed var(--stroke)' }} data-day-plan-history>
                    <div className="mb-1 flex items-center justify-between text-[10px]" style={{ color: 'var(--text-3)' }}>
                      <span>计划更改与完成日志</span>
                      <span className="mono">{dayPlan.history.length} 条</span>
                    </div>
                    <div className="flex max-h-36 flex-col gap-1 overflow-y-auto">
                      {[...dayPlan.history].reverse().map((h, hIdx) => {
                        const wall = new Date(h.atTs).toTimeString().slice(0, 5);
                        return (
                          <div key={`${h.atTs}:${hIdx}`} className="rounded-md px-2 py-1 text-[9.5px]" style={{ background: 'var(--inset)' }}>
                            <div className="flex items-center gap-1.5">
                              <span className="mono rounded px-1 py-px text-[8.5px]" style={{
                                color: h.kind === 'morning' ? 'var(--violet)' : 'var(--amber)',
                                background: 'var(--surface-2)',
                              }}>{h.kind === 'morning' ? '晨间立项' : '调整'}</span>
                              <span className="mono" style={{ color: 'var(--text-2)' }}>{h.atClock}</span>
                              <span className="mono ml-auto text-[8.5px]" style={{ color: 'var(--text-3)' }}>{wall}</span>
                            </div>
                            <div className="mt-0.5" style={{ color: 'var(--text-1)' }}>{h.summary}</div>
                            {h.why !== undefined && h.why !== '' && (
                              <div className="mt-0.5" style={{ color: 'var(--text-3)' }}>原因：{h.why}</div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
              <GameGoalChain
                goals={dayPlan !== null && dayPlan.items.length > 0
                  ? dayPlan.items.map((item) => (item.status === 'done' ? `✓ ${item.goal}` : item.goal))
                  : STARDEW_GOALS}
                activeIndex={dayPlan !== null && dayPlan.items.length > 0
                  ? Math.max(0, dayPlan.items.findIndex((item) => item.status === 'in_progress'))
                  : 0}
              />
            </section>

            <GameReceiptTimeline
              receipts={receipts}
              filter={chatFilter}
              onFilter={(next) => onSetChatFilter(next)}
              emptyHint="游戏连接后，这里会按时间线记录每一步动作与结果。"
            />

            <section className="flex flex-col gap-3">
              <div className="card px-4 py-3.5" data-strategy-notebook-panel>
                <div className="mb-1.5 flex items-center justify-between text-[11px]" style={{ color: 'var(--text-2)' }}>
                  <span>心得本（只读 · 攻略与复盘）</span>
                  <span className="mono text-[9.5px]" style={{ color: 'var(--green)' }}>{insights.length} 条</span>
                </div>
                {insights.length > 0 ? (
                  <div className="flex max-h-48 flex-col gap-1.5 overflow-y-auto">
                    {insights.slice(-8).reverse().map((ins) => (
                      <div key={ins.id} className="rounded-lg px-2 py-1.5 text-[10px]" style={{ background: 'var(--surface-2)', border: '1px solid var(--stroke)' }}>
                        <div className="flex items-center gap-1.5">
                          <span className="mono font-semibold" style={{
                            color: ins.verdict === 'adopt' ? 'var(--green)' : ins.verdict === 'defer' ? 'var(--amber)' : ins.verdict === 'refuted' ? 'var(--red)' : 'var(--text-3)',
                          }}>[{ins.verdict}]</span>
                          <span style={{ color: 'var(--text-1)' }}>{ins.claim}</span>
                          <span className="ml-auto text-[9px]" style={{ color: 'var(--text-3)' }}>引用{ins.hits}</span>
                        </div>
                        <div className="mt-0.5 text-[9.5px]" style={{ color: 'var(--text-3)' }}>
                          条件：{ins.when} · {ins.source} · {ins.why}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <span className="text-[10.5px]" style={{ color: 'var(--text-3)' }}>暂无心得：小鲸阅读攻略或夜间复盘后会记在这里。</span>
                )}
              </div>
              <GameMetricsCard
                rows={[
                  ['回执总数', receipts.length],
                  ['决策次数', decisions.length],
                  ['看门狗事件', watchdog.length],
                  ['攻略专题', guidesCount],
                ]}
              />
              <GameQualityCard events={events} />
              <GameQuickCommands
                commands={STARDEW_QUICK}
                onCommand={(key) => onSendText(key)}
                stopKey="/stop"
              />
              <GameDiagnostics
                title="高级诊断"
                rows={[
                  ['桥接方式', `BWF Mod 本机服务 (:${bwfPort})`],
                  ['可用动作', '78 个白名单动作'],
                  ['卡死策略', '大脑救援问询 + 离线阶梯兜底'],
                  ['直写工具', '默认关闭（运行期安全锁）'],
                ]}
                notes={[
                  '所有动作走 BWF MCP 回执，超时不重发、卡死由看门狗接管；审计写 JSONL。',
                  '结论与许可证见 docs/REFERENCE-dsh-stardew-blind-whale-farmer.md。',
                ]}
              />
            </section>
          </div>
        </div>
      )}
    </section>
  );
}
