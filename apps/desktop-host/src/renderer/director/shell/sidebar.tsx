/**
 * v4 Shell 左侧栏（设计稿：分组插件导航 + 赛博饭碗 footer）。
 * 插件启停会过滤这里的入口 —— 与「插件与权限」页联动（localStorage 持久）。
 */
import { useEffect, useRef, useState } from 'react';
import {
  AudioLines, Blocks, Brain, ChevronDown, Cpu, Fish, Gamepad2, MessageSquare, MonitorPlay, Plus,
  Search, Terminal, Users, Wheat,
  type LucideIcon,
} from 'lucide-react';
import { APP_NAME, APP_TAGLINE, whaleMarkPaths } from '../../../shared/brand';
import type { CharacterSummary } from '../bridge';

export type Tab =
  | 'chat' | 'memory' | 'voice' | 'pet' | 'stardew' | 'terraria' | 'dst' | 'mods' | 'coop' | 'obs' | 'harness' | 'providers' | 'plugins';

export interface NavItem {
  id: Tab;
  label: string;
  icon: LucideIcon;
  group: string;
  live?: boolean;
}

export const NAV_GROUPS: Array<{ label: string; items: NavItem[] }> = [
  {
    label: '交互中枢',
    items: [
      { id: 'chat', label: '聊天 · 小鲸', icon: MessageSquare, group: '交互中枢' },
      { id: 'memory', label: '记忆图谱与日记', icon: Brain, group: '交互中枢' },
    ],
  },
  {
    label: '声形与舞台',
    items: [
      { id: 'voice', label: '声音工坊与音色库', icon: AudioLines, group: '声形与舞台' },
      { id: 'pet', label: '桌宠舞台与动作库', icon: Fish, group: '声形与舞台' },
    ],
  },
  {
    label: '游戏与直播',
    items: [
      { id: 'stardew', label: '游戏共玩', icon: Gamepad2, group: '游戏与直播', live: true },
      { id: 'coop', label: '联机协作', icon: Users, group: '游戏与直播' },
      { id: 'obs', label: 'OBS 透明挂件', icon: MonitorPlay, group: '游戏与直播' },
    ],
  },
  {
    label: '平台与底层',
    items: [
      { id: 'harness', label: 'Harness · ACP', icon: Terminal, group: '平台与底层' },
      { id: 'providers', label: '模型与服务商', icon: Cpu, group: '平台与底层' },
      { id: 'plugins', label: '插件与权限策略', icon: Blocks, group: '平台与底层' },
    ],
  },
];

const MARK = whaleMarkPaths();

const WHALE_SVG = (
  <svg style={{ width: 22, height: 22, flexShrink: 0 }} viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d={MARK.tail} fill="var(--blue)" />
    <path d={MARK.body} fill="var(--blue)" />
    <path d={MARK.band} stroke="#F6FAFF" strokeWidth="1.7" strokeLinecap="round" />
    <circle cx={MARK.eye.cx} cy={MARK.eye.cy} r={MARK.eye.r} fill="#06182E" />
    <circle cx={MARK.glint.cx} cy={MARK.glint.cy} r={MARK.glint.r} fill="#FFFFFF" />
  </svg>
);

export interface SidebarProps {
  tab: Tab;
  onSelect: (tab: Tab) => void;
  running: boolean;
  rice: number;
  riceCap: number;
  onFeed: () => void;
  onOpenCommandPalette: () => void;
  /** 插件启停过滤：返回 false 的入口隐藏 */
  isPluginEnabled: (id: Tab) => boolean;
  characters: CharacterSummary[];
  characterId: string;
  onSelectCharacter: (id: string) => void;
  /** 动态 badge 文案（如记忆节点数） */
  badges?: Partial<Record<Tab, string>>;
}

