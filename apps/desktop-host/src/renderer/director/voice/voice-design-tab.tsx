/**
 * Tab 2：「音色设计台」（AI Voice Design Studio — 融合旧 VoiceDesignLab + VoiceWorkshop）
 *
 * 四步引导闭环（对标 ElevenLabs Voice Design + MiniMax Voice Design + 鲸屿实测漂移红线）：
 * 1. 配方构思：快捷配方起点 + 4 维度结构化拨盘（年龄段/质感/语速/尾音）+ 自然语言描述
 * 2. 候选生成：一次批量生成 2–8 条候选（默认 4），另提供单句快测（支持 optimize_text_preview）
 * 3. 真波形试听 & A/B 并排对比 & 4 情绪多句试戴（强度 A/B/C 默认 B + 内联标签快捷键）
 * 4. 命名定格为 VoiceClone 固定声线（防止 VoiceDesign 0.4145 漂移）+ 自动 CAM++ 一致性体检
 */
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  Activity, ArrowLeftRight, CheckCircle2, Flame, Loader2, Pin, Play,
  RotateCcw, ShieldAlert, Sparkles, Wand2,
} from 'lucide-react';
import {
  composeVoiceWorkshopDescription,
  MIMO_WORKSHOP_AUDITION_LINES,
  VOICE_DESIGN_STARTER_RECIPES,
  VOICE_INLINE_SOUND_TAGS,
  VOICE_WORKSHOP_DIAL_OPTIONS,
  type VoicePerformanceIntensity,
  type VoiceTimbreVersion,
  type VoiceWorkshopCandidate,
  type VoiceWorkshopDial,
  type VoiceWorkshopState,
} from '@workbench/shared-protocol';
import { formatBytes } from './audio-dsp';
import { ConsistencyGauge, WaveformPlayer } from './waveform-player';

const INTENSITIES: Array<{ id: VoicePerformanceIntensity; label: string; hint: string }> = [
  { id: 'A', label: 'A · 提级', hint: '基础指令 +「更外放」' },
  { id: 'B', label: 'B · 夸张（默认）', hint: '重写指令：起伏/重音/尾音；实测 ΔRMS 4.45dB' },
  { id: 'C', label: 'C · 副语言', hint: 'B + 允许笑声/哼气/叹气；标签未验证，只做实验' },
];

interface AuditionRow {
  key: string;
  label: string;
  text: string;
  audioBase64: string;
  durationMs: number | null;
}

