/**
 * 「默认模型」Tab（T-M6-26 自 providers-panel.tsx 拆出）：
 * 八槽位绑定（LLM / 视觉 / TTS / SVC）、自动挑选开关展示、一键智能分配与全部跟随主脑。
 * 选择变更（含自动挑选开关的 Dexie 持久化）由容器处理，本组件只负责渲染与事件上抛。
 */
import { Database, SlidersHorizontal, Sparkles } from 'lucide-react';
import type { WorkbenchRoleSlot } from '@workbench/shared-protocol';
import { SLOT_META } from './catalog';
import type { SlotOption } from './catalog';

interface Props {
  slotOptions: SlotOption[];
  roleBindings: Partial<Record<WorkbenchRoleSlot, string>>;
  autoFlags: Partial<Record<WorkbenchRoleSlot, boolean>>;
  enabledCount: number;
  configuredCount: number;
  onAutoAssign: () => void;
  onSyncAllMain: () => void;
  onSlotChange: (slot: WorkbenchRoleSlot, value: string) => void;
}

export function SlotsTab({
  slotOptions, roleBindings, autoFlags, enabledCount, configuredCount, onAutoAssign, onSyncAllMain, onSlotChange,
}: Props): React.JSX.Element {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-7 pb-12 pt-6">
      <div className="mx-auto max-w-[780px]">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2.5">
          <div>
            <div className="text-sm font-semibold">功能默认模型</div>
            <div className="mt-0.5 text-[11.5px]" style={{ color: 'var(--text-3)' }}>仅从已启用的服务商模型中选择，修改后自动保存并立即同步主脑路由</div>
          </div>
          <button className="btn-pill ghost" onClick={onAutoAssign} data-auto-assign>
            <Sparkles size={12} />一键智能分配
          </button>
          <button className="btn-pill ghost" onClick={onSyncAllMain} data-sync-all-main>
            <SlidersHorizontal size={12} />文本角色全部跟随主脑
          </button>
        </div>

        {(['llm', 'audio'] as const).map((group) => (
          <div key={group}>
            <div className="mb-2 mt-4 text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-3)' }}>
              {group === 'llm' ? '对话与推理（LLM / 视觉）' : '语音合成与演唱（TTS / SVC）'}
            </div>
            <div className="card overflow-hidden">
              {SLOT_META.filter((s) => s.group === group).map((meta) => {
                const Icon = meta.icon;
                const options = slotOptions.filter((o) => o.audio === (group === 'audio'));
                const current = roleBindings[meta.slot] ?? '';
                const optionExists = options.some((o) => o.value === current);
                return (
                  <div key={meta.slot} className="grid items-center gap-4 px-4 py-3" style={{ gridTemplateColumns: '1fr 300px', borderBottom: '1px solid var(--stroke)' }}>
                    <div className="flex min-w-0 items-center gap-2.5">
                      <span className="grid h-8 w-8 place-items-center rounded-lg" style={{ background: 'var(--inset)', border: '1px solid var(--stroke)', color: 'var(--blue)' }}>
                        <Icon size={14} />
                      </span>
                      <div className="min-w-0">
                        <div className="text-[13px] font-semibold">{meta.name}</div>
                        <div className="mt-0.5 text-[11px]" style={{ color: 'var(--text-3)' }}>{meta.desc}</div>
                      </div>
                    </div>
                    <select
                      data-slot-select={meta.slot}
                      className="w-full rounded-lg px-2.5 py-2 font-mono text-[12px] outline-none"
                      style={{ background: 'var(--inset)', border: '1px solid var(--stroke)', color: 'var(--text-1)' }}
                      value={autoFlags[meta.slot] === true ? 'auto' : optionExists ? current : ''}
                      onChange={(e) => onSlotChange(meta.slot, e.target.value)}
                    >
                      <option value="auto">自动挑选{autoFlags[meta.slot] === true && current !== '' ? ` → ${current.split('/').pop() ?? ''}` : '（按测试结果）'}</option>
                      <option value="">（未绑定）</option>
                      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  </div>
                );
              })}
            </div>
          </div>
        ))}

        <div className="mt-4 flex items-center gap-2 text-[11px]" style={{ color: 'var(--text-3)' }}>
          <Database size={12} />{enabledCount} 家服务商已启用 · {configuredCount} 家已配置凭据 · 槽位改动即时写 Dexie 并热更新主脑
        </div>
      </div>
    </div>
  );
}
