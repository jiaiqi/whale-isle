/**
 * v4 Shell 顶栏：面包屑 + ⌘K 搜索 + 语音/大脑/自动驾驶三开关 + 主题切换。
 * 纯展示组件——状态与动作由 App 注入（与 v4 shell.js 的行为一一对应）。
 */
import { useEffect, useRef, useState } from 'react';
import {
  Brain, ChevronDown, ChevronRight, Flame, Moon, Play, Search, Sprout, Square, Sun, Swords,
  Volume2, VolumeX, type LucideIcon,
} from 'lucide-react';
import { GAME_OPTIONS, type GameId } from '../bridge';

const GAME_ICON: Record<GameId, LucideIcon> = { stardew: Sprout, terraria: Swords, dst: Flame };

export interface TopbarProps {
  group: string;
  title: string;
  voiceOn: boolean;
  /** T-M6-33 实际语音后端；null=探测中 */
  voiceBackend?: { backend: 'mcode' | 'say' | 'unsupported'; detail: string } | null;
  brainMode: string;
  llmReady: boolean;
  mainModelId: string;
  gameId: GameId;
  gameEnabled: Record<GameId, boolean>;
  running: boolean;
  theme: 'dark' | 'light';
  onOpenCommandPalette: () => void;
  onToggleVoice: () => void;
  onSwitchBrain: () => void;
  onSelectGame: (gameId: GameId) => void;
  onToggleDrive: () => void;
  onToggleTheme: () => void;
}

export function Topbar({
  group, title, voiceOn, voiceBackend, brainMode, llmReady, mainModelId, gameId, gameEnabled, running, theme,
  onOpenCommandPalette, onToggleVoice, onSwitchBrain, onSelectGame, onToggleDrive, onToggleTheme,
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
  const gameMenuRef = useRef<HTMLDivElement>(null);
  const gamePickerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!gameMenuOpen) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (!gameMenuRef.current?.contains(event.target as Node)) setGameMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setGameMenuOpen(false);
        gamePickerRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [gameMenuOpen]);

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
        <kbd style={{ fontFamily: 'var(--font-ui)' }}>⌘K</kbd>
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
          style={{ border: `1px solid ${running ? 'var(--red-line)' : activeGameEnabled ? 'var(--green-line)' : 'var(--stroke)'}`, background: running ? 'var(--red-dim)' : activeGameEnabled ? 'var(--green-dim)' : 'var(--surface)' }}
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
            title={running ? `停止${activeGame.label}自动驾驶` : activeGameEnabled ? `启动${activeGame.label}自动驾驶` : `请先在「插件与权限」启用${activeGame.label}`}
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
                  title={enabled ? game.label : `请先在「插件与权限」启用${game.label}`}
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
      <button data-theme-toggle className="icon-btn" onClick={onToggleTheme} title="切换深浅主题">
        {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
      </button>
    </header>
  );
}
