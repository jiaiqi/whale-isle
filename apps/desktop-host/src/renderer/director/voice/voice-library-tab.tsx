/**
 * Tab 1：「声线库与版本档案」（Voice Roster, Per-Character Lock & Contextual Inspector）
 *
 * 融合 Tidepaper v3.1 纸面视觉与声音中心 V2 核心资产模型：
 * 1. 当前角色生效声线 Hero 卡（显示锁定版本 / 是否独立绑定 / 一键恢复默认 / 真实波形 / CAM++ 体检 / 4 情绪试戴）
 * 2. 左栏资产网格：搜索 + 来源筛选（全部/我的/出厂/AI设计/克隆/已归档）+ 仅看收藏；点击卡片只选中不误切声线
 * 3. 右栏上下文详情面板（宽屏吸顶、窄屏自然折叠）：完整血缘与 SHA-256、显式确认绑定、收藏/软归档/改名、
 *    「送入克隆台精修」、受引用保护的删除护栏，以及一键「撤销声音授权并清理本地样本」合规闭环
 * 4. MiMo 官方 9 款零漂移内置音色
 */
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  Activity, Archive, AudioLines, Ban, Check, Edit3, FlaskConical, Link2,
  Mic, Play, RotateCcw, Scissors, Search, ShieldAlert, ShieldCheck,
  Sparkles, Star, Trash2, Unlink, Volume2, X,
} from 'lucide-react';
import {
  MIMO_WORKSHOP_AUDITION_LINES,
  type CommercialTtsProvider,
  type VoicePerformanceIntensity,
  type VoiceTimbreVersion,
  type VoiceWorkshopState,
} from '@workbench/shared-protocol';
import { MIMO_TTS_BUILTIN_VOICES } from '@workbench/voice-runtime/browser';
import type { CharacterSummary } from '../bridge';
import { LicenseBadge } from '../v2/signature-widgets';
import { formatBytes } from './audio-dsp';
import { useAuditionPlayer } from './audition-player';
import { ConsistencyGauge, WaveformPlayer } from './waveform-player';

interface AuditionRow {
  key: string;
  label: string;
  text: string;
  audioBase64: string;
  durationMs: number | null;
}

type SourceFilter = 'all' | 'mine' | 'factory' | 'ai-design' | 'uploaded' | 'archived';

const SOURCE_META: Record<VoiceTimbreVersion['source'], { label: string; pill: string }> = {
  factory: { label: '出厂 · 已定格', pill: 'pill-blue' },
  'ai-design': { label: 'AI 设计 · 已定格', pill: 'pill-violet' },
  uploaded: { label: '克隆声线 · 已定格', pill: 'pill-green' },
};

const FILTER_TABS: Array<{ id: SourceFilter; label: string }> = [
  { id: 'all', label: '全部可用' },
  { id: 'mine', label: '我的创作' },
  { id: 'ai-design', label: 'AI 设计' },
  { id: 'uploaded', label: '克隆声线' },
  { id: 'factory', label: '出厂基准' },
  { id: 'archived', label: '已归档 / 已撤权' },
];

