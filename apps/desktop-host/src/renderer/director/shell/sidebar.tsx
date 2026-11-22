/**
 * v4 Shell 左侧栏（设计稿：分组插件导航 + 赛博饭碗 footer）。
 * 插件启停会过滤这里的入口 —— 与「插件与权限」页联动（localStorage 持久）。
 */
import {
  AudioLines, Blocks, Brain, Cpu, Fish, MessageSquare, MonitorPlay, Package, Plus,
  Search, Sprout, Terminal, Wheat,
  type LucideIcon,
} from 'lucide-react';

export type Tab =
  | 'chat' | 'memory' | 'voice' | 'pet' | 'stardew' | 'mods' | 'obs' | 'harness' | 'providers' | 'plugins';

export interface NavItem {
  id: Tab;
  label: string;
  icon: LucideIcon;
  group: string;
  badge?: string;
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
      { id: 'voice', label: '声音工坊与音色库', icon: AudioLines, group: '声形与舞台', badge: '5×5' },
      { id: 'pet', label: '桌宠舞台与动作库', icon: Fish, group: '声形与舞台', badge: '114' },
    ],
  },
  {
    label: '游戏与直播',
    items: [
      { id: 'stardew', label: '星露谷共玩', icon: Sprout, group: '游戏与直播', live: true },
      { id: 'mods', label: 'Mod 管理', icon: Package, group: '游戏与直播' },
      { id: 'obs', label: 'OBS 透明挂件', icon: MonitorPlay, group: '游戏与直播', badge: '18765' },
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

const WHALE_SVG = (
  <svg style={{ width: 22, height: 22, flexShrink: 0 }} viewBox="0 0 24 24" fill="none">
    <path d="M3 12c0-4.4 3.6-8 8-8h5a5 5 0 0 1 5 5c0 6.6-5.4 12-12 12H4l2.5-3.2C4.4 16.3 3 14.3 3 12Z" fill="var(--blue)" opacity=".28" />
    <path d="M3 12c0-4.4 3.6-8 8-8h5a5 5 0 0 1 5 5c0 6.6-5.4 12-12 12H4l2.5-3.2C4.4 16.3 3 14.3 3 12Z" stroke="var(--blue)" strokeWidth="1.55" strokeLinejoin="round" />
    <circle cx="17.5" cy="10.5" r="1" fill="var(--blue)" />
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
  /** 动态 badge 文案（如记忆节点数、Mod 数） */
  badges?: Partial<Record<Tab, string>>;
}

export function Sidebar({
  tab, onSelect, running, rice, riceCap, onFeed, onOpenCommandPalette, isPluginEnabled, badges,
}: SidebarProps): React.JSX.Element {
  const pct = Math.min(100, Math.round((rice / riceCap) * 100));
  return (
    <aside className="wb-side">
      <div className="wb-brand">
        {WHALE_SVG}
        <span className="t">大肥鱼工作台</span>
        <span className="v">v4</span>
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
                const badge = badges?.[item.id] ?? item.badge;
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
