/**
 * ⌘K 命令面板（v4 设计稿 / 基于开源库 `cmdk`，不手写键盘导航与过滤）。
 * 职责：页面快速跳转 + 全局动作（语音/大脑/自动驾驶/投喂/主题）。
 * 视觉：复用 design-tokens.css 的 .wb-cmdk* 材质类。
 */
import { Command } from 'cmdk';
import type { LucideIcon } from 'lucide-react';

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
}

export function CommandPalette({ open, onOpenChange, actions }: CommandPaletteProps): React.JSX.Element {
  const groups = [...new Set(actions.map((a) => a.group))];
  return (
    <Command.Dialog open={open} onOpenChange={onOpenChange} label="命令面板">
      <div className="wb-cmdk-head">
        <span style={{ color: 'var(--blue)', fontSize: 12, fontFamily: 'var(--font-ui)' }}>⌘K</span>
        <Command.Input autoFocus placeholder="输入页面名称或动作，如 声音、记忆、星露谷、投喂…" />
        <span className="pill" style={{ fontSize: 10 }}>ESC</span>
      </div>
      <Command.List className="wb-cmdk-list">
        <Command.Empty>
          <div style={{ padding: 18, textAlign: 'center', color: 'var(--text-3)', fontSize: 12 }}>未找到匹配项</div>
        </Command.Empty>
        {groups.map((group) => (
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
    </Command.Dialog>
  );
}