export function VoiceLibraryTab(props: {
  characterId: string;
  characterName: string;
  characters: CharacterSummary[];
  workshop: VoiceWorkshopState | null;
  commercial: CommercialTtsProvider;
  mimoBuiltinVoice: string;
  previewingKey: string | null;
  onRefreshWorkshop: () => void;
  onUpdateWorkshop: (next: VoiceWorkshopState) => void;
  onSelectBuiltin: (voice: string) => void;
  onPreviewBuiltin: (voice: string) => Promise<void>;
  onSwitchToTab: (tab: 'workshop' | 'clone' | 'studio' | 'engine') => void;
  onSendVersionToClone: (version: VoiceTimbreVersion) => void;
  onSpeakOnPet: (text: string) => Promise<void>;
}): React.JSX.Element {
  const {
    characterId,
    characterName,
    characters,
    workshop,
    commercial,
    mimoBuiltinVoice,
    previewingKey,
    onUpdateWorkshop,
    onSelectBuiltin,
    onPreviewBuiltin,
    onSwitchToTab,
    onSendVersionToClone,
    onSpeakOnPet,
  } = props;

  const player = useAuditionPlayer();
  const [busy, setBusy] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pendingBindId, setPendingBindId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');
  const [favOnly, setFavOnly] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState('');
  const [auditionIntensity, setAuditionIntensity] = useState<VoicePerformanceIntensity>('B');
  const [auditions, setAuditions] = useState<Record<string, AuditionRow[]>>({});
  const [audioCache, setAudioCache] = useState<Record<string, string>>({});

  const versions = workshop?.versions ?? [];
  const charBindings = workshop?.characterBindings ?? {};
  const explicitBoundId = charBindings[characterId];
  const effectiveVersionId = explicitBoundId ?? workshop?.currentVersionId ?? 'factory';
  const current = versions.find((v) => v.id === effectiveVersionId) ?? versions[0] ?? null;
  const selected = versions.find((v) => v.id === selectedId) ?? current;

  const charNameOf = (id: string): string => characters.find((c) => c.id === id)?.displayName ?? id;

  const boundCharsForVersion = (versionId: string): string[] =>
    Object.entries(charBindings)
      .filter(([, vId]) => vId === versionId)
      .map(([cId]) => cId);

  const filteredVersions = useMemo(() => {
    const q = search.trim().toLowerCase();
    return versions.filter((v) => {
      const isRevoked = v.consent?.revokedAt !== undefined;
      const isArchived = Boolean(v.archivedAt) || isRevoked;
      if (sourceFilter === 'archived') {
        if (!isArchived) return false;
      } else {
        if (isArchived) return false;
        if (sourceFilter === 'mine' && v.source === 'factory') return false;
        if (sourceFilter === 'factory' && v.source !== 'factory') return false;
        if (sourceFilter === 'ai-design' && v.source !== 'ai-design') return false;
        if (sourceFilter === 'uploaded' && v.source !== 'uploaded') return false;
      }
      if (favOnly && !v.favorite) return false;
      if (q !== '') {
        const hay = [v.label, v.description, ...(v.tags ?? []), v.consent?.source ?? ''].join(' ').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [versions, sourceFilter, favOnly, search]);

  const fetchVersionAudio = async (versionId: string): Promise<string> => {
    const cached = audioCache[versionId];
    if (cached !== undefined) return cached;
    const res = await window.directorBridge.v2VoiceWorkshopReadAudio({ kind: 'version', id: versionId });
    setAudioCache((prev) => ({ ...prev, [versionId]: res.audioBase64 }));
    return res.audioBase64;
  };

  const playAuditionRow = (versionLabel: string, row: AuditionRow): void => {
    if (player !== null) {
      player.playTrack({
        id: `audition-${versionLabel}-${row.key}-${row.text.slice(0, 12)}`,
        title: `${versionLabel} · ${row.label}`,
        sourceLabel: '情绪试戴',
        subtitle: row.text,
        audioBase64: row.audioBase64,
        downloadName: `${versionLabel}-${row.key}.wav`,
        ...(row.durationMs !== null ? { durationHintSec: row.durationMs / 1000 } : {}),
      });
    } else {
      void new Audio(`data:audio/wav;base64,${row.audioBase64}`).play().catch(() => undefined);
    }
  };

  const confirmBindToCharacter = async (version: VoiceTimbreVersion): Promise<void> => {
    const targetCharId = characterId;
    const targetCharName = characterName;
    setBusy(`bind-${version.id}`);
    try {
      const { state } = await window.directorBridge.v2VoiceWorkshopBind({ characterId: targetCharId, versionId: version.id });
      // 同步激活全局默认克隆参考（与 V1/V2 既有偏好一致）
      await window.directorBridge.v2VoiceWorkshopRollback(version.id).then((r) => onUpdateWorkshop(r.state)).catch(() => onUpdateWorkshop(state));
      await window.directorBridge.prefsSet({ voiceCommercialProvider: 'mimo-tts-voiceclone' });
      setPendingBindId(null);
      toast.success(`已将「${targetCharName}」锁定绑定到声线「${version.label}」`);
    } catch (err) {
      toast.error(`绑定失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const unbindCurrentCharacter = async (): Promise<void> => {
    setBusy('unbind');
    try {
      const { state } = await window.directorBridge.v2VoiceWorkshopUnbind({ characterId });
      onUpdateWorkshop(state);
      toast.success(`「${characterName}」已恢复跟随默认声线`);
    } catch (err) {
      toast.error(`解除绑定失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const toggleFavorite = async (version: VoiceTimbreVersion): Promise<void> => {
    setBusy(`fav-${version.id}`);
    try {
      const { state } = await window.directorBridge.v2VoiceWorkshopFavorite({ versionId: version.id, favorite: !version.favorite });
      onUpdateWorkshop(state);
    } catch (err) {
      toast.error(`收藏操作失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const toggleArchive = async (version: VoiceTimbreVersion): Promise<void> => {
    const nextArchived = !version.archivedAt;
    setBusy(`archive-${version.id}`);
    try {
      const { state } = await window.directorBridge.v2VoiceWorkshopArchive({ versionId: version.id, archived: nextArchived });
      onUpdateWorkshop(state);
      toast.success(nextArchived ? `已软归档「${version.label}」（不影响已有角色绑定）` : `已恢复「${version.label}」到声线库`);
    } catch (err) {
      toast.error(`归档失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const revokeConsent = async (version: VoiceTimbreVersion): Promise<void> => {
    if (!window.confirm(`确定撤销「${version.label}」的声音授权？撤销后将立即删除本地参考音频与原始副本、解绑所有引用角色并清空合成缓存，且无法恢复使用。`)) return;
    setBusy(`revoke-${version.id}`);
    try {
      const res = await window.directorBridge.v2VoiceWorkshopRevokeConsent({ versionId: version.id, reason: '用户主动撤销授权' });
      onUpdateWorkshop(res.state);
      setAudioCache((prev) => {
        const next = { ...prev };
        delete next[version.id];
        return next;
      });
      toast.success(`已撤销「${version.label}」授权并清理本地参考与合成缓存${res.unboundCharacters.length > 0 ? `（已自动解绑 ${res.unboundCharacters.length} 个角色）` : ''}`);
    } catch (err) {
      toast.error(`撤销授权失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const runCheck = async (versionId?: string): Promise<void> => {
    const key = `check-${versionId ?? 'current'}`;
    setBusy(key);
    try {
      const { result, state } = await window.directorBridge.v2VoiceWorkshopConsistency(versionId);
      onUpdateWorkshop(state);
      if (result.verdict === 'unavailable') toast.error(`体检未完成：${result.detail}`);
      else toast.success(`体检完成：均值 ${result.mean?.toFixed(4)} · 最低 ${result.min?.toFixed(4)}`);
    } catch (err) {
      toast.error(`体检失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const runAudition = async (version: VoiceTimbreVersion): Promise<void> => {
    setBusy(`audition-${version.id}`);
    try {
      const rows = await window.directorBridge.v2VoiceWorkshopVersionAudition({ versionId: version.id, intensity: auditionIntensity });
      setAuditions((prev) => ({ ...prev, [version.id]: rows }));
      if (rows[0] !== undefined) playAuditionRow(version.label, rows[0]);
      toast.success(`已合成 ${rows.length} 句情绪试戴（强度 ${auditionIntensity}，消耗 ${rows.length} 次合成）`);
    } catch (err) {
      toast.error(`试戴失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const saveRename = async (versionId: string): Promise<void> => {
    const trimmed = nameDraft.trim();
    if (trimmed === '') return;
    setBusy(`rename-${versionId}`);
    try {
      const { state } = await window.directorBridge.v2VoiceWorkshopRename({ versionId, label: trimmed });
      onUpdateWorkshop(state);
      setEditingId(null);
      toast.success(`已重命名为「${trimmed}」`);
    } catch (err) {
      toast.error(`重命名失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const removeVersion = async (version: VoiceTimbreVersion): Promise<void> => {
    if (!window.confirm(`确定永久删除本地声线版本「${version.label}」？该版本的参考音频与原始副本也将一并移除，出厂版本不受影响。`)) return;
    setBusy(`delete-${version.id}`);
    try {
      const { state } = await window.directorBridge.v2VoiceWorkshopDelete({ versionId: version.id });
      onUpdateWorkshop(state);
      if (selectedId === version.id) setSelectedId(null);
      toast.success(`已删除「${version.label}」`);
    } catch (err) {
      toast.error(`删除失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const selectedBoundChars = selected !== null ? boundCharsForVersion(selected.id) : [];
  const selectedRevoked = selected?.consent?.revokedAt !== undefined;
  const pendingBindVersion = pendingBindId !== null ? versions.find((v) => v.id === pendingBindId) ?? null : null;

  return (
    <div className="space-y-5" data-voice-library-tab>
      {/* ① 当前角色生效声线 Hero 卡 */}
      <section className="card p-5" data-voice-active-hero>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="eyebrow"><AudioLines size={11} />当前生效声线 · {characterName}</span>
              {current !== null && (
                <span className={`pill ${SOURCE_META[current.source].pill}`} style={{ fontSize: 10 }}>
                  {SOURCE_META[current.source].label}
                </span>
              )}
              {explicitBoundId !== undefined ? (
                <span className="pill pill-blue" style={{ fontSize: 10 }} data-voice-char-lock-badge>
                  <Link2 size={10} />角色独立锁定
                </span>
              ) : (
                <span className="pill" style={{ fontSize: 10 }}>跟随全局默认</span>
              )}
              <LicenseBadge scope={current?.licenseScope ?? 'DEV_ONLY_NON_COMMERCIAL'} compact />
              {commercial === 'mimo-tts' && (
                <span className="pill pill-green" style={{ fontSize: 10 }}>当前走官方内置 · {mimoBuiltinVoice}</span>
              )}
            </div>
            <h2 className="wb-display mt-2 text-2xl" style={{ color: 'var(--text-1)' }}>
              {current?.label ?? '读取声线档案中…'}
            </h2>
            <p className="mt-1.5 max-w-3xl text-[12.5px] leading-relaxed" style={{ color: 'var(--text-2)' }}>
              {current?.description ?? '正在读取当前声线描述与定格元数据…'}
            </p>
            {current !== null && (
              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px]" style={{ color: 'var(--text-3)' }}>
                <span className="mono">{formatBytes(current.referenceBytes)}{current.durationMs ? ` · ${(current.durationMs / 1000).toFixed(1)}s` : ''}</span>
                {current.referenceSha256 !== undefined && (
                  <span className="mono" title={current.referenceSha256}>SHA-256: {current.referenceSha256.slice(0, 12)}</span>
                )}
                {current.consent !== undefined && current.consent.revokedAt === undefined && (
                  <span className="inline-flex items-center gap-1" style={{ color: 'var(--green)' }}>
                    <ShieldCheck size={11} />权属留档：{current.consent.source}
                  </span>
                )}
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {explicitBoundId !== undefined && (
              <button
                type="button"
                className="btn-pill ghost"
                disabled={busy !== null}
                onClick={() => void unbindCurrentCharacter()}
                data-voice-unbind-character
              >
                <Unlink size={12} />恢复默认
              </button>
            )}
            <button
              type="button"
              className="btn-pill primary"
              onClick={() => onSwitchToTab('workshop')}
              data-voice-hero-design
            >
              <Sparkles size={13} />AI 设计新音色
            </button>
            <button
              type="button"
              className="btn-pill ghost"
              onClick={() => onSwitchToTab('clone')}
              data-voice-hero-clone
            >
              <Mic size={13} />音色克隆
            </button>
            <button
              type="button"
              className="btn-pill ghost"
              disabled={busy !== null}
              onClick={() => void onSpeakOnPet(`主人，我是${characterName}，这是我现在的声音，你听着舒服吗？`)}
            >
              <Volume2 size={13} />让桌宠试说
            </button>
          </div>
        </div>

        {/* 真实参考音频波形 + 一致性仪表两栏 */}
        {current !== null && current.consent?.revokedAt === undefined && (
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <div className="inset p-3.5">
              <div className="mb-2 flex items-center justify-between text-[11px]">
                <span className="font-semibold" style={{ color: 'var(--text-2)' }}>锁定参考干声（VoiceClone 声线锚点）</span>
                <span style={{ color: 'var(--text-3)' }}>所有情绪由此单点锚定，杜绝换人</span>
              </div>
              <WaveformPlayer
                key={current.id}
                trackId={`hero-version-${current.id}`}
                audioBase64={audioCache[current.id] ?? null}
                onRequestAudio={() => fetchVersionAudio(current.id)}
                durationMs={current.durationMs ?? null}
                downloadName={`${current.id}-reference.wav`}
                label={`${current.label} 参考干声`}
                sourceLabel="锁定参考干声"
                eagerLoad
              />
              <div className="mt-2.5 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void runAudition(current)}
                  className="btn-pill ghost"
                  style={{ padding: '4px 11px', fontSize: 11 }}
                >
                  <Play size={11} />
                  {busy === `audition-${current.id}` ? '合成 4 情绪中…' : `4 情绪试戴（强度 ${auditionIntensity} · 4 次合成）`}
                </button>
                <div className="seg" role="group" aria-label="试戴强度">
                  {(['A', 'B', 'C'] as const).map((lvl) => (
                    <button
                      key={lvl}
                      type="button"
                      className={auditionIntensity === lvl ? 'on' : ''}
                      onClick={() => setAuditionIntensity(lvl)}
                      style={{ height: 22, padding: '0 8px', fontSize: 10.5 }}
                    >
                      {lvl}{lvl === 'B' ? '·默认' : ''}
                    </button>
                  ))}
                </div>
              </div>
              {(auditions[current.id] ?? []).length > 0 && (
                <div className="mt-2.5 grid gap-1.5 border-t pt-2.5" style={{ borderColor: 'var(--stroke)' }}>
                  {(auditions[current.id] ?? []).map((row) => (
                    <div key={row.key} className="flex items-center gap-2 text-[11px]">
                      <span className="pill" style={{ fontSize: 10, padding: '1px 7px' }}>{row.label}</span>
                      <span className="min-w-0 flex-1 truncate" style={{ color: 'var(--text-2)' }} title={row.text}>{row.text}</span>
                      <button
                        type="button"
                        className="btn-pill ghost"
                        style={{ padding: '2px 9px', fontSize: 10.5 }}
                        onClick={() => playAuditionRow(current.label, row)}
                      >
                        <Play size={10} />播放
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="inset flex flex-col justify-between p-3.5">
              <div>
                <div className="mb-2 flex items-center justify-between text-[11px]">
                  <span className="flex items-center gap-1.5 font-semibold" style={{ color: 'var(--text-2)' }}>
                    <Activity size={12} style={{ color: 'var(--accent)' }} />一致性质检（CAM++ 说话人余弦）
                  </span>
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => void runCheck(current.id)}
                    className="btn-pill ghost"
                    style={{ padding: '3px 10px', fontSize: 10.5 }}
                  >
                    {busy === `check-${current.id}` ? '体检中 (×10)…' : '重新体检（10 次合成）'}
                  </button>
                </div>
                <ConsistencyGauge result={current.consistency} />
              </div>
              <p className="mt-2.5 text-[10.5px] leading-relaxed" style={{ color: 'var(--text-3)' }}>
                真实运行同句 ×10 克隆并计算说话人余弦；工具缺失如实报「不可用」。单次 10 条存在抽样波动（同一出厂参考三次实测 0.9059 / 0.8632 / 0.8795），拿不准可重跑。
              </p>
            </div>
          </div>
        )}
      </section>

      {/* ② 显式角色绑定确认条（防止单点卡片直接换掉直播中角色的声线） */}
      {pendingBindVersion !== null && (
        <div
          className="card flex flex-wrap items-center justify-between gap-3 p-4"
          style={{ borderColor: 'var(--accent-line)', background: 'var(--accent-soft)' }}
          data-voice-bind-confirm
        >
          <div className="text-xs" style={{ color: 'var(--text-1)' }}>
            <strong>确认角色声线绑定：</strong>
            将角色 <b>「{characterName}」</b> 从「{current?.label ?? '默认'}」切换并锁定至 <b>「{pendingBindVersion.label}」</b>（版本锁定，同时启用 MiMo VoiceClone）？
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="btn-pill ghost"
              onClick={() => setPendingBindId(null)}
            >
              取消
            </button>
            <button
              type="button"
              className="btn-pill primary"
              data-voice-bind-confirm-ok
              disabled={busy !== null}
              onClick={() => void confirmBindToCharacter(pendingBindVersion)}
            >
              <Check size={12} />确认绑定到 {characterName}
            </button>
          </div>
        </div>
      )}

      {/* ③ 声线版本库（左）+ 上下文详情面板（右） */}
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_316px] items-start">
        <section className="card p-5">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold">声线资产库（共 {versions.length} 个版本 · 当前显示 {filteredVersions.length}）</h3>
              <p className="mt-0.5 text-[11.5px]" style={{ color: 'var(--text-3)' }}>
                点击卡片仅选中查看详情，避免误切线上声线；支持按来源筛选、收藏与多角色独立版本锁定。
              </p>
            </div>
            <button
              type="button"
              data-voice-fav-only
              onClick={() => setFavOnly((v) => !v)}
              className={`btn-pill ${favOnly ? 'accent' : 'ghost'}`}
              style={{ padding: '4px 11px', fontSize: 11 }}
            >
              <Star size={11} fill={favOnly ? 'currentColor' : 'none'} />仅看收藏
            </button>
          </div>

          {/* 搜索 + 来源筛选胶囊 */}
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <label className="relative min-w-[200px] flex-1">
              <Search size={13} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-3)' }} />
              <input
                type="text"
                data-voice-library-search
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="搜索声线名称、音色描述、标签或授权来源…"
                className="w-full rounded-xl py-1.5 pl-8 pr-3 text-xs outline-none"
                style={{ border: '1px solid var(--stroke)', background: 'var(--inset)', color: 'var(--text-1)' }}
              />
            </label>
            <div className="flex flex-wrap gap-1" role="tablist" aria-label="声线来源筛选">
              {FILTER_TABS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  data-voice-filter={f.id}
                  onClick={() => setSourceFilter(f.id)}
                  className={`pill ${sourceFilter === f.id ? 'pill-blue' : ''}`}
                  style={{ fontSize: 10.5, padding: '2.5px 9px', cursor: 'pointer' }}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          {filteredVersions.length === 0 ? (
            <div className="inset flex flex-col items-center justify-center gap-2 py-10 text-center">
              <p className="text-xs" style={{ color: 'var(--text-2)' }}>当前筛选条件下没有匹配的声线</p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="btn-pill ghost"
                  onClick={() => { setSearch(''); setSourceFilter('all'); setFavOnly(false); }}
                >
                  重置筛选
                </button>
                <button type="button" className="btn-pill primary" onClick={() => onSwitchToTab('workshop')}>
                  <Sparkles size={12} />去 AI 设计音色
                </button>
              </div>
            </div>
          ) : (
            <div className="grid gap-3 md:grid-cols-2" data-voice-version-grid>
              {filteredVersions.map((version) => {
                const isBoundHere = version.id === effectiveVersionId;
                const isSelected = selected?.id === version.id;
                const isRevoked = version.consent?.revokedAt !== undefined;
                const boundChars = boundCharsForVersion(version.id);
                const srcMeta = SOURCE_META[version.source];
                return (
                  <article
                    key={version.id}
                    data-voice-version-card={version.id}
                    data-active={isBoundHere ? 'true' : 'false'}
                    data-selected={isSelected ? 'true' : 'false'}
                    tabIndex={0}
                    onClick={() => setSelectedId(version.id)}
                    onKeyDown={(e) => { if (e.target === e.currentTarget && e.key === 'Enter') setSelectedId(version.id); }}
                    className="inset flex cursor-pointer flex-col justify-between p-3.5 transition"
                    style={{
                      borderColor: isSelected ? 'var(--accent-line)' : isBoundHere ? 'var(--green-line)' : undefined,
                      background: isSelected ? 'var(--surface-solid)' : undefined,
                      opacity: isRevoked ? 0.65 : 1,
                    }}
                  >
                    <div>
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="text-[13px] font-semibold" style={{ color: 'var(--text-1)' }}>{version.label}</span>
                          <span className={`pill ${srcMeta.pill}`} style={{ fontSize: 9.5, padding: '1px 7px' }}>{srcMeta.label}</span>
                          {isBoundHere && <span className="pill pill-green" style={{ fontSize: 9.5, padding: '1px 7px' }}>{characterName} 使用中</span>}
                          {isRevoked && <span className="pill pill-red" style={{ fontSize: 9.5, padding: '1px 7px' }}>已撤权</span>}
                          {!isRevoked && Boolean(version.archivedAt) && <span className="pill" style={{ fontSize: 9.5, padding: '1px 7px' }}>已归档</span>}
                        </div>
                        <button
                          type="button"
                          className="vs-icon-btn"
                          title={version.favorite ? '取消收藏' : '收藏此声线'}
                          aria-label={`收藏 ${version.label}`}
                          data-voice-fav-btn={version.id}
                          onClick={(e) => { e.stopPropagation(); void toggleFavorite(version); }}
                          style={version.favorite ? { color: 'var(--amber)', borderColor: 'var(--amber-line)' } : undefined}
                        >
                          <Star size={11} fill={version.favorite ? 'currentColor' : 'none'} />
                        </button>
                      </div>

                      <p className="mt-1.5 line-clamp-2 text-[11.5px] leading-relaxed" style={{ color: 'var(--text-2)' }}>
                        {version.description}
                      </p>

                      <div className="mt-2 flex flex-wrap items-center gap-2 text-[10.5px]" style={{ color: 'var(--text-3)' }}>
                        <span className="mono">{formatBytes(version.referenceBytes)}</span>
                        {version.durationMs != null && <span className="mono">{(version.durationMs / 1000).toFixed(1)}s</span>}
                        <span>{boundChars.length > 0 ? `${boundChars.length} 个角色锁定` : '未单独锁定'}</span>
                        {version.originCandidateId !== undefined && (
                          <span className="pill pill-violet" style={{ fontSize: 9, padding: '0.5px 6px' }}>源自 AI 设计</span>
                        )}
                      </div>

                      {!isRevoked && (
                        <div className="mt-2.5" onClick={(e) => e.stopPropagation()}>
                          <WaveformPlayer
                            compact
                            trackId={`card-version-${version.id}`}
                            audioBase64={audioCache[version.id] ?? null}
                            onRequestAudio={() => fetchVersionAudio(version.id)}
                            durationMs={version.durationMs ?? null}
                            downloadName={`${version.label}.wav`}
                            label={version.label}
                            sourceLabel={srcMeta.label}
                          />
                        </div>
                      )}
                    </div>

                    <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t pt-2.5" style={{ borderColor: 'var(--stroke)' }} onClick={(e) => e.stopPropagation()}>
                      <div className="flex flex-wrap gap-1.5">
                        {!isBoundHere && !isRevoked && (
                          <button
                            type="button"
                            disabled={busy !== null}
                            data-voice-bind-btn={version.id}
                            onClick={() => setPendingBindId(version.id)}
                            className="btn-pill primary"
                            style={{ padding: '4px 10px', fontSize: 11 }}
                          >
                            <Link2 size={10} />绑定到 {characterName}
                          </button>
                        )}
                        {!isRevoked && (
                          <button
                            type="button"
                            disabled={busy !== null}
                            onClick={() => void runAudition(version)}
                            className="btn-pill ghost"
                            style={{ padding: '4px 10px', fontSize: 11 }}
                          >
                            <Play size={10} />{busy === `audition-${version.id}` ? '试戴中…' : '4 情绪试戴'}
                          </button>
                        )}
                      </div>
                      {version.source !== 'factory' && (
                        <button
                          type="button"
                          disabled={busy !== null}
                          onClick={() => void removeVersion(version)}
                          className="vs-icon-btn danger"
                          title={boundChars.length > 0 ? `正被 ${boundChars.length} 个角色绑定，请先解绑或归档` : '永久删除此版本'}
                          aria-label={`删除 ${version.label}`}
                        >
                          <Trash2 size={12} />
                        </button>
                      )}
                    </div>

                    {(auditions[version.id] ?? []).length > 0 && version.id !== current?.id && (
                      <div className="mt-2 grid gap-1 border-t pt-2" style={{ borderColor: 'var(--stroke)' }} onClick={(e) => e.stopPropagation()}>
                        {(auditions[version.id] ?? []).map((row) => (
                          <div key={row.key} className="flex items-center gap-1.5 text-[10.5px]">
                            <span className="pill" style={{ fontSize: 9.5, padding: '1px 6px' }}>{row.label}</span>
                            <span className="min-w-0 flex-1 truncate" style={{ color: 'var(--text-3)' }}>{row.text}</span>
                            <button
                              type="button"
                              className="btn-pill ghost"
                              style={{ padding: '1px 8px', fontSize: 10 }}
                              onClick={() => playAuditionRow(version.label, row)}
                            >
                              播放
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          )}
        </section>

        {/* 右侧上下文详情面板（Inspector） */}
        <aside className="card vs-inspector space-y-3.5 p-4" data-voice-inspector>
          <div className="flex items-center justify-between">
            <span className="eyebrow">声线档案详情</span>
            {selected !== null && (
              <span className={`pill ${SOURCE_META[selected.source].pill}`} style={{ fontSize: 9.5 }}>
                {SOURCE_META[selected.source].label}
              </span>
            )}
          </div>

          {selected === null ? (
            <p className="py-6 text-center text-xs" style={{ color: 'var(--text-3)' }}>
              点击左侧任意声线卡片查看档案、引用角色与合规操作
            </p>
          ) : (
            <>
              <div>
                {editingId === selected.id ? (
                  <div className="flex items-center gap-1.5">
                    <input
                      type="text"
                      value={nameDraft}
                      maxLength={40}
                      onChange={(e) => setNameDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void saveRename(selected.id);
                        if (e.key === 'Escape') setEditingId(null);
                      }}
                      className="min-w-0 flex-1 rounded-lg px-2.5 py-1 text-xs outline-none"
                      style={{ border: '1px solid var(--accent-line)', background: 'var(--inset)', color: 'var(--text-1)' }}
                      autoFocus
                    />
                    <button type="button" className="vs-icon-btn" onClick={() => void saveRename(selected.id)} aria-label="保存名称"><Check size={12} /></button>
                    <button type="button" className="vs-icon-btn" onClick={() => setEditingId(null)} aria-label="取消重命名"><X size={12} /></button>
                  </div>
                ) : (
                  <div className="flex items-center justify-between gap-2">
                    <h4 className="wb-display text-lg" style={{ color: 'var(--text-1)' }}>{selected.label}</h4>
                    {selected.source !== 'factory' && (
                      <button
                        type="button"
                        className="vs-icon-btn"
                        title="重命名"
                        aria-label={`重命名 ${selected.label}`}
                        onClick={() => { setEditingId(selected.id); setNameDraft(selected.label); }}
                      >
                        <Edit3 size={11} />
                      </button>
                    )}
                  </div>
                )}
                <p className="mt-1 text-[11.5px] leading-relaxed" style={{ color: 'var(--text-2)' }}>
                  {selected.description}
                </p>
              </div>

              <div className="inset space-y-1.5 p-3 text-[11px]">
                <div className="flex justify-between gap-2">
                  <span style={{ color: 'var(--text-3)' }}>模式与管线</span>
                  <span className="mono font-medium">{selected.freeze.mode}</span>
                </div>
                <div className="flex justify-between gap-2">
                  <span style={{ color: 'var(--text-3)' }}>文件体积 / 时长</span>
                  <span className="mono">{formatBytes(selected.referenceBytes)}{selected.durationMs ? ` · ${(selected.durationMs / 1000).toFixed(1)}s` : ''}</span>
                </div>
                {selected.referenceSha256 !== undefined && (
                  <div className="flex justify-between gap-2">
                    <span style={{ color: 'var(--text-3)' }}>SHA-256</span>
                    <span className="mono">{selected.referenceSha256.slice(0, 14)}</span>
                  </div>
                )}
                <div className="flex justify-between gap-2">
                  <span style={{ color: 'var(--text-3)' }}>入库时间</span>
                  <span className="mono">{selected.frozenAt.slice(0, 16).replace('T', ' ')}</span>
                </div>
                <div className="flex justify-between gap-2">
                  <span style={{ color: 'var(--text-3)' }}>锁定角色 ({selectedBoundChars.length})</span>
                  <span className="truncate text-right" style={{ color: 'var(--text-1)' }}>
                    {selectedBoundChars.length > 0 ? selectedBoundChars.map(charNameOf).join('、') : '无独立锁定'}
                  </span>
                </div>
                {selected.rawReferencePath !== undefined && (
                  <div className="flex justify-between gap-2">
                    <span style={{ color: 'var(--text-3)' }}>原始未裁剪副本</span>
                    <span style={{ color: 'var(--green)' }}>已保留本地</span>
                  </div>
                )}
              </div>

              {selected.consistency !== null && <ConsistencyGauge result={selected.consistency} compact />}

              {/* 授权合规卡片 */}
              {selected.consent !== undefined && (
                <div
                  className="rounded-xl p-2.5 text-[11px]"
                  style={{
                    background: selectedRevoked ? 'var(--red-dim)' : 'var(--green-dim)',
                    border: `1px solid ${selectedRevoked ? 'var(--red-line)' : 'var(--green-line)'}`,
                    color: selectedRevoked ? 'var(--red)' : 'var(--green)',
                  }}
                >
                  <div className="flex items-center gap-1.5 font-semibold">
                    {selectedRevoked ? <Ban size={12} /> : <ShieldCheck size={12} />}
                    {selectedRevoked ? `已撤销授权（${selected.consent.revokedAt?.slice(0, 10)}）` : '声音权属已登记'}
                  </div>
                  <p className="mt-0.5 text-[10.5px] opacity-90">{selected.consent.source}</p>
                </div>
              )}

              {/* 操作区 */}
              <div className="space-y-2 border-t pt-3" style={{ borderColor: 'var(--stroke)' }}>
                {!selectedRevoked && selected.id !== effectiveVersionId && (
                  <button
                    type="button"
                    className="btn-pill primary w-full"
                    disabled={busy !== null}
                    onClick={() => setPendingBindId(selected.id)}
                  >
                    <Link2 size={12} />绑定到「{characterName}」
                  </button>
                )}
                {!selectedRevoked && (
                  <button
                    type="button"
                    className="btn-pill ghost w-full"
                    data-inspector-send-clone
                    onClick={() => onSendVersionToClone(selected)}
                  >
                    <Scissors size={12} />送入克隆台裁剪 / 派生新克隆
                  </button>
                )}
                {!selectedRevoked && (
                  <button
                    type="button"
                    className="btn-pill ghost w-full"
                    disabled={busy !== null}
                    onClick={() => void runCheck(selected.id)}
                  >
                    <FlaskConical size={12} />{busy === `check-${selected.id}` ? '体检中 (×10)…' : '跑 CAM++ 一致性体检 (×10)'}
                  </button>
                )}
                {selected.source !== 'factory' && !selectedRevoked && (
                  <button
                    type="button"
                    className="btn-pill ghost w-full"
                    disabled={busy !== null}
                    data-inspector-archive
                    onClick={() => void toggleArchive(selected)}
                  >
                    <Archive size={12} />{selected.archivedAt ? '取消归档' : '软归档（不破坏现有绑定）'}
                  </button>
                )}
                {selected.source !== 'factory' && !selectedRevoked && (
                  <button
                    type="button"
                    className="btn-pill red w-full"
                    disabled={busy !== null}
                    data-inspector-revoke
                    onClick={() => void revokeConsent(selected)}
                  >
                    <ShieldAlert size={12} />撤销授权并清理本地样本
                  </button>
                )}
                {selected.source !== 'factory' && (
                  <button
                    type="button"
                    className="btn-pill ghost w-full"
                    style={{ color: 'var(--red)' }}
                    disabled={busy !== null || selectedBoundChars.length > 0}
                    onClick={() => void removeVersion(selected)}
                  >
                    <Trash2 size={12} />
                    {selectedBoundChars.length > 0 ? `被 ${selectedBoundChars.length} 个角色锁定，先解绑再删` : '永久删除此版本'}
                  </button>
                )}
              </div>
            </>
          )}
        </aside>
      </div>

      {/* ④ MiMo 官方 9 内置零漂移音色 */}
      <section className="card p-5" data-voice-voice-source="builtin">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold">官方内置音色（MiMo 9 选 1）</h3>
            <p className="mt-0.5 text-[11.5px]" style={{ color: 'var(--text-3)' }}>
              无需参考音频、固定声线零漂移；选中即切默认档到 <span className="mono">mimo-tts</span>（唯一支持 <span className="mono">(唱歌)</span> 前缀的型号）。
            </p>
          </div>
          <span className="pill pill-green" style={{ fontSize: 10 }}>固定声线零漂移</span>
        </div>

        <div className="grid grid-cols-3 gap-2 sm:grid-cols-5 lg:grid-cols-9" data-voice-mimo-builtin-grid>
          {MIMO_TTS_BUILTIN_VOICES.map((voice) => {
            const on = mimoBuiltinVoice === voice && commercial === 'mimo-tts';
            return (
              <button
                key={voice}
                type="button"
                data-voice-mimo-builtin={voice}
                aria-pressed={on}
                onClick={() => onSelectBuiltin(voice)}
                className="flex flex-col items-center justify-center gap-1 rounded-xl px-2.5 py-2.5 text-xs font-semibold transition"
                style={{
                  border: `1px solid ${on ? 'var(--accent-line)' : 'var(--stroke)'}`,
                  background: on ? 'var(--accent-soft)' : 'var(--inset)',
                  color: on ? 'var(--accent)' : 'var(--text-2)',
                }}
              >
                <span>{voice}</span>
                {on && <span className="text-[9.5px] font-medium">使用中</span>}
              </button>
            );
          })}
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <span className="text-[11px]" style={{ color: 'var(--text-3)' }}>
            当前内置音色：<b style={{ color: 'var(--text-1)' }}>{mimoBuiltinVoice}</b>
          </span>
          <button
            type="button"
            data-voice-mimo-builtin-preview
            disabled={previewingKey !== null}
            onClick={() => void onPreviewBuiltin(mimoBuiltinVoice)}
            className="btn-pill ghost"
            style={{ padding: '5px 14px', fontSize: 11.5 }}
          >
            <Play size={11} />
            {previewingKey === 'builtin' ? '合成试听中…' : `试听 ${mimoBuiltinVoice}`}
          </button>
        </div>
      </section>
    </div>
  );
}
