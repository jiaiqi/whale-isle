/**
 * 记忆图谱与日记（v4 设计稿 02）：真实 memory-graph 数据。
 * 图谱渲染用开源库 react-force-graph-2d（Canvas 力导向，自写成本高且无收益）。
 * 数据链路：memory:graph（节点 ≤200/边/日键）→ 检索 memory:query（高亮命中）→ memory:diary（日记全文）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import { Brain, Pin, PinOff, RefreshCw, Search, Trash2 } from 'lucide-react';
import type { MemoryGraphView, MemoryNodeView } from '@workbench/shared-protocol';
import { PageHead } from './shell/page-head';

const QUICK_QUERIES = ['钓鱼', '浇水', '威利'];

/** Canvas 不认 CSS 变量：运行时把 token 解析成真实颜色，避免硬编码主题色 */
function cssToken(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

function withAlpha(color: string, alpha: number): string {
  const hex = /^#([\da-f]{6})$/i.exec(color.trim())?.[1];
  if (hex !== undefined) {
    const [r, g, b] = [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(color.trim())?.[1];
  if (rgb !== undefined) return `rgba(${rgb.split(',').slice(0, 3).map((part) => part.trim()).join(', ')}, ${alpha})`;
  return color;
}

const NODE_TOKEN: Record<string, string> = {
  event: '--whale',
  summary: '--green',
  entity: '--amber',
  concept: '--violet',
};

interface GraphLink {
  source: string;
  target: string;
  kind: string;
  weight: number;
}

export function MemoryPanel(): React.JSX.Element {
  const [graph, setGraph] = useState<MemoryGraphView | null>(null);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<Array<{ text: string; score: number; type: string }>>([]);
  const [context, setContext] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [diaryDay, setDiaryDay] = useState<string | null>(null);
  const [diaryText, setDiaryText] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const graphRef = useRef<{ zoomToFit: (ms?: number, pad?: number) => void } | undefined>(undefined);
  const fittedRef = useRef(false);
  const [size, setSize] = useState({ width: 640, height: 420 });

  const load = useCallback(async (): Promise<void> => {
    const next = await window.directorBridge.memoryGraph();
    setGraph(next);
    if (next.days.length > 0 && diaryDay === null) {
      const latest = next.days[next.days.length - 1] ?? null;
      setDiaryDay(latest);
      if (latest !== null) setDiaryText((await window.directorBridge.memoryDiary(latest)).text ?? '');
    }
  }, [diaryDay]);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const el = wrapRef.current;
    if (el === null) return;
    const ro = new ResizeObserver(() => setSize({ width: el.clientWidth, height: Math.max(360, el.clientHeight) }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const selected = useMemo(
    () => graph?.nodes.find((n) => n.id === selectedId) ?? null,
    [graph, selectedId],
  );

  const hitIds = useMemo(() => {
    if (graph === null || hits.length === 0) return new Set<string>();
    const texts = new Set(hits.map((h) => h.text));
    const seed = new Set(graph.nodes.filter((n) => texts.has(n.text)).map((n) => n.id));
    // 1 跳扩展：命中节点的邻居也点亮（与 retrieve() 的图扩展方向一致）
    for (const e of graph.edges) {
      if (seed.has(e.from)) seed.add(e.to);
      if (seed.has(e.to)) seed.add(e.from);
    }
    return seed;
  }, [graph, hits]);

  const graphData = useMemo(() => {
    if (graph === null) return { nodes: [], links: [] };
    return {
      nodes: graph.nodes.map((n) => ({ ...n, val: 1 + n.importance * 3 })),
      links: graph.edges.map((e) => ({ source: e.from, target: e.to, kind: e.kind, weight: e.weight })),
    };
  }, [graph]);

  const runQuery = async (q: string): Promise<void> => {
    setQuery(q);
    if (q.trim() === '') {
      setHits([]);
      setContext('');
      return;
    }
    const res = await window.directorBridge.memoryQuery(q);
    setHits(res.hits);
    setContext(res.context);
  };

  const openDiary = async (day: string): Promise<void> => {
    setDiaryDay(day);
    const res = await window.directorBridge.memoryDiary(day);
    setDiaryText(res.text ?? '');
  };

  const togglePin = async (node: MemoryNodeView): Promise<void> => {
    await window.directorBridge.memoryPin(node.id, !node.pinned);
    await load();
    setNotice(node.pinned ? '已取消钉住' : '已钉住：遗忘曲线不再衰减');
  };

  const wipe = async (): Promise<void> => {
    if (!window.confirm('确认擦除全部本地记忆？（隐私合规：不可恢复）')) return;
    setBusy(true);
    await window.directorBridge.memoryWipe();
    setBusy(false);
    setHits([]);
    setContext('');
    setDiaryText('');
    await load();
    setNotice('记忆已清空');
  };

  const dayStats = useMemo(() => {
    const m = new Map<string, { events: number; importance: number }>();
    for (const n of graph?.nodes ?? []) {
      if (n.nodeType !== 'event' || n.day === '') continue;
      const cur = m.get(n.day) ?? { events: 0, importance: 0 };
      cur.events += 1;
      cur.importance += n.importance;
      m.set(n.day, cur);
    }
    return m;
  }, [graph]);

  const days = [...(graph?.days ?? [])].reverse();

  return (
    <div className="wb-page">
      <PageHead
        eyebrow="角色 · 记忆"
        eyebrowIcon={Brain}
        title="记忆图谱与日记"
        description="小鲸的真机记忆：JSONL 图谱 + 换日日记 + 混合检索（2-gram 词法 → 2 跳图扩展 → 加权重排）"
        actions={(
          <>
            <button className="btn-pill ghost" onClick={() => void load()} disabled={busy}>
              <RefreshCw size={13} /> 刷新
            </button>
            <button className="btn-pill red" onClick={() => void wipe()} disabled={busy} data-memory-wipe>
              <Trash2 size={13} /> 隐私一键擦除
            </button>
          </>
        )}
      />

      {/* 统计条 */}
      <div className="mb-4 grid grid-cols-2 gap-2 lg:grid-cols-5">
        {[
          ['节点', String(graph?.stats.nodes ?? 0)],
          ['边', String(graph?.stats.edges ?? 0)],
          ['最近换日', graph?.stats.lastDay ?? '—'],
          ['遗忘策略', '半衰 30d · 宽限 7d'],
          ['检索预算', 'topN 5 · ≤600 字'],
        ].map(([k, v]) => (
          <div key={k} className="card min-w-0 px-3 py-2.5">
            <div className="text-[10px]" style={{ color: 'var(--text-3)' }}>{k}</div>
            <div className="mono mt-0.5 truncate text-sm font-semibold" style={{ color: 'var(--text-1)' }} title={v}>{v}</div>
          </div>
        ))}
      </div>

      {notice !== null && (
        <div className="mono mb-3 rounded-xl px-3 py-2 text-[11px]" style={{ background: 'var(--blue-dim)', border: '1px solid var(--blue-line)', color: 'var(--blue)' }}>
          {notice}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[340px_minmax(0,1fr)]">
        {/* 日记列 */}
        <section className="flex flex-col gap-2">
          <div className="mb-1 flex items-center justify-between text-[11px]" style={{ color: 'var(--text-3)' }}>
            <span>小鲸日记（换日自动归纳）</span>
            <span className="mono">{days.length} 天</span>
          </div>
          <div className="flex max-h-[46vh] flex-col gap-2 overflow-y-auto pr-0.5">
            {days.map((day) => {
              const st = dayStats.get(day);
              const active = day === diaryDay;
              return (
                <button
                  key={day}
                  onClick={() => void openDiary(day)}
                  className="card card-hover px-3.5 py-3 text-left"
                  style={active ? { borderColor: 'var(--blue-line)', background: 'var(--blue-dim)' } : undefined}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-[12.5px] font-semibold" style={{ color: active ? 'var(--blue)' : 'var(--text-1)' }}>{day}</span>
                    <span className="mono text-[10px]" style={{ color: 'var(--text-3)' }}>{st?.events ?? 0} 事件</span>
                  </div>
                  <div className="mt-1 flex items-center gap-1.5 text-[10px]" style={{ color: 'var(--text-3)' }}>
                    <span className="pill" style={{ fontSize: 9, padding: '1px 6px' }}>重要度 {((st?.importance ?? 0) / Math.max(1, st?.events ?? 1)).toFixed(2)}</span>
                    {graph?.nodes.some((n) => n.day === day && n.pinned) === true && <span className="pill pill-amber" style={{ fontSize: 9, padding: '1px 6px' }}>钉住</span>}
                  </div>
                </button>
              );
            })}
            {days.length === 0 && (
              <div className="card px-4 py-6 text-center text-xs" style={{ color: 'var(--text-3)' }}>
                还没有日记——启动自动驾驶，换日后会自动生成。
              </div>
            )}
          </div>
          <div className="card px-3.5 py-3">
            <div className="mb-1.5 text-[11px] font-semibold" style={{ color: 'var(--text-2)' }}>
              {diaryDay ?? '日记'} · 全文
            </div>
            <p className="text-xs leading-relaxed" style={{ color: 'var(--text-2)', whiteSpace: 'pre-wrap' }}>
              {diaryText === '' ? '（这一天还没有记录）' : diaryText}
            </p>
          </div>
        </section>

        {/* 图谱 + 检索 */}
        <section className="flex min-w-0 flex-col gap-3">
          <div className="card flex items-center gap-2 px-3 py-2">
            <Search size={13} style={{ color: 'var(--blue)' }} />
            <input
              data-memory-search
              value={query}
              onChange={(e) => void runQuery(e.target.value)}
              placeholder="检索记忆，如：钓鱼 / 威利 / 浇水…"
              className="flex-1 bg-transparent text-xs outline-none"
              style={{ color: 'var(--text-1)' }}
            />
            {QUICK_QUERIES.map((q) => (
              <button key={q} className="pill" style={{ fontSize: 10 }} onClick={() => void runQuery(q)}>{q}</button>
            ))}
          </div>

          <div ref={wrapRef} className="card relative overflow-hidden" style={{ height: 440 }}>
            <ForceGraph2D
              ref={graphRef as never}
              graphData={graphData}
              width={size.width}
              height={size.height}
              backgroundColor="rgba(0,0,0,0)"
              linkColor={(l: GraphLink) => (hitIds.has(l.source) && hitIds.has(l.target) ? cssToken('--violet', '#6c4ba3') : cssToken('--stroke-2', 'rgba(20,32,54,.16)'))}
              linkWidth={(l: GraphLink) => (hitIds.has(l.source) && hitIds.has(l.target) ? 1.8 : 0.6)}
              nodeLabel={(n: MemoryNodeView) => n.text}
              nodeRelSize={4}
              nodeColor={(n: MemoryNodeView) => {
                if (hitIds.size > 0 && !hitIds.has(n.id)) return withAlpha(cssToken('--text-3', '#5c6475'), 0.28);
                if (n.pinned) return cssToken('--amber', '#9e6300');
                return cssToken(NODE_TOKEN[n.nodeType] ?? '--text-3', '#5c6475');
              }}
              nodeCanvasObjectMode={() => 'after'}
              nodeCanvasObject={(n: MemoryNodeView & { x?: number; y?: number }, ctx: CanvasRenderingContext2D) => {
                if (selectedId !== n.id) return;
                ctx.beginPath();
                ctx.arc(n.x ?? 0, n.y ?? 0, 9, 0, Math.PI * 2);
                ctx.strokeStyle = cssToken('--blue', '#2955bb');
                ctx.lineWidth = 1.6;
                ctx.stroke();
              }}
              onNodeClick={(n: MemoryNodeView) => setSelectedId(n.id)}
              onEngineStop={() => {
                if (!fittedRef.current) {
                  fittedRef.current = true;
                  graphRef.current?.zoomToFit(500, 36);
                }
              }}
              cooldownTicks={90}
            />
            <div className="mono absolute bottom-2 left-3 text-[10px]" style={{ color: 'var(--text-3)' }}>
              蓝=事件 · 绿=日记 · 橙=实体/钉住 · 紫=概念 — {graph?.nodes.length ?? 0} 节点 / {graph?.edges.length ?? 0} 边
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="card px-3.5 py-3">
              <div className="mb-1.5 text-[11px] font-semibold" style={{ color: 'var(--text-2)' }}>检索命中 {hits.length} 条</div>
              <div className="flex max-h-40 flex-col gap-1 overflow-y-auto">
                {hits.map((h, i) => (
                  <button
                    key={i}
                    onClick={() => {
                      const node = graph?.nodes.find((n) => n.text === h.text);
                      if (node !== undefined) setSelectedId(node.id);
                    }}
                    className="rounded-lg px-2 py-1 text-left text-[11px]"
                    style={{ background: 'var(--inset)', color: 'var(--text-2)' }}
                  >
                    <span className="mono mr-1.5" style={{ color: 'var(--violet)' }}>{h.score.toFixed(2)}</span>
                    {h.text}
                  </button>
                ))}
                {hits.length === 0 && <span className="text-[11px]" style={{ color: 'var(--text-3)' }}>输入关键词检索图谱（词法 + 图扩展）</span>}
              </div>
            </div>
            <div className="card px-3.5 py-3">
              <div className="mb-1.5 flex items-center justify-between text-[11px] font-semibold" style={{ color: 'var(--text-2)' }}>
                <span>System 注入预览（≤600 字）</span>
                {selected !== null && (
                  <button
                    className="pill"
                    style={{ fontSize: 9 }}
                    onClick={() => void togglePin(selected)}
                  >
                    {selected.pinned ? <PinOff size={10} /> : <Pin size={10} />}
                    {selected.pinned ? '取消钉住' : '钉住'}
                  </button>
                )}
              </div>
              <p className="mono max-h-40 overflow-y-auto text-[10.5px] leading-relaxed" style={{ color: 'var(--text-2)', whiteSpace: 'pre-wrap' }}>
                {context === '' ? (selected === null ? '（无匹配记忆）' : selected.text) : context}
              </p>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
