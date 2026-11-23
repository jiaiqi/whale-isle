/**
 * 服务商详情区（T-M6-26 自 providers-panel.tsx 拆出）：
 * 详情头（logo/名称/启停/删除）+ 凭据卡片（Key 保存与检测、复制、余额、Key 控制台直达）
 * + Base URL 与协议变体选择。全部数据与副作用回调由容器传入。
 */
import {
  Activity, Check, CheckCircle2, Copy, Database, ExternalLink, Info, Sparkles, Trash2, TriangleAlert,
} from 'lucide-react';
import { BALANCE_SUPPORTED, KEY_URL, safeHostOf } from './catalog';
import { ProviderLogo } from './ui';
import type { Protocol, UiProvider } from './catalog';

interface Props {
  active: UiProvider;
  providerUrl: string;
  keyDraft: string;
  busy: string | null;
  onRename: (name: string) => void;
  onProtocol: (protocol: Protocol) => void;
  onDelete: () => void;
  onToggleEnabled: () => void;
  onKeyDraft: (value: string) => void;
  onSaveAndTest: () => void;
  onOpenKeyConsole: () => void;
  onCopyKey: () => void;
  onCheckBalance: () => void;
  onVariant: (index: number) => void;
  onUrl: (url: string) => void;
  onFullUrl: (checked: boolean) => void;
  onTestLocal: () => void;
}

