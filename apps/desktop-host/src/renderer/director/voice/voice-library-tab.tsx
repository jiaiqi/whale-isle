/**
 * Tab 1：「声线库与版本档案」（Voice Roster & Version Vault）
 * 对标 ElevenLabs My Voices + Fish Audio 资产卡片，完全融入 Tidepaper v3.1 纸面视觉。
 *
 * 三段结构：
 * 1. 当前生效声线 Hero 卡（真实波形 + CAM++ 一致性仪表 + 许可徽章 + 一键试戴/让桌宠试说/快捷创作入口）
 * 2. 声线版本资产库（出厂基准 + AI 设计定格 + 真人录音克隆，支持激活/回退/重命名/删除/体检/4 情绪试戴）
 * 3. 官方内置零漂移音色（MiMo 9 音色即点即切）
 */
import { useState } from 'react';
import { toast } from 'sonner';
import {
  Activity, AudioLines, Check, Edit3, FlaskConical, Mic, Play, RotateCcw,
  ShieldCheck, Sparkles, Trash2, Volume2, X,
} from 'lucide-react';
import {
  MIMO_WORKSHOP_AUDITION_LINES,
  type CommercialTtsProvider,
  type VoicePerformanceIntensity,
  type VoiceTimbreVersion,
  type VoiceWorkshopState,
} from '@workbench/shared-protocol';
import { MIMO_TTS_BUILTIN_VOICES } from '@workbench/voice-runtime/browser';
import { LicenseBadge } from '../v2/signature-widgets';
import { formatBytes } from './audio-dsp';
import { ConsistencyGauge, WaveformPlayer } from './waveform-player';

interface AuditionRow {
  key: string;
  label: string;
  text: string;
  audioBase64: string;
  durationMs: number | null;
}

const SOURCE_META: Record<VoiceTimbreVersion['source'], { label: string; pill: string }> = {
  factory: { label: '出厂 · 已定格', pill: 'pill-blue' },
  'ai-design': { label: 'AI 设计 · 已定格', pill: 'pill-violet' },
  uploaded: { label: '克隆声线 · 已定格', pill: 'pill-green' },
};

