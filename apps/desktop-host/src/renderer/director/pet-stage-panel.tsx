/**
 * 桌宠舞台（v4 设计稿 04 的「透明舞台」Tab）：真实 manifest 待机动画 + 双轨气泡 + 语音设置。
 * 视频直接用 dist 内 pet-stage 素材；气泡数据来自真实 autodrive 事件流。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { SpritesheetRenderer, WebmVideoRenderer } from '@workbench/pet-renderer';
import { toast } from 'sonner';
import { Fish, Hand, Volume2 } from 'lucide-react';
import type { AutodriveEventView, CharacterSummary } from './bridge';
import { CharacterPackStore } from './character-pack-store';

interface ManifestClip { clipId: string; webmPath: string; spriteSheetPath?: string; sprite?: { frameWidth: number; frameHeight: number; columns: number; frameCount: number; sampleFps: number }; audioPath?: string }
interface ManifestAction { actionState: string; clips: ManifestClip[] }
interface AmbientClip extends ManifestClip { category: string; weight: number }
interface ManifestShape { renderer?: 'webm-alpha' | 'live2d' | 'sprite-sheet'; actions?: ManifestAction[]; ambientPool?: AmbientClip[] }

function RendererPreview({ manifest, action }: { manifest: ManifestShape; action: string }): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return undefined;
    container.replaceChildren();
    const normalized = {
      ...manifest,
      renderer: manifest.renderer ?? 'webm-alpha', licenseScope: 'DEV_ONLY_NON_COMMERCIAL', attribution: 'preview',
      width: 640, height: 360, footlineRatio: 0.92, defaultAction: 'idle', petId: 'preview', ambientPool: manifest.ambientPool ?? [],
      actions: (manifest.actions ?? []).map((entry) => ({ ...entry, clips: entry.clips.map((clip) => ({ ...clip, playbackRate: 1, loop: true, fps: clip.sprite?.sampleFps ?? 12, weight: 1, webmPath: clip.webmPath.startsWith('assets/') ? `../pet-stage/${clip.webmPath.replace(/^\.\//, '')}` : clip.webmPath })) })),
    } as import('@workbench/shared-protocol').PetAvatarManifest;
    const applySquash = (pose: { scaleX: number; scaleY: number }): void => { container.style.transform = `scale(${pose.scaleX}, ${pose.scaleY})`; };
    const host = {
      mountVideo(handle: { el?: unknown }) { const el = handle.el as HTMLElement | undefined; if (el) { el.style.width = '100%'; el.style.height = '100%'; el.style.objectFit = 'contain'; container.appendChild(el); } },
      showVideo(handle: { el?: unknown }) { const el = handle.el as HTMLElement | undefined; if (el) el.style.opacity = '1'; },
      hideVideo(handle: { el?: unknown }) { const el = handle.el as HTMLElement | undefined; if (el) el.style.opacity = '0'; },
      detachVideo(handle: { el?: unknown }) { (handle.el as HTMLElement | undefined)?.remove(); },
      setDevBadge: () => undefined, applyLayout: () => undefined, applySquash,
    };
    const audioEl = new Audio();
    const audio = { async play(src: string, opts: { volume: number }) { audioEl.src = src; audioEl.volume = opts.volume; await audioEl.play(); }, stop() { audioEl.pause(); }, setVolume(volume: number) { audioEl.volume = volume; } };
    const videoFactory = (src: string) => {
      const el = document.createElement('video'); el.src = src; el.muted = true; el.playsInline = true; el.autoplay = true; el.loop = true;
      return { src, el, play: async () => { await el.play(); }, pause: () => el.pause(), detach: () => el.remove() };
    };
    const surfaceFactory = (src: string, meta: { frameWidth: number; frameHeight: number; columns: number; frameCount: number; sampleFps: number }) => {
      const canvas = document.createElement('canvas'); canvas.width = meta.frameWidth; canvas.height = meta.frameHeight;
      let raf = 0; let image: HTMLImageElement | null = null;
      return { src, el: canvas, play: async () => {
        image = await new Promise<HTMLImageElement>((resolve, reject) => { const img = new Image(); img.onload = () => resolve(img); img.onerror = () => reject(new Error('sprite load')); img.src = src; });
        const start = performance.now();
        const draw = (now: number): void => { if (image === null) return; const index = Math.floor(((now - start) / 1000) * meta.sampleFps) % meta.frameCount; const sx = (index % meta.columns) * meta.frameWidth; const sy = Math.floor(index / meta.columns) * meta.frameHeight; canvas.getContext('2d')?.drawImage(image, sx, sy, meta.frameWidth, meta.frameHeight, 0, 0, meta.frameWidth, meta.frameHeight); raf = requestAnimationFrame(draw); };
        raf = requestAnimationFrame(draw);
      }, pause: () => cancelAnimationFrame(raf), detach: () => { cancelAnimationFrame(raf); canvas.remove(); } };
    };
    const renderer = normalized.renderer === 'sprite-sheet'
      ? new SpritesheetRenderer({ host, surfaceFactory, audio })
      : new WebmVideoRenderer({ host, videoFactory });
    let disposed = false;
    void renderer.load(normalized).then(() => renderer.play(action as import('@workbench/shared-protocol').PetActionState)).catch(() => undefined);
    return () => { disposed = true; void disposed; renderer.dispose(); container.replaceChildren(); };
  }, [manifest, action]);
  return <div ref={containerRef} data-stage-renderer={manifest.renderer} style={{ width: 360, height: 203, display: 'grid', placeItems: 'center', filter: 'drop-shadow(0 18px 30px rgba(0,0,0,0.45))' }} />;
}

export interface PetStagePanelProps {
  events: AutodriveEventView[];
  running: boolean;
  characters: CharacterSummary[];
  characterId: string;
  onSelectCharacter: (id: string) => void;
}

function goalOf(clock: string): string[] {
  const hour = Number(/ (\d{2}):/.exec(clock)?.[1] ?? '6');
  if (hour < 11) return ['读信 / 浇水 / 播种', '整理背包并带好鱼饵', '11:00 出发海滩'];
  if (hour < 17) return ['海滩钓鱼赚米', '体力 <15% 先吃东西', '17:30 转傍晚采集'];
  if (hour < 20) return ['镇上采集 / 翻垃圾桶', '18:30 前回家', '睡前确认体力与背包'];
  return ['回家睡觉（绝不晕倒）', '确认出货箱收益', '明早 6:00 起床'];
}

export function PetStagePanel({ events, running, characters, characterId, onSelectCharacter }: PetStagePanelProps): React.JSX.Element {
  const [manifest, setManifest] = useState<ManifestShape | null>(null);
  const [activeAction, setActiveAction] = useState('idle');
  const [voice, setVoice] = useState({ enabled: true, innerVoice: true, volume: 1 });
  const [showGoals, setShowGoals] = useState(true);
  const [scale, setScale] = useState(1); // T-M6-20 桌宠缩放（滑块/滚轮/右键菜单同源）
  const [desk, setDesk] = useState({ powerSaverEnabled: true, shortcutHideEnabled: true, autoHideFullscreen: true, sfxEnabled: true, sfxVolume: 0.7 });

  useEffect(() => {
    void window.directorBridge.petsManifest().then((res) => {
      setManifest((res.manifest as ManifestShape | undefined) ?? null);
      setActiveAction('idle');
    }).catch(() => setManifest(null));
    void window.directorBridge.voiceConfigGet().then((c) => setVoice({ enabled: c.enabled, innerVoice: c.innerVoice, volume: c.volume }));
    void window.directorBridge.prefsGet().then((p) => {
      setScale(p.scale);
      setDesk({
        powerSaverEnabled: p.powerSaverEnabled ?? true,
        shortcutHideEnabled: p.shortcutHideEnabled ?? true,
        autoHideFullscreen: p.autoHideFullscreen ?? true,
        sfxEnabled: p.sfxEnabled ?? true,
        sfxVolume: p.sfxVolume ?? 0.7,
      });
    }).catch(() => undefined);
  }, [characterId]);

  const latestState = [...events].reverse().find((e) => e.type === 'state');
  const latestThink = [...events].reverse().find((e) => e.type === 'decision');
  const latestTalk = [...events].reverse().find((e) => e.tool === 'chat_reply' || e.tool === 'reflex_spray' || (e.type === 'receipt' && e.tool === 'fish'));
  const goals = useMemo(() => goalOf(latestState?.clock ?? ''), [latestState?.clock]);
  const staminaPct = latestState?.stamina != null && latestState.staminaMax ? Math.round((latestState.stamina / latestState.staminaMax) * 100) : 0;

  const patchVoice = async (next: Partial<{ enabled: boolean; innerVoice: boolean; volume: number }>): Promise<void> => {
    const applied = await window.directorBridge.voiceConfigSet(next);
    setVoice({ enabled: applied.enabled, innerVoice: applied.innerVoice, volume: applied.volume });
    toast(next.enabled === false ? '已静音：仅字幕与云朵气泡' : '语音设置已保存');
  };

  const patHead = (): void => {
    void window.directorBridge.petsPreview('happy_maid', null);
    toast('摸头成功：桌宠窗已切到「优雅女仆舞」');
  };

  return (
    <div className="grid grid-cols-[1fr_320px] gap-4">
      <section className="card relative overflow-hidden" style={{ height: 590, background: 'radial-gradient(120% 90% at 50% 105%, rgba(10,132,255,0.12), transparent 60%), var(--surface)' }}>
        <div className="absolute inset-0" style={{ backgroundImage: 'radial-gradient(rgba(255,255,255,0.06) 1px, transparent 1px)', backgroundSize: '18px 18px' }} />
        <div className="absolute right-3 top-3 z-10"><CharacterPackStore /></div>

        {/* 内心戏紫云朵 */}
        {latestThink !== undefined && (
          <div className="absolute left-6 top-6 max-w-[52%] rounded-[18px] px-3.5 py-2.5 text-[12px]" style={{ background: 'linear-gradient(135deg, rgba(191,90,242,0.16), rgba(191,90,242,0.05))', border: '1.5px dashed rgba(191,90,242,0.45)', color: 'var(--text-1)' }}>
            <span className="mono mr-1 text-[9px]" style={{ color: 'var(--violet)' }}>内心戏</span>
            {latestThink.intent ?? '……'}
          </div>
        )}

        {/* 正式台词泡 */}
        <div className="absolute left-1/2 top-24 w-[56%] -translate-x-1/2 rounded-2xl px-4 py-3 text-[13px]" style={{ background: 'var(--surface)', border: '1px solid var(--blue-line)', backdropFilter: 'blur(14px)', color: 'var(--text-1)' }}>
          {latestTalk?.summary ?? '小鲸待命中——启动自动驾驶后，台词会实时出现在这里。'}
          <div className="mono mt-1.5 flex items-center gap-1 text-[9.5px]" style={{ color: 'var(--green)' }}>
            <Volume2 size={10} /> {voice.enabled ? 'TTS 播报中 · 俏皮萌妹' : '已静音'}
          </div>
        </div>

        {/* 桌宠本体 */}
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2">
          {manifest !== null ? <RendererPreview manifest={manifest} action={activeAction} /> : <div style={{ width: 360, height: 203, display: 'grid', placeItems: 'center', color: 'var(--text-3)', fontSize: 11 }}>角色素材未安装</div>}
          <button onClick={patHead} className="mx-auto mt-1 flex items-center gap-1.5 rounded-full px-3 py-1 text-[10.5px]" style={{ background: 'var(--surface-2)', border: '1px solid var(--stroke-2)', color: 'var(--text-2)' }}>
            <Hand size={11} /> 摸摸头
          </button>
        </div>

        {/* 今日目标卡 */}
        {showGoals && (
          <div className="absolute bottom-6 right-4 w-52 rounded-xl px-3 py-2.5" style={{ background: 'var(--surface)', border: '1px solid var(--stroke-2)', backdropFilter: 'blur(12px)' }}>
            <div className="mb-1 flex items-center justify-between text-[10px]" style={{ color: 'var(--text-3)' }}>
              <span>今日目标</span>
              <button onClick={() => setShowGoals(false)} style={{ color: 'var(--text-3)' }}>收起</button>
            </div>
            {goals.map((g, i) => (
              <div key={g} className="mono py-0.5 text-[10.5px]" style={{ color: i === 0 ? 'var(--blue)' : 'var(--text-2)' }}>
                {i === 0 ? '▸' : '·'} {g}
              </div>
            ))}
          </div>
        )}

        {/* 底部状态条 */}
        <div className="absolute bottom-2 left-4 right-4 flex items-center gap-3 text-[10px]" style={{ color: 'var(--text-3)' }}>
          <span className="flex items-center gap-1"><Fish size={11} style={{ color: 'var(--green)' }} />{running ? '自动驾驶中' : '待命'}</span>
          {latestState === undefined ? (
            <span className="mono">等待游戏状态…</span>
          ) : (
            <>
              <span className="mono">{latestState.clock} · {latestState.location}</span>
              <span className="mono">体力 {staminaPct}%</span>
              <span className="mono">{latestState.money != null ? `${latestState.money}g` : '—'}</span>
            </>
          )}
          {!showGoals && <button className="ml-auto pill" style={{ fontSize: 9 }} onClick={() => setShowGoals(true)}>显示目标</button>}
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <div className="card px-4 py-3.5">
          <h3 className="mb-2 text-xs font-semibold" style={{ color: 'var(--text-2)' }}>当前角色</h3>
          <div className="flex flex-wrap gap-1.5">
            {characters.map((c) => (
              <button
                key={c.id}
                data-character={c.id}
                aria-pressed={characterId === c.id}
                onClick={() => onSelectCharacter(c.id)}
                className={`pill${characterId === c.id ? ' pill-blue' : ''}`}
                style={{ fontSize: 10, cursor: 'pointer' }}
                title={`${c.displayName} · 音色 ${c.voiceId}${c.licenseScope === 'DEV_ONLY_NON_COMMERCIAL' ? ' · 非商用素材' : ''}`}
              >
                {c.displayName}
              </button>
            ))}
            {characters.length === 0 && <span className="text-[11px]" style={{ color: 'var(--text-3)' }}>正在读取角色注册表…</span>}
          </div>
        </div>

        <div className="card px-4 py-3.5">
          <h3 className="mb-2 text-xs font-semibold" style={{ color: 'var(--text-2)' }}>动作槽位与氛围池</h3>
          <div className="flex flex-wrap gap-1">
            {(manifest?.actions ?? []).map((action) => (
              <button key={action.actionState} className={`pill${activeAction === action.actionState ? ' pill-blue' : ''}`} style={{ fontSize: 9.5 }} onClick={() => { setActiveAction(action.actionState); void window.directorBridge.petsPreview(action.actionState, null); }}>
                {action.actionState}
              </button>
            ))}
          </div>
          <div className="mt-1.5 text-[10px]" style={{ color: 'var(--text-3)' }}>
            renderer {manifest?.renderer ?? '—'} · {manifest?.ambientPool?.length ?? 0} 条氛围动作
          </div>
        </div>

        <div className="card px-4 py-3.5">
          <h3 className="mb-2 text-xs font-semibold" style={{ color: 'var(--text-2)' }}>桌宠大小</h3>
          <label className="block text-[11px]" style={{ color: 'var(--text-2)' }}>
            当前 <span className="mono">{scale.toFixed(1)}×</span>（桌宠身上滚轮 / 右键菜单也可调）
            <input
              type="range" className="wb-range mt-1.5" min={0.6} max={2} step={0.1}
              value={scale}
              onChange={(e) => {
                const next = Number(e.target.value);
                setScale(next);
                void window.directorBridge.prefsSet({ scale: next });
              }}
            />
          </label>
        </div>

        <div className="card px-4 py-3.5">
          <h3 className="mb-2 text-xs font-semibold" style={{ color: 'var(--text-2)' }}>语音设置</h3>
          {([
            ['语音播报', 'enabled'],
            ['内心戏出声', 'innerVoice'],
          ] as const).map(([label, key]) => (
            <div key={key} className="flex items-center justify-between py-1.5 text-[11.5px]" style={{ color: 'var(--text-2)' }}>
              <span>{label}</span>
              <button className={`sw${voice[key] ? ' on' : ''}`} aria-pressed={voice[key]} onClick={() => void patchVoice({ [key]: !voice[key] })} />
            </div>
          ))}
          <label className="mt-2 block text-[11px]" style={{ color: 'var(--text-2)' }}>
            心声音量 <span className="mono">{Math.round(voice.volume * 100)}%</span>
            <input
              type="range" className="wb-range violet mt-1.5" min={0} max={1} step={0.05}
              value={voice.volume}
              onChange={(e) => setVoice((v) => ({ ...v, volume: Number(e.target.value) }))}
              onMouseUp={(e) => void patchVoice({ volume: Number((e.target as HTMLInputElement).value) })}
            />
          </label>
        </div>

        <div className="card px-4 py-3.5">
          <h3 className="mb-2 text-xs font-semibold" style={{ color: 'var(--text-2)' }}>桌面防打扰与省电</h3>
          {([
            ['闲置 30s 降低渲染帧率', 'powerSaverEnabled'],
            ['Ctrl+Option+P 暂藏/唤回', 'shortcutHideEnabled'],
            ['全屏应用时自动隐藏', 'autoHideFullscreen'],
            ['播放动作原声', 'sfxEnabled'],
          ] as const).map(([label, key]) => (
            <div key={key} className="flex items-center justify-between py-1.5 text-[11.5px]" style={{ color: 'var(--text-2)' }}>
              <span>{label}</span>
              <button aria-pressed={desk[key]} className={`sw${desk[key] ? ' on' : ''}`} onClick={() => { const next = { ...desk, [key]: !desk[key] }; setDesk(next); void window.directorBridge.prefsSet({ [key]: next[key] }); }} />
            </div>
          ))}
          <label className="mt-2 block text-[11px]" style={{ color: 'var(--text-2)' }}>
            动作原声音量 <span className="mono">{Math.round(desk.sfxVolume * 100)}%</span>
            <input type="range" className="wb-range mt-1.5" min={0} max={1} step={0.05} value={desk.sfxVolume} onChange={(event) => setDesk({ ...desk, sfxVolume: Number(event.target.value) })} onMouseUp={(event) => void window.directorBridge.prefsSet({ sfxVolume: Number((event.target as HTMLInputElement).value) })} />
          </label>
          <p className="mt-1.5 text-[10px] leading-relaxed" style={{ color: 'var(--text-3)' }}>贴边后 10s 缩回；Alt/Option 按住临时穿透；睡眠时屏蔽随机动作、余额与工作打扰。</p>
        </div>

        <div className="card px-4 py-3.5">
          <h3 className="mb-2 text-xs font-semibold" style={{ color: 'var(--text-2)' }}>语音场景矩阵</h3>
          {[
            ['正式台词', 'daily · 软萌小女仆', 'var(--green)'],
            ['内心戏', 'sleepy · 慵懒气声', 'var(--violet)'],
            ['雷区反射', 'tsundere · 傲娇炸毛（0 token）', 'var(--red)'],
          ].map(([t, d, c]) => (
            <div key={t} className="flex items-center gap-2 py-1.5 text-[11px]">
              <span style={{ width: 6, height: 6, borderRadius: 99, background: c as string }} />
              <span style={{ color: 'var(--text-2)' }}>{t}</span>
              <span className="mono ml-auto text-[9.5px]" style={{ color: 'var(--text-3)' }}>{d}</span>
            </div>
          ))}
        </div>

        <div className="card px-4 py-3.5">
          <h3 className="mb-2 text-xs font-semibold" style={{ color: 'var(--text-2)' }}>当前动作</h3>
          <div className="mono text-[12px] font-semibold" style={{ color: 'var(--blue)' }}>
            {latestThink?.tool ?? 'idle'}
          </div>
          <p className="mt-1 text-[10.5px] leading-relaxed" style={{ color: 'var(--text-3)' }}>
            {latestThink?.intent ?? '等待下一次决策…'}
          </p>
          {latestTalk?.status !== undefined && (
            <span className={`pill mt-2 pill-${latestTalk.status === 'COMPLETED' ? 'green' : latestTalk.status === 'FAILED' ? 'red' : 'amber'}`} style={{ fontSize: 9 }}>
              {latestTalk.status}
            </span>
          )}
        </div>
      </section>
    </div>
  );
}
