/**
 * v4 Shell 顶栏：面包屑 + ⌘K 搜索 + 语音/大脑/自动驾驶三开关 + 主题切换。
 * 纯展示组件——状态与动作由 App 注入（与 v4 shell.js 的行为一一对应）。
 */
import { Brain, ChevronRight, Moon, Play, Search, Square, Sun, Volume2, VolumeX } from 'lucide-react';

export interface TopbarProps {
  group: string;
  title: string;
  voiceOn: boolean;
  brainMode: string;
  llmReady: boolean;
  running: boolean;
  theme: 'dark' | 'light';
  onOpenCommandPalette: () => void;
  onToggleVoice: () => void;
  onSwitchBrain: () => void;
  onToggleDrive: () => void;
  onToggleTheme: () => void;
}

export function Topbar({
  group, title, voiceOn, brainMode, llmReady, running, theme,
  onOpenCommandPalette, onToggleVoice, onSwitchBrain, onToggleDrive, onToggleTheme,
}: TopbarProps): React.JSX.Element {
  const isLlm = brainMode === 'llm';
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
        onClick={onToggleVoice}
        className={`wb-ctrl${voiceOn ? ' on-green' : ''}`}
        title="切换全局语音播报"
      >
        {voiceOn ? <Volume2 size={12} /> : <VolumeX size={12} />}
        <span>{voiceOn ? '语音开' : '语音关'}</span>
      </button>
      <button
        data-brain-toggle
        onClick={onSwitchBrain}
        disabled={!llmReady && !isLlm}
        className={`wb-ctrl${isLlm ? ' on-violet' : ''}`}
        style={{ opacity: !llmReady && !isLlm ? 0.5 : 1 }}
        title="热切换 LLM 大脑 / 规则日程"
      >
        <Brain size={12} />
        <span>{isLlm ? 'LLM 大脑' : '规则日程'}</span>
      </button>
      <button
        data-autodrive-toggle
        onClick={onToggleDrive}
        className={`wb-ctrl ${running ? 'on-red' : 'on-green'}`}
        title="启停星露谷自动驾驶"
      >
        {running ? <Square size={10} fill="currentColor" /> : <Play size={10} fill="currentColor" />}
        <span>{running ? '停止自动驾驶' : '启动自动驾驶'}</span>
      </button>
      <button className="icon-btn" onClick={onToggleTheme} title="切换深浅主题">
        {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
      </button>
    </header>
  );
}
