/**
 * 服务商页两个弹窗（T-M6-26 合并：自定义服务商 + 导入）。
 * 全部状态与提交动作由容器通过 props 传入。
 */
import { Database, Download, FileJson, Info, RefreshCw, X } from 'lucide-react';
import type { ImportScanView } from '../bridge';
import { EmptyState } from './ui';
import type { Protocol } from './catalog';

/**
 * 导入外部配置弹窗（T-M6-26 自 providers-panel.tsx 拆出）：
 * Magpie / CC Switch / 手动 JSON-DB 只读扫描、待导入项勾选预览、同名冲突策略与加密导入。
 * 扫描/应用等主进程 IPC 与状态全部留在容器。
 */

interface ImportDialogProps {
  source: 'magpie' | 'ccswitch' | 'file';
  scan: ImportScanView | null;
  selected: Set<string>;
  policy: 'skip' | 'overwrite';
  busy: boolean;
  onClose: () => void;
  onSelectSource: (source: 'magpie' | 'ccswitch') => void;
  onPickFile: () => void;
  onToggle: (id: string) => void;
  onPolicy: (policy: 'skip' | 'overwrite') => void;
  onApply: () => void;
}

export function ImportDialog({
  source, scan, selected, policy, busy, onClose, onSelectSource, onPickFile, onToggle, onPolicy, onApply,
}: ImportDialogProps): React.JSX.Element {
  return (
    <div className="fixed inset-0 z-[150] flex items-center justify-center" style={{ background: 'rgba(0,0,0,.52)', backdropFilter: 'blur(6px)' }} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-[560px] max-w-[92vw] rounded-2xl p-5" style={{ background: 'var(--bg-elev)', border: '1px solid var(--stroke-2)', boxShadow: 'var(--shadow-2)' }}>
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-[15px] font-semibold">导入外部配置（Magpie / CC Switch）</h3>
          <button className="icon-btn" onClick={onClose}><X size={14} /></button>
        </div>
        <div className="mb-3">
          <div className="mb-1.5 text-[11.5px] font-semibold" style={{ color: 'var(--text-2)' }}>选择来源（主进程只读解析，绝不修改原配置）</div>
          <div className="flex flex-wrap gap-1.5">
            <button className={`pill${source === 'magpie' ? ' pill-blue' : ''}`} style={{ fontSize: 11 }} onClick={() => onSelectSource('magpie')}>
              <FileJson size={11} />Magpie
            </button>
            <button className={`pill${source === 'ccswitch' ? ' pill-blue' : ''}`} style={{ fontSize: 11 }} onClick={() => onSelectSource('ccswitch')}>
              <Database size={11} />CC Switch
            </button>
            <button className={`pill${source === 'file' ? ' pill-blue' : ''}`} style={{ fontSize: 11 }} onClick={onPickFile}>
              <Download size={11} />手动选 JSON / DB
            </button>
          </div>
          <div className="mono mt-1.5 flex items-center gap-1.5 text-[10.5px]" style={{ color: scan?.ok ? 'var(--green)' : scan === null ? 'var(--text-3)' : 'var(--red)' }}>
            {busy ? <RefreshCw size={11} /> : <Info size={11} />}
            {busy ? '只读扫描中…' : scan?.ok ? `已读取 ${scan.detectedPath || '手动文件'} · 发现 ${scan.items.length} 个可导入服务商` : (scan?.error ?? '等待扫描')}
          </div>
        </div>
        <div className="mb-3">
          <div className="mb-1.5 flex items-center justify-between text-[11.5px] font-semibold" style={{ color: 'var(--text-2)' }}>
            <span>预览待导入项（勾选需迁移的服务商）</span>
            <span className="mono font-normal" style={{ color: 'var(--text-3)' }}>已选 {selected.size} 项</span>
          </div>
          <div className="card max-h-[220px] overflow-y-auto">
            {scan?.items.map((item) => (
              <div
                key={item.id}
                className="flex cursor-pointer items-center gap-2 px-3 py-2"
                style={{ borderBottom: '1px solid var(--stroke)' }}
                onClick={() => onToggle(item.id)}
              >
                <input type="checkbox" checked={selected.has(item.id)} readOnly style={{ accentColor: 'var(--blue)' }} />
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 text-[12.5px] font-semibold">
                    {item.name}
                    <span className={`pill ${item.protocol === 'anthropic' ? 'pill-amber' : 'pill-green'}`} style={{ fontSize: 9.5 }}>{item.protocol}</span>
                  </div>
                  <div className="mono mt-0.5 truncate text-[10.5px]" style={{ color: 'var(--text-3)' }}>
                    {item.baseUrl} · {item.models.length} 个模型 · {item.hasKey ? `凭据 ${item.keyMask}` : '无凭据'}
                  </div>
                </div>
                <div className="flex-1" />
                <span className={`pill ${item.matchedBuiltin ? 'pill-blue' : 'pill-violet'}`} style={{ fontSize: 9.5 }}>
                  {item.matchedBuiltin ? '匹配内置项' : '新增为自定义'}
                </span>
              </div>
            ))}
            {scan !== null && scan.items.length === 0 && (
              <EmptyState className="px-4 py-5 text-center text-[12px]">没有可导入的服务商</EmptyState>
            )}
          </div>
        </div>
        <div className="mb-4">
          <div className="mb-1.5 text-[11.5px] font-semibold" style={{ color: 'var(--text-2)' }}>同名服务商冲突策略</div>
          <div className="flex flex-wrap gap-1.5">
            <button className={`pill${policy === 'skip' ? ' pill-blue' : ''}`} style={{ fontSize: 11 }} onClick={() => onPolicy('skip')}>跳过已有凭据（默认安全）</button>
            <button className={`pill${policy === 'overwrite' ? ' pill-blue' : ''}`} style={{ fontSize: 11 }} onClick={() => onPolicy('overwrite')}>覆盖已有凭据与地址</button>
          </div>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-[11px]" style={{ color: 'var(--text-3)' }}>导入后自动加密转存至本机安全存储</span>
          <div className="flex gap-2">
            <button className="btn-pill ghost" onClick={onClose}>取消</button>
            <button className="btn-pill primary" onClick={onApply} disabled={busy || selected.size === 0} data-import-apply>
              <Download size={13} />加密导入所选
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * 添加自定义服务商弹窗（T-M6-26 自 providers-panel.tsx 拆出）：
 * 名称 / 协议 / Base URL（支持 curl、export 智能粘贴）/ 完整端点开关 / 初始模型 ID。
 * 草稿状态与创建副作用（Dexie + toast + 选中新条目）由容器持有。
 */

interface CustomProviderDialogProps {
  name: string;
  protocol: Protocol;
  url: string;
  fullUrl: boolean;
  models: string;
  onName: (value: string) => void;
  onProtocol: (protocol: Protocol) => void;
  onUrl: (value: string) => void;
  onPaste: (event: React.ClipboardEvent<HTMLInputElement>) => void;
  onFullUrl: (checked: boolean) => void;
  onModels: (value: string) => void;
  onClose: () => void;
  onCreate: () => void;
}

export function CustomProviderDialog({
  name, protocol, url, fullUrl, models, onName, onProtocol, onUrl, onPaste, onFullUrl, onModels, onClose, onCreate,
}: CustomProviderDialogProps): React.JSX.Element {
  return (
    <div className="fixed inset-0 z-[150] flex items-center justify-center" style={{ background: 'rgba(0,0,0,.52)', backdropFilter: 'blur(6px)' }} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-[460px] max-w-[92vw] rounded-2xl p-5" style={{ background: 'var(--bg-elev)', border: '1px solid var(--stroke-2)', boxShadow: 'var(--shadow-2)' }}>
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-[15px] font-semibold">添加自定义服务商</h3>
          <button className="icon-btn" onClick={onClose}><X size={14} /></button>
        </div>
        <label className="mb-3 block">
          <span className="mb-1.5 block text-[11.5px] font-semibold" style={{ color: 'var(--text-2)' }}>服务商名称</span>
          <input className="w-full rounded-lg px-3 py-2 text-[12.5px] outline-none" style={{ background: 'var(--inset)', border: '1px solid var(--stroke)', color: 'var(--text-1)' }} value={name} onChange={(e) => onName(e.target.value)} placeholder="例如：自建 vLLM / 团队中转网关" data-new-name />
        </label>
        <div className="mb-3">
          <span className="mb-1.5 block text-[11.5px] font-semibold" style={{ color: 'var(--text-2)' }}>接口协议</span>
          <div className="flex flex-wrap gap-1.5">
            {(['openai', 'anthropic'] as const).map((p) => (
              <button key={p} className={`pill${protocol === p ? ' pill-blue' : ''}`} style={{ fontSize: 11 }} onClick={() => onProtocol(p)} data-new-proto={p}>
                {p === 'anthropic' ? 'Anthropic 兼容 (/messages)' : 'OpenAI 兼容 (/chat/completions)'}
              </button>
            ))}
          </div>
        </div>
        <label className="mb-1 block">
          <span className="mb-1.5 block text-[11.5px] font-semibold" style={{ color: 'var(--text-2)' }}>接口地址（Base URL）</span>
          <input
            className="w-full rounded-lg px-3 py-2 font-mono text-[12.5px] outline-none"
            style={{ background: 'var(--inset)', border: '1px solid var(--stroke)', color: 'var(--text-1)' }}
            value={url}
            onChange={(e) => onUrl(e.target.value)}
            onPaste={onPaste}
            placeholder="支持直接粘贴 curl / export 命令自动填充，例如：http://127.0.0.1:8000/v1"
            data-new-url
          />
        </label>
        <label className="mb-3 flex cursor-pointer items-center gap-2 text-[11.5px]" style={{ color: 'var(--text-2)' }}>
          <input type="checkbox" checked={fullUrl} onChange={(e) => onFullUrl(e.target.checked)} style={{ accentColor: 'var(--blue)' }} />
          完整端点地址（不自动拼接 /chat/completions 或 /messages）
        </label>
        <label className="mb-1 block">
          <span className="mb-1.5 block text-[11.5px] font-semibold" style={{ color: 'var(--text-2)' }}>初始模型 ID（可选，逗号分隔）</span>
          <input className="w-full rounded-lg px-3 py-2 font-mono text-[12.5px] outline-none" style={{ background: 'var(--inset)', border: '1px solid var(--stroke)', color: 'var(--text-1)' }} value={models} onChange={(e) => onModels(e.target.value)} placeholder="例如：deepseek-v4-flash, qwen3-32b" data-new-models />
        </label>
        <div className="mt-4 flex justify-end gap-2">
          <button className="btn-pill ghost" onClick={onClose}>取消</button>
          <button className="btn-pill primary" onClick={onCreate} data-create-provider>创建并配置</button>
        </div>
      </div>
    </div>
  );
}
