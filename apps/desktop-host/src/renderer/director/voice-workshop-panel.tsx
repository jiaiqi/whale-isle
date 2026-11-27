/**
 * 音色工坊（M1 + M2）—— 语音中心里的独立区块。
 *
 * 四步（与主进程 `voice-workshop.ts` 一一对应）：
 * 1. **声线卡**：当前版本、定格状态、来源、参考音频、最近体检、版本时间线（可回退）；
 * 2. **一致性体检**：同一句 ×10 真实克隆 → 说话人余弦 → 人话结论（跑前提示消耗 10 次合成）；
 * 3. **生成候选**：描述 + 拨盘（年龄段/质感/语速/尾音）→ 一次 4–8 条 VoiceDesign 候选；
 * 4. **多句试戴 + 定格**：每条候选套 4 句（中性/调皮/傲娇/撒娇，用接线后的 B 级指令），
 *    选定后定格成本地声线版本（只写 userData，出厂默认不动）。
 *
 * 诚实口径：体检工具不可用时主进程返回 `unavailable`，这里原样显示原因，**不编造数字**；
 * 未定格的候选一律标「不能当固定声线」（VoiceDesign 同描述 ×10 余弦最低 0.4145）。
 */
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  MIMO_WORKSHOP_AUDITION_LINES,
  VOICE_WORKSHOP_DIAL_OPTIONS,
  composeVoiceWorkshopDescription,
  type VoicePerformanceIntensity,
  type VoiceTimbreVersion,
  type VoiceWorkshopCandidate,
  type VoiceWorkshopDial,
  type VoiceWorkshopState,
} from '@workbench/shared-protocol';

const INTENSITIES: Array<{ id: VoicePerformanceIntensity; label: string; hint: string }> = [
  { id: 'A', label: 'A · 提级', hint: '基础指令 +「更外放」' },
  { id: 'B', label: 'B · 夸张（默认）', hint: '重写指令：起伏/重音/尾音；实测 ΔRMS 4.45dB' },
  { id: 'C', label: 'C · 副语言', hint: 'B + 允许笑声/哼气/叹气；标签未验证，只做实验' },
];

const VERDICT_STYLE: Record<string, { label: string; color: string }> = {
  stable: { label: '锁得稳', color: 'var(--green, #3fa66b)' },
  drifty: { label: '偶尔飘', color: 'var(--amber)' },
  swapped: { label: '会换人', color: 'var(--red, #d05656)' },
  unavailable: { label: '体检不可用', color: 'var(--text-3)' },
};

function playBase64(base64: string): void {
  void new Audio(`data:audio/wav;base64,${base64}`).play().catch(() => undefined);
}