export function VoiceDesignTab(props: {
  workshop: VoiceWorkshopState | null;
  onRefreshWorkshop: () => void;
  onUpdateWorkshop: (next: VoiceWorkshopState) => void;
}): React.JSX.Element {
  const { workshop, onRefreshWorkshop, onUpdateWorkshop } = props;

  const [busy, setBusy] = useState<string | null>(null);
  const [description, setDescription] = useState('八九岁小女孩，声音甜而脆，元气满满，语速快，句尾翘起来，像随时要跳起来');
  const [dial, setDial] = useState<VoiceWorkshopDial>({ age: 'child', texture: 'sweet_crisp', pace: 'fast', ending: 'rising' });
  const [count, setCount] = useState(4);
  const [previewText, setPreviewText] = useState<string>(MIMO_WORKSHOP_AUDITION_LINES[0].text);
  const [optimizePreview, setOptimizePreview] = useState(false);
  const [quickPreviewB64, setQuickPreviewB64] = useState<string | null>(null);
  const [quickPreviewDuration, setQuickPreviewDuration] = useState<number | null>(null);

  const [candidates, setCandidates] = useState<VoiceWorkshopCandidate[]>(workshop?.candidates ?? []);
  const [intensity, setIntensity] = useState<VoicePerformanceIntensity>('B');
  const [customAuditionText, setCustomAuditionText] = useState('');
  const [auditions, setAuditions] = useState<Record<string, AuditionRow[]>>({});
  const [audioCache, setAudioCache] = useState<Record<string, string>>({});

  // A/B 并排对比槽
  const [pinA, setPinA] = useState<string | null>(null);
  const [pinB, setPinB] = useState<string | null>(null);

  // 定格命名草稿
  const [freezeLabels, setFreezeLabels] = useState<Record<string, string>>({});

  useEffect(() => {
    if (workshop?.candidates !== undefined && workshop.candidates.length > 0 && candidates.length === 0) {
      setCandidates(workshop.candidates);
    }
  }, [workshop?.candidates, candidates.length]);

  const current: VoiceTimbreVersion | null = workshop?.versions.find((item) => item.id === workshop.currentVersionId) ?? null;
  const composed = composeVoiceWorkshopDescription(description, dial);

  const fetchCandidateAudio = async (candidateId: string): Promise<string> => {
    const cached = audioCache[candidateId];
    if (cached !== undefined) return cached;
    const res = await window.directorBridge.v2VoiceWorkshopReadAudio({ kind: 'candidate', id: candidateId });
    setAudioCache((prev) => ({ ...prev, [candidateId]: res.audioBase64 }));
    return res.audioBase64;
  };

  const applyRecipe = (recipe: (typeof VOICE_DESIGN_STARTER_RECIPES)[number]): void => {
    setDescription(recipe.description);
    setDial({ ...recipe.dial });
    toast(`已套用配方起点「${recipe.label}」`);
  };

  const runQuickSinglePreview = async (): Promise<void> => {
    if (composed.trim().length < 2) return;
    setBusy('quick-preview');
    try {
      const res = await window.directorBridge.v2VoiceDesignPreview({
        text: previewText.trim() || MIMO_WORKSHOP_AUDITION_LINES[0].text,
        voiceDescription: composed,
        optimizeTextPreview: optimizePreview,
      });
      if (res.audioBase64 === undefined) {
        toast.error(`${res.providerKind} 没有返回可播放音频`);
        return;
      }
      setQuickPreviewB64(res.audioBase64);
      setQuickPreviewDuration(res.durationMs);
      void new Audio(`data:audio/wav;base64,${res.audioBase64}`).play().catch(() => undefined);
      toast.success('单句快测已生成（仅供听配方方向，如需定格请用批量候选）');
    } catch (err) {
      toast.error(`单句快测失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const generate = async (): Promise<void> => {
    setBusy('generate');
    try {
      const list = await window.directorBridge.v2VoiceWorkshopGenerate({
        description,
        dial,
        count,
        ...(previewText.trim() !== '' ? { previewText: previewText.trim() } : {}),
      });
      setCandidates((prev) => [...list, ...prev]);
      setAuditions({});
      onRefreshWorkshop();
      toast.success(`已生成 ${list.length} 条候选（消耗 ${list.length} 次合成）`);
    } catch (err) {
      toast.error(`生成候选失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const auditionCandidate = async (candidateId: string, customOnly = false): Promise<void> => {
    const custom = customOnly ? customAuditionText.trim() : '';
    setBusy(`audition-${candidateId}`);
    try {
      const rows = await window.directorBridge.v2VoiceWorkshopAudition({
        candidateId,
        intensity,
        ...(custom !== '' ? { customText: custom } : {}),
      });
      setAuditions((prev) => ({
        ...prev,
        [candidateId]: customOnly ? [...(prev[candidateId] ?? []).filter((r) => r.key !== 'custom'), ...rows] : rows,
      }));
      onRefreshWorkshop();
      if (rows[0]?.audioBase64) {
        void new Audio(`data:audio/wav;base64,${rows[0].audioBase64}`).play().catch(() => undefined);
      }
      toast.success(customOnly ? '自定义台词试戴完成（消耗 1 次合成）' : `已出 4 句情绪试戴（强度 ${intensity}，消耗 4 次合成）`);
    } catch (err) {
      toast.error(`试戴失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const freezeCandidate = async (candidateId: string): Promise<void> => {
    setBusy(`freeze-${candidateId}`);
    try {
      const label = (freezeLabels[candidateId] ?? '').trim();
      const { version, state: next } = await window.directorBridge.v2VoiceWorkshopFreeze({
        candidateId,
        intensity,
        ...(label === '' ? {} : { label }),
      });
      onUpdateWorkshop(next);
      await window.directorBridge.prefsSet({ voiceCommercialProvider: 'mimo-tts-voiceclone' });
      toast.success(`已定格「${version.label}」，默认档切到 VoiceClone；自动运行一致性质检…`);
      try {
        const { result, state: after } = await window.directorBridge.v2VoiceWorkshopConsistency(version.id);
        onUpdateWorkshop(after);
        if (result.verdict === 'unavailable') toast.error(`体检未完成：${result.detail}`);
      } catch (err) {
        toast.error(`自动体检失败：${err instanceof Error ? err.message : String(err)}`);
      }
    } catch (err) {
      toast.error(`定格失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const runConsistency = async (): Promise<void> => {
    setBusy('consistency');
    try {
      const { result, state: next } = await window.directorBridge.v2VoiceWorkshopConsistency();
      onUpdateWorkshop(next);
      if (result.verdict === 'unavailable') {
        toast.error(`体检未完成：${result.detail}`);
      } else {
        toast.success(`体检完成：均值 ${result.mean?.toFixed(4)} · 最低 ${result.min?.toFixed(4)}`);
      }
    } catch (err) {
      toast.error(`体检失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const rollback = async (versionId: string): Promise<void> => {
    setBusy(`rollback-${versionId}`);
    try {
      const { version, state: next } = await window.directorBridge.v2VoiceWorkshopRollback(versionId);
      onUpdateWorkshop(next);
      toast.success(`已回退到「${version.label}」`);
    } catch (err) {
      toast.error(`回退失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const togglePin = (slot: 'A' | 'B', id: string): void => {
    if (slot === 'A') setPinA((prev) => (prev === id ? null : id));
    else setPinB((prev) => (prev === id ? null : id));
  };

  const candA = candidates.find((c) => c.id === pinA) ?? null;
  const candB = candidates.find((c) => c.id === pinB) ?? null;

  return (
    <div className="space-y-4" data-voice-workshop>
      {/* 顶部上下文条：当前定格声线 + 快速版本回退 + 额度消耗诚实计数 */}
      <section className="card p-4" data-workshop-current>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold" style={{ color: 'var(--text-1)' }}>
              当前定格基线：{current?.label ?? '读取中…'}
            </span>
            <span className="pill pill-blue" style={{ fontSize: 10 }}>
              {current?.source === 'factory' ? '出厂 · 已定格' : current?.source === 'uploaded' ? '已定格 · 克隆声线' : '已定格 · AI 设计'}
            </span>
            {current?.consistency !== null && current?.consistency !== undefined && (
              <ConsistencyGauge result={current.consistency} compact />
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="mono text-[10.5px]" style={{ color: 'var(--text-3)' }} data-workshop-calls>
              本次会话已合成 {workshop?.sessionCalls ?? 0} 次（MiMo 限免，配额耗尽直接报错，不静默降级）
            </span>
            <button
              type="button"
              data-workshop-check
              disabled={busy !== null}
              onClick={() => void runConsistency()}
              className="btn-pill ghost"
              style={{ padding: '3px 10px', fontSize: 11 }}
            >
              <Activity size={11} />
              {busy === 'consistency' ? '体检中 (×10)…' : '一致性体检 (×10)'}
            </button>
          </div>
        </div>

        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[11px]" style={{ color: 'var(--text-3)' }}>
          <span className="mono truncate max-w-2xl" title={current?.referencePath}>
            参考音频：{current?.referencePath ?? '—'}（{formatBytes(current?.referenceBytes ?? 0)}）
          </span>
          <div className="flex flex-wrap items-center gap-1.5" data-workshop-versions>
            <span className="text-[10.5px] font-semibold" style={{ color: 'var(--text-2)' }}>版本时间线：</span>
            {(workshop?.versions ?? []).slice(0, 5).map((version) => {
              const on = version.id === workshop?.currentVersionId;
              return (
                <span key={version.id} className="inline-flex items-center gap-1" data-workshop-version={version.id}>
                  <span className={`pill ${on ? 'pill-blue' : ''}`} style={{ fontSize: 10, padding: '1.5px 7px' }}>
                    {version.label} · {version.source === 'factory' ? '随包出厂' : version.source === 'uploaded' ? '克隆' : 'AI 设计'}
                  </span>
                  {!on && (
                    <button
                      type="button"
                      data-workshop-rollback={version.id}
                      disabled={busy !== null}
                      onClick={() => void rollback(version.id)}
                      className="btn-pill ghost"
                      style={{ padding: '1px 7px', fontSize: 10 }}
                    >
                      <RotateCcw size={9} />回退
                    </button>
                  )}
                </span>
              );
            })}
          </div>
        </div>
      </section>

      {/* 主双栏创作工作台：左「配方与生成」 / 右「候选池 · A/B 对比 · 多句试戴与定格」 */}
      <div className="grid gap-4 lg:grid-cols-[minmax(360px,0.95fr)_1.25fr]">
        {/* 左栏：音色配方编辑器 */}
        <section className="card flex flex-col gap-4 p-5" data-workshop-generate-box>
          <div className="flex items-center justify-between">
            <div className="min-w-0 flex-1">
              <h2 className="wb-display text-lg">① 构思音色配方</h2>
              <p className="mt-0.5 text-[11.5px]" style={{ color: 'var(--text-3)' }}>
                自然语言 + 4 项拨盘描述声线，批量抽卡试戴后定格。
              </p>
            </div>
            <span className="pill pill-amber" style={{ fontSize: 10 }}>
              <ShieldAlert size={10} />探索态会漂移
            </span>
          </div>

          {/* 快捷配方起点 */}
          <div>
            <div className="mb-1.5 text-[11px] font-semibold" style={{ color: 'var(--text-3)' }}>快捷配方起点</div>
            <div className="flex flex-wrap gap-1.5">
              {VOICE_DESIGN_STARTER_RECIPES.map((recipe) => (
                <button
                  key={recipe.id}
                  type="button"
                  data-workshop-recipe={recipe.id}
                  onClick={() => applyRecipe(recipe)}
                  className="rounded-full px-2.5 py-1 text-[11px] font-medium transition"
                  style={{ border: '1px solid var(--stroke)', background: 'var(--inset)', color: 'var(--text-2)' }}
                >
                  {recipe.label}
                </button>
              ))}
            </div>
          </div>

          {/* 4 维度结构化拨盘 */}
          <div className="grid grid-cols-2 gap-2.5">
            {VOICE_WORKSHOP_DIAL_OPTIONS.map((group) => (
              <label key={group.key} className="flex flex-col gap-1 text-[11px]" style={{ color: 'var(--text-2)' }}>
                <span className="font-semibold">{group.label}</span>
                <select
                  data-workshop-dial={group.key}
                  value={(dial as Record<string, string | undefined>)[group.key] ?? ''}
                  onChange={(e) => setDial((prev) => ({ ...prev, [group.key]: e.target.value === '' ? undefined : e.target.value }))}
                  className="rounded-lg px-2.5 py-1.5 text-xs outline-none"
                  style={{ border: '1px solid var(--stroke)', background: 'var(--inset)', color: 'var(--text-1)' }}
                >
                  <option value="">不指定</option>
                  {group.options.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </label>
            ))}
          </div>

          {/* 自然语言描述 */}
          <div>
            <div className="mb-1 flex items-center justify-between text-[11px]">
              <span className="font-semibold" style={{ color: 'var(--text-2)' }}>音色自然语言描述</span>
              <span className="mono text-[10px]" style={{ color: 'var(--text-3)' }}>{description.length}/300</span>
            </div>
            <textarea
              value={description}
              data-workshop-description
              maxLength={300}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              className="w-full rounded-xl px-3 py-2 text-xs leading-relaxed outline-none"
              style={{ border: '1px solid var(--stroke)', background: 'var(--inset)', color: 'var(--text-1)', resize: 'vertical' }}
              placeholder="年龄、音质、语速、尾音习惯、性格投射；勿写「大肥鱼」雷区词或模仿真人"
            />
          </div>

          {/* 实际下发描述预览 */}
          <div className="inset p-3 text-[11px] leading-relaxed" data-workshop-composed>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-3)' }}>
              最终合成提示词（已合并拨盘）
            </div>
            <span style={{ color: 'var(--text-1)' }}>{composed}</span>
          </div>

          {/* 试听预览句 + 单句快测 */}
          <div>
            <div className="mb-1 flex items-center justify-between text-[11px]">
              <span className="font-semibold" style={{ color: 'var(--text-2)' }}>候选预览台词</span>
              <div className="flex flex-wrap gap-1">
                {VOICE_INLINE_SOUND_TAGS.map((item) => (
                  <button
                    key={item.tag}
                    type="button"
                    title={item.hint}
                    onClick={() => setPreviewText((prev) => `${prev}${item.tag}`)}
                    className="rounded-md px-1.5 py-0.5 font-mono text-[9.5px]"
                    style={{ border: '1px solid var(--stroke)', background: 'var(--surface)', color: 'var(--text-3)' }}
                  >
                    +{item.label}
                  </button>
                ))}
              </div>
            </div>
            <input
              type="text"
              value={previewText}
              maxLength={200}
              onChange={(e) => setPreviewText(e.target.value)}
              className="w-full rounded-lg px-3 py-1.5 text-xs outline-none"
              style={{ border: '1px solid var(--stroke)', background: 'var(--inset)', color: 'var(--text-1)' }}
            />
            <label className="mt-1.5 flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--text-3)' }}>
              <input
                type="checkbox"
                checked={optimizePreview}
                onChange={(e) => setOptimizePreview(e.target.checked)}
              />
              单句快测启用 <span className="mono">optimize_text_preview</span>（只听音色质感，由模型自选试听词）
            </label>
          </div>

          {/* 生成操作栏 */}
          <div className="flex flex-wrap items-center gap-2 border-t pt-3" style={{ borderColor: 'var(--stroke)' }}>
            <label className="flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--text-2)' }}>
              候选数
              <select
                data-workshop-count
                value={count}
                onChange={(e) => setCount(Number(e.target.value))}
                className="rounded-lg px-2 py-1 text-xs"
                style={{ border: '1px solid var(--stroke)', background: 'var(--inset)', color: 'var(--text-1)' }}
              >
                {[2, 4, 5, 6, 7, 8].map((n) => <option key={n} value={n}>{n} 条</option>)}
              </select>
            </label>
            <button
              type="button"
              data-workshop-generate
              disabled={busy !== null || description.trim().length < 2}
              onClick={() => void generate()}
              className="btn-pill primary flex-1"
            >
              {busy === 'generate' ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
              {busy === 'generate' ? `批量生成中（${count} 次合成）…` : `生成 ${count} 条候选（消耗 ${count} 次合成）`}
            </button>
            <button
              type="button"
              disabled={busy !== null || description.trim().length < 2}
              onClick={() => void runQuickSinglePreview()}
              className="btn-pill ghost"
              title="仅消耗 1 次合成快速试听这段描述，不写入候选列表"
            >
              {busy === 'quick-preview' ? <Loader2 size={12} className="animate-spin" /> : <Wand2 size={12} />}
              单句快测 (1 次)
            </button>
          </div>

          {quickPreviewB64 !== null && (
            <div className="inset p-2.5">
              <div className="mb-1 text-[10.5px] font-semibold" style={{ color: 'var(--text-2)' }}>单句快测结果</div>
              <WaveformPlayer audioBase64={quickPreviewB64} durationMs={quickPreviewDuration} downloadName="quick-design-preview.wav" compact />
            </div>
          )}

          <p className="rounded-xl px-3 py-2 text-[11px] leading-relaxed" style={{ background: 'var(--amber-dim)', border: '1px solid var(--amber-line)', color: 'var(--amber)' }}>
            实测提醒：未定格的候选<strong>不能当固定声线</strong>（VoiceDesign 同描述 ×10 说话人余弦最低 0.4145）。正确路径是「批量出候选 → 对比并 4 情绪试戴 → 点定格锁成 VoiceClone 固定声线」。
          </p>
        </section>

        {/* 右栏：候选池 · A/B 对比 · 4 情绪试戴与定格 */}
        <section className="card flex flex-col gap-3.5 p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="wb-display text-lg">② 对比试戴与定格（{candidates.length} 条候选）</h2>
              <p className="mt-0.5 text-[11.5px]" style={{ color: 'var(--text-3)' }}>
                候选音频持久化在本地 userData，切页不丢失；把心仪的两条固定到 A/B 槽可快速盲听对拍。
              </p>
            </div>
          </div>

          {/* 试戴强度阶梯（A / B / C） */}
          <div className="inset p-3" data-workshop-intensity>
            <div className="flex flex-wrap items-center gap-2">
              <span className="flex items-center gap-1 text-[11px] font-semibold" style={{ color: 'var(--text-2)' }}>
                <Flame size={12} style={{ color: 'var(--accent)' }} />试戴表演强度
              </span>
              {INTENSITIES.map((item) => {
                const on = intensity === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    data-workshop-intensity-option={item.id}
                    onClick={() => setIntensity(item.id)}
                    title={item.hint}
                    className="rounded-full px-2.5 py-0.5 text-[11px] font-semibold transition"
                    style={{
                      border: `1px solid ${on ? 'var(--accent-line)' : 'var(--stroke)'}`,
                      background: on ? 'var(--accent-soft)' : 'var(--surface)',
                      color: on ? 'var(--accent)' : 'var(--text-2)',
                    }}
                  >
                    {item.label}
                  </button>
                );
              })}
            </div>
            <p className="mt-1 text-[10.5px]" style={{ color: 'var(--text-3)' }}>
              {INTENSITIES.find((i) => i.id === intensity)?.hint}
            </p>
            <div className="mt-2 flex items-center gap-2">
              <input
                type="text"
                value={customAuditionText}
                maxLength={200}
                onChange={(e) => setCustomAuditionText(e.target.value)}
                placeholder="可选：输入自定义试戴句（点击候选上的「试这句」仅耗 1 次合成）"
                className="min-w-0 flex-1 rounded-lg px-2.5 py-1 text-[11px] outline-none"
                style={{ border: '1px solid var(--stroke)', background: 'var(--surface)', color: 'var(--text-1)' }}
              />
            </div>
          </div>

          {/* A / B 并排对比栏（固定任意候选后显现） */}
          {(candA !== null || candB !== null) && (
            <div className="rounded-xl p-3" style={{ border: '1px solid var(--accent-line)', background: 'var(--accent-soft)' }} data-workshop-ab-compare>
              <div className="mb-2 flex items-center justify-between text-[11px] font-semibold" style={{ color: 'var(--accent)' }}>
                <span className="flex items-center gap-1.5"><ArrowLeftRight size={12} />A / B 并排对拍槽</span>
                <button type="button" className="text-[10.5px] underline" onClick={() => { setPinA(null); setPinB(null); }}>清空对比</button>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {(['A', 'B'] as const).map((slot) => {
                  const cand = slot === 'A' ? candA : candB;
                  return (
                    <div key={slot} className="rounded-lg p-2.5" style={{ background: 'var(--surface-solid)', border: '1px solid var(--stroke)' }}>
                      <div className="mb-1.5 flex items-center justify-between text-[11px]">
                        <span className="font-semibold">槽位 {slot}{cand !== null ? ` · ${cand.id.slice(0, 6)}` : ''}</span>
                        {cand !== null && (
                          <button type="button" className="text-[10px]" style={{ color: 'var(--text-3)' }} onClick={() => togglePin(slot, cand.id)}>移除</button>
                        )}
                      </div>
                      {cand !== null ? (
                        <WaveformPlayer
                          compact
                          audioBase64={audioCache[cand.id] ?? null}
                          onRequestAudio={() => fetchCandidateAudio(cand.id)}
                          durationMs={cand.durationMs}
                          label={`对比槽 ${slot}`}
                          eagerLoad
                        />
                      ) : (
                        <p className="py-2 text-center text-[11px]" style={{ color: 'var(--text-3)' }}>在下方候选点击「钉到 {slot}」</p>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* 候选卡片列表 */}
          <div className="grid gap-2.5" data-workshop-candidates>
            {candidates.length === 0 ? (
              <div className="inset flex flex-col items-center justify-center gap-2 py-12 text-center">
                <Sparkles size={22} style={{ color: 'var(--text-3)', opacity: 0.6 }} />
                <p className="text-xs font-medium" style={{ color: 'var(--text-2)' }}>还没有设计候选</p>
                <p className="max-w-sm text-[11px]" style={{ color: 'var(--text-3)' }}>
                  在左侧调好配方拨盘与描述，点击「生成 4 条候选」，系统会并行保存所有已生成的 WAV 供你波形试听、A/B 对拍、4 情绪试戴并定格。
                </p>
              </div>
            ) : (
              candidates.map((candidate, index) => {
                const isA = pinA === candidate.id;
                const isB = pinB === candidate.id;
                const rows = auditions[candidate.id] ?? [];
                return (
                  <article
                    key={candidate.id}
                    data-workshop-candidate={candidate.id}
                    className="inset p-3.5"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs font-semibold" style={{ color: 'var(--text-1)' }}>候选 #{index + 1}</span>
                        <span className="mono text-[10.5px]" style={{ color: 'var(--text-3)' }}>
                          {formatBytes(candidate.bytes)}{candidate.durationMs === null ? '' : ` · ${(candidate.durationMs / 1000).toFixed(2)}s`}
                        </span>
                        <span className="mono text-[10px]" style={{ color: 'var(--text-3)' }}>
                          {candidate.createdAt.slice(11, 19)}
                        </span>
                      </div>
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => togglePin('A', candidate.id)}
                          className={`pill ${isA ? 'pill-blue' : ''}`}
                          style={{ fontSize: 10, padding: '1.5px 7px' }}
                        >
                          <Pin size={9} />{isA ? '已钉 A' : '钉到 A'}
                        </button>
                        <button
                          type="button"
                          onClick={() => togglePin('B', candidate.id)}
                          className={`pill ${isB ? 'pill-violet' : ''}`}
                          style={{ fontSize: 10, padding: '1.5px 7px' }}
                        >
                          <Pin size={9} />{isB ? '已钉 B' : '钉到 B'}
                        </button>
                      </div>
                    </div>

                    <div className="mt-2">
                      <WaveformPlayer
                        compact
                        audioBase64={audioCache[candidate.id] ?? null}
                        onRequestAudio={() => fetchCandidateAudio(candidate.id)}
                        durationMs={candidate.durationMs}
                        downloadName={`candidate-${index + 1}.wav`}
                        label={`候选 ${index + 1}`}
                      />
                    </div>

                    {/* 试戴与命名定格操作行 */}
                    <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                      <button
                        type="button"
                        data-workshop-audition={candidate.id}
                        disabled={busy !== null}
                        onClick={() => void auditionCandidate(candidate.id, false)}
                        className="btn-pill ghost"
                        style={{ padding: '4px 10px', fontSize: 11 }}
                      >
                        <Play size={10} />
                        {busy === `audition-${candidate.id}` ? '试戴中…' : `多句试戴 (强度 ${intensity} · 4 次)`}
                      </button>
                      {customAuditionText.trim() !== '' && (
                        <button
                          type="button"
                          disabled={busy !== null}
                          onClick={() => void auditionCandidate(candidate.id, true)}
                          className="btn-pill ghost"
                          style={{ padding: '4px 10px', fontSize: 11 }}
                        >
                          试这句 (1 次)
                        </button>
                      )}
                      <input
                        type="text"
                        value={freezeLabels[candidate.id] ?? ''}
                        maxLength={40}
                        onChange={(e) => setFreezeLabels((prev) => ({ ...prev, [candidate.id]: e.target.value }))}
                        placeholder="定格名称（如：小鲸·元气 v2）"
                        className="ml-auto min-w-[140px] flex-1 rounded-full px-2.5 py-1 text-[11px] outline-none sm:max-w-[200px]"
                        style={{ border: '1px solid var(--stroke)', background: 'var(--surface)', color: 'var(--text-1)' }}
                      />
                      <button
                        type="button"
                        data-workshop-freeze={candidate.id}
                        disabled={busy !== null}
                        onClick={() => void freezeCandidate(candidate.id)}
                        className="btn-pill accent"
                        style={{ padding: '4px 12px', fontSize: 11 }}
                      >
                        <CheckCircle2 size={11} />
                        {busy === `freeze-${candidate.id}` ? '定格中…' : '定格此音色'}
                      </button>
                    </div>

                    {rows.length > 0 && (
                      <div className="mt-2.5 grid gap-1.5 border-t pt-2.5" style={{ borderColor: 'var(--stroke)' }}>
                        {rows.map((row) => (
                          <div key={row.key} className="flex items-center gap-2 text-[11px]" data-workshop-audition-row={row.key}>
                            <span className="pill" style={{ fontSize: 10, padding: '1px 7px', minWidth: 42, justifyContent: 'center' }}>{row.label}</span>
                            <span className="min-w-0 flex-1 truncate" style={{ color: 'var(--text-2)' }} title={row.text}>{row.text}</span>
                            <button
                              type="button"
                              onClick={() => void new Audio(`data:audio/wav;base64,${row.audioBase64}`).play().catch(() => undefined)}
                              className="btn-pill ghost"
                              style={{ padding: '2px 9px', fontSize: 10.5 }}
                            >
                              <Play size={10} />播放
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </article>
                );
              })
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