export function Sidebar({
  tab, onSelect, running, rice, riceCap, onFeed, onOpenCommandPalette, isPluginEnabled,
  characters, characterId, onSelectCharacter, badges,
}: SidebarProps): React.JSX.Element {
  const pct = Math.min(100, Math.round((rice / riceCap) * 100));
  const [characterMenuOpen, setCharacterMenuOpen] = useState(false);
  const characterMenuRef = useRef<HTMLDivElement>(null);
  const selectedCharacter = characters.find((character) => character.id === characterId);

  useEffect(() => {
    if (!characterMenuOpen) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (!characterMenuRef.current?.contains(event.target as Node)) setCharacterMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setCharacterMenuOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [characterMenuOpen]);
  return (
    <aside className="wb-side">
      <div className="wb-brand">
        {WHALE_SVG}
        <span className="t" title={APP_TAGLINE} style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{APP_NAME}</span>
        <div ref={characterMenuRef} style={{ position: 'relative', marginLeft: 'auto', flexShrink: 0 }}>
          <button
            type="button"
            data-character-switch
            aria-label={`切换陪伴角色，当前${selectedCharacter?.displayName ?? '未选择'}`}
            aria-haspopup="menu"
            aria-expanded={characterMenuOpen}
            disabled={characters.length === 0}
            onClick={() => setCharacterMenuOpen((open) => !open)}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, maxWidth: 108, padding: '5px 7px', borderRadius: 999, border: '1px solid var(--stroke)', background: 'var(--surface)', color: 'var(--text-2)', fontSize: 10.5, whiteSpace: 'nowrap', opacity: characters.length === 0 ? 0.6 : 1 }}
          >
            <Fish size={12} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{selectedCharacter?.displayName ?? '角色'}</span>
            <ChevronDown size={11} />
          </button>
          {characterMenuOpen && (
            <div
              role="menu"
              aria-label="选择陪伴角色"
              className="card"
              style={{ position: 'absolute', zIndex: 60, top: 'calc(100% + 6px)', right: 0, width: 190, maxHeight: 280, overflowY: 'auto', padding: 5, background: 'var(--surface-solid)', boxShadow: 'var(--shadow-2)' }}
            >
              {characters.map((character) => (
                <button
                  key={character.id}
                  type="button"
                  role="menuitemradio"
                  data-character-option={character.id}
                  aria-checked={characterId === character.id}
                  onClick={() => { onSelectCharacter(character.id); setCharacterMenuOpen(false); }}
                  style={{ display: 'flex', width: '100%', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '8px 9px', border: 0, borderRadius: 8, background: characterId === character.id ? 'var(--blue-dim)' : 'transparent', color: characterId === character.id ? 'var(--blue)' : 'var(--text-1)', textAlign: 'left', fontSize: 11.5 }}
                >
                  <span>{character.displayName}</span>
                  {characterId === character.id && <span aria-hidden="true">当前</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="wb-nav-scroll">
        {NAV_GROUPS.map((group) => {
          const items = group.items.filter((item) => isPluginEnabled(item.id));
          if (items.length === 0) return null;
          return (
            <div key={group.label}>
              <div className="wb-nav-sec">{group.label}</div>
              {items.map((item) => {
                const Icon = item.icon;
                const active = tab === item.id;
                const badge = badges?.[item.id];
                return (
                  <button
                    key={item.id}
                    data-tab={item.id}
                    data-active={active ? 'true' : 'false'}
                    onClick={() => onSelect(item.id)}
                    className={`wb-nav-item${active ? ' on' : ''}`}
                    style={{ width: 'calc(100% - 18px)', textAlign: 'left', border: 'none' }}
                  >
                    <Icon size={14} />
                    <span>{item.label}</span>
                    {item.live && running && (
                      <span className="dot-right"><span className="pulse-dot" /></span>
                    )}
                    {!item.live && badge !== undefined && badge !== '' && (
                      <span className="badge">{badge}</span>
                    )}
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
      <div className="wb-side-foot">
        <div className="wb-rice-row">
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Wheat size={14} style={{ color: 'var(--amber)' }} />赛博饭碗
          </span>
          <b style={{ color: pct <= 15 ? 'var(--amber)' : 'var(--green)' }}>{rice.toLocaleString()} 粒</b>
        </div>
        <div className="wb-rice-bar"><i style={{ width: `${Math.max(4, pct)}%` }} /></div>
        <div className="wb-foot-actions">
          <button className="wb-foot-btn" onClick={onFeed} title="投喂 5,000 粒米">
            <Plus size={12} />投喂 5k
          </button>
          <button className="wb-foot-btn" onClick={onOpenCommandPalette} title="打开命令面板（⌘K）">
            <Search size={12} />命令
          </button>
        </div>
      </div>
    </aside>
  );
}
