/**
 * ⌘K 命令面板（Tidepaper v3.1 / 基于 cmdk，不手写键盘导航与过滤）。
 * 职责：页面快速跳转 + 全局动作（语音/大脑/自动驾驶/投喂/主题）。
 * 新增：以 `>` 开头时在列表顶部强制渲染「发给小鲸：…」，选中后调用 onSay。
 */
import { useEffect, useState } from 'react';
import { Command } from 'cmdk';
import { Search, Send, type LucideIcon } from 'lucide-react';

export interface CommandAction {
  id: string;
  label: string;
  group: string;
  icon: LucideIcon;
  hint?: string;
  run: () => void;
}

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  actions: CommandAction[];
  /** 可选：以 `>` 开头直接发给小鲸 */
  onSay?: (text: string) => void;
}

export function CommandPalette({ open, onOpenChange, actions, onSay }: CommandPaletteProps): React.JSX.Element {
  const [query, setQuery] = useState('');
  const groups = [...new Set(actions.map((a) => a.group))];
  const sayMode = query.trimStart().startsWith('>');
  const sayText = sayMode ? query.trimStart().slice(1).trim() : '';

  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  return (
    <Command.Dialog open={open} onOpenChange={onOpenChange} label="命令面板">
      <div className="wb-cmdk-head">
        <Search size={15} style={{ color: 'var(--text-3)', flexShrink: 0 }} />
        <Command.Input
          autoFocus
          value={query}
          onValueChange={setQuery}
          placeholder="输入页面名称或动作；以 > 开头直接对小鲸说…"
        />
        <span className="kbd">ESC</span>
      </div>
      <Command.List className="wb-cmdk-list">
        {!sayMode && (
          <Command.Empty>
            <div style={{ padding: 18, textAlign: 'center', color: 'var(--text-3)', fontSize: 12 }}>未找到匹配项</div>
          </Command.Empty>
        )}
        {sayMode && onSay !== undefined && (
          <Command.Group heading="对话" forceMount className="wb-cmdk-group">
            <Command.Item
              forceMount
              value="say-to-whale"
              className="wb-cmdk-item wb-cmdk-say"
              onSelect={() => {
                if (sayText !== '') onSay(sayText);
                onOpenChange(false);
              }}
            >
              <Send size={14} />
              <span>发给小鲸：{sayText === '' ? '…' : sayText}</span>
              <span className="hint">↵</span>
            </Command.Item>
          </Command.Group>
        )}
        {!sayMode && groups.map((group) => (
          <Command.Group key={group} heading={group} className="wb-cmdk-group">
            {actions
              .filter((a) => a.group === group)
              .map((action) => {
                const Icon = action.icon;
                return (
                  <Command.Item
                    key={action.id}
                    value={`${action.label} ${action.group} ${action.hint ?? ''}`}
                    className="wb-cmdk-item"
                    onSelect={() => {
                      action.run();
                      onOpenChange(false);
                    }}
                  >
                    <Icon size={14} />
                    <span>{action.label}</span>
                    <span className="hint">{action.hint ?? action.group}</span>
                  </Command.Item>
                );
              })}
          </Command.Group>
        ))}
      </Command.List>
      <div className="wb-cmdk-foot">
        <span><span className="kbd">↑</span> <span className="kbd">↓</span> 选择</span>
        <span><span className="kbd">↵</span> 执行</span>
        <span className="grow">以 <b>&gt;</b> 开头直接发给小鲸</span>
      </div>
    </Command.Dialog>
  );
}