export function VoiceWorkshopPanel(): React.JSX.Element {
  const [state, setState] = useState<VoiceWorkshopState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [description, setDescription] = useState('八九岁小女孩，声音甜而脆，元气满满，语速快，句尾翘起来，像随时要跳起来');
  const [dial, setDial] = useState<VoiceWorkshopDial>({ age: 'child', texture: 'sweet_crisp', pace: 'fast', ending: 'rising' });
  const [count, setCount] = useState(4);
  const [candidates, setCandidates] = useState<VoiceWorkshopCandidate[]>([]);
  const [intensity, setIntensity] = useState<VoicePerformanceIntensity>('B');
  const [auditions, setAuditions] = useState<Record<string, Array<{ key: string; label: string; text: string; audioBase64: string }>>>({});

  const reload = useCallback((): void => {
    void window.directorBridge.v2VoiceWorkshopState().then(setState).catch(() => setState(null));
  }, []);
  useEffect(() => { reload(); }, [reload]);

  const current: VoiceTimbreVersion | null = state?.versions.find((item) => item.id === state.currentVersionId) ?? null;
  const composed = composeVoiceWorkshopDescription(description, dial);
  const consistency = current?.consistency ?? null;

  const runConsistency = async (): Promise<void> => {
    setBusy('consistency');
    try {
      const { result, state: next } = await window.directorBridge.v2VoiceWorkshopConsistency();
      setState(next);
      if (result.verdict === 'unavailable') {
        toast.error(`体检未完成：${result.detail}`);
      } else {
        toast.success(`${VERDICT_STYLE[result.verdict]?.label ?? result.verdict}：均值 ${result.mean?.toFixed(4)} · 最低 ${result.min?.toFixed(4)}`);
      }
    } catch (err) {
      toast.error(`体检失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const generate = async (): Promise<void> => {
    setBusy('generate');
    try {
      const list = await window.directorBridge.v2VoiceWorkshopGenerate({ description, dial, count });
      setCandidates(list);
      setAuditions({});
      reload();
      toast.success(`已生成 ${list.length} 条候选（消耗 ${list.length} 次合成）`);
    } catch (err) {
      toast.error(`生成候选失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const audition = async (candidateId: string): Promise<void> => {
    setBusy(`audition-${candidateId}`);
    try {
      const rows = await window.directorBridge.v2VoiceWorkshopAudition({ candidateId, intensity });
      setAuditions((prev) => ({ ...prev, [candidateId]: rows }));
      reload();
      playBase64(rows[0]?.audioBase64 ?? '');
      toast.success(`已出 4 句试戴（强度 ${intensity}，消耗 4 次合成）`);
    } catch (err) {
      toast.error(`试戴失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const freeze = async (candidateId: string): Promise<void> => {
    setBusy(`freeze-${candidateId}`);
    try {
      const { version, state: next } = await window.directorBridge.v2VoiceWorkshopFreeze({ candidateId });
      setState(next);
      await window.directorBridge.prefsSet({ voiceCommercialProvider: 'mimo-tts-voiceclone' });
      toast.success(`已定格「${version.label}」，默认档切到 VoiceClone；接下来自动跑一次体检`);
      // 定格即自动体检（owner 要求）；失败不吞，按体检自己的错误提示走
      try {
        const { result, state: after } = await window.directorBridge.v2VoiceWorkshopConsistency(version.id);
        setState(after);
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

  const rollback = async (versionId: string): Promise<void> => {
    setBusy(`rollback-${versionId}`);
    try {
      const { version, state: next } = await window.directorBridge.v2VoiceWorkshopRollback(versionId);
      setState(next);
      toast.success(`已回退到「${version.label}」`);
    } catch (err) {
      toast.error(`回退失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="mt-2 rounded-xl p-2.5" style={{ border: '1px solid var(--stroke)', background: 'var(--inset)' }} data-voice-workshop>
      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] font-semibold">
        <span>音色工坊<span style={{ color: 'var(--text-3)', fontWeight: 500 }}> · 声线版本 / 体检 / 生成候选 / 多句试戴</span></span>
        <span className="text-[10px]" style={{ color: 'var(--text-3)' }} data-workshop-calls>
          本次会话已合成 {state?.sessionCalls ?? 0} 次（MiMo 限免，配额耗尽会直接报错，不会静默降级）
        </span>
      </div>

      {/* ① 声线卡 */}
      <div className="mt-1.5 rounded-lg p-2" style={{ border: '1px solid var(--stroke)', background: 'var(--surface)' }} data-workshop-current>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] font-semibold" style={{ color: 'var(--text-2)' }}>{current?.label ?? '读取中…'}</span>
          <span className="pill pill-blue" style={{ fontSize: 10 }}>{current?.source === 'factory' ? '出厂 · 已定格' : '已定格 · AI 设计'}</span>
          {consistency !== null && (
            <span className="text-[10px]" style={{ color: VERDICT_STYLE[consistency.verdict]?.color ?? 'var(--text-3)' }} data-workshop-verdict>
              {VERDICT_STYLE[consistency.verdict]?.label ?? consistency.verdict}
              {consistency.mean !== null && ` · 均值 ${consistency.mean.toFixed(4)} / 最低 ${consistency.min?.toFixed(4)} / σ ${consistency.std?.toFixed(4)}`}
            </span>
          )}
        </div>
        <p className="mt-1 text-[10px] leading-relaxed" style={{ color: 'var(--text-3)' }}>{current?.description ?? ''}</p>
        <p className="mt-0.5 truncate font-mono text-[9.5px]" style={{ color: 'var(--text-3)' }} title={current?.referencePath}>
          参考音频：{current?.referencePath ?? '—'}（{(current?.referenceBytes ?? 0) / 1024 | 0} KB）
        </p>
        {consistency?.detail !== undefined && (
          <p className="mt-0.5 text-[10px]" style={{ color: VERDICT_STYLE[consistency.verdict]?.color ?? 'var(--text-3)' }}>{consistency.detail}</p>
        )}
        <div className="mt-1 flex flex-wrap gap-1">
          <button
            type="button"
            data-workshop-check
            disabled={busy !== null}
            onClick={() => void runConsistency()}
            className="rounded-full px-2 py-0.5 text-[10.5px] font-semibold"
            style={{ border: '1px solid var(--stroke)', background: 'var(--surface)', color: 'var(--text-2)' }}
          >
            {busy === 'consistency' ? '体检中（10 次合成）…' : '一致性体检（消耗 10 次合成）'}
          </button>
          <span className="text-[9.5px]" style={{ color: 'var(--text-3)' }}>
            真跑同一句 ×10 克隆再算说话人余弦；工具缺失会如实报「不可用」，不编数字。
            单次 10 条有抽样波动（同一出厂参考三次实测 0.9059 / 0.8632 / 0.8795），拿不准就再跑一次。
          </span>
        </div>

        {/* 版本时间线 */}
        <div className="mt-1.5" data-workshop-versions>
          <span className="text-[10px] font-semibold" style={{ color: 'var(--text-2)' }}>版本时间线</span>
          <div className="mt-0.5 grid gap-0.5">
            {(state?.versions ?? []).map((version) => (
              <div key={version.id} className="flex flex-wrap items-center gap-1.5 text-[10px]" data-workshop-version={version.id}>
                <span style={{ color: version.id === state?.currentVersionId ? 'var(--blue)' : 'var(--text-2)' }}>
                  {version.id === state?.currentVersionId ? '● ' : '○ '}{version.label}
                </span>
                <span style={{ color: 'var(--text-3)' }}>{version.source === 'factory' ? '随包出厂' : 'AI 设计'} · {version.frozenAt.slice(0, 16).replace('T', ' ')}</span>
                {version.id === state?.currentVersionId ? (
                  <span className="pill" style={{ fontSize: 9 }}>当前</span>
                ) : (
                  <button
                    type="button"
                    data-workshop-rollback={version.id}
                    disabled={busy !== null}
                    onClick={() => void rollback(version.id)}
                    className="rounded-full px-1.5 py-0.5"
                    style={{ color: 'var(--text-3)', border: '1px solid var(--stroke)' }}
                  >
                    回退
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ② 生成候选 + ④ 多句试戴/定格 */}
      <div className="mt-1.5 rounded-lg p-2" style={{ border: '1px solid var(--stroke)', background: 'var(--surface)' }} data-workshop-generate-box>
        <span className="text-[10.5px] font-semibold" style={{ color: 'var(--text-2)' }}>生成候选（描述 + 拨盘）</span>
        <textarea
          value={description}
          data-workshop-description
          onChange={(event) => setDescription(event.target.value)}
          rows={2}
          className="mt-1 w-full rounded-md p-1.5 text-[10.5px]"
          style={{ border: '1px solid var(--stroke)', background: 'var(--inset)', color: 'var(--text-1)', resize: 'vertical' }}
        />
        <div className="mt-1 flex flex-wrap gap-1.5">
          {VOICE_WORKSHOP_DIAL_OPTIONS.map((group) => (
            <label key={group.key} className="flex items-center gap-1 text-[10px]" style={{ color: 'var(--text-3)' }}>
              {group.label}
              <select
                data-workshop-dial={group.key}
                value={(dial as Record<string, string | undefined>)[group.key] ?? ''}
                onChange={(event) => setDial((prev) => ({ ...prev, [group.key]: event.target.value === '' ? undefined : event.target.value }))}
                className="rounded-md px-1 py-0.5 text-[10px]"
                style={{ border: '1px solid var(--stroke)', background: 'var(--inset)', color: 'var(--text-2)' }}
              >
                <option value="">不指定</option>
                {group.options.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
          ))}
          <label className="flex items-center gap-1 text-[10px]" style={{ color: 'var(--text-3)' }}>
            条数
            <select
              data-workshop-count
              value={count}
              onChange={(event) => setCount(Number(event.target.value))}
              className="rounded-md px-1 py-0.5 text-[10px]"
              style={{ border: '1px solid var(--stroke)', background: 'var(--inset)', color: 'var(--text-2)' }}
            >
              {[4, 5, 6, 7, 8].map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
        </div>
        <p className="mt-1 text-[9.5px] leading-relaxed" style={{ color: 'var(--text-3)' }} data-workshop-composed>
          实际描述：{composed}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-1">
          <button
            type="button"
            data-workshop-generate
            disabled={busy !== null || description.trim().length < 2}
            onClick={() => void generate()}
            className="rounded-full px-2 py-0.5 text-[10.5px] font-semibold"
            style={{ border: '1px solid var(--stroke)', background: 'var(--inset)', color: 'var(--text-2)' }}
          >
            {busy === 'generate' ? `生成中（${count} 次合成）…` : `生成 ${count} 条候选（消耗 ${count} 次合成）`}
          </button>
          <span className="text-[9.5px]" style={{ color: 'var(--amber)' }}>
            未定格的候选**不能当固定声线**（VoiceDesign 同描述 ×10 余弦最低 0.4145）
          </span>
        </div>

        {/* 表演强度（A/B/C） */}
        <div className="mt-1.5 flex flex-wrap items-center gap-1" data-workshop-intensity>
          <span className="text-[10px] font-semibold" style={{ color: 'var(--text-2)' }}>试戴强度</span>
          {INTENSITIES.map((item) => (
            <button
              key={item.id}
              type="button"
              data-workshop-intensity-option={item.id}
              onClick={() => setIntensity(item.id)}
              title={item.hint}
              className="rounded-full px-1.5 py-0.5 text-[10px]"
              style={{
                border: `1px solid ${intensity === item.id ? 'var(--blue-line)' : 'var(--stroke)'}`,
                background: intensity === item.id ? 'var(--blue-dim)' : 'transparent',
                color: intensity === item.id ? 'var(--blue)' : 'var(--text-3)',
              }}
            >
              {item.label}
            </button>
          ))}
          <span className="text-[9.5px]" style={{ color: 'var(--text-3)' }}>
            {INTENSITIES.find((item) => item.id === intensity)?.hint}
          </span>
        </div>

        {/* 候选列表 */}
        <div className="mt-1.5 grid gap-1" data-workshop-candidates>
          {candidates.length === 0 && (
            <span className="text-[9.5px]" style={{ color: 'var(--text-3)' }}>还没有候选：先点上面的「生成」。</span>
          )}
          {candidates.map((candidate, index) => (
            <div key={candidate.id} className="rounded-md p-1.5" style={{ border: '1px solid var(--stroke)' }} data-workshop-candidate={candidate.id}>
              <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
                <span className="font-semibold" style={{ color: 'var(--text-2)' }}>候选 {index + 1}</span>
                <span style={{ color: 'var(--text-3)' }}>{(candidate.bytes / 1024).toFixed(0)} KB{candidate.durationMs === null ? '' : ` · ${(candidate.durationMs / 1000).toFixed(2)}s`}</span>
                <button
                  type="button"
                  data-workshop-audition={candidate.id}
                  disabled={busy !== null}
                  onClick={() => void audition(candidate.id)}
                  className="rounded-full px-1.5 py-0.5 text-[10px] font-semibold"
                  style={{ border: '1px solid var(--stroke)', background: 'var(--inset)', color: 'var(--text-2)' }}
                >
                  {busy === `audition-${candidate.id}` ? '试戴中（4 次合成）…' : `多句试戴（强度 ${intensity}）`}
                </button>
                <button
                  type="button"
                  data-workshop-freeze={candidate.id}
                  disabled={busy !== null}
                  onClick={() => void freeze(candidate.id)}
                  className="rounded-full px-1.5 py-0.5 text-[10px] font-semibold"
                  style={{ border: '1px solid var(--blue-line)', background: 'var(--blue-dim)', color: 'var(--blue)' }}
                >
                  {busy === `freeze-${candidate.id}` ? '定格中…' : '定格此音色'}
                </button>
              </div>
              {(auditions[candidate.id] ?? []).length > 0 && (
                <div className="mt-1 grid gap-0.5">
                  {(auditions[candidate.id] ?? []).map((row) => (
                    <div key={row.key} className="flex items-center gap-1.5 text-[10px]" data-workshop-audition-row={row.key}>
                      <span style={{ color: 'var(--text-2)', width: 28 }}>{row.label}</span>
                      <span className="truncate" style={{ color: 'var(--text-3)', flex: 1 }} title={row.text}>{row.text}</span>
                      <button
                        type="button"
                        onClick={() => playBase64(row.audioBase64)}
                        className="rounded-full px-1.5 py-0.5"
                        style={{ color: 'var(--text-3)', border: '1px solid var(--stroke)' }}
                      >
                        播放
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      <p className="mt-1 text-[9.5px] leading-relaxed" style={{ color: 'var(--text-3)' }}>
        试戴四句固定为：{MIMO_WORKSHOP_AUDITION_LINES.map((line) => line.label).join(' / ')}；
        情绪映射只走「风格指令 + 前缀标签」，不做按情绪参考音频（已实测证伪：换情绪参考 = 换人）。
        出厂默认（随包 07 甜脆·元气）不会被定格覆盖：定格只写本地 userData，回退到出厂即删除本地副本。
      </p>
    </section>
  );
}
