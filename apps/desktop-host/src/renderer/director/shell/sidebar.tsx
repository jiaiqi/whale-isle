/**
 * Tidepaper v3.1 侧栏：
 * - 墨色方块 mark + 衬线「鲸屿」+ 小型大写「WHALE ISLE · V2」
 * - IA 按 此刻 / 角色 / 化身 / 生活 / 能力 / 治理 分组（只放已实现页，空组自动隐藏）
 * - 底部 rail-me：小鲸待机动画角色卡，点击向上弹出角色菜单 + 紧凑赛博饭碗
 */
import { useEffect, useRef, useState } from 'react';
import {
  AudioLines, Bot, ChevronsUpDown, Compass, Database, Gamepad2, MessageCircle, Music4, Plus, Puzzle,
  Radio, Search, Shapes, SquareTerminal, Users, Wheat,
  type LucideIcon,
} from 'lucide-react';
import { APP_NAME, APP_TAGLINE, whaleMarkPaths } from '../../../shared/brand';
import type { CharacterSummary } from '../bridge';

export type Tab =
  | 'chat' | 'life' | 'memory' | 'voice' | 'pet' | 'stardew' | 'terraria' | 'dst' | 'mods' | 'coop' | 'obs' | 'song' | 'harness' | 'providers' | 'plugins';

export interface NavItem {
  id: Tab;
  label: string;
  icon: LucideIcon;
  group: string;
  live?: boolean;
}

export const NAV_GROUPS: Array<{ label: string; items: NavItem[] }> = [
  {
    label: '此刻',
    items: [
      { id: 'life', label: '生命中枢', icon: Compass, group: '此刻' },
      { id: 'chat', label: '对话', icon: MessageCircle, group: '此刻' },
    ],
  },
  {
    label: '角色',
    items: [
      { id: 'voice', label: '声音与表演', icon: AudioLines, group: '角色' },
      { id: 'memory', label: '记忆', icon: Database, group: '角色' },
    ],
  },
  {
    label: '化身',
    items: [
      { id: 'pet', label: '桌宠工坊', icon: Shapes, group: '化身' },
    ],
  },
  {
    label: '生活',
    items: [
      { id: 'stardew', label: '游戏共玩', icon: Gamepad2, group: '生活', live: true },
      { id: 'coop', label: '联机协作', icon: Users, group: '生活' },
      { id: 'obs', label: '直播与 OBS', icon: Radio, group: '生活' },
      { id: 'song', label: '点歌台', icon: Music4, group: '生活' },
    ],
  },
  {
    label: '能力',
    items: [
      { id: 'providers', label: '模型与饭碗', icon: Bot, group: '能力' },
      { id: 'plugins', label: '插件 · MCP · 技能', icon: Puzzle, group: '能力' },
      { id: 'harness', label: 'Harness 智能体', icon: SquareTerminal, group: '能力' },
    ],
  },
  // 治理：P3-03 设备与租约、P4 安全与授权 / 进化引擎落地后放入；组内无项时自动隐藏
  { label: '治理', items: [] },
];

const MARK = whaleMarkPaths();
const PET_ASSET = '../pet-stage/assets/blue-whale-maid/';
const IDLE_CLIP = `${PET_ASSET}${encodeURIComponent('待机呼吸休闲')}.webm`;

function BrandMark(): React.JSX.Element {
  return (
    <span className="mark" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none">
        <path d={MARK.tail} fill="currentColor" />
        <path d={MARK.body} fill="currentColor" />
        <path d={MARK.band} stroke="var(--inverse)" strokeWidth={1.7} strokeLinecap="round" />
        <circle cx={MARK.eye.cx} cy={MARK.eye.cy} r={MARK.eye.r} fill="var(--inverse)" />
        <circle cx={MARK.glint.cx} cy={MARK.glint.cy} r={MARK.glint.r} fill="currentColor" />
      </svg>
    </span>
  );
}