export function VoiceLibraryTab(props: {
  characterName: string;
  workshop: VoiceWorkshopState | null;
  commercial: CommercialTtsProvider;
  mimoBuiltinVoice: string;
  previewingKey: string | null;
  onRefreshWorkshop: () => void;
  onUpdateWorkshop: (next: VoiceWorkshopState) => void;
  onSelectBuiltin: (voice: string) => void;
  onPreviewBuiltin: (voice: string) => Promise<void>;
  onSwitchToTab: (tab: 'workshop' | 'clone' | 'studio' | 'engine') => void;
  onSpeakOnPet: (text: string) => Promise<void>;
}): React.JSX.Element {
  const {
    characterName,
    workshop,
    commercial,
    mimoBuiltinVoice,
    previewingKey,
    onUpdateWorkshop,
    onSelectBuiltin,
    onPreviewBuiltin,
    onSwitchToTab,
    onSpeakOnPet,
  } = props;

  const [busy, setBusy] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState('');
  const [auditionIntensity, setAuditionIntensity] = useState<VoicePerformanceIntensity>('B');
  const [auditions, setAuditions] = useState<Record<string, AuditionRow[]>>({});
  const [audioCache, setAudioCache] = useState<Record<string, string>>({});

  const versions = workshop?.versions ?? [];
  const current = versions.find((v) => v.id === workshop?.currentVersionId) ?? versions[0] ?? null;

  const fetchVersionAudio = async (versionId: string): Promise<string> => {
    const cached = audioCache[versionId];
    if (cached !== undefined) return cached;
    const res = await window.directorBridge.v2VoiceWorkshopReadAudio({ kind: 'version', id: versionId });
    setAudioCache((prev) => ({ ...prev, [versionId]: res.audioBase64 }));
    return res.audioBase64;
  };

  const activateVersion = async (version: VoiceTimbreVersion): Promise<void> => {
    setBusy(`activate-${version.id}`);
    try {
      const { state } = await window.directorBridge.v2VoiceWorkshopRollback(version.id);
      await window.directorBridge.prefsSet({ voiceCommercialProvider: 'mimo-tts-voiceclone' });
      onUpdateWorkshop(state);
      toast.success(`已启用声线「${version.label}」（VoiceClone 锁定生效）`);
    } catch (err) {
      toast.error(`切换失败：${err instanceof Error ? err.message : String(err)}`);
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

  const runAudition = async (versionId: string): Promise<void> => {
    setBusy(`audition-${versionId}`);
    try {
      const rows = await window.directorBridge.v2VoiceWorkshopVersionAudition({ versionId, intensity: auditionIntensity });
      setAuditions((prev) => ({ ...prev, [versionId]: rows }));
      if (rows[0]?.audioBase64) {
        void new Audio(`data:audio/wav;base64,${rows[0].audioBase64}`).play().catch(() => undefined);
      }
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
    if (!window.confirm(`确定删除本地声线版本「${version.label}」？该版本的参考音频副本也将一并移除，出厂版本不受影响。`)) return;
    setBusy(`delete-${version.id}`);
    try {
      const { state } = await window.directorBridge.v2VoiceWorkshopDelete({ versionId: version.id });
      onUpdateWorkshop(state);
      toast.success(`已删除「${version.label}」`);
    } catch (err) {
      toast.error(`删除失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-5" data-voice-library-tab>
      {/* ① 当前生效声线 Hero 卡 */}
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
                {current.consent !== undefined && (
                  <span className="inline-flex items-center gap-1" style={{ color: 'var(--green)' }}>
                    <ShieldCheck size={11} />权属留档：{current.consent.source}
                  </span>
                )}
                <span className="mono truncate max-w-md" title={current.referencePath}>
                  参考文件：{current.referencePath.split(/[/\\]/).slice(-2).join('/')}
                </span>
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
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
              <Mic size={13} />录音 / 上传克隆
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
        {current !== null && (
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <div className="inset p-3.5">
              <div className="mb-2 flex items-center justify-between text-[11px]">
                <span className="font-semibold" style={{ color: 'var(--text-2)' }}>锁定参考干声（VoiceClone 声线锚点）</span>
                <span style={{ color: 'var(--text-3)' }}>所有情绪由此单点锚定，杜绝换人</span>
              </div>
              <WaveformPlayer
                key={current.id}
                audioBase64={audioCache[current.id] ?? null}
                onRequestAudio={() => fetchVersionAudio(current.id)}
                durationMs={current.durationMs ?? null}
                downloadName={`${current.id}-reference.wav`}
                label={`${current.label} 参考干声`}
                eagerLoad
              />
              <div className="mt-2.5 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void runAudition(current.id)}
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
                        onClick={() => void new Audio(`data:audio/wav;base64,${row.audioBase64}`).play().catch(() => undefined)}
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

      {/* ② 声线版本库（出厂 / AI 设计 / 录音克隆） */}
      <section className="card p-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold">声线版本库（共 {versions.length} 个版本）</h3>
            <p className="mt-0.5 text-[11.5px]" style={{ color: 'var(--text-3)' }}>
              所有 AI 设计定格与本地克隆声线统一入库；出厂基准永久保留可随时回退，全部数据仅存本地 userData。
            </p>
          </div>
          <span className="pill mono" style={{ fontSize: 10 }}>
            试戴四句：{MIMO_WORKSHOP_AUDITION_LINES.map((l) => l.label).join(' / ')}
          </span>
        </div>

        <div className="grid gap-3 md:grid-cols-2" data-voice-version-grid>
          {versions.map((version) => {
            const isActive = version.id === workshop?.currentVersionId;
            const isEditing = editingId === version.id;
            const srcMeta = SOURCE_META[version.source];
            return (
              <article
                key={version.id}
                data-voice-version-card={version.id}
                data-active={isActive ? 'true' : 'false'}
                className="inset flex flex-col justify-between p-3.5 transition"
                style={isActive ? { borderColor: 'var(--accent-line)', background: 'var(--surface-solid)' } : undefined}
              >
                <div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {isEditing ? (
                      <div className="flex flex-1 items-center gap-1.5">
                        <input
                          type="text"
                          value={nameDraft}
                          maxLength={40}
                          onChange={(e) => setNameDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') void saveRename(version.id);
                            if (e.key === 'Escape') setEditingId(null);
                          }}
                          className="min-w-0 flex-1 rounded-md px-2 py-0.5 text-xs outline-none"
                          style={{ border: '1px solid var(--accent-line)', background: 'var(--surface)', color: 'var(--text-1)' }}
                          autoFocus
                        />
                        <button type="button" className="vs-icon-btn" onClick={() => void saveRename(version.id)} aria-label="保存名称"><Check size={12} /></button>
                        <button type="button" className="vs-icon-btn" onClick={() => setEditingId(null)} aria-label="取消重命名"><X size={12} /></button>
                      </div>
                    ) : (
                      <>
                        <span className="text-[13px] font-semibold" style={{ color: 'var(--text-1)' }}>{version.label}</span>
                        {version.source !== 'factory' && (
                          <button
                            type="button"
                            className="vs-icon-btn"
                            title="重命名此声线版本"
                            aria-label={`重命名 ${version.label}`}
                            onClick={() => { setEditingId(version.id); setNameDraft(version.label); }}
                          >
                            <Edit3 size={11} />
                          </button>
                        )}
                      </>
                    )}
                    <span className={`pill ${srcMeta.pill}`} style={{ fontSize: 9.5, padding: '1.5px 7px' }}>{srcMeta.label}</span>
                    {isActive && <span className="pill pill-blue" style={{ fontSize: 9.5, padding: '1.5px 7px' }}>当前生效</span>}
                  </div>

                  <p className="mt-1.5 line-clamp-2 text-[11.5px] leading-relaxed" style={{ color: 'var(--text-2)' }}>
                    {version.description}
                  </p>

                  <div className="mt-2 flex flex-wrap items-center gap-2 text-[10.5px]" style={{ color: 'var(--text-3)' }}>
                    <span className="mono">{formatBytes(version.referenceBytes)}</span>
                    {version.durationMs != null && <span className="mono">{(version.durationMs / 1000).toFixed(1)}s</span>}
                    {version.audioQuality !== undefined && (
                      <span className={`pill ${version.audioQuality.grade === 'good' ? 'pill-green' : version.audioQuality.grade === 'fair' ? 'pill-amber' : 'pill-red'}`} style={{ fontSize: 9.5, padding: '1px 6px' }}>
                        声学 {version.audioQuality.grade === 'good' ? '优' : version.audioQuality.grade === 'fair' ? '良' : '需注意'} · {version.audioQuality.rmsDb} dBFS
                      </span>
                    )}
                    <span className="mono">{version.frozenAt.slice(0, 16).replace('T', ' ')}</span>
                  </div>

                  <div className="mt-2.5">
                    <WaveformPlayer
                      compact
                      audioBase64={audioCache[version.id] ?? null}
                      onRequestAudio={() => fetchVersionAudio(version.id)}
                      durationMs={version.durationMs ?? null}
                      downloadName={`${version.label}.wav`}
                      label={version.label}
                    />
                  </div>

                  {version.consistency !== null && (
                    <div className="mt-2">
                      <ConsistencyGauge result={version.consistency} compact />
                    </div>
                  )}
                </div>

                <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t pt-2.5" style={{ borderColor: 'var(--stroke)' }}>
                  <div className="flex flex-wrap gap-1.5">
                    {!isActive && (
                      <button
                        type="button"
                        disabled={busy !== null}
                        onClick={() => void activateVersion(version)}
                        className="btn-pill primary"
                        style={{ padding: '4px 11px', fontSize: 11 }}
                      >
                        <RotateCcw size={11} />{version.source === 'factory' ? '回退出厂' : '启用此声线'}
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => void runAudition(version.id)}
                      className="btn-pill ghost"
                      style={{ padding: '4px 10px', fontSize: 11 }}
                    >
                      <Play size={10} />{busy === `audition-${version.id}` ? '试戴中…' : '4 情绪试戴'}
                    </button>
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => void runCheck(version.id)}
                      className="btn-pill ghost"
                      style={{ padding: '4px 10px', fontSize: 11 }}
                    >
                      <FlaskConical size={10} />{busy === `check-${version.id}` ? '体检中…' : '体检'}
                    </button>
                  </div>
                  {version.source !== 'factory' && (
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => void removeVersion(version)}
                      className="vs-icon-btn danger"
                      title="删除此版本"
                      aria-label={`删除 ${version.label}`}
                    >
                      <Trash2 size={12} />
                    </button>
                  )}
                </div>

                {(auditions[version.id] ?? []).length > 0 && version.id !== current?.id && (
                  <div className="mt-2 grid gap-1 border-t pt-2" style={{ borderColor: 'var(--stroke)' }}>
                    {(auditions[version.id] ?? []).map((row) => (
                      <div key={row.key} className="flex items-center gap-1.5 text-[10.5px]">
                        <span className="pill" style={{ fontSize: 9.5, padding: '1px 6px' }}>{row.label}</span>
                        <span className="min-w-0 flex-1 truncate" style={{ color: 'var(--text-3)' }}>{row.text}</span>
                        <button
                          type="button"
                          className="btn-pill ghost"
                          style={{ padding: '1px 8px', fontSize: 10 }}
                          onClick={() => void new Audio(`data:audio/wav;base64,${row.audioBase64}`).play().catch(() => undefined)}
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
      </section>

      {/* ③ MiMo 官方 9 内置零漂移音色 */}
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
