/**
 * 模型列表区（T-M6-26 自 providers-panel.tsx 拆出）：
 * 标题计数、模型搜索、全部开启/关闭、批量测试、拉取/手动添加，以及逐模型行
 * （能力徽标、测试状态、单测、设为主脑、删除、启停开关）。数据与回调全部来自容器。
 */
import { Activity, Plus, RefreshCw, Search, Trash2 } from 'lucide-react';
import { CAP_LABEL, shortError } from './catalog';
import { EmptyState } from './ui';
import type { ModelEntry, ModelTestEntry, UiProvider } from './catalog';

interface Props {
  active: UiProvider;
  shownModels: ModelEntry[];
  modelSearch: string;
  modelTests: Record<string, ModelTestEntry>;
  rowTesting: string | null;
  busy: string | null;
  batchProgress: { done: number; total: number } | null;
  onSearch: (value: string) => void;
  onToggleAll: (enabled: boolean) => void;
  onTestAll: () => void;
  onPull: () => void;
  onAddManual: () => void;
  onTest: (modelId: string) => void;
  onSetMain: (fullId: string) => void;
  onRemove: (modelId: string) => void;
  onToggleModel: (modelId: string) => void;
}

export function ModelList({
  active, shownModels, modelSearch, modelTests, rowTesting, busy, batchProgress,
  onSearch, onToggleAll, onTestAll, onPull, onAddManual, onTest, onSetMain, onRemove, onToggleModel,
}: Props): React.JSX.Element {
  return (
    <>
      <div className="mb-2 mt-4 flex flex-wrap items-center gap-2">
        <h3 className="text-[13px] font-semibold">模型列表 ({active.models.filter((m) => m.enabled).length} / {active.models.length})</h3>
        <div className="flex-1" />
        <div className="flex items-center gap-1.5 rounded-lg px-2.5" style={{ background: 'var(--inset)', border: '1px solid var(--stroke)' }}>
          <Search size={12} style={{ color: 'var(--text-3)' }} />
          <input
            data-model-search
            value={modelSearch}
            onChange={(e) => onSearch(e.target.value)}
            placeholder="搜索模型…"
            className="w-28 bg-transparent py-1.5 text-[12px] outline-none"
            style={{ color: 'var(--text-1)' }}
          />
        </div>
        <button className="btn-pill ghost" onClick={() => onToggleAll(true)} data-models-all-on>全部开启</button>
        <button className="btn-pill ghost" onClick={() => onToggleAll(false)} data-models-all-off>全部关闭</button>
        <button className="btn-pill ghost" onClick={onTestAll} disabled={busy !== null} data-test-all>
          <Activity size={12} />{batchProgress !== null ? `停止 ${batchProgress.done}/${batchProgress.total}` : '测试模型'}
        </button>
        <button className="btn-pill ghost" onClick={onPull} disabled={busy !== null} data-pull-models>
          <RefreshCw size={12} />{busy === `pull:${active.id}` ? '拉取中…' : '拉取模型'}
        </button>
        <button className="btn-pill ghost" onClick={onAddManual} data-add-model>
          <Plus size={12} />手动添加
        </button>
      </div>
      <div className="card overflow-hidden">
        {active.models.length === 0 && (
          <EmptyState>暂无模型，可点击「拉取模型」或「手动添加」</EmptyState>
        )}
        {active.models.length > 0 && shownModels.length === 0 && (
          <EmptyState>没有匹配「{modelSearch.trim()}」的模型</EmptyState>
        )}
        {shownModels.map((m) => (
          <div key={m.id} className="flex items-center gap-2.5 px-3.5 py-2.5" style={{ borderBottom: '1px solid var(--stroke)' }}>
            <span className="font-mono text-[12.5px] font-medium" style={{ color: 'var(--text-1)' }}>{m.id}</span>
            <div className="flex flex-wrap gap-1">
              {m.caps.map((c) => {
                const cap = CAP_LABEL[c] ?? { text: c, cls: '' };
                return <span key={c} className={`pill ${cap.cls}`} style={{ fontSize: 9.5, padding: '1px 7px' }}>{cap.text}</span>;
              })}
            </div>
            <div className="flex-1" />
            {(() => {
              const testResult = modelTests[m.id];
              if (testResult === undefined) return null;
              return (
                <span
                  className="mono whitespace-nowrap text-[10px]"
                  style={{ color: testResult.ok === true ? 'var(--green)' : 'var(--red)' }}
                  title={testResult.error ?? ''}
                  data-model-status={m.id}
                >
                  {testResult.ok === true ? `✓ ${testResult.latencyMs ?? 0}ms` : `✗ ${shortError(testResult.error)}`}
                </span>
              );
            })()}
            <button
              className="pill whitespace-nowrap"
              style={{ fontSize: 10.5 }}
              onClick={() => onTest(m.id)}
              data-model-test={m.id}
              title="对该模型发一次微型请求验证连通（决策协议模型自动走 System One 探针）"
            >
              {rowTesting === m.id ? '测试中…' : '测试'}
            </button>
            {!active.audio && !m.caps.includes('decision') && (
              <button className="pill" style={{ fontSize: 10.5 }} onClick={() => onSetMain(`${active.id}/${m.id}`)} data-set-main={m.id}>设为主脑</button>
            )}
            {active.custom && (
              <button className="icon-btn h-6 w-6" style={{ color: 'var(--text-3)' }} onClick={() => onRemove(m.id)} title="移除模型">
                <Trash2 size={12} />
              </button>
            )}
            <button className={`sw${m.enabled ? ' on' : ''}`} data-model-toggle={m.id} aria-pressed={m.enabled} onClick={() => onToggleModel(m.id)} title="启用或隐藏此模型" />
          </div>
        ))}
      </div>
    </>
  );
}
