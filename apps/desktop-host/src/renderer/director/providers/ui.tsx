/**
 * 服务商页公共小组件（T-M6-26 自 providers-panel.tsx 拆出）：
 * logo 兜底图标、侧栏服务商行、顶部状态条与空态。全部只接收渲染所需 props。
 */
import { CheckCircle2, Info, type LucideIcon } from 'lucide-react';
import type { UiProvider } from './catalog';

/** logo 优先、lucide 兜底的供应商图标；className 控制外框尺寸与圆角 */
export function ProviderLogo({ src, icon: Icon, size = 14, className = '' }: { src?: string; icon: LucideIcon; size?: number; className?: string }): React.JSX.Element {
  return src !== undefined
    ? <img src={src} alt="" className={`object-contain ${className}`} style={{ width: size, height: size }} />
    : <Icon size={size} />;
}

/** 侧栏供应商行（与「已关闭」折叠子区共用；dimmed = Magpie 停用沉降态） */
export function ProviderRow({ p, activeId, dimmed, onSelect }: { p: UiProvider; activeId: string | undefined; dimmed?: boolean; onSelect: () => void }): React.JSX.Element {
  const Icon = p.icon;
  const on = p.id === activeId;
  return (
    <button
      data-provider-item={p.id}
      data-active={on ? 'true' : 'false'}
      onClick={onSelect}
      className="mb-0.5 flex w-full items-center gap-2.5 rounded-xl px-2.5 py-[7px] text-left text-[12.5px] transition-colors"
      style={on ? { background: 'var(--blue-dim)', color: 'var(--blue)', fontWeight: 600 } : { color: 'var(--text-2)', opacity: dimmed === true ? 0.55 : 1 }}
    >
      <span
        className="grid h-6 w-6 place-items-center rounded-lg"
        style={{ background: p.logoSrc !== undefined ? '#fff' : on ? 'var(--blue-dim)' : 'var(--inset)', border: `1px solid ${on ? 'var(--blue-line)' : 'var(--stroke)'}` }}
      >
        <ProviderLogo src={p.logoSrc} icon={Icon} size={p.logoSrc !== undefined ? 15 : 12} />
      </span>
      <span className="flex-1 truncate">{p.name}</span>
      <span
        className="h-1.5 w-1.5 rounded-full"
        style={{ background: p.enabled && p.configured ? 'var(--green)' : 'var(--text-3)', opacity: p.enabled && p.configured ? 1 : 0.3, boxShadow: p.enabled && p.configured ? '0 0 6px var(--green)' : 'none' }}
      />
    </button>
  );
}

/** 顶部内联状态条（保存/检测/余额结论）；由容器决定何时渲染 */
export function NoticeBar({ notice }: { notice: { kind: 'ok' | 'err' | 'info'; text: string } }): React.JSX.Element {
  return (
    <div
      data-provider-notice
      className="mono mx-6 mt-3 flex items-center gap-2 rounded-xl px-3 py-2 text-[11px]"
      style={{
        background: notice.kind === 'ok' ? 'var(--green-dim)' : notice.kind === 'err' ? 'var(--red-dim)' : 'var(--blue-dim)',
        border: `1px solid ${notice.kind === 'ok' ? 'var(--green-line)' : notice.kind === 'err' ? 'var(--red-line)' : 'var(--blue-line)'}`,
        color: notice.kind === 'ok' ? 'var(--green)' : notice.kind === 'err' ? 'var(--red)' : 'var(--blue)',
      }}
    >
      {notice.kind === 'ok' ? <CheckCircle2 size={12} /> : <Info size={12} />}
      {notice.text}
    </div>
  );
}

/** 列表空态（默认样式与模型列表/服务商详情一致；导入预览等用 className 覆盖内边距） */
export function EmptyState({ children, className = 'px-4 py-6 text-center text-[12px]' }: { children: React.ReactNode; className?: string }): React.JSX.Element {
  return <div className={className} style={{ color: 'var(--text-3)' }}>{children}</div>;
}
