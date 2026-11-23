/**
 * 服务商目录侧栏（T-M6-26 自 providers-panel.tsx 拆出）：
 * 搜索框 + 云端/自定义/本地三组 + 「已关闭」折叠沉降区 + 添加自定义服务商入口。
 */
import { Plus, Search } from 'lucide-react';
import { ProviderRow } from './ui';
import type { UiGroup, UiProvider } from './catalog';

interface Props {
  providers: UiProvider[];
  activeId: string | undefined;
  search: string;
  onSearch: (value: string) => void;
  onSelect: (id: string) => void;
  onAdd: () => void;
}

const GROUPS: UiGroup[] = ['云端服务', '自定义服务商', '本地引擎'];

export function ProvidersSidebar({ providers, activeId, search, onSearch, onSelect, onAdd }: Props): React.JSX.Element {
  const keyword = search.trim().toLowerCase();
  return (
    <aside className="flex min-h-0 flex-col" style={{ borderRight: '1px solid var(--stroke)', background: 'color-mix(in srgb, var(--bg-elev) 32%, transparent)' }}>
      <div className="flex gap-1.5 px-3 py-2.5" style={{ borderBottom: '1px solid var(--stroke)' }}>
        <div className="flex flex-1 items-center gap-1.5 rounded-lg px-2.5" style={{ background: 'var(--inset)', border: '1px solid var(--stroke)' }}>
          <Search size={12} style={{ color: 'var(--text-3)' }} />
          <input
            data-provider-search
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            placeholder="搜索服务商…"
            className="w-full bg-transparent py-1.5 text-[12px] outline-none"
            style={{ color: 'var(--text-1)' }}
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1.5">
        {GROUPS.map((group) => {
          const list = providers.filter((p) => p.group === group && (keyword === '' || p.name.toLowerCase().includes(keyword)));
          if (list.length === 0) return null;
          // Magpie「Turned off」交互：停用的服务商沉底到折叠子区，不与启用项混排
          const onList = list.filter((p) => p.enabled);
          const offList = list.filter((p) => !p.enabled);
          return (
            <div key={group}>
              <div className="flex justify-between px-2.5 pb-1 pt-2 text-[10px] font-semibold tracking-wider" style={{ color: 'var(--text-3)' }}>
                <span>{group}</span><span className="mono">{list.length}</span>
              </div>
              {onList.map((p) => (
                <ProviderRow key={p.id} p={p} activeId={activeId} onSelect={() => onSelect(p.id)} />
              ))}
              {offList.length > 0 && (
                <div className="mb-1 mt-1.5 rounded-xl px-2.5 py-1 text-[10px]" style={{ background: 'var(--inset)', color: 'var(--text-3)' }} data-off-section={offList.length}>
                  已关闭 · {offList.length}（配置保留，开关随时找回）
                </div>
              )}
              {offList.map((p) => (
                <ProviderRow key={p.id} p={p} activeId={activeId} dimmed onSelect={() => onSelect(p.id)} />
              ))}
            </div>
          );
        })}
      </div>
      <div className="px-3 py-2.5" style={{ borderTop: '1px solid var(--stroke)' }}>
        <button className="btn-pill ghost w-full" onClick={onAdd} data-add-provider>
          <Plus size={13} />添加自定义服务商
        </button>
      </div>
    </aside>
  );
}
