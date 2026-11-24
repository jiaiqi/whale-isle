/**
 * 姿态与场景验收台（T-M6-53，对齐 design/pet-stage.html）：
 * 暂停真实事件 → 12 场景直接驱动真实桌宠窗口 → 回退检查 → 90% 参考线轮播 → 脱敏报告。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ClipboardCheck, Play, Stethoscope, X } from 'lucide-react';
import { toast } from 'sonner';

interface FallbackView {
  requested: string;
  pose: string;
  status: 'ok' | 'fallback' | 'missing';
  reason: string;
}
interface ScenarioView { id: string; label: string; description: string }
interface ResultView { scenarioId: string; label: string; status: 'completed' | 'failed'; steps: number; note: string }

const STATUS_COLOR: Record<FallbackView['status'], string> = {
  ok: 'var(--green)',
  fallback: 'var(--amber)',
  missing: 'var(--red)',
};

export function AcceptanceBench({ open, onClose }: { open: boolean; onClose: () => void }): React.JSX.Element | null {
  const [scenarios, setScenarios] = useState<ScenarioView[]>([]);
  const [character, setCharacter] = useState<{ name: string; id: string; available: string[]; fallbacks: FallbackView[] } | null>(null);
  const [paused, setPaused] = useState(false);
  const [results, setResults] = useState<Record<string, ResultView>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [carousel, setCarousel] = useState(false);
  const [carouselPose, setCarouselPose] = useState('');
  const [report, setReport] = useState('');
  const carouselRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const reload = useCallback((): void => {
    void window.directorBridge.acceptanceCatalog().then((catalog) => {
      setScenarios(catalog.scenarios);
      setCharacter(catalog.character);
      setPaused(catalog.paused);
    }).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    reload();
    return () => { if (carouselRef.current !== null) clearInterval(carouselRef.current); };
  }, [open, reload]);

  const setPause = async (next: boolean): Promise<void> => {
    const result = await window.directorBridge.acceptancePause(next);
    setPaused(result.paused);
    toast(next ? '已暂停真实 autodrive / 工作跟随事件' : '已恢复真实事件');
  };

  const runOne = async (id: string): Promise<void> => {
    setBusy(id);
    try {
      const result = await window.directorBridge.acceptanceRun(id);
      if (result.ok && result.result !== undefined) {
        setResults((prev) => ({ ...prev, [result.result!.scenarioId]: result.result! }));
        toast.success(`场景完成：${result.result.label}（${result.result.steps} 步）`);
      } else {
        toast.error(result.error ?? '场景执行失败');
      }
    } finally { setBusy(null); }
  };

  const runAll = async (): Promise<void> => {
    setBusy('all');
    try {
      const result = await window.directorBridge.acceptanceRunAll();
      const next: Record<string, ResultView> = {};
      for (const item of result.results) next[item.scenarioId] = item;
      setResults(next);
      const passed = result.results.filter((item) => item.status === 'completed').length;
      toast.success(`全部演练完成：${passed}/${result.results.length} 通过`);
    } finally { setBusy(null); }
  };

  const toggleCarousel = async (): Promise<void> => {
    if (carouselRef.current !== null) {
      clearInterval(carouselRef.current);
      carouselRef.current = null;
      setCarousel(false);
      setCarouselPose('');
      const stopped = await window.directorBridge.acceptanceCarousel(false);
      if (!stopped.ok) toast.error('停止轮播失败');
      return;
    }
    const result = await window.directorBridge.acceptanceCarousel(true, 1_500);
    if (!result.ok) { toast.error(result.error ?? '当前角色没有可轮播的姿态'); return; }
    const poses = result.poses ?? [];
    if (poses.length === 0) { toast.error('当前角色没有可轮播的姿态'); return; }
    let index = 0;
    setCarousel(true);
    // 节拍由主进程真实驱动桌宠窗；这里只同步本地角标显示，避免两处各自下发姿态
    const step = (): void => {
      setCarouselPose(poses[index % poses.length]!);
      index += 1;
    };
    step();
    carouselRef.current = setInterval(step, result.intervalMs ?? 1_500);
    toast.success(`桌面桌宠窗已开启 1.5s 全姿态轮播（${poses.length} 个姿态）并叠加 90% 参考线`);
  };

  const exportReport = async (): Promise<void> => {
    const result = await window.directorBridge.acceptanceReport();
    if (!result.ok || result.markdown === undefined) { toast.error('报告生成失败'); return; }
    setReport(result.markdown);
    await navigator.clipboard.writeText(result.markdown);
    toast.success('已生成脱敏诊断报告并复制到剪贴板（零对话正文 / 零路径 / 零密钥）');
  };

  useEffect(() => {
    if (!open && carouselRef.current !== null) {
      clearInterval(carouselRef.current);
      carouselRef.current = null;
      setCarousel(false);
      // 关闭弹窗也必须撤掉桌面参考线并恢复 idle（主进程收口）
      void window.directorBridge.acceptanceCarousel(false).catch(() => undefined);
    }
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center px-4" style={{ background: 'rgba(2,6,16,.72)', backdropFilter: 'blur(6px)' }} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }} data-acceptance-bench>
      <div className="card w-full max-w-[980px]" style={{ maxHeight: '90vh', overflow: 'auto', padding: 18 }}>
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-[15px] font-semibold"><Stethoscope size={15} style={{ color: 'var(--green)' }} />姿态与场景验收台</h2>
            <p className="mt-1 text-[11px]" style={{ color: 'var(--text-2)' }}>免联网演练 · 直接驱动真实桌宠窗口 · 当前角色 {character?.name ?? '—'}</p>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-[11.5px]" style={{ color: 'var(--text-2)' }}>暂停真实事件</span>
            <button className={`sw${paused ? ' on' : ''}`} aria-pressed={paused} data-bench-pause onClick={() => void setPause(!paused)} />
            <button className="icon-btn" aria-label="关闭验收台" onClick={() => { if (carouselRef.current !== null) clearInterval(carouselRef.current); onClose(); }}><X size={14} /></button>
          </div>
        </div>

        <div className="mb-2 text-[12px] font-semibold" style={{ color: 'var(--text-2)' }}>免联网 12 场景一键演练</div>
        <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))' }} data-bench-grid>
          {scenarios.map((scenario) => {
            const result = results[scenario.id];
            const running = busy === scenario.id || busy === 'all';
            return (
              <button
                key={scenario.id}
                data-bench-scenario={scenario.id}
                disabled={running}
                onClick={() => void runOne(scenario.id)}
                className="card card-hover p-2.5 text-left"
                style={{ opacity: running ? 0.6 : 1, borderColor: result?.status === 'completed' ? 'var(--green-line)' : result?.status === 'failed' ? 'var(--red-line)' : 'var(--stroke)' }}
              >
                <div className="flex items-center gap-1.5 text-[12px] font-semibold">
                  <Play size={11} style={{ color: 'var(--blue)' }} />{scenario.label}
                </div>
                <div className="mt-1 text-[10.5px]" style={{ color: 'var(--text-3)' }}>{scenario.description}</div>
                <div className="mt-1 text-[10px] mono" style={{ color: result === undefined ? 'var(--text-3)' : STATUS_COLOR[result.status === 'completed' ? 'ok' : 'missing'] }}>
                  {result === undefined ? '未演练' : `${result.status === 'completed' ? '通过' : '失败'} · ${result.steps} 步`}
                </div>
              </button>
            );
          })}
        </div>
        <div className="mt-2 flex justify-end">
          <button className="btn-pill primary" data-bench-run-all disabled={busy !== null} onClick={() => void runAll()}>
            <Play size={12} />{busy === 'all' ? '演练中…' : '全部演练（约 20s）'}
          </button>
        </div>

        <div className="mt-4 mb-1 flex items-center justify-between">
          <div className="text-[12px] font-semibold" style={{ color: 'var(--text-2)' }}>缺失姿态回退检查</div>
          <span className="text-[10px]" style={{ color: 'var(--text-3)' }}>缺图自动回退 idle / 对应默认态</span>
        </div>
        <div className="rounded-xl p-2.5 text-[11px]" style={{ border: '1px solid var(--stroke)', background: 'var(--inset)' }} data-bench-fallback>
          {(character?.fallbacks ?? []).map((entry) => (
            <div key={entry.requested} className="mono flex flex-wrap gap-2 py-0.5">
              <span style={{ color: STATUS_COLOR[entry.status] }}>[{entry.status === 'ok' ? 'OK' : entry.status === 'fallback' ? 'FALLBACK' : 'MISSING'}]</span>
              <span>{entry.requested}</span>
              <span style={{ color: 'var(--text-3)' }}>→ {entry.pose}</span>
              <span style={{ color: 'var(--text-3)' }}>· {entry.reason}</span>
            </div>
          ))}
          {(character?.fallbacks ?? []).length === 0 && <div style={{ color: 'var(--text-3)' }}>当前角色没有姿态清单（WebM/精灵角色不参与姿态验收）</div>}
        </div>

        <div className="mt-3 grid gap-3 md:grid-cols-[260px_1fr]">
          <div className="relative h-[220px] overflow-hidden rounded-xl" style={{ border: '1px solid var(--stroke-2)', background: 'linear-gradient(160deg, #14213d, #0a0f1e)' }}>
            <div className="absolute inset-x-0" style={{ bottom: '10%', borderTop: '1px dashed rgba(148,163,184,.5)' }}>
              <span className="mono absolute left-2 -top-4 text-[9px]" style={{ color: 'var(--text-3)' }}>90% 身高参考线</span>
            </div>
            <div className="absolute inset-0 grid place-items-center text-[12px]" style={{ color: 'var(--text-2)' }}>
              {carousel ? `轮播：${carouselPose}` : '点击「全姿态轮播」在桌面窗口逐个比对'}
            </div>
            <div className="absolute inset-x-0 bottom-2 text-center text-[10px]" style={{ color: 'var(--text-3)' }}>舞台参考线固定；真实播放见桌面桌宠窗</div>
          </div>
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap gap-2">
              <button className="btn-pill ghost" data-bench-carousel onClick={toggleCarousel}>
                <Play size={12} />{carousel ? '停止轮播' : '全姿态轮播比大小（1.5s）'}
              </button>
              <button className="btn-pill primary" data-bench-report onClick={() => void exportReport()}>
                <ClipboardCheck size={12} />导出脱敏诊断报告
              </button>
            </div>
            {report !== '' && (
              <pre className="max-h-[180px] flex-1 overflow-auto rounded-xl p-2.5 text-[10px] whitespace-pre-wrap" style={{ border: '1px solid var(--stroke)', background: 'var(--inset)', color: 'var(--text-2)' }} data-bench-report-md>{report}</pre>
            )}
            {report === '' && (
              <div className="text-[10.5px] leading-relaxed" style={{ color: 'var(--text-3)' }}>
                报告只包含角色名、姿态命中/回退与场景通过状态；不包含对话正文、绝对路径、密钥或 token。
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
