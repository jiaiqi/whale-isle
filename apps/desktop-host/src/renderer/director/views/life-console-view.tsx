/**
 * Whale Isle V2 「V2 生命中枢」（V2-P1-05）
 * 全量对接 P1 真实 IPC：
 *   - 12 域 CharacterCore + LifeRuntime 活动切换 + 目标/约定写入
 *   - VoiceProvider 实测状态 + 独立 VoiceIdentity + 多轨 AudioMixer + 口型包络预览
 *   - 四级诚实额度矩阵（严禁编造未知余额）
 *   - 五类记忆查询 + 模糊印象归纳 + 级联真删除（Self 保护 + 无明文审计）
 *   - P2/P3 未实现能力以 StageBadge 诚实标注阶段状态，不放假按钮
 */
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  Activity,
  AudioLines,
  Brain,
  Database,
  Gauge,
  Play,
  Plus,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  Square,
  Trash2,
} from 'lucide-react';
import type {
  AudioMixerSnapshot,
  CharacterCoreSnapshot,
  LifeActivityKind,
  MemoryCategory,
  MemoryDeletionAudit,
  ProviderQuotaMatrix,
  ProviderQuotaReport,
  VoiceProviderStatus,
} from '@workbench/shared-protocol';
import type { V2MemoryQueryResult } from '../bridge';
import { LicenseBadge, SonarRing, StageBadge } from '../v2/signature-widgets';

const ACTIVITIES: Array<{ mode: LifeActivityKind; label: string }> = [
  { mode: 'companion', label: '桌面陪伴' },
  { mode: 'gaming', label: '游戏共玩' },
  { mode: 'creative', label: '创作思考' },
  { mode: 'resting', label: '静息睡眠' },
];

const MEMORY_CATEGORIES: Array<{ id: MemoryCategory; label: string }> = [
  { id: 'working', label: '工作记忆 Working' },
  { id: 'episodic', label: '情景 Episodic' },
  { id: 'semantic', label: '语义 Semantic' },
  { id: 'relational', label: '关系 Relational' },
  { id: 'self', label: '自我 Self（受保护）' },
];

const DEFAULT_QUOTA_PROVIDERS = [
  'deepseek-official',
  'kimi-moonshot',
  'minimax',
  'openrouter',
  'siliconflow',
  'opencode-go',
  'ollama-local',
  'openai',
];

function formatQuotaMetric(report: ProviderQuotaReport): string {
  if (!report.queryable) return '未知（该供应商无查询接口，绝不编造）';
  const parts: string[] = [];
  if (report.balance !== null) {
    const cur = report.balance.currency ?? '';
    if (report.balance.remaining !== null) parts.push(`剩余 ${cur}${report.balance.remaining}`);
    else if (report.balance.total !== null) parts.push(`总额 ${cur}${report.balance.total}`);
  }
  for (const w of report.windows) {
    if (w.remainingPercent !== null) parts.push(`${w.label}: 余 ${w.remainingPercent}%`);
    else if (w.usedPercent !== null) parts.push(`${w.label}: 已用 ${w.usedPercent}%`);
  }
  return parts.length > 0 ? parts.join(' · ') : report.summary;
}