export function ProviderDetail({
  active, providerUrl, keyDraft, busy,
  onRename, onProtocol, onDelete, onToggleEnabled, onKeyDraft, onSaveAndTest,
  onOpenKeyConsole, onCopyKey, onCheckBalance, onVariant, onUrl, onFullUrl, onTestLocal,
}: Props): React.JSX.Element {
  return (
    <>
      <div className="mb-4 flex items-center gap-3 pb-4" style={{ borderBottom: '1px solid var(--stroke)' }}>
        <span
          className="grid h-10 w-10 place-items-center rounded-xl"
          style={active.logoSrc !== undefined ? { background: '#fff', border: '1px solid var(--stroke-2)' } : { background: 'var(--blue-dim)', border: '1px solid var(--blue-line)', color: 'var(--blue)' }}
        >
          <ProviderLogo src={active.logoSrc} icon={active.icon} size={active.logoSrc !== undefined ? 24 : 18} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="flex flex-wrap items-center gap-2 text-[17px] font-bold">
            {active.name}
            <span className="pill" style={{ fontSize: 10 }}>{active.tag}</span>
          </h2>
          <div className="mt-0.5 text-[11.5px]" style={{ color: 'var(--text-3)' }}>
            {`${safeHostOf(providerUrl)} · ${active.models.length} 模型 · ${active.enabled ? '已启用，可在「默认模型」中选用' : '未启用，开启后进入模型选择器'}`}
          </div>
        </div>
        {active.custom && (
          <button className="btn-pill red" style={{ padding: '5px 12px', fontSize: 11 }} onClick={onDelete} data-delete-provider>
            <Trash2 size={12} />删除
          </button>
        )}
        <button
          className={`sw${active.enabled ? ' on' : ''}`}
          data-provider-enabled={active.id}
          aria-pressed={active.enabled}
          onClick={onToggleEnabled}
          title="启用/停用该服务商"
        />
      </div>

      <section className="card px-4 py-4" style={{ borderRadius: 'var(--r-lg)' }}>
        {active.custom && (
          <div className="mb-3">
            <div className="mb-1.5 text-[11.5px] font-semibold" style={{ color: 'var(--text-2)' }}>服务商名称与协议</div>
            <input
              className="mb-2 w-full rounded-lg px-3 py-2 text-[12.5px] outline-none"
              style={{ background: 'var(--inset)', border: '1px solid var(--stroke)', color: 'var(--text-1)' }}
              value={active.name}
              onChange={(e) => onRename(e.target.value)}
              data-custom-name
            />
            <div className="flex flex-wrap gap-1.5">
              {(['openai', 'anthropic'] as const).map((p) => (
                <button key={p} className={`pill${active.protocol === p ? ' pill-blue' : ''}`} style={{ fontSize: 11 }} onClick={() => onProtocol(p)} data-custom-proto={p}>
                  {p === 'anthropic' ? 'Anthropic 兼容 (/messages)' : 'OpenAI 兼容 (/chat/completions)'}
                </button>
              ))}
            </div>
          </div>
        )}

        {active.local ? (
          <div>
            <div className="mb-1.5 flex items-center justify-between text-[11.5px] font-semibold" style={{ color: 'var(--text-2)' }}>
              <span>服务地址</span>
              <span className="pill pill-green" style={{ fontSize: 10 }}>本地直连</span>
            </div>
            <div className="flex items-center gap-2">
              <input
                className="min-w-0 flex-1 rounded-lg px-3 py-2 font-mono text-[12.5px] outline-none"
                style={{ background: 'var(--inset)', border: '1px solid var(--stroke)', color: 'var(--text-1)' }}
                value={providerUrl}
                onChange={(e) => onUrl(e.target.value)}
              />
              <button className="btn-pill primary" onClick={onTestLocal} disabled={busy !== null}>
                <Activity size={13} />检测服务
              </button>
            </div>
            <div className="mt-1.5 flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--green)' }}>
              <CheckCircle2 size={12} />本地引擎无需外部凭据，断网可用
            </div>
          </div>
        ) : (
          <>
            <div className="mb-3">
              <div className="mb-1.5 flex items-center justify-between text-[11.5px] font-semibold" style={{ color: 'var(--text-2)' }}>
                <span>访问凭据</span>
                <span className="font-normal" style={{ color: 'var(--text-3)' }}>仅保存在本机系统加密存储</span>
              </div>
              <div className="flex items-center gap-2">
                <input
                  data-key-input={active.id}
                  type="password"
                  className="min-w-0 flex-1 rounded-lg px-3 py-2 font-mono text-[12.5px] outline-none"
                  style={{ background: 'var(--inset)', border: '1px solid var(--stroke)', color: 'var(--text-1)' }}
                  placeholder={active.configured ? `已保存 ${active.keyMask}（留空保持不变）` : '粘贴服务访问凭据'}
                  value={keyDraft}
                  onChange={(e) => onKeyDraft(e.target.value)}
                />
                <button className="btn-pill primary whitespace-nowrap" onClick={onSaveAndTest} disabled={busy !== null} data-save-test>
                  <Check size={13} />{busy === `save:${active.id}` ? '检测中…' : '保存并检测'}
                </button>
                {KEY_URL[active.id] !== undefined && (
                  <button
                    className="btn-pill ghost whitespace-nowrap"
                    data-get-key
                    onClick={onOpenKeyConsole}
                    title="直达该厂商的控制台/密钥页（主进程白名单校验后用系统浏览器打开）"
                  >
                    <ExternalLink size={13} />获取 Key
                  </button>
                )}
                {active.configured && (
                  <button
                    className="btn-pill ghost whitespace-nowrap"
                    data-copy-key
                    onClick={onCopyKey}
                    title="把已保存的明文 Key 复制到系统剪贴板（主进程直写，界面不显示明文）"
                  >
                    <Copy size={13} />复制 Key
                  </button>
                )}
                {BALANCE_SUPPORTED.has(active.id) && !active.local && (
                  <button
                    className="btn-pill ghost whitespace-nowrap"
                    data-check-balance
                    onClick={onCheckBalance}
                    disabled={busy !== null}
                    title="查询该厂商的余额/额度（走公开余额 API，主进程持 Key 请求）"
                  >
                    <Database size={13} />{busy === `balance:${active.id}` ? '查询中…' : '查余额'}
                  </button>
                )}
              </div>
              <div
                className="mt-1.5 flex items-center gap-1.5 text-[11px]"
                style={{ color: active.configured ? (active.testOk === false ? 'var(--amber)' : 'var(--green)') : 'var(--text-3)' }}
              >
                {active.configured && active.testOk === false
                  ? <TriangleAlert size={12} />
                  : active.configured
                    ? <CheckCircle2 size={12} />
                    : <Info size={12} />}
                {active.configured && active.testOk === false
                  ? `凭据已保存（${active.keyMask}）· 连通检测未通过，可修改后重试「保存并检测」`
                  : active.configured
                    ? `已连接 · 已启用 ${active.models.filter((m) => m.enabled).length} 个模型`
                    : '填写凭据后点「保存并检测」，自动验证连通性并尝试拉取模型列表'}
              </div>
              {active.balance !== undefined && (
                <div className="mono mt-1 flex items-center gap-1.5 text-[10.5px]" style={{ color: 'var(--text-2)' }} data-balance={active.id}>
                  <Database size={11} style={{ color: 'var(--green)' }} />
                  余额 {active.balance.text}
                  <span style={{ color: 'var(--text-3)' }}>· {new Date(active.balance.at).toLocaleTimeString('zh-CN', { hour12: false })} 查询</span>
                </div>
              )}
            </div>

            <div>
              <div className="mb-1.5 flex items-center justify-between text-[11.5px] font-semibold" style={{ color: 'var(--text-2)' }}>
                <span>接口地址（Base URL）</span>
                <span className="pill" style={{ fontSize: 10 }}>{active.protocol === 'anthropic' ? 'Anthropic /messages' : 'OpenAI /chat/completions'}</span>
              </div>
              {active.variants.length > 1 && (
                <div className="mb-2 flex flex-wrap gap-1.5">
                  {active.variants.map((v, i) => (
                    <button
                      key={`${v.region}-${v.planType}-${v.protocol}-${i}`}
                      className={`pill${i === active.activeVariant ? ' pill-blue' : ''}`}
                      style={{ fontSize: 11 }}
                      onClick={() => onVariant(i)}
                      data-variant={i}
                    >
                      {v.protocol === 'anthropic' ? 'Anthropic' : v.region}{v.planType === 'CODING_PLAN' ? ' · 包月' : ''}
                    </button>
                  ))}
                </div>
              )}
              <input
                data-base-url
                className="w-full rounded-lg px-3 py-2 font-mono text-[12.5px] outline-none"
                style={{ background: 'var(--inset)', border: '1px solid var(--stroke)', color: 'var(--text-1)' }}
                value={providerUrl}
                onChange={(e) => onUrl(e.target.value)}
              />
              <label className="mt-2 flex cursor-pointer items-center gap-2 text-[11.5px]" style={{ color: 'var(--text-2)' }}>
                <input
                  type="checkbox"
                  checked={active.variants[active.activeVariant]?.isFullUrl ?? false}
                  onChange={(e) => onFullUrl(e.target.checked)}
                  style={{ accentColor: 'var(--blue)' }}
                  data-full-url
                />
                完整地址模式（isFullUrl：原样请求，不自动追加后缀）
              </label>
              {active.note !== '' && (
                <div className="mt-1.5 flex items-start gap-1.5 text-[11px] leading-relaxed" style={{ color: 'var(--text-3)' }}>
                  <Sparkles size={12} style={{ color: 'var(--blue)', flexShrink: 0, marginTop: 2 }} />{active.note}
                </div>
              )}
            </div>
          </>
        )}
      </section>
    </>
  );
}
