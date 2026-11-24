/**
 * 插件与权限策略（v4 设计稿 09）：插件热开关（影响侧栏/页面可见性）+ 只读策略表。
 * 插件模型对齐 plugin-kit（manifest/defineTool/事件总线），热插拔执行点由主进程承载（T-M6-01 收尾）。
 */
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  AudioLines, Blocks, Brain, Cpu, Fish, Flame, MessageSquare, MonitorPlay, Package, Play, RefreshCw, ShieldCheck, Sprout, Swords, Terminal,
  type LucideIcon,
} from 'lucide-react';

export interface PluginCatalogItem {
  id: string;
  name: string;
  tag: string;
  desc: string;
  icon: LucideIcon;
  group: string;
  permissions: string;
}

export const PLUGIN_CATALOG: PluginCatalogItem[] = [
  { id: 'chat', name: '聊天 · 小鲸', tag: '核心', group: '交互中枢', icon: MessageSquare, desc: 'LLM 回话、内心戏、指令插队与记忆注入', permissions: 'llm/* · memory/*' },
  { id: 'memory', name: '记忆图谱与日记', tag: '内置', group: '交互中枢', icon: Brain, desc: 'JSONL 图谱、换日日记、混合检索与钉住', permissions: 'fs/memory/*' },
  { id: 'voice', name: '语音中心', tag: '内置', group: '桌宠与声音', icon: AudioLines, desc: '5×5 试听矩阵、TTS 调音台、RVC 实验室', permissions: 'audio/*' },
  { id: 'pet', name: '桌宠工坊', tag: '核心', group: '桌宠与声音', icon: Fish, desc: '114 动作、双轨气泡、语音锁与饭碗挂件', permissions: 'fs/assets/*' },
  { id: 'stardew', name: '星露谷共玩', tag: 'dsh', group: '游戏与直播', icon: Sprout, desc: 'BWF MCP 自动驾驶、LLM 规划器与攻略注入', permissions: 'net/mcp/* · llm/*' },
  { id: 'terraria', name: '泰拉瑞亚共玩', tag: 'M7', group: '游戏与直播', icon: Swords, desc: 'tModLoader 模组桥、寻路与生存反射', permissions: 'net/http/* · llm/*' },
  { id: 'dst', name: '饥荒 DST 共玩', tag: 'M7', group: '游戏与直播', icon: Flame, desc: '本地专用服 + Lua 模组 + sidecar 桥', permissions: 'net/http/* · llm/*' },
  { id: 'mods', name: 'Mod 管理', tag: '内置', group: '游戏与直播', icon: Package, desc: 'SMAPI 目录扫描、启停与 ZIP 安装', permissions: 'fs/mods/*' },
  { id: 'obs', name: 'OBS 挂件', tag: 'dsh', group: '游戏与直播', icon: MonitorPlay, desc: '18765 透明源：双轨气泡/议会/歌词/饭碗', permissions: 'net/stage/*' },
  { id: 'harness', name: 'Harness', tag: 'dsh', group: '平台与底层', icon: Terminal, desc: 'ACP agents 握手、事件流与 Y/N/A 审批', permissions: 'shell/agent/*' },
  { id: 'providers', name: '模型供应商', tag: '核心', group: '平台与底层', icon: Cpu, desc: '干饭套餐、六槽位绑定与 safeStorage 凭据', permissions: 'vault://*' },
];

const POLICY: Array<{ resource: string; rule: 'allow' | 'ask' | 'deny'; note: string }> = [
  { resource: 'fs/memory/* · fs/mods/*', rule: 'allow', note: '用户数据目录内读写' },
  { resource: 'net/mcp/* · net/stage/*', rule: 'allow', note: '仅回环地址' },
  { resource: 'vault://*', rule: 'deny', note: '密钥永不进插件（单咽喉）' },
  { resource: 'shell://*', rule: 'ask', note: '命令执行需审批卡' },
  { resource: 'llm/*', rule: 'allow', note: '统一走 model-gateway 记账' },
];

const EXT_POINTS = ['sidebar.item', 'panel.route', 'aside.card', 'tool.defineTool', 'bus.on', 'pet.*'];

export interface PluginsPanelProps {
  enabled: Set<string>;
  onToggle: (id: string, enabled: boolean) => void;
}