export function LifeConsoleView({
  snapshot,
  onSnapshotChanged,
}: {
  snapshot: CharacterCoreSnapshot | null;
  onSnapshotChanged: () => Promise<void>;
}): React.JSX.Element {
  const [storageInfo, setStorageInfo] = useState<{ ok: boolean; engine: string; schemaVersion: string | null; integrity: string } | null>(null);
  const [voiceProviders, setVoiceProviders] = useState<VoiceProviderStatus[]>([]);
  const [mixer, setMixer] = useState<AudioMixerSnapshot | null>(null);
  const [lipCount, setLipCount] = useState<number | null>(null);
  const [quotaMatrix, setQuotaMatrix] = useState<ProviderQuotaMatrix | null>(null);
  const [quotaLoading, setQuotaLoading] = useState(false);

  const [goalDraft, setGoalDraft] = useState('');
  const [commitDraft, setCommitDraft] = useState('');

  const [memQuery, setMemQuery] = useState('');
  const [memFilter, setMemFilter] = useState<MemoryCategory | 'all'>('all');
  const [memHits, setMemHits] = useState<V2MemoryQueryResult['hits']>([]);
  const [memAddCategory, setMemAddCategory] = useState<MemoryCategory>('episodic');
  const [memAddText, setMemAddText] = useState('');
  const [audits, setAudits] = useState<MemoryDeletionAudit[]>([]);
  const [busy, setBusy] = useState(false);

  const loadAll = useCallback(async (): Promise<void> => {
    const [storage, providers, mix, auditRows] = await Promise.all([
      window.directorBridge.v2StorageCheck().catch(() => null),
      window.directorBridge.v2VoiceProviders().catch(() => []),
      window.directorBridge.v2VoiceMixerState().catch(() => null),
      window.directorBridge.v2MemoryDeletionAudits().catch(() => []),
    ]);
    if (storage !== null) setStorageInfo(storage);
    setVoiceProviders(providers);
    if (mix !== null) setMixer(mix);
    setAudits(auditRows);
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const refreshQuotas = async (): Promise<void> => {
    setQuotaLoading(true);
    try {
      const matrix = await window.directorBridge.v2ProviderQuotaMatrix({
        providerIds: DEFAULT_QUOTA_PROVIDERS,
        includeCli: true,
      });
      setQuotaMatrix(matrix);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '额度探针查询失败');
    } finally {
      setQuotaLoading(false);
    }
  };

  const handleSelectActivity = async (mode: LifeActivityKind): Promise<void> => {
    setBusy(true);
    try {
      const res = await window.directorBridge.v2SelectActivity({
        mode,
        reason: 'V2 生命中枢切换活动',
        source: 'user_command',
      });
      if (!res.accepted) {
        toast.warning(`活动切换被拒绝：${res.reason ?? '未知原因'}`);
      } else {
        toast.success(`已切换活动状态：${mode}`);
      }
      await onSnapshotChanged();
    } finally {
      setBusy(false);
    }
  };

  const handleAddGoal = async (): Promise<void> => {
    const title = goalDraft.trim();
    if (title === '') return;
    setBusy(true);
    try {
      await window.directorBridge.v2AddGoal({ title, priority: 80, relatedActivity: 'companion' });
      setGoalDraft('');
      toast.success(`已添加目标：${title}`);
      await onSnapshotChanged();
    } finally {
      setBusy(false);
    }
  };

  const handleAddCommitment = async (): Promise<void> => {
    const title = commitDraft.trim();
    if (title === '') return;
    setBusy(true);
    try {
      await window.directorBridge.v2AddCommitment({ partnerId: 'owner', partnerName: '主人', title });
      setCommitDraft('');
      toast.success(`已记下约定：${title}`);
      await onSnapshotChanged();
    } finally {
      setBusy(false);
    }
  };

  const handleStartTestBgm = async (): Promise<void> => {
    await window.directorBridge.v2VoiceTrackStart({
      trackId: 'bgm-console-preview',
      kind: 'bgm',
      label: 'V2 中枢伴奏轨',
      gain: 0.65,
    });
    setMixer(await window.directorBridge.v2VoiceMixerState());
    toast.success('已开启多轨 AudioMixer 伴奏轨');
  };

  const handleStopTestBgm = async (): Promise<void> => {
    await window.directorBridge.v2VoiceTrackStop('bgm-console-preview');
    setMixer(await window.directorBridge.v2VoiceMixerState());
    toast('已停止伴奏轨');
  };

  const handleLipPreview = async (): Promise<void> => {
    const res = await window.directorBridge.v2VoiceSynthesizePreview({
      text: '主人，这是 V2 多轨语音与口型包络测试。',
    });
    setLipCount(res.lipFrames.length);
    toast.success(`已生成 ${res.lipFrames.length} 帧口型包络（${res.providerKind}）`);
  };

  const runMemSearch = async (q = memQuery, cat = memFilter): Promise<void> => {
    const term = q.trim() === '' ? '小' : q.trim();
    const res = await window.directorBridge.v2MemoryQuery({
      query: term,
      ...(cat === 'all' ? {} : { categories: [cat] }),
      topN: 15,
      recordRecall: false,
    });
    setMemHits(res.hits);
  };

  const handleAddMemory = async (): Promise<void> => {
    const text = memAddText.trim();
    if (text === '') return;
    const res = await window.directorBridge.v2MemoryAdd({
      nodeType: 'event',
      category: memAddCategory,
      text,
      emotionWeight: 0.7,
    });
    if (res.ok) {
      setMemAddText('');
      setMemQuery(text);
      toast.success(`已写入 ${memAddCategory} 记忆节点`);
      await runMemSearch(text, memFilter);
    } else {
      toast.error(res.error ?? '写入失败');
    }
  };

  const handleHardDelete = async (nodeId: string): Promise<void> => {
    const res = await window.directorBridge.v2MemoryHardDelete({
      nodeId,
      reason: 'V2 中枢主动级联删除',
    });
    if (res.deleted) {
      toast.success(`已完成级联真删除（清理 ${res.deletedNodeIds?.length ?? 1} 个节点与审计归档）`);
      setMemHits((prev) => prev.filter((h) => h.id !== nodeId));
      setAudits(await window.directorBridge.v2MemoryDeletionAudits());
    } else {
      toast.warning(`删除被保护策略拦截：${res.blockedReason ?? '未知'}`);
    }
  };

  const handleConsolidate = async (): Promise<void> => {
    const res = await window.directorBridge.v2MemoryConsolidate({ minInteractions: 2 });
    toast.success(`模糊印象归纳完成：新增/更新 ${res.impressions.length} 条关系印象`);
  };

  const activeEmbodiment = snapshot?.embodiments.find((e) => e.active) ?? snapshot?.embodiments[0];

  return (
    <div data-v2-life-console className="mx-auto max-w-[1320px] space-y-4 px-6 py-5">
      {/* Header Summary Card */}
      <section className="card flex flex-wrap items-center gap-3 px-5 py-4">
        <SonarRing
          expression={snapshot?.activityState.expression ?? 'idle'}
          halted={snapshot?.activityState.halted ?? false}
          size={36}
        />
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-lg font-semibold">
              {snapshot?.identity.displayName ?? '小鲸'} · V2 生命中枢
            </h1>
            <span className="mono pill">{snapshot?.identity.characterId ?? 'char_xiaojing'}</span>
            {activeEmbodiment && <LicenseBadge scope={activeEmbodiment.licenseScope} compact />}
            {storageInfo && (
              <span className={`pill mono ${storageInfo.ok ? 'pill-green' : 'pill-red'}`} style={{ fontSize: 10 }}>
                <Database size={10} />
                {storageInfo.engine} · v{storageInfo.schemaVersion ?? '?'} · {storageInfo.integrity}
              </span>
            )}
          </div>
          <p className="mt-1 text-xs" style={{ color: 'var(--text-2)' }}>
            统一 12 域身份/人格/目标/约定/声音/记忆事实源 —— 所有数值均实时取自 Electron 主进程内核，无任何伪造指标。
          </p>
        </div>
        <div className="flex-1" />
        <button
          type="button"
          className="btn-pill ghost"
          onClick={() => { void onSnapshotChanged(); void loadAll(); }}
        >
          <RefreshCw size={12} />刷新全舱
        </button>
      </section>

      {/* Grid 1: CharacterCore & LifeRuntime + Multi-Track Voice */}
      <div className="grid gap-4 lg:grid-cols-2">
        <section className="card space-y-3 px-5 py-4" data-v2-character-section>
          <div className="flex items-center justify-between">
            <h2 className="flex items-center gap-1.5 text-sm font-semibold">
              <Sparkles size={14} style={{ color: 'var(--blue)' }} />
              12 域 CharacterCore 与 LifeRuntime
            </h2>
            <span className="mono text-[11px]" style={{ color: 'var(--text-3)' }}>
              主脑绑定：{snapshot?.activityState.activeModelRef ?? '未绑定'}
            </span>
          </div>

          <div className="flex flex-wrap gap-1.5">
            {ACTIVITIES.map((act) => {
              const active = snapshot?.activityState.mode === act.mode;
              return (
                <button
                  key={act.mode}
                  type="button"
                  data-v2-activity={act.mode}
                  disabled={busy}
                  onClick={() => void handleSelectActivity(act.mode)}
                  className={`pill cursor-pointer ${active ? 'pill-blue' : ''}`}
                >
                  <Activity size={10} />
                  <span>{act.label}</span>
                </button>
              );
            })}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            {/* Goals */}
            <div className="inset space-y-2 p-3">
              <div className="flex items-center justify-between text-xs font-semibold">
                <span>活跃目标栈（Goals）</span>
                <span className="mono text-[10px]" style={{ color: 'var(--text-3)' }}>
                  {snapshot?.goals.length ?? 0} 条
                </span>
              </div>
              <div className="flex gap-1.5">
                <input
                  data-v2-goal-input
                  value={goalDraft}
                  onChange={(e) => setGoalDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void handleAddGoal(); }}
                  placeholder="新增小鲸目标…"
                  className="min-w-0 flex-1 rounded-lg px-2.5 py-1 text-xs outline-none"
                  style={{ background: 'var(--surface-solid)', border: '1px solid var(--stroke)', color: 'var(--text-1)' }}
                />
                <button
                  type="button"
                  data-v2-goal-add
                  disabled={busy}
                  onClick={() => void handleAddGoal()}
                  className="btn-pill primary"
                  style={{ padding: '4px 10px', fontSize: 11 }}
                >
                  <Plus size={11} />添加
                </button>
              </div>
              <div className="max-h-36 space-y-1 overflow-y-auto">
                {(snapshot?.goals ?? []).slice(-6).reverse().map((g) => (
                  <div key={g.goalId} data-v2-goal-item className="rounded-lg px-2 py-1 text-[11px]" style={{ background: 'var(--surface)', border: '1px solid var(--stroke)' }}>
                    <span className="font-medium">{g.title}</span>
                    <span className="mono ml-1.5 text-[9.5px]" style={{ color: 'var(--text-3)' }}>[{g.status}]</span>
                  </div>
                ))}
                {(snapshot?.goals.length ?? 0) === 0 && (
                  <p className="text-[11px]" style={{ color: 'var(--text-3)' }}>尚无长期/短期目标</p>
                )}
              </div>
            </div>

            {/* Commitments */}
            <div className="inset space-y-2 p-3">
              <div className="flex items-center justify-between text-xs font-semibold">
                <span>主仆约定账本（Commitments）</span>
                <span className="mono text-[10px]" style={{ color: 'var(--text-3)' }}>
                  {snapshot?.commitments.length ?? 0} 条
                </span>
              </div>
              <div className="flex gap-1.5">
                <input
                  data-v2-commitment-input
                  value={commitDraft}
                  onChange={(e) => setCommitDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void handleAddCommitment(); }}
                  placeholder="新增共同约定…"
                  className="min-w-0 flex-1 rounded-lg px-2.5 py-1 text-xs outline-none"
                  style={{ background: 'var(--surface-solid)', border: '1px solid var(--stroke)', color: 'var(--text-1)' }}
                />
                <button
                  type="button"
                  data-v2-commitment-add
                  disabled={busy}
                  onClick={() => void handleAddCommitment()}
                  className="btn-pill ghost"
                  style={{ padding: '4px 10px', fontSize: 11 }}
                >
                  <Plus size={11} />记下
                </button>
              </div>
              <div className="max-h-36 space-y-1 overflow-y-auto">
                {(snapshot?.commitments ?? []).slice(-6).reverse().map((c) => (
                  <div key={c.commitmentId} data-v2-commitment-item className="rounded-lg px-2 py-1 text-[11px]" style={{ background: 'var(--surface)', border: '1px solid var(--stroke)' }}>
                    <span className="font-medium">{c.title}</span>
                    <span className="mono ml-1.5 text-[9.5px]" style={{ color: 'var(--text-3)' }}>{c.status}</span>
                  </div>
                ))}
                {(snapshot?.commitments.length ?? 0) === 0 && (
                  <p className="text-[11px]" style={{ color: 'var(--text-3)' }}>尚无已登记约定</p>
                )}
              </div>
            </div>
          </div>
        </section>

        {/* VoiceProvider & Multi-Track AudioMixer */}
        <section className="card space-y-3 px-5 py-4" data-v2-voice-section>
          <div className="flex items-center justify-between">
            <h2 className="flex items-center gap-1.5 text-sm font-semibold">
              <AudioLines size={14} style={{ color: 'var(--green)' }} />
              VoiceIdentity · 多轨 AudioMixer · 口型同步
            </h2>
            <span className="mono pill" style={{ fontSize: 10 }}>
              声线 {snapshot?.voiceIdentity.voiceProfileId ?? 'qiaopi_mengmei'}
            </span>
          </div>

          <div className="flex flex-wrap gap-1.5">
            {voiceProviders.map((vp) => (
              <span
                key={vp.kind}
                className={`pill mono ${vp.available && !vp.degraded ? 'pill-green' : vp.available ? 'pill-amber' : ''}`}
                style={{ fontSize: 10 }}
                title={vp.detail}
              >
                {vp.kind} ({vp.quality}{vp.available ? '' : ' · 未就绪'})
              </span>
            ))}
          </div>

          <div className="inset space-y-2 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <span>
                活跃音轨：<b>{mixer?.tracks.length ?? 0}</b> · 自动压低（Ducking）：
                <b>{mixer?.duckingActive ? '生效中' : '待命'}</b>
              </span>
              <div className="flex flex-wrap gap-1.5">
                <button
                  type="button"
                  data-v2-mixer-start-bgm
                  onClick={() => void handleStartTestBgm()}
                  className="btn-pill green"
                  style={{ padding: '4px 10px', fontSize: 11 }}
                >
                  <Play size={10} />启伴奏轨
                </button>
                <button
                  type="button"
                  data-v2-mixer-stop-bgm
                  onClick={() => void handleStopTestBgm()}
                  className="btn-pill ghost"
                  style={{ padding: '4px 10px', fontSize: 11 }}
                >
                  <Square size={10} />停伴奏轨
                </button>
                <button
                  type="button"
                  data-v2-lip-preview
                  onClick={() => void handleLipPreview()}
                  className="btn-pill violet"
                  style={{ padding: '4px 10px', fontSize: 11 }}
                >
                  口型包络预览{lipCount !== null ? ` (${lipCount}帧)` : ''}
                </button>
              </div>
            </div>
            {(mixer?.tracks ?? []).length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {mixer!.tracks.map((t) => (
                  <span key={t.trackId} data-v2-mixer-track={t.trackId} className="pill pill-blue mono" style={{ fontSize: 10 }}>
                    {t.kind} · {t.label} · 路由 {t.outputDeviceId}
                  </span>
                ))}
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2 pt-1">
            <StageBadge stage="P3" label="SVS 歌声与版权曲库未接线" />
            <StageBadge stage="P2" label="3D VRM 与 Blender 管线规划中" />
            <StageBadge stage="P4" label="Social L2→L3 社区发布未开启" />
          </div>
        </section>
      </div>

      {/* Section C: Four-Level Honest Quota Matrix */}
      <section className="card space-y-3 px-5 py-4" data-v2-quota-section>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="flex items-center gap-1.5 text-sm font-semibold">
              <Gauge size={14} style={{ color: 'var(--amber)' }} />
              四级诚实额度矩阵（Official API / 第三方 / CLI 状态 / 未知）
            </h2>
            <p className="mt-0.5 text-[11px]" style={{ color: 'var(--text-3)' }}>
              严格标明数据来源与刷新时间；未实测或不可查接口（如 OpenAI 账户接口）严禁编造余额，强制显示「未知」。
            </p>
          </div>
          <button
            type="button"
            data-v2-quota-refresh
            disabled={quotaLoading}
            onClick={() => void refreshQuotas()}
            className="btn-pill primary"
            style={{ padding: '5px 12px', fontSize: 11.5 }}
          >
            <RefreshCw size={12} />
            <span>{quotaLoading ? '探针实测中…' : '刷新真实额度矩阵'}</span>
          </button>
        </div>

        {quotaMatrix === null ? (
          <div className="inset px-4 py-3 text-xs" style={{ color: 'var(--text-3)' }}>
            点击「刷新真实额度矩阵」执行本机钥匙串 / 官方接口 / CLI 只读探测（按需请求，不空跑配额）。
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-xs">
              <thead>
                <tr className="border-b" style={{ borderColor: 'var(--stroke)', color: 'var(--text-3)' }}>
                  <th className="py-1.5 pr-3">服务商</th>
                  <th className="py-1.5 pr-3">诚实层级 Source</th>
                  <th className="py-1.5 pr-3">认证状态</th>
                  <th className="py-1.5 pr-3">余额 / 窗口配额</th>
                  <th className="py-1.5">实测说明</th>
                </tr>
              </thead>
              <tbody>
                {quotaMatrix.reports.map((r) => (
                  <tr
                    key={r.providerId}
                    data-v2-quota-row={r.providerId}
                    data-quota-source={r.source}
                    className="border-b"
                    style={{ borderColor: 'var(--stroke)' }}
                  >
                    <td className="py-2 pr-3 font-medium">
                      <div>{r.providerName}</div>
                      <div className="mono text-[10px]" style={{ color: 'var(--text-3)' }}>{r.providerId}</div>
                    </td>
                    <td className="py-2 pr-3">
                      <span
                        className={`pill mono ${
                          r.source === 'official_api'
                            ? 'pill-green'
                            : r.source === 'cli_status' || r.source === 'verifiable_third_party'
                              ? 'pill-blue'
                              : ''
                        }`}
                        style={{ fontSize: 10 }}
                      >
                        {r.source}
                      </span>
                    </td>
                    <td className="py-2 pr-3 mono text-[11px]" style={{ color: r.authState === 'authenticated' ? 'var(--green)' : 'var(--text-2)' }}>
                      {r.authState}
                    </td>
                    <td className="py-2 pr-3 text-[11.5px]">{formatQuotaMetric(r)}</td>
                    <td className="py-2 text-[11px]" style={{ color: 'var(--text-3)' }}>
                      {r.summary}
                      {r.errorDetail ? ` · ${r.errorDetail}` : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Section D: Five-Category Memory & Cascade Hard Delete */}
      <section className="card space-y-3 px-5 py-4" data-v2-memory-section>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="flex items-center gap-1.5 text-sm font-semibold">
              <Brain size={14} style={{ color: 'var(--violet)' }} />
              五类记忆 · 模糊印象归纳 · 级联真删除（Self 保护域）
            </h2>
            <p className="mt-0.5 text-[11px]" style={{ color: 'var(--text-3)' }}>
              主动删除会级联清理衍生摘要、磁盘 JSONL 与 SQLite 常客账本，并写入无明文 DeletionAudit。
            </p>
          </div>
          <button
            type="button"
            data-v2-memory-consolidate
            onClick={() => void handleConsolidate()}
            className="btn-pill ghost"
            style={{ padding: '5px 12px', fontSize: 11.5 }}
          >
            归纳模糊印象
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            className={`pill cursor-pointer ${memFilter === 'all' ? 'pill-blue' : ''}`}
            onClick={() => { setMemFilter('all'); void runMemSearch(memQuery, 'all'); }}
          >全部五类</button>
          {MEMORY_CATEGORIES.map((c) => (
            <button
              key={c.id}
              type="button"
              className={`pill cursor-pointer ${memFilter === c.id ? 'pill-violet' : ''}`}
              onClick={() => { setMemFilter(c.id); void runMemSearch(memQuery, c.id); }}
            >{c.label}</button>
          ))}
        </div>

        <div className="grid gap-3 lg:grid-cols-2">
          <div className="inset flex flex-wrap items-center gap-2 p-3">
            <input
              data-v2-memory-search
              value={memQuery}
              onChange={(e) => setMemQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void runMemSearch(); }}
              placeholder="按语义/实体检索五类记忆…"
              className="min-w-0 flex-1 rounded-lg px-2.5 py-1.5 text-xs outline-none"
              style={{ background: 'var(--surface-solid)', border: '1px solid var(--stroke)', color: 'var(--text-1)' }}
            />
            <button
              type="button"
              data-v2-memory-search-btn
              onClick={() => void runMemSearch()}
              className="btn-pill primary"
              style={{ padding: '5px 12px', fontSize: 11 }}
            >检索</button>
          </div>

          <div className="inset flex flex-wrap items-center gap-2 p-3">
            <select
              data-v2-memory-add-category
              value={memAddCategory}
              onChange={(e) => setMemAddCategory(e.target.value as MemoryCategory)}
              className="rounded-lg px-2 py-1.5 text-xs outline-none"
              style={{ background: 'var(--surface-solid)', border: '1px solid var(--stroke)', color: 'var(--text-1)' }}
            >
              {MEMORY_CATEGORIES.map((c) => (
                <option key={c.id} value={c.id}>{c.id}</option>
              ))}
            </select>
            <input
              data-v2-memory-add-text
              value={memAddText}
              onChange={(e) => setMemAddText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void handleAddMemory(); }}
              placeholder="写入新记忆条目（测试分类与真删除）…"
              className="min-w-0 flex-1 rounded-lg px-2.5 py-1.5 text-xs outline-none"
              style={{ background: 'var(--surface-solid)', border: '1px solid var(--stroke)', color: 'var(--text-1)' }}
            />
            <button
              type="button"
              data-v2-memory-add-btn
              onClick={() => void handleAddMemory()}
              className="btn-pill green"
              style={{ padding: '5px 12px', fontSize: 11 }}
            >
              <Plus size={11} />写入
            </button>
          </div>
        </div>

        <div className="space-y-1.5">
          {memHits.map((hit) => (
            <div
              key={hit.id}
              data-v2-memory-hit={hit.id}
              className="flex flex-wrap items-center gap-2 rounded-xl px-3 py-2 text-xs"
              style={{ background: 'var(--surface-2)', border: '1px solid var(--stroke)' }}
            >
              <span className="pill pill-violet mono" style={{ fontSize: 10 }}>{hit.category}</span>
              <span className="pill mono" style={{ fontSize: 10 }}>{hit.certainty}</span>
              <span className="min-w-0 flex-1">{hit.text}</span>
              <span className="mono text-[10px]" style={{ color: 'var(--text-3)' }}>score {hit.score}</span>
              <button
                type="button"
                data-v2-memory-delete={hit.id}
                onClick={() => void handleHardDelete(hit.id)}
                className="pill pill-red cursor-pointer"
                style={{ fontSize: 10 }}
                title="级联真删除（Self 受保护节点会被拒绝）"
              >
                <Trash2 size={10} />真删除
              </button>
            </div>
          ))}
        </div>

        <div className="inset p-3" data-v2-deletion-audits>
          <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold" style={{ color: 'var(--text-2)' }}>
            <ShieldAlert size={11} style={{ color: 'var(--amber)' }} />
            无明文删除审计日志（{audits.length} 条 · 不留被删正文）
          </div>
          {audits.length === 0 ? (
            <span className="text-[11px]" style={{ color: 'var(--text-3)' }}>暂无删除审计</span>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {audits.slice(-6).reverse().map((a) => (
                <span key={a.auditId} className="pill mono" style={{ fontSize: 10 }}>
                  {a.targetCategory} · {a.targetNodeId.slice(0, 12)} · 清理 {a.deletedNodeIds.length} 节点
                </span>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
