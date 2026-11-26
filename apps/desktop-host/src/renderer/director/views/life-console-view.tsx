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
  Compass,
  Database,
  Gamepad2,
  Gauge,
  Hand,
  KeyRound,
  Layers,
  Monitor,
  Music2,
  Play,
  Plus,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Square,
  Trash2,
  Wand2,
} from 'lucide-react';
import type {
  AudioMixerSnapshot,
  BlenderToolchainStatus,
  BrowserComputerSnapshot,
  BrowserTaskOutcome,
  CharacterCoreSnapshot,
  CoopModCompatibilityReport,
  CoopRuntimeSnapshot,
  LifeActivityKind,
  LiveRuntimeSnapshot,
  MemoryCategory,
  MemoryDeletionAudit,
  PerformanceSnapshot,
  ProviderQuotaMatrix,
  ProviderQuotaReport,
  SingProviderStatus,
  StageBackendKind,
  StageRuntimeSnapshot,
  VoiceProviderStatus,
} from '@workbench/shared-protocol';
import type { V2MemoryQueryResult } from '../bridge';
import { PageHead } from '../shell/page-head';
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

  // V2-P3-01 表演总控 & 2D/Live2D/VRM/OBS StageRuntime 实时状态
  const [perfSnap, setPerfSnap] = useState<PerformanceSnapshot | null>(null);
  const [stageSnap, setStageSnap] = useState<StageRuntimeSnapshot | null>(null);
  const [singBackends, setSingBackends] = useState<SingProviderStatus[]>([]);
  // V2-P2 创作工坊 & 联机协作实时基数
  const [p2Summary, setP2Summary] = useState<{
    blender: BlenderToolchainStatus | null;
    bibleCount: number;
    assetCount: number;
    coopRoom: CoopRuntimeSnapshot | null;
    compatReport: CoopModCompatibilityReport | null;
  }>({ blender: null, bibleCount: 0, assetCount: 0, coopRoom: null, compatReport: null });
  const [liveSnap, setLiveSnap] = useState<LiveRuntimeSnapshot | null>(null);
  // V2-P3-03 受控 Browser Use / Computer Use
  const [autoSnap, setAutoSnap] = useState<BrowserComputerSnapshot | null>(null);
  const [lastBrowserOutcome, setLastBrowserOutcome] = useState<BrowserTaskOutcome | null>(null);
  const [acctDraft, setAcctDraft] = useState({ characterId: 'char_xiaojing', platform: 'bilibili', username: '', secret: '' });

  const loadAll = useCallback(async (): Promise<void> => {
    const [storage, providers, mix, auditRows, perfRes, blender, bibles, assets, coop, liveRes, auto] = await Promise.all([
      window.directorBridge.v2StorageCheck().catch(() => null),
      window.directorBridge.v2VoiceProviders().catch(() => []),
      window.directorBridge.v2VoiceMixerState().catch(() => null),
      window.directorBridge.v2MemoryDeletionAudits().catch(() => []),
      window.directorBridge.v2PerfSnapshot().catch(() => null),
      window.directorBridge.v23dToolchain().catch(() => null),
      window.directorBridge.v2BibleList().catch(() => []),
      window.directorBridge.v2AssetList().catch(() => []),
      window.directorBridge.v2CoopSnapshot().catch(() => null),
      window.directorBridge.v2LiveSnapshot().catch(() => null),
      window.directorBridge.v2AutoSnapshot().catch(() => null),
    ]);
    if (storage !== null) setStorageInfo(storage);
    setVoiceProviders(providers);
    if (mix !== null) setMixer(mix);
    setAudits(auditRows);
    if (perfRes !== null) {
      setPerfSnap(perfRes.performance);
      setStageSnap(perfRes.stage);
      setSingBackends(perfRes.singBackends);
    }
    if (liveRes !== null) setLiveSnap(liveRes);
    if (auto !== null) setAutoSnap(auto);
    setP2Summary((prev) => ({
      ...prev,
      blender,
      bibleCount: bibles.length,
      assetCount: assets.length,
      coopRoom: coop,
    }));
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

  const handleSwitchStageBackend = async (backend: StageBackendKind): Promise<void> => {
    const res = await window.directorBridge.v2StageSwitchBackend({ backend });
    if (!res.ok || !res.stage) {
      toast.error(res.error ?? '舞台维度切换失败');
      return;
    }
    setStageSnap(res.stage);
    toast.success(`已无缝切换至 ${backend}（保留角色与歌词状态）`);
  };

  const handleDemoSingAndDance = async (): Promise<void> => {
    const startRes = await window.directorBridge.v2PerfSingStart({
      request: {
        requestId: `ui-sing-${Date.now().toString(36)}`,
        characterId: snapshot?.identity.characterId ?? 'char_xiaojing',
        voiceProfileId: snapshot?.voiceIdentity.voiceProfileId ?? 'qiaopi_mengmei',
        mode: 'svs',
        channel: 'livestream_public',
        song: {
          songId: 'tidepaper-morning-song',
          title: '鲸屿晨雾',
          durationMs: 6000,
          accompanimentTrackPath: 'assets/audio/tide-accomp.wav',
          lyrics: [
            { index: 0, startMs: 0, endMs: 2200, primaryText: '潮汐漫过晨雾里的石阶', secondaryText: 'Tide laps gently across misty stone steps' },
            { index: 1, startMs: 2200, endMs: 6000, primaryText: '小鲸为你点亮海图的星光', secondaryText: 'Xiaojing lights up starlight on the sea chart' },
          ],
          rights: {
            songLicense: 'original_owned',
            accompanimentLicense: 'original_owned',
            lyricsLicense: 'original_owned',
            voiceModelAuthorized: true,
            voiceConsentSource: 'whale-isle-original',
          },
        },
      },
      danceRoutine: {
        routineId: 'tide-wave-dance',
        title: '晨汐挥手舞',
        durationMs: 6000,
        cues: [
          { cueId: 'cue-wave', atMs: 0, durationMs: 2200, poseId: 'wave_arms', vrmMotionTag: 'dance_wave', expressionId: 'happy' },
          { cueId: 'cue-spin', atMs: 2200, durationMs: 3800, poseId: 'spin_smile', vrmMotionTag: 'dance_spin', expressionId: 'singing' },
        ],
      },
    });
    if (!startRes.ok) {
      toast.error(startRes.error ?? '试演启动失败');
      return;
    }
    const ticked = await window.directorBridge.v2PerfTick(2500);
    setPerfSnap(ticked.performance);
    setStageSnap(ticked.stage);
    setMixer(ticked.performance.mixer);
    toast.success(`已同步唱跳与双语歌词（后端模式：${startRes.result?.backendMode ?? 'preview_guide_tone'}）`);
  };

  const handleTestNcBlock = async (): Promise<void> => {
    const res = await window.directorBridge.v2PerfSingStart({
      request: {
        requestId: `ui-nc-${Date.now().toString(36)}`,
        characterId: snapshot?.identity.characterId ?? 'char_xiaojing',
        voiceProfileId: snapshot?.voiceIdentity.voiceProfileId ?? 'qiaopi_mengmei',
        mode: 'svs',
        channel: 'livestream_public',
        song: {
          songId: 'nc-demo-song',
          title: '非商用曲目测试',
          durationMs: 3000,
          rights: {
            songLicense: 'dev_only_non_commercial',
            accompanimentLicense: 'original_owned',
            lyricsLicense: 'original_owned',
            voiceModelAuthorized: true,
            voiceConsentSource: 'test-consent',
          },
        },
      },
    });
    if (!res.ok) {
      toast.warning(`版权门禁已生效阻断：${res.result?.rightsCheck.reasons.join('；') ?? res.error ?? '禁止进入公开直播'}`);
    }
  };

  const handleStopPerformance = async (): Promise<void> => {
    const res = await window.directorBridge.v2PerfStop('ui_stop');
    setPerfSnap(res.performance);
    setStageSnap(res.stage);
    setMixer(res.performance.mixer);
    toast('表演已停演归零');
  };

  const handleScanCoopMods = async (): Promise<void> => {
    const res = await window.directorBridge.v2CoopModCompat();
    if (!res.ok || !res.report) {
      toast.warning(res.error ?? '未检测到星露谷 Mods 目录');
      return;
    }
    setP2Summary((prev) => ({ ...prev, compatReport: res.report ?? null }));
    toast.success(`星露谷 Mods 扫描完成：BWF ${res.report.bwfReady ? '就绪' : '缺件'} · 发现 ${res.report.hostModCount} 个 Mod`);
  };

  const refreshAuto = async (): Promise<void> => {
    setAutoSnap(await window.directorBridge.v2AutoSnapshot());
  };

  const handleRegisterAccount = async (): Promise<void> => {
    const { characterId, platform, username, secret } = acctDraft;
    if (characterId.trim() === '' || platform.trim() === '' || username.trim() === '' || secret.trim() === '') {
      toast.warning('请填写角色、平台、账号与凭据（凭据只在主进程加密保存）');
      return;
    }
    const registered = await window.directorBridge.v2AutoAccountRegister({
      characterId: characterId.trim(),
      platform: platform.trim(),
      username: username.trim(),
      plainSecret: secret,
    });
    setAcctDraft((prev) => ({ ...prev, secret: '', username: '' }));
    if (!registered.ok) {
      toast.error(registered.error ?? '账号写入失败');
      return;
    }
    const accountId = registered.entry?.accountId;
    if (accountId) {
      const profile = await window.directorBridge.v2AutoProfileEnsure({ characterId: characterId.trim(), accountId });
      if (!profile.ok) toast.error(profile.error ?? '隔离 Profile 创建失败');
    }
    await refreshAuto();
    toast.success(`账号已写入隔离库（${registered.entry?.maskedSecret ?? '••••'}），明文不会下行`);
  };

  const handleAcquireDesktopLease = async (): Promise<void> => {
    const res = await window.directorBridge.v2AutoLease({
      action: 'acquire',
      deviceId: 'host-primary',
      holderId: 'director-ui',
      characterId: snapshot?.identity.characterId ?? 'char_xiaojing',
      purpose: '中控台手动申请桌面租约',
    });
    await refreshAuto();
    if (!res.ok) toast.warning(`桌面租约申请被拒绝：${res.reason ?? '未知'}`);
    else toast.success(`已获得桌面独占租约：${res.lease?.leaseId ?? ''}`);
  };

  const handleSimulateHumanInput = async (): Promise<void> => {
    const res = await window.directorBridge.v2AutoInputSimulate('host-primary');
    await refreshAuto();
    toast(
      res.preemptedLease
        ? `已模拟用户物理输入：桌面租约 ${res.preemptedLease.leaseId} 被撤销（游戏租约不受影响）`
        : '已模拟用户物理输入：当前没有桌面租约可撤销',
    );
  };

  const handleDryRunInput = async (): Promise<void> => {
    const res = await window.directorBridge.v2AutoExecInput({
      leaseId: autoSnap?.activeLeases[0]?.leaseId ?? null,
      step: { kind: 'click', x: 10, y: 10, detail: '中控台 OS 输入 dry-run' },
    });
    await refreshAuto();
    toast(`OS 输入执行器：${res.code} · ${res.detail}`);
  };

  const handleRunBrowserRead = async (): Promise<void> => {
    const profile = autoSnap?.profiles[0];
    if (!profile) {
      toast.warning('请先注册账号并创建隔离 Profile');
      return;
    }
    const outcome = await window.directorBridge.v2AutoBrowserExec({
      taskId: `ui-read-${Date.now().toString(36)}`,
      characterId: profile.characterId,
      profileId: profile.profileId,
      url: 'https://example.com/',
      action: 'read',
    });
    setLastBrowserOutcome(outcome);
    await refreshAuto();
    toast[outcome.ok ? 'success' : 'warning'](
      outcome.ok ? `确定性读取完成：${outcome.runner.engine}` : `浏览器任务暂停：${outcome.pauseReason}`,
    );
  };

  const handleCompleteHandoff = async (handoffId: string): Promise<void> => {
    const res = await window.directorBridge.v2AutoHandoffComplete(handoffId, 'completed');
    await refreshAuto();
    if (!res.ok) toast.error(res.error ?? '交接单处理失败');
    else toast.success('已确认人类完成验证，Profile 恢复可用');
  };

  const handleP5Confirm = async (): Promise<void> => {
    const res = await window.directorBridge.v2AutoP5Confirm({
      taskId: 'ui-p5-demo',
      action: 'payment',
      url: 'https://example.com/checkout',
    });
    await refreshAuto();
    if (!res.ok || !res.token) toast.error(res.error ?? 'P5 令牌签发失败');
    else toast.success(`已签发一次性 P5 确认令牌（${Math.round(((res.expiresAt ?? 0) - Date.now()) / 1000)}s 内有效，单次消费）`);
  };

  const handlePurgeCharacter = async (): Promise<void> => {
    const characterId = snapshot?.identity.characterId ?? 'char_xiaojing';
    const res = await window.directorBridge.v2AutoCharacterPurge(characterId);
    await refreshAuto();
    toast.success(`已级联清理 ${characterId}：账号 ${res.accountsRemoved} 个 / Profile ${res.profilesRemoved} 个（租约审计保留）`);
  };

  const activeEmbodiment = snapshot?.embodiments.find((e) => e.active) ?? snapshot?.embodiments[0];

  return (
    <div data-v2-life-console className="wb-page space-y-4 rise">
      <PageHead
        eyebrow="此刻 · 生命中枢"
        eyebrowIcon={Compass}
        title={<>{snapshot?.identity.displayName ?? '小鲸'} · 数字生命与统一舞台</>}
        description={(
          <>
            12 域单一事实源（活动：<b style={{ color: 'var(--text-1)' }}>{snapshot?.activityState.mode ?? 'companion'}</b> ·
            情绪：<b style={{ color: 'var(--text-1)' }}>{snapshot?.emotion.label ?? '平静'}</b> ·
            驱动：<b style={{ color: 'var(--text-1)' }}>{snapshot?.motivation.reason ?? '桌面陪伴'}</b>）—— 全量直连 Electron 主进程，无虚假数值。
          </>
        )}
        meta={(
          <>
            <SonarRing
              expression={snapshot?.activityState.expression ?? 'idle'}
              halted={snapshot?.activityState.halted ?? false}
              size={22}
            />
            <span className="mono pill">{snapshot?.identity.characterId ?? 'char_xiaojing'}</span>
            {activeEmbodiment && <LicenseBadge scope={activeEmbodiment.licenseScope} compact />}
            {storageInfo && (
              <span className={`pill mono ${storageInfo.ok ? 'pill-green' : 'pill-red'}`} style={{ fontSize: 10 }}>
                <Database size={10} />
                {storageInfo.engine} · v{storageInfo.schemaVersion ?? '?'} · {storageInfo.integrity}
              </span>
            )}
          </>
        )}
        actions={(
          <button
            type="button"
            className="btn-pill ghost"
            onClick={() => { void onSnapshotChanged(); void loadAll(); }}
          >
            <RefreshCw size={12} />刷新全舱
          </button>
        )}
      />

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
            <div className="inset min-w-0 space-y-2 p-3">
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
              <div className="max-h-36 min-w-0 space-y-1 overflow-y-auto overflow-x-hidden">
                {(snapshot?.goals ?? []).slice(-6).reverse().map((g) => (
                  <div key={g.goalId} data-v2-goal-item className="flex min-w-0 items-center gap-2 rounded-lg px-2 py-1 text-[11px]" style={{ background: 'var(--surface)', border: '1px solid var(--stroke)' }}>
                    <span className="min-w-0 flex-1 truncate font-medium" title={g.title}>{g.title}</span>
                    <span className="mono shrink-0 rounded-full px-1.5 py-0.5 text-[9.5px]" style={{ color: 'var(--text-3)', background: 'var(--inset)', whiteSpace: 'nowrap' }}>{g.status}</span>
                  </div>
                ))}
                {(snapshot?.goals.length ?? 0) === 0 && (
                  <p className="text-[11px]" style={{ color: 'var(--text-3)' }}>尚无长期/短期目标</p>
                )}
              </div>
            </div>

            {/* Commitments */}
            <div className="inset min-w-0 space-y-2 p-3">
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
              <div className="max-h-36 min-w-0 space-y-1 overflow-y-auto overflow-x-hidden">
                {(snapshot?.commitments ?? []).slice(-6).reverse().map((c) => (
                  <div key={c.commitmentId} data-v2-commitment-item className="flex min-w-0 items-center gap-2 rounded-lg px-2 py-1 text-[11px]" style={{ background: 'var(--surface)', border: '1px solid var(--stroke)' }}>
                    <span className="min-w-0 flex-1 truncate font-medium" title={c.title}>{c.title}</span>
                    <span className="mono shrink-0 rounded-full px-1.5 py-0.5 text-[9.5px]" style={{ color: 'var(--text-3)', background: 'var(--inset)', whiteSpace: 'nowrap' }}>{c.status}</span>
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
            <StageBadge stage="P3" label="统一舞台与导唱已接线 · 待实机神经歌声与3D画布" />
            <StageBadge stage="P2" label="创作工坊与人机联机已接线 · 待实机客户端" />
            <StageBadge stage="P4" label="Social L2→L3 社区发布未开启" />
          </div>
        </section>
      </div>

      {/* Section B2: V2-P3-01 PerformanceDirector & Unified 2D/Live2D/VRM Stage + P2 Studio/Coop */}
      <div className="grid gap-4 lg:grid-cols-2">
        <section className="card space-y-3 px-5 py-4" data-v2-perf-section>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="flex items-center gap-1.5 text-sm font-semibold">
              <Music2 size={14} style={{ color: 'var(--accent)' }} />
              统一表演舞台（SingEngine SVS/SVC · 双语歌词 · 2D/Live2D/VRM）
            </h2>
            <span className="pill mono" style={{ fontSize: 10 }}>
              舞台模式：{perfSnap?.mode ?? 'idle'} · 渲染：{stageSnap?.activeBackend ?? 'desktop-2d'}
            </span>
          </div>

          <div className="flex flex-wrap gap-1.5">
            {(['desktop-2d', 'live2d', 'vrm-3d', 'obs-stage'] as const).map((backend) => {
              const active = stageSnap?.activeBackend === backend;
              return (
                <button
                  key={backend}
                  type="button"
                  data-v2-stage-backend={backend}
                  onClick={() => void handleSwitchStageBackend(backend)}
                  className={`pill cursor-pointer mono ${active ? 'pill-blue' : ''}`}
                  style={{ fontSize: 10.5 }}
                >
                  <Layers size={10} />
                  <span>{backend}</span>
                </button>
              );
            })}
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              data-v2-perf-demo-sing
              onClick={() => void handleDemoSingAndDance()}
              className="btn-pill primary"
              style={{ padding: '4.5px 12px', fontSize: 11.5 }}
            >
              <Play size={11} />试演原创唱跳 + 双语歌词
            </button>
            <button
              type="button"
              data-v2-perf-nc-test
              onClick={() => void handleTestNcBlock()}
              className="btn-pill ghost"
              style={{ padding: '4.5px 11px', fontSize: 11 }}
            >
              测试 NC 直播版权拦截
            </button>
            <button
              type="button"
              data-v2-perf-stop
              onClick={() => void handleStopPerformance()}
              className="btn-pill ghost"
              style={{ padding: '4.5px 11px', fontSize: 11 }}
            >
              <Square size={10} />停演归零
            </button>
          </div>

          <div className="inset space-y-1.5 p-3 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              {singBackends.map((b) => (
                <span key={b.mode} className="pill mono" style={{ fontSize: 10 }} title={b.detail}>
                  {b.mode.toUpperCase()}: {b.backend}
                </span>
              ))}
              {stageSnap?.devWatermarkActive && (
                <span className="pill pill-amber mono" style={{ fontSize: 10 }}>DEV 水印保护激活</span>
              )}
            </div>
            {perfSnap?.lyrics.activeLine ? (
              <div className="pt-1">
                <div className="wb-display text-sm" style={{ color: 'var(--text-1)' }}>
                  {perfSnap.lyrics.activeLine.primaryText}
                </div>
                {perfSnap.lyrics.activeLine.secondaryText && (
                  <div className="wb-serif-quote text-[11.5px]">{perfSnap.lyrics.activeLine.secondaryText}</div>
                )}
              </div>
            ) : (
              <div className="text-[11px]" style={{ color: 'var(--text-3)' }}>
                当前未在唱歌：可点击「试演原创唱跳」或切换 2D/Live2D/VRM/OBS 化身检验跨维度状态保留。
              </div>
            )}
          </div>
        </section>

        <section className="card space-y-3 px-5 py-4" data-v2-p2-summary>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="flex items-center gap-1.5 text-sm font-semibold">
              <Wand2 size={14} style={{ color: 'var(--sea, var(--blue))' }} />
              创作工坊资产与星露谷联机协作态势（V2-P2 实盘数据）
            </h2>
            <button
              type="button"
              data-v2-coop-compat-btn
              onClick={() => void handleScanCoopMods()}
              className="btn-pill ghost"
              style={{ padding: '4px 10px', fontSize: 11 }}
            >
              <Gamepad2 size={11} />扫描本机联机 Mods
            </button>
          </div>

          <div className="grid grid-cols-3 gap-2">
            <div className="inset p-2.5">
              <div className="text-[10.5px]" style={{ color: 'var(--text-3)' }}>Character Bible</div>
              <div className="wb-display text-lg">{p2Summary.bibleCount}</div>
            </div>
            <div className="inset p-2.5">
              <div className="text-[10.5px]" style={{ color: 'var(--text-3)' }}>十态 AssetRegistry</div>
              <div className="wb-display text-lg">{p2Summary.assetCount}</div>
            </div>
            <div className="inset p-2.5">
              <div className="text-[10.5px]" style={{ color: 'var(--text-3)' }}>Blender 3D 工具链</div>
              <div className="mono mt-1 text-[11px]" style={{ color: p2Summary.blender?.available ? 'var(--green)' : 'var(--amber)' }}>
                {p2Summary.blender?.available ? '已安装就绪' : '本机未安装'}
              </div>
            </div>
          </div>

          <div className="inset space-y-1 p-3 text-[11.5px]" style={{ color: 'var(--text-2)' }}>
            <div>
              联机房间：<b>{p2Summary.coopRoom?.roomId ?? '待开房'}</b> · 状态：<b>{p2Summary.coopRoom?.status ?? 'idle'}</b>
            </div>
            {p2Summary.compatReport ? (
              <div>
                本机 Mods 预检：BWF {p2Summary.compatReport.bwfReady ? '就绪' : '缺失'} ·
                已安装 {p2Summary.compatReport.hostModCount} 个 Mod · 可联机：{p2Summary.compatReport.canStartCoop ? '是' : '否'}
              </div>
            ) : (
              <div style={{ color: 'var(--text-3)' }}>
                点击「扫描本机联机 Mods」读取本地星露谷 SMAPI Mods 目录兼容性。
              </div>
            )}
          </div>

          <div className="inset space-y-2 p-3 text-[11.5px]" data-v2-live-section>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-semibold" style={{ color: 'var(--text-1)' }}>
                V2-P3-02 直播中控：{liveSnap?.active ? `${liveSnap.adapter.platform} · ${liveSnap.adapter.connectionState}` : '未开播'}
              </span>
              <span className="mono text-[10px]" style={{ color: 'var(--text-3)' }}>
                场次摘要 {liveSnap?.summaryCount ?? 0} · 拦截点歌 {liveSnap?.blockedSongLog.length ?? 0}
              </span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {!liveSnap?.active ? (
                <button
                  type="button"
                  data-v2-live-start
                  onClick={() => void window.directorBridge.v2LiveSessionStart({ platform: 'local_replay', roomId: 'tide-room-1' }).then((r) => {
                    if (r.snapshot) setLiveSnap(r.snapshot);
                    void onSnapshotChanged();
                    toast.success('已开启本地回放直播会话（SIMULATION）');
                  })}
                  className="btn-pill primary"
                  style={{ padding: '4px 10px', fontSize: 11 }}
                >开启直播中控</button>
              ) : (
                <button
                  type="button"
                  data-v2-live-end
                  onClick={() => void window.directorBridge.v2LiveSessionEnd('manual_end').then((r) => {
                    if (r.snapshot) setLiveSnap(r.snapshot);
                    void onSnapshotChanged();
                    toast.success(`已下播并归档场次摘要（共 ${r.summary?.totalEvents ?? 0} 条事件）`);
                  })}
                  className="btn-pill ghost"
                  style={{ padding: '4px 10px', fontSize: 11 }}
                >下播归档</button>
              )}
              <button
                type="button"
                data-v2-live-song-nc
                onClick={() => void window.directorBridge.v2LiveSongRequest({ title: '大肥鱼非商用曲', requesterUid: 'ui', requesterName: '观众', autoPerform: true }).then((r) => {
                  if (r.snapshot) setLiveSnap(r.snapshot);
                  if (!r.ok) toast.warning(`点歌已拦截：${r.item?.rightsReasons.join('；') ?? '版权不符'}`);
                })}
                className="btn-pill ghost"
                style={{ padding: '4px 10px', fontSize: 11 }}
              >点歌拦截测试</button>
            </div>
          </div>
        </section>
      </div>

      {/* Section B3: V2-P3-03 受控 Browser Use / Computer Use（ADR-004 双租约分离） */}
      <section className="card space-y-3 px-5 py-4" data-v2-browser-section>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold">
            <ShieldCheck size={14} style={{ color: 'var(--green)' }} />
            受控 Browser Use 与 Computer Use（P3-03 实盘）
          </h2>
          <span className="mono text-[10px]" style={{ color: 'var(--text-3)' }}>
            桌面租约 {autoSnap?.activeLeases.length ?? 0} · 待人工交接 {autoSnap?.pendingHandoffs.length ?? 0} ·
            OS 输入 {autoSnap?.inputExecutor.mode ?? 'disabled'}
          </span>
        </div>

        <div className="grid gap-2 md:grid-cols-2">
          <div className="inset space-y-1.5 p-3 text-[11.5px]" data-v2-auto-accounts>
            <div className="font-semibold" style={{ color: 'var(--text-1)' }}>
              <KeyRound size={11} className="inline" /> 账号凭据（仅掩码，明文永不下行）
            </div>
            {(autoSnap?.accounts.length ?? 0) === 0 ? (
              <div style={{ color: 'var(--text-3)' }}>暂无账号，注册后自动创建按角色隔离的 Profile。</div>
            ) : (
              autoSnap!.accounts.map((acc) => (
                <div key={acc.accountId} className="flex flex-wrap items-center gap-1.5" data-v2-auto-account={acc.accountId}>
                  <span className="pill pill-green mono" style={{ fontSize: 10 }}>{acc.platform}</span>
                  <span>{acc.username}</span>
                  <span className="mono text-[10px]" style={{ color: 'var(--text-3)' }}>{acc.maskedSecret || '已撤销'}</span>
                </div>
              ))
            )}
            <div className="flex flex-wrap gap-1.5 pt-1">
              <input
                data-v2-auto-character-input
                value={acctDraft.characterId}
                onChange={(e) => setAcctDraft((prev) => ({ ...prev, characterId: e.target.value }))}
                placeholder="characterId"
                className="w-32 rounded-lg px-2 py-1 text-[11px] outline-none"
                style={{ background: 'var(--surface-solid)', border: '1px solid var(--stroke)', color: 'var(--text-1)' }}
              />
              <input
                data-v2-auto-platform-input
                value={acctDraft.platform}
                onChange={(e) => setAcctDraft((prev) => ({ ...prev, platform: e.target.value }))}
                placeholder="平台"
                className="w-24 rounded-lg px-2 py-1 text-[11px] outline-none"
                style={{ background: 'var(--surface-solid)', border: '1px solid var(--stroke)', color: 'var(--text-1)' }}
              />
              <input
                data-v2-auto-username-input
                value={acctDraft.username}
                onChange={(e) => setAcctDraft((prev) => ({ ...prev, username: e.target.value }))}
                placeholder="账号名"
                className="w-28 rounded-lg px-2 py-1 text-[11px] outline-none"
                style={{ background: 'var(--surface-solid)', border: '1px solid var(--stroke)', color: 'var(--text-1)' }}
              />
              <input
                data-v2-auto-secret-input
                type="password"
                value={acctDraft.secret}
                onChange={(e) => setAcctDraft((prev) => ({ ...prev, secret: e.target.value }))}
                placeholder="凭据（只上行）"
                className="w-32 rounded-lg px-2 py-1 text-[11px] outline-none"
                style={{ background: 'var(--surface-solid)', border: '1px solid var(--stroke)', color: 'var(--text-1)' }}
              />
              <button type="button" data-v2-auto-account-register onClick={() => void handleRegisterAccount()} className="btn-pill green" style={{ padding: '4px 10px', fontSize: 11 }}>
                <Plus size={11} />注册
              </button>
            </div>
          </div>

          <div className="inset space-y-1.5 p-3 text-[11.5px]" data-v2-auto-profiles>
            <div className="font-semibold" style={{ color: 'var(--text-1)' }}>
              <Monitor size={11} className="inline" /> 隔离 Profile 与双租约
            </div>
            {(autoSnap?.profiles.length ?? 0) === 0 ? (
              <div style={{ color: 'var(--text-3)' }}>暂无隔离 Profile。</div>
            ) : (
              autoSnap!.profiles.map((profile) => (
                <div key={profile.profileId} className="flex flex-wrap items-center gap-1.5" data-v2-auto-profile={profile.profileId}>
                  <span className="pill mono" style={{ fontSize: 10 }}>{profile.profileId}</span>
                  <span className="pill pill-blue" style={{ fontSize: 10 }}>{profile.status}</span>
                  <span className="text-[10px]" style={{ color: 'var(--text-3)' }}>Cookie {profile.cookieCount} · 独立目录 {profile.isolatedFromUserDaily ? '是' : '否'}</span>
                </div>
              ))
            )}
            <div className="flex flex-wrap gap-1.5 pt-1">
              <button type="button" data-v2-auto-lease-acquire onClick={() => void handleAcquireDesktopLease()} className="btn-pill primary" style={{ padding: '4px 10px', fontSize: 11 }}>
                <Hand size={11} />申请桌面租约
              </button>
              <button type="button" data-v2-auto-human-simulate onClick={() => void handleSimulateHumanInput()} className="btn-pill ghost" style={{ padding: '4px 10px', fontSize: 11 }}>
                模拟用户键鼠输入
              </button>
              <button type="button" data-v2-auto-dry-run onClick={() => void handleDryRunInput()} className="btn-pill ghost" style={{ padding: '4px 10px', fontSize: 11 }}>
                OS 输入 dry-run
              </button>
              <button type="button" data-v2-auto-browser-read onClick={() => void handleRunBrowserRead()} className="btn-pill ghost" style={{ padding: '4px 10px', fontSize: 11 }}>
                <Play size={11} />确定性读取
              </button>
            </div>
            <div className="text-[10.5px]" style={{ color: 'var(--text-2)' }}>
              OS 输入执行器：{autoSnap?.inputExecutor.enabled ? '已开启' : '默认关闭（dry-run）'} ·
              权限 {autoSnap?.inputExecutor.permission ?? 'unknown'} · dry-run {autoSnap?.inputExecutor.dryRunCount ?? 0} 次 ·
              检测器 {autoSnap?.inputMonitor.running ? '运行中' : '未运行'}（已识别 {autoSnap?.inputMonitor.detected ?? 0} 次，
              排除合成事件 {autoSnap?.inputMonitor.syntheticExcluded ?? 0} 次）
            </div>
            <div className="text-[10px]" style={{ color: 'var(--text-3)' }}>
              桌面租约只管 OS 合成键鼠与前台窗口；游戏角色租约只认 F7 / 界面开关 / P0 急停。外部 Harness 不受本租约约束。
            </div>
          </div>
        </div>

        {(autoSnap?.pendingHandoffs.length ?? 0) > 0 && (
          <div className="inset space-y-1.5 p-3 text-[11.5px]" data-v2-auto-handoffs>
            <div className="font-semibold" style={{ color: 'var(--amber)' }}>
              <ShieldAlert size={11} className="inline" /> 待人类处理（验证码/登录/风控，绝不自动绕过）
            </div>
            {autoSnap!.pendingHandoffs.map((handoff) => (
              <div key={handoff.handoffId} className="flex flex-wrap items-center gap-2" data-v2-auto-handoff={handoff.handoffId}>
                <span className="pill pill-amber mono" style={{ fontSize: 10 }}>{handoff.reason}</span>
                <span className="min-w-0 flex-1 truncate">{handoff.url}</span>
                <button type="button" data-v2-auto-handoff-complete={handoff.handoffId} onClick={() => void handleCompleteHandoff(handoff.handoffId)} className="btn-pill green" style={{ padding: '3px 9px', fontSize: 10 }}>
                  人类已完成
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 text-[10.5px]" style={{ color: 'var(--text-2)' }}>
          <button type="button" data-v2-auto-p5-confirm onClick={() => void handleP5Confirm()} className="btn-pill ghost" style={{ padding: '4px 10px', fontSize: 11 }}>
            <KeyRound size={11} />签发一次性 P5 确认（{autoSnap?.p5ConfirmationCount ?? 0} 待用）
          </button>
          <button type="button" data-v2-auto-character-purge onClick={() => void handlePurgeCharacter()} className="btn-pill ghost" style={{ padding: '4px 10px', fontSize: 11 }}>
            <Trash2 size={11} />级联清理当前角色账号与 Profile
          </button>
          {lastBrowserOutcome && (
            <span data-v2-auto-last-outcome className="mono" style={{ color: 'var(--text-3)' }}>
              最近任务：{lastBrowserOutcome.pauseReason} · {lastBrowserOutcome.runner.engine}/{lastBrowserOutcome.runner.status}
              {lastBrowserOutcome.runner.injectionSignals.length > 0 ? ` · 注入特征 ${lastBrowserOutcome.runner.injectionSignals.join('/')}` : ''}
            </span>
          )}
        </div>
      </section>

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