interface ExternalPlugin {
  id: string;
  name: string;
  version: string;
  description: string;
  enabled: boolean;
  tools: string[];
  error?: string;
}
interface PluginToolEntry {
  name: string;
  pluginId: string;
  policy: 'allow' | 'ask' | 'deny';
  description: string;
}

export function PluginsPanel({ enabled, onToggle }: PluginsPanelProps): React.JSX.Element {
  const activeCount = PLUGIN_CATALOG.filter((p) => enabled.has(p.id)).length;
  const [external, setExternal] = useState<ExternalPlugin[]>([]);
  const [tools, setTools] = useState<PluginToolEntry[]>([]);
  const [errors, setErrors] = useState<Array<{ id: string; error: string; phase: string }>>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback((): void => {
    void Promise.all([
      window.directorBridge.pluginList(),
      window.directorBridge.pluginTools(),
      window.directorBridge.pluginErrors(),
    ]).then(([list, toolList, errorList]) => {
      setExternal(list);
      setTools(toolList);
      setErrors(errorList);
    }).catch(() => undefined);
  }, []);
  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 10_000);
    window.directorBridge.onPluginEvent(() => refresh());
    return () => clearInterval(timer);
  }, [refresh]);

  const toggleExternal = (id: string, next: boolean): void => {
    setBusy(id);
    void window.directorBridge.pluginToggle(id, next).then((res) => {
      if (!res.ok) toast.error(res.error ?? '插件操作失败');
      else toast.success(`${id} 已${next ? '启用' : '停用'}`);
    }).finally(() => { setBusy(null); refresh(); });
  };
  const callTool = async (tool: PluginToolEntry): Promise<void> => {
    setBusy(tool.name);
    if (tool.policy === 'ask') {
      const approved = await window.directorBridge.pluginApprove(tool.name);
      if (!approved.ok) { toast.error(approved.error ?? '审批失败'); setBusy(null); return; }
      toast('已批准本次会话内调用该工具');
    }
    const res = await window.directorBridge.pluginInvoke(tool.name, {});
    toast(res.ok ? `${tool.name} → ${JSON.stringify(res.result ?? null).slice(0, 80)}` : `${tool.name}：${res.error ?? '调用失败'}`);
    setBusy(null);
  };
  return (
    <div className="mx-auto max-w-[1000px] px-6 py-5">
      <header className="mb-4">
        <h1 className="flex items-center gap-2 text-xl font-semibold"><Blocks size={18} /> 插件与权限策略</h1>
        <p className="mt-1 text-xs" style={{ color: 'var(--text-2)' }}>
          {activeCount} enabled / {PLUGIN_CATALOG.length - activeCount} disabled ·
          插件启停即时影响侧栏与页面可见性（运行期热插拔由 plugin-kit 承接）
        </p>
      </header>

      <div className="card mb-4 overflow-hidden">
        {PLUGIN_CATALOG.map((p) => {
          const Icon = p.icon;
          const on = enabled.has(p.id);
          return (
            <div
              key={p.id}
              data-plugin={p.id}
              className="flex items-center gap-3 px-4 py-3"
              style={{ borderBottom: '1px solid var(--stroke)', opacity: on ? 1 : 0.65 }}
            >
              <span className="grid h-8 w-8 place-items-center rounded-lg" style={{ background: on ? 'var(--blue-dim)' : 'var(--inset)', color: on ? 'var(--blue)' : 'var(--text-3)' }}>
                <Icon size={15} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-[12.5px] font-semibold">{p.name}</span>
                  <span className="pill" style={{ fontSize: 9, padding: '1px 7px' }}>{p.tag}</span>
                  <span className="pill" style={{ fontSize: 9, padding: '1px 7px' }}>{p.group}</span>
                </div>
                <div className="mt-0.5 truncate text-[11px]" style={{ color: 'var(--text-3)' }}>{p.desc}</div>
              </div>
              <span className="mono hidden text-[10px] md:block" style={{ color: 'var(--text-3)' }}>{p.permissions}</span>
              <button
                className={`sw${on ? ' on' : ''}`}
                aria-pressed={on}
                aria-label={`${on ? '停用' : '启用'}${p.name}`}
                onClick={() => onToggle(p.id, !on)}
              />
            </div>
          );
        })}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <section className="card px-4 py-3.5">
          <h3 className="mb-2.5 text-xs font-semibold" style={{ color: 'var(--text-2)' }}>Policy（单咽喉 · 只读预览）</h3>
          {POLICY.map((row) => (
            <div key={row.resource} className="flex items-center gap-2 py-1.5 text-[11px]" style={{ borderBottom: '1px solid var(--stroke)' }}>
              <span className="mono min-w-0 flex-1 truncate" style={{ color: 'var(--text-2)' }}>{row.resource}</span>
              <span className="hidden text-[10px] lg:block" style={{ color: 'var(--text-3)' }}>{row.note}</span>
              <span className={`pill pill-${row.rule === 'allow' ? 'green' : row.rule === 'ask' ? 'amber' : 'red'}`} style={{ fontSize: 9, padding: '1px 8px' }}>
                {row.rule}
              </span>
            </div>
          ))}
        </section>

        <section className="card px-4 py-3.5">
          <h3 className="mb-2.5 text-xs font-semibold" style={{ color: 'var(--text-2)' }}>六大扩展点</h3>
          <div className="grid grid-cols-2 gap-1.5">
            {EXT_POINTS.map((ext) => (
              <div key={ext} className="inset mono px-2.5 py-2 text-[10.5px]" style={{ color: 'var(--text-2)' }}>{ext}</div>
            ))}
          </div>
          <p className="mt-2.5 text-[10.5px] leading-relaxed" style={{ color: 'var(--text-3)' }}>
            dsh 兼容层已由 plugin-kit 提供（manifest / defineTool / domain:* 总线）；host 三层的装载与热插拔在 T-M6-01 收尾。
          </p>
        </section>
      </div>

      <section className="card mt-4 overflow-hidden" data-external-plugins>
        <div className="flex items-center gap-2 px-4 py-3" style={{ borderBottom: '1px solid var(--stroke)' }}>
          <Package size={14} />
          <h3 className="text-xs font-semibold">外部插件（userData/plugins）</h3>
          <span className="pill" style={{ fontSize: 9 }}>{external.length} found</span>
          <div className="flex-1" />
          <button className="pill" onClick={refresh} title="重新扫描插件目录"><RefreshCw size={11} />刷新</button>
        </div>
        {external.length === 0 && (
          <p className="px-4 py-3 text-[11px]" style={{ color: 'var(--text-3)' }}>
            尚无外部插件。将 dsh 形态插件放入 <span className="mono">userData/plugins/&lt;id&gt;/manifest.json</span> 与 <span className="mono">index.mjs</span> 后点刷新。
          </p>
        )}
        {external.map((p) => (
          <div key={p.id} data-external-plugin={p.id} className="px-4 py-3" style={{ borderBottom: '1px solid var(--stroke)' }}>
            <div className="flex items-center gap-2">
              <span className="text-[12.5px] font-semibold">{p.name}</span>
              <span className="mono text-[10px]" style={{ color: 'var(--text-3)' }}>{p.id}@{p.version}</span>
              <div className="flex-1" />
              <button
                className={`sw${p.enabled ? ' on' : ''}`}
                aria-pressed={p.enabled}
                aria-label={`${p.enabled ? '停用' : '启用'}${p.name}`}
                disabled={busy === p.id}
                onClick={() => toggleExternal(p.id, !p.enabled)}
              />
            </div>
            <p className="mt-0.5 text-[11px]" style={{ color: 'var(--text-3)' }}>{p.description}</p>
            {p.error !== undefined && <p className="mt-1 text-[11px]" style={{ color: 'var(--red)' }}>{p.error}</p>}
            {p.tools.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {p.tools.map((name) => {
                  const tool = tools.find((t) => t.name === name);
                  return (
                    <button
                      key={name}
                      className="pill"
                      data-plugin-tool={name}
                      disabled={!p.enabled || busy === name}
                      onClick={() => { if (tool !== undefined) void callTool(tool); }}
                      title={tool?.description ?? name}
                    >
                      {tool?.policy === 'ask' ? <ShieldCheck size={10} /> : <Play size={10} />}{name}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        ))}
        {errors.length > 0 && (
          <div className="px-4 py-2.5 text-[11px]" style={{ color: 'var(--amber)' }}>
            <div className="mb-1 flex items-center gap-2">运行期错误 {errors.length}
              <button className="pill" onClick={() => { window.directorBridge.pluginClearErrors(); refresh(); }}>清空</button>
            </div>
            {errors.slice(-5).map((e, i) => <div key={i} className="mono truncate" title={e.error}>{e.id} [{e.phase}] {e.error.slice(0, 140)}</div>)}
          </div>
        )}
      </section>
    </div>
  );
}
