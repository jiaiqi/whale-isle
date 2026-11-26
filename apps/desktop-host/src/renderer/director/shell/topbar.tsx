/**
 * Tidepaper 主工作台顶栏：面包屑 + ⌘K 搜索 + 语音/大脑/自动驾驶三开关 + 多主题(Tidepaper / Obsidian Tide / Tide Deep)与强调色切换。
 */
import { useEffect, useRef, useState } from 'react';
import {
  Brain, ChevronDown, ChevronRight, Flame, Monitor, Moon, Palette, Play, Search, Sprout, Square, Sun, Swords,
  Volume2, VolumeX, type LucideIcon,
} from 'lucide-react';
import { GAME_OPTIONS, type GameId } from '../bridge';

const GAME_ICON: Record<GameId, LucideIcon> = { stardew: Sprout, terraria: Swords, dst: Flame };

export type ThemeMode = 'system' | 'dark' | 'light';
export type ThemeSkin = 'tidepaper' | 'obsidian-tide' | 'tide-deep';
export type TideAccent = 'coral' | 'sea' | 'whale' | 'kelp' | 'plum';

const SKIN_OPTIONS: Array<{ id: ThemeSkin; label: string; desc: string }> = [
  { id: 'tidepaper', label: '潮汐纸 Tidepaper', desc: '默认 · 晨雾纸面 / 夜潮' },
  { id: 'obsidian-tide', label: '曜潮 Obsidian Tide', desc: '经典深空玻璃主题' },
  { id: 'tide-deep', label: '深海屿光 Tide Deep', desc: '深海澄蓝主题' },
];

const ACCENT_OPTIONS: Array<{ id: TideAccent; label: string; color: string }> = [
  { id: 'coral', label: '珊瑚落日', color: '#E5603F' },
  { id: 'sea', label: '海潮青', color: '#1D7A8A' },
  { id: 'whale', label: '鲸蓝', color: '#3260C9' },
  { id: 'kelp', label: '苔绿', color: '#247244' },
  { id: 'plum', label: '紫藤', color: '#7A5AB0' },
];

export interface TopbarProps {
  group: string;
  title: string;
  voiceOn: boolean;
  voiceBackend?: { backend: 'mcode' | 'say' | 'unsupported'; detail: string } | null;
  brainMode: string;
  llmReady: boolean;
  mainModelId: string;
  gameId: GameId;
  gameEnabled: Record<GameId, boolean>;
  running: boolean;
  theme: 'dark' | 'light';
  themeMode?: ThemeMode;
  skin?: ThemeSkin;
  accent?: TideAccent;
  onOpenCommandPalette: () => void;
  onToggleVoice: () => void;
  onSwitchBrain: () => void;
  onSelectGame: (gameId: GameId) => void;
  onToggleDrive: () => void;
  onToggleTheme: () => void;
  onSelectSystemTheme?: () => void;
  onSelectSkin?: (skin: ThemeSkin) => void;
  onSelectAccent?: (accent: TideAccent) => void;
}