/** 底部角色卡的小鲸待机动画；加载失败或减少动效时回退为首字头像 */
function RailAvatar({ name }: { name: string }): React.JSX.Element {
  const [failed, setFailed] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const apply = (): void => {
      const video = videoRef.current;
      if (video === null) return;
      if (mq.matches) video.pause();
      else void video.play().catch(() => undefined);
    };
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);

  return (
    <span className="pv" aria-hidden="true">
      {failed
        ? <span className="fallback">{name.slice(0, 1)}</span>
        : (
          <video
            ref={videoRef}
            src={IDLE_CLIP}
            muted
            loop
            autoPlay
            playsInline
            preload="metadata"
            onError={() => setFailed(true)}
          />
        )}
    </span>
  );
}

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
  /** 主角色当前活动/心情摘要 */
  presenceSummary?: string;
}

export function Sidebar({
  tab, onSelect, running, rice, riceCap, onFeed, onOpenCommandPalette, isPluginEnabled,
  characters, characterId, onSelectCharacter, badges, presenceSummary,
}: SidebarProps): React.JSX.Element {
  const pct = Math.min(100, Math.round((rice / riceCap) * 100));
  const [characterMenuOpen, setCharacterMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ left: number; bottom: number } | null>(null);
  const characterMenuRef = useRef<HTMLDivElement>(null);
  const switchRef = useRef<HTMLButtonElement>(null);
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

  const toggleCharacterMenu = (): void => {
    if (characters.length === 0) return;
    if (characterMenuOpen) {
      setCharacterMenuOpen(false);
      return;
    }
    const rect = switchRef.current?.getBoundingClientRect();
    if (rect !== undefined) {
      setMenuPos({ left: Math.max(8, rect.left), bottom: window.innerHeight - rect.top + 8 });
    }
    setCharacterMenuOpen(true);
  };

  return (
    <aside className="wb-side">
      <div className="wb-brand" title={APP_TAGLINE}>
        <BrandMark />
        <span className="t">
          {APP_NAME}
          <small>Whale Isle · V2</small>
        </span>
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
        <div ref={characterMenuRef}>
          <button
            ref={switchRef}
            type="button"
            data-character-switch
            className="rail-me"
            aria-label={`切换陪伴角色，当前${selectedCharacter?.displayName ?? '未选择'}`}
            aria-haspopup="menu"
            aria-expanded={characterMenuOpen}
            disabled={characters.length === 0}
            onClick={toggleCharacterMenu}
          >
            <RailAvatar name={selectedCharacter?.displayName ?? '鲸'} />
            <span style={{ minWidth: 0, flex: 1 }}>
              <b>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {selectedCharacter?.displayName ?? '小鲸'}
                </span>
              </b>
              <span className="sub">
                <span className="role-tag">主角色</span>
                <span className="sub-text">{presenceSummary ?? '桌面陪伴中 · 本地运行'}</span>
              </span>
            </span>
            <ChevronsUpDown size={13} className="chev" />
          </button>
          {characterMenuOpen && menuPos !== null && (
            <div
              role="menu"
              aria-label="选择陪伴角色"
              className="rail-me-menu"
              style={{ left: menuPos.left, bottom: menuPos.bottom }}
            >
              <div className="menu-eyebrow">切换角色</div>
              {characters.map((character) => (
                <button
                  key={character.id}
                  type="button"
                  role="menuitemradio"
                  data-character-option={character.id}
                  aria-checked={characterId === character.id}
                  onClick={() => { onSelectCharacter(character.id); setCharacterMenuOpen(false); }}
                >
                  <span>{character.displayName}</span>
                  {characterId === character.id && <span className="ml-auto text-[10px]">当前</span>}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="wb-rice-row" style={{ marginTop: 8 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Wheat size={13} style={{ color: 'var(--amber)' }} />赛博饭碗
          </span>
          <b style={{ color: pct <= 15 ? 'var(--amber)' : 'var(--green)' }}>{rice.toLocaleString()} 粒</b>
        </div>
        <div className="wb-rice-bar"><i style={{ width: `${Math.max(4, pct)}%` }} /></div>
        <div className="wb-foot-actions">
          <button className="wb-foot-btn" onClick={onFeed} title="投喂 5,000 粒米">
            <Plus size={12} />投喂
          </button>
          <button className="wb-foot-btn" onClick={onOpenCommandPalette} title="打开命令面板（⌘K）">
            <Search size={12} />⌘K
          </button>
        </div>
      </div>
    </aside>
  );
}