export function Topbar({
  group, title, voiceOn, voiceBackend, brainMode, llmReady, mainModelId, gameId, gameEnabled, running,
  theme, themeMode = theme, skin = 'tidepaper', accent = 'coral',
  onOpenCommandPalette, onToggleVoice, onSwitchBrain, onSelectGame, onToggleDrive, onToggleTheme,
  onSelectSystemTheme, onSelectSkin, onSelectAccent,
}: TopbarProps): React.JSX.Element {
  const isLlm = brainMode === 'llm';
  const needsKeyFallback = !llmReady && !isLlm;
  const modelId = mainModelId.trim();
  const modelLabel = modelId === '' ? '未绑定' : modelId.split('/').filter(Boolean).pop() ?? modelId;
  const brainLabel = isLlm ? `主脑 · ${modelLabel}` : needsKeyFallback ? `缺 Key · ${modelLabel}` : `规则 · ${modelLabel}`;
  const activeGame = GAME_OPTIONS.find((game) => game.id === gameId) ?? GAME_OPTIONS[0];
  const GameIcon = GAME_ICON[gameId];
  const activeGameEnabled = gameEnabled[gameId];
  const [gameMenuOpen, setGameMenuOpen] = useState(false);
  const [skinMenuOpen, setSkinMenuOpen] = useState(false);
  const gameMenuRef = useRef<HTMLDivElement>(null);
  const skinMenuRef = useRef<HTMLDivElement>(null);
  const gamePickerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!gameMenuOpen && !skinMenuOpen) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (gameMenuOpen && !gameMenuRef.current?.contains(event.target as Node)) setGameMenuOpen(false);
      if (skinMenuOpen && !skinMenuRef.current?.contains(event.target as Node)) setSkinMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        if (gameMenuOpen) {
          setGameMenuOpen(false);
          gamePickerRef.current?.focus();
        }
        if (skinMenuOpen) setSkinMenuOpen(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [gameMenuOpen, skinMenuOpen]);

  useEffect(() => {
    if (running) setGameMenuOpen(false);
  }, [running]);

  return (
    <header className="wb-top">
      <div className="wb-crumb">
        {group} <ChevronRight size={11} /> <b>{title}</b>
      </div>
      <button className="wb-search-btn" onClick={onOpenCommandPalette} title="快速跳转 / 指令（⌘K）">
        <Search size={12} />
        <span>快速跳转 / 指令…</span>
        <kbd style={{ fontFamily: 'var(--font-mono)' }}>⌘K</kbd>
      </button>
      <div className="sp" />
      <button
        data-voice-toggle
        data-voice-backend={voiceBackend?.backend ?? 'probing'}
        onClick={onToggleVoice}
        className={`wb-ctrl${voiceOn ? ' on-green' : ''}`}
        title={`切换全局语音播报 · 当前后端：${voiceBackend?.detail ?? '探测中'}`}
      >
        {voiceOn ? <Volume2 size={12} /> : <VolumeX size={12} />}
        <span>
          {voiceOn ? '语音开' : '语音关'}
          {voiceBackend != null && voiceBackend.backend !== 'mcode'
            ? ` · ${voiceBackend.backend === 'say' ? 'say' : '未适配'}`
            : ''}
        </span>
      </button>
      <button
        data-brain-toggle
        data-brain-fallback={needsKeyFallback ? 'true' : 'false'}
        data-brain-model={mainModelId}
        onClick={onSwitchBrain}
        className={`wb-ctrl${isLlm ? ' on-violet' : ''}`}
        style={needsKeyFallback ? { color: 'var(--amber)', borderColor: 'var(--amber-line)', background: 'var(--amber-dim)' } : undefined}
        title={needsKeyFallback ? '主脑未就绪，当前使用规则日程。点击打开模型与服务商。' : `切换主脑模式 · ${modelLabel}`}
        aria-label={needsKeyFallback ? `主脑缺少 Key，当前使用规则模式。打开模型与服务商，绑定模型：${modelLabel}` : `主脑：${brainLabel}。切换模式`}
      >
        <Brain size={12} />
        <span>{brainLabel}</span>
      </button>
      <div ref={gameMenuRef} className="relative">
        <div
          data-game-drive
          className="inline-flex items-stretch overflow-hidden rounded-full"
          style={{ border: `1px solid ${running ? 'var(--red-line)' : activeGameEnabled ? 'var(--green-line)' : 'var(--stroke)'}`, background: running ? 'var(--red-dim)' : activeGameEnabled ? 'var(--green-dim)' : 'var(--surface-solid)' }}
        >
          <button
            ref={gamePickerRef}
            type="button"
            data-game-picker
            data-active-game={gameId}
            onClick={() => setGameMenuOpen((open) => !open)}
            disabled={running}
            aria-haspopup="menu"
            aria-expanded={gameMenuOpen}
            aria-label={`选择游戏，当前为${activeGame.label}${running ? '，自动驾驶运行中不可切换' : ''}`}
            title={running ? `自动驾驶正在运行：${activeGame.label}。停止后可切换游戏。` : '选择自动驾驶目标游戏'}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 9px 5px 11px', border: 0, borderRight: '1px solid var(--stroke)', background: 'transparent', color: 'var(--text-1)', fontSize: 11.5, fontWeight: 600, whiteSpace: 'nowrap', opacity: running ? 0.75 : 1 }}
          >
            <GameIcon size={12} />
            <span>{activeGame.shortLabel}</span>
            <ChevronDown size={10} />
          </button>
          <button
            type="button"
            data-autodrive-toggle
            onClick={onToggleDrive}
            disabled={!running && !activeGameEnabled}
            aria-label={running ? `停止${activeGame.label}自动驾驶` : `启动${activeGame.label}自动驾驶`}
            title={running ? `停止${activeGame.label}自动驾驶` : activeGameEnabled ? `启动${activeGame.label}自动驾驶` : `请先在「扩展与权限」启用${activeGame.label}`}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 11px 5px 9px', border: 0, background: 'transparent', color: running ? 'var(--red)' : activeGameEnabled ? 'var(--green)' : 'var(--text-3)', fontSize: 11.5, fontWeight: 600, whiteSpace: 'nowrap', opacity: !running && !activeGameEnabled ? 0.6 : 1 }}
          >
            {running ? <Square size={10} fill="currentColor" /> : <Play size={10} fill="currentColor" />}
            <span>{running ? '停止' : '启动'}</span>
          </button>
        </div>
        {gameMenuOpen && (
          <div
            role="menu"
            aria-label="选择自动驾驶目标游戏"
            className="card"
            style={{ position: 'absolute', zIndex: 80, top: 'calc(100% + 7px)', right: 0, width: 190, padding: 5, background: 'var(--surface-solid)', boxShadow: 'var(--shadow-2)' }}
          >
            {GAME_OPTIONS.map((game) => {
              const OptionIcon = GAME_ICON[game.id];
              const selected = game.id === gameId;
              const enabled = gameEnabled[game.id];
              return (
                <button
                  key={game.id}
                  type="button"
                  role="menuitemradio"
                  data-game-option={game.id}
                  data-selected={selected ? 'true' : 'false'}
                  aria-checked={selected}
                  disabled={running || !enabled}
                  onClick={() => { onSelectGame(game.id); setGameMenuOpen(false); }}
                  title={enabled ? game.label : `请先在「扩展与权限」启用${game.label}`}
                  style={{ display: 'flex', width: '100%', alignItems: 'center', gap: 8, padding: '8px 9px', border: 0, borderRadius: 8, background: selected ? 'var(--blue-dim)' : 'transparent', color: selected ? 'var(--blue)' : enabled ? 'var(--text-1)' : 'var(--text-3)', textAlign: 'left', fontSize: 11.5, opacity: enabled ? 1 : 0.58 }}
                >
                  <OptionIcon size={13} />
                  <span>{game.label}</span>
                  {selected && <span aria-hidden="true" className="ml-auto">当前</span>}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* 主题风格与 Tidepaper 强调色选择器 */}
      {(onSelectSkin || onSelectAccent) && (
        <div ref={skinMenuRef} className="relative">
          <button
            type="button"
            data-skin-picker
            className="icon-btn"
            onClick={() => setSkinMenuOpen((open) => !open)}
            title="切换视觉主题（潮汐纸 / 曜潮 / 深海屿光）与强调色"
          >
            <Palette size={15} />
          </button>
          {skinMenuOpen && (
            <div
              className="card space-y-2.5 p-3"
              style={{ position: 'absolute', zIndex: 85, top: 'calc(100% + 7px)', right: 0, width: 240, background: 'var(--surface-solid)', boxShadow: 'var(--shadow-2)' }}
            >
              <div className="wb-eyebrow">外观风格（ADR-003 多主题）</div>
              <div className="space-y-1">
                {SKIN_OPTIONS.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    data-skin-option={item.id}
                    onClick={() => { onSelectSkin?.(item.id); setSkinMenuOpen(false); }}
                    className="flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left text-xs"
                    style={{
                      background: skin === item.id ? 'var(--accent-soft)' : 'transparent',
                      color: skin === item.id ? 'var(--accent)' : 'var(--text-1)',
                      border: skin === item.id ? '1px solid var(--accent-line)' : '1px solid transparent',
                    }}
                  >
                    <div>
                      <div className="font-semibold">{item.label}</div>
                      <div className="text-[10px]" style={{ color: 'var(--text-3)' }}>{item.desc}</div>
                    </div>
                  </button>
                ))}
              </div>
              {onSelectAccent && (
                <>
                  <div className="wb-eyebrow pt-1">潮汐纸强调色</div>
                  <div className="flex flex-wrap gap-1.5">
                    {ACCENT_OPTIONS.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        data-accent-option={item.id}
                        onClick={() => onSelectAccent(item.id)}
                        title={item.label}
                        className="inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-[10.5px]"
                        style={{
                          background: accent === item.id ? 'var(--accent-soft)' : 'var(--inset)',
                          color: accent === item.id ? 'var(--text-1)' : 'var(--text-2)',
                          border: accent === item.id ? '1px solid var(--accent-line)' : '1px solid var(--stroke)',
                        }}
                      >
                        <span style={{ width: 9, height: 9, borderRadius: 999, background: item.color }} />
                        <span>{item.label}</span>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      )}

      <button
        data-theme-toggle
        className="icon-btn"
        onClick={onToggleTheme}
        title={theme === 'dark' ? '切到晨雾/浅色模式' : '切到夜潮/深色模式'}
      >
        {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
      </button>
      {onSelectSystemTheme && (
        <button
          data-theme-system
          type="button"
          aria-pressed={themeMode === 'system'}
          className={`icon-btn${themeMode === 'system' ? ' on-blue' : ''}`}
          style={themeMode === 'system' ? { background: 'var(--blue-dim)', color: 'var(--blue)' } : undefined}
          onClick={onSelectSystemTheme}
          title={themeMode === 'system' ? '当前：跟随系统浅深色' : '切换到跟随系统浅深色'}
        >
          <Monitor size={15} />
        </button>
      )}
    </header>
  );
}
