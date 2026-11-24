/**
 * 桌宠工坊 Tab 2「动作预览与素材库」（T-M6-46，T-M6-50 按上游 preview.json 语义重做）。
 *
 * 上游 hunmer/aboutme-pets 的实现要点（逐条对齐）：
 *   ① 动作库严格按角色/形象分库：每个角色有自己的 categories + idleAnimationId + totalActions，
 *      切角色 = 换整套动作库、清空搜索、自动播该角色的待机动作；
 *   ② 每个动作自带 frameWidth/frameHeight/columns/rows/frameCount/fps，不是全局 640×360；
 *   ③ 音频作为时钟：有音轨时帧号 = floor(audio.currentTime × fps)，音频 blob 就绪前冻结动画，
 *      保证声画从 0 同时开始、循环不漂移；拖动/逐帧时 seek 音频；
 *   ④ 右侧按 category 折叠分组，搜索只在当前角色内过滤。
 *
 * 数据全部来自 `pet:studio-catalog`（主进程读随包素材，不伪造）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Clapperboard, Download, Pause, Play, Search, Send, SkipBack, SkipForward } from 'lucide-react';
import { toast } from 'sonner';
import type { PetStudioAction, PetStudioCatalog, PetStudioSkin, PetStudioSlot } from '@workbench/shared-protocol';

const SLOT_LABELS: Record<string, string> = {
  idle: '待机呼吸', walk: '漫游走动', eat_rice: '干饭吃米', happy_maid: '开心女仆礼',
  thinking_tail_wag: '歪头思考', rage_spray: '喷水抗议', clumsy_panic: '心虚冒汗',
  game_focus: '游戏专注', sing_stage: '唱歌表演', hungry_lazy: '饿瘪瘫倒', sleep_mute: '睡觉静音',
};

type LibTab = 'actions' | 'slots' | 'skins';
type Scope = 'character' | 'all';

/**
 * 逐帧画布：音频在播时以音频位置为时钟（与上游一致）；无音轨/音频未就绪时按时间推进；
 * 暂停时锁定父组件 frame。只在帧号变化时回报父组件，避免 1,040 条列表跟着 60fps 重渲染。
 */
function FrameCanvas(props: {
  image: HTMLImageElement | null;
  columns: number;
  rows: number;
  frameCount: number;
  frameWidth: number;
  frameHeight: number;
  fps: number;
  paused: boolean;
  audioPending: boolean;
  frame: number;
  onFrame: (frame: number) => void;
  /** 音频播放位置对应的帧；null = 当前没有可用的音频时钟 */
  getAudioFrame: () => number | null;
}): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stateRef = useRef(props);
  stateRef.current = props;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return undefined;
    const context = canvas.getContext('2d');
    if (context === null) return undefined;
    let raf = 0;
    let lastReported = -1;
    let lastIndex = -1;
    let index = stateRef.current.frame;
    let accumulator = 0;
    let lastNow = performance.now();
    const draw = (): void => {
      const current = stateRef.current;
      const now = performance.now();
      const count = Math.max(1, current.frameCount);
      raf = requestAnimationFrame(draw);
      if (current.paused) {
        index = current.frame % count;
        accumulator = 0;
      } else {
        const audioFrame = current.getAudioFrame();
        if (audioFrame !== null) {
          // 音频即时钟：声画同源，循环点天然对齐
          index = audioFrame % count;
          accumulator = 0;
        } else if (current.audioPending) {
          // 音频 blob 就绪前冻结，避免动画跑到声音前面（上游同款行为）
        } else {
          accumulator += ((now - lastNow) / 1000) * current.fps;
          const step = Math.floor(accumulator);
          if (step > 0) {
            index = (index + step) % count;
            accumulator -= step;
          }
        }
      }
      lastNow = now;
      if (current.image !== null && index !== lastIndex) {
        // 优先按精灵图真实尺寸推导帧宽高（naturalWidth/columns），元数据仅在无法整除时兜底
        const columns = Math.max(1, current.columns);
        const rows = Math.max(1, current.rows > 0 ? current.rows : Math.ceil(count / columns));
        const naturalFrameWidth = current.image.naturalWidth / columns;
        const naturalFrameHeight = current.image.naturalHeight / rows;
        const useNatural = Number.isInteger(naturalFrameWidth) && Number.isInteger(naturalFrameHeight)
          && naturalFrameWidth > 0 && naturalFrameHeight > 0;
        const frameWidth = useNatural ? naturalFrameWidth : current.frameWidth;
        const frameHeight = useNatural ? naturalFrameHeight : current.frameHeight;
        const sx = (index % columns) * frameWidth;
        const sy = Math.floor(index / columns) * frameHeight;
        if (canvas.width !== frameWidth) canvas.width = frameWidth;
        if (canvas.height !== frameHeight) canvas.height = frameHeight;
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.drawImage(current.image, sx, sy, frameWidth, frameHeight, 0, 0, canvas.width, canvas.height);
        lastIndex = index;
      }
      if (index !== lastReported) {
        lastReported = index;
        if (!current.paused) current.onFrame(index);
      }
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <canvas
      ref={canvasRef}
      width={props.frameWidth}
      height={props.frameHeight}
      data-preview-canvas
      style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
    />
  );
}

export function ActionPlayer(props: {
  characterId: string;
  characterName: string;
  catalog: PetStudioCatalog | null;
  error: string | null;
  onOpenCreator?: () => void;
  onOpenBench?: () => void;
}): React.JSX.Element {
  const { characterId, characterName, catalog, error, onOpenCreator, onOpenBench } = props;
  const [libTab, setLibTab] = useState<LibTab>('actions');
  const [scope, setScope] = useState<Scope>('character');
  const [packFilter, setPackFilter] = useState<string>('');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<PetStudioAction | null>(null);
  const [paused, setPaused] = useState(false);
  const [frame, setFrame] = useState(0);
  const [sfx, setSfx] = useState(true);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [audioPending, setAudioPending] = useState(false);
  const [exporting, setExporting] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioObjectUrlRef = useRef<string>('');
  const audioTokenRef = useRef(0);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const appliedCharacterRef = useRef('');

  const currentSlug = slugOf(characterId);
  const currentPack = catalog?.packs.find((pack) => pack.slug === currentSlug);
  const hasOwnPack = currentPack !== undefined;
  const packSlugOfId = useCallback((catalogId: string): string => catalog?.packs.find((pack) => pack.catalogId === catalogId)?.slug ?? '', [catalog]);

  // 当前生效的动作库范围：角色自己的包 → 明确指定包 → 全部
  const activeSlug = scope === 'character' && hasOwnPack ? currentSlug : packFilter;
  const scopedActions = useMemo(
    () => (catalog?.actions ?? []).filter((action) => activeSlug === '' || action.slug === activeSlug),
    [catalog, activeSlug],
  );

  const filteredActions = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (keyword === '') return scopedActions;
    return scopedActions.filter((action) =>
      action.clipId.toLowerCase().includes(keyword)
      || action.category.toLowerCase().includes(keyword)
      || action.displayName.toLowerCase().includes(keyword));
  }, [scopedActions, query]);

  /** 按 category 折叠分组（保持上游 actions.json 的首次出现顺序）。 */
  const groupedActions = useMemo(() => {
    const groups = new Map<string, PetStudioAction[]>();
    for (const action of filteredActions) {
      const list = groups.get(action.category);
      if (list === undefined) groups.set(action.category, [action]);
      else list.push(action);
    }
    return [...groups.entries()];
  }, [filteredActions]);

  const filteredSlots = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return (catalog?.slots ?? []).filter((slot) => {
      const slug = packSlugOfId(slot.packId);
      if (activeSlug !== '' && slug !== activeSlug) return false;
      if (keyword === '') return true;
      return slot.slot.toLowerCase().includes(keyword)
        || (SLOT_LABELS[slot.slot] ?? '').includes(keyword)
        || slot.clipIds.some((clipId) => clipId.toLowerCase().includes(keyword));
    });
  }, [catalog, activeSlug, query, packSlugOfId]);

  const filteredSkins = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return (catalog?.skins ?? []).filter((skin) => keyword === ''
      || skin.id.includes(keyword) || skin.name.toLowerCase().includes(keyword) || skin.outfit.includes(keyword));
  }, [catalog, query]);

  // ── 音频：blob + 隐藏元素 + 音频即时钟（与上游一致） ──
  const stopAudio = useCallback((revoke = true): void => {
    audioTokenRef.current += 1;
    const audio = audioRef.current;
    if (audio !== null) {
      audio.pause();
      audio.remove();
      audioRef.current = null;
    }
    if (revoke && audioObjectUrlRef.current !== '') {
      URL.revokeObjectURL(audioObjectUrlRef.current);
      audioObjectUrlRef.current = '';
    }
    setAudioPending(false);
  }, []);

  const startAudio = useCallback((action: PetStudioAction | null): void => {
    stopAudio();
    if (action === null || !sfx || action.audioUrl === '') return;
    const token = ++audioTokenRef.current;
    setAudioPending(true);
    void fetch(action.audioUrl)
      .then((response) => { if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.blob(); })
      .then((blob) => {
        if (token !== audioTokenRef.current) return;
        const url = URL.createObjectURL(blob);
        audioObjectUrlRef.current = url;
        const audio = new Audio(url);
        audio.hidden = true;
        audio.volume = 0.8;
        document.body.appendChild(audio);
        audio.addEventListener('error', () => {
          if (audioRef.current === audio) { audioRef.current = null; setAudioPending(false); }
        });
        audio.addEventListener('ended', () => {
          if (audioRef.current === audio && !pausedRef.current) void audio.play().catch(() => undefined);
        });
        audioRef.current = audio;
        setAudioPending(false);
        if (!pausedRef.current) void audio.play().catch(() => undefined);
      })
      .catch(() => { if (token === audioTokenRef.current) setAudioPending(false); });
  }, [sfx, stopAudio]);

  const seekAudioToFrame = useCallback((target: number, action: PetStudioAction | null): void => {
    const audio = audioRef.current;
    if (audio === null || action === null) return;
    const time = target / Math.max(1, action.sampleFps);
    try {
      audio.currentTime = Number.isFinite(audio.duration) && audio.duration > 0 ? Math.min(time, audio.duration - 0.01) : time;
    } catch { /* 元数据未就绪前忽略 */ }
  }, []);

  const selectAction = useCallback((action: PetStudioAction | null, resetView = true): void => {
    if (action === null) return;
    if (resetView) {
      setFrame(0);
      setPaused(false);
    }
    setSelected(action);
    stopAudio(); // 旧声音先停；新音频等精灵图就绪后与动画同时起播
  }, [stopAudio]);

  // 切角色 = 换整套动作库（上游 selectPet 语义）：清搜索、选该角色 idleAnimationId
  useEffect(() => {
    if (catalog === null) return;
    if (appliedCharacterRef.current === characterId) return;
    appliedCharacterRef.current = characterId;
    setQuery('');
    if (currentSlug !== '' && currentPack !== undefined) {
      setScope('character');
      const idle = catalog.actions.find((action) => action.slug === currentSlug && action.clipId === currentPack.idleClipId)
        ?? catalog.actions.find((action) => action.slug === currentSlug)
        ?? null;
      if (idle !== null) selectAction(idle);
      return;
    }
    // 当前角色没有随包精灵动作（如内置小鲸）：显示全部 9 包，但不冒充它的动作
    setScope('all');
    const first = catalog.actions[0] ?? null;
    if (first !== null) selectAction(first);
  }, [catalog, characterId, currentSlug, currentPack, selectAction]);

  // 切动作：加载精灵图；图就绪后起播音频（声画一起从 0 开始）
  useEffect(() => {
    setFrame(0);
    if (selected === null || selected.spriteUrl === '') {
      setImage(null);
      return undefined;
    }
    let cancelled = false;
    const img = new Image();
    img.onload = () => { if (!cancelled) setImage(img); };
    img.onerror = () => { if (!cancelled) { setImage(null); toast.error(`精灵图加载失败：${selected.clipId}`); } };
    img.src = selected.spriteUrl;
    return () => { cancelled = true; };
  }, [selected]);

  useEffect(() => {
    if (image !== null && selected !== null) startAudio(selected);
    return () => stopAudio();
  }, [image, selected, startAudio, stopAudio]);

  // 暂停/恢复：音频与动画一起停/走
  useEffect(() => {
    const audio = audioRef.current;
    if (audio === null) return;
    if (paused) audio.pause();
    else void audio.play().catch(() => undefined);
  }, [paused]);

  const getAudioFrame = useCallback((): number | null => {
    const audio = audioRef.current;
    if (audio === null || selected === null || audio.paused || audio.currentTime <= 0) return null;
    if (audioPending) return null;
    return Math.floor(audio.currentTime * selected.sampleFps) % Math.max(1, selected.frameCount);
  }, [audioPending, selected]);

  const moveAction = useCallback((delta: number): void => {
    if (filteredActions.length === 0) return;
    const index = selected === null ? -1 : filteredActions.findIndex((action) => action.clipId === selected.clipId && action.slug === selected.slug);
    const next = filteredActions[(index + delta + filteredActions.length) % filteredActions.length];
    if (next !== undefined) selectAction(next);
  }, [filteredActions, selectAction, selected]);

  const stepFrame = useCallback((delta: number): void => {
    if (selected === null) return;
    setPaused(true);
    setFrame((prev) => {
      const count = Math.max(1, selected.frameCount);
      const next = (prev + delta + count) % count;
      seekAudioToFrame(next, selected);
      return next;
    });
  }, [seekAudioToFrame, selected]);

  const scrubTo = useCallback((target: number): void => {
    if (selected === null) return;
    setPaused(true);
    setFrame(target);
    seekAudioToFrame(target, selected);
  }, [seekAudioToFrame, selected]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      if (target !== null && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      if (event.code === 'Space') { event.preventDefault(); setPaused((prev) => !prev); }
      else if (event.key === 'ArrowLeft') { event.preventDefault(); stepFrame(-1); }
      else if (event.key === 'ArrowRight') { event.preventDefault(); stepFrame(1); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); moveAction(-1); }
      else if (event.key === 'ArrowDown') { event.preventDefault(); moveAction(1); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [moveAction, stepFrame]);

  const slotOfSelected = useMemo<PetStudioSlot | undefined>(() => {
    if (selected === null || catalog === null) return undefined;
    return catalog.slots.find((slot) => slot.packId === selected.packId && slot.clipIds.includes(selected.clipId));
  }, [catalog, selected]);

  // 只有「当前角色自己的动作」才能推给桌面：桌面主宠显示的是全局选中角色，
  // 把别的角色的 clipId 推过去会落到错误 manifest（上游同样按角色隔离动作库）。
  const canPushToDesktop = selected !== null && scope === 'character' && hasOwnPack && selected.slug === currentSlug;
  const pushToDesktop = async (): Promise<void> => {
    if (selected === null) return;
    if (!canPushToDesktop) {
      toast.error('先切到该角色的桌宠（动作库=当前角色）再试播，避免把别的角色的动作推到桌面');
      return;
    }
    const slot = slotOfSelected?.slot ?? 'idle';
    const result = await window.directorBridge.petsPreview(slot, selected.clipId);
    if (result.ok) toast.success(`已推送到桌面桌宠试播：${selected.clipId}（${SLOT_LABELS[slot] ?? slot}）`);
    else toast.error('推送失败：桌面桌宠未就绪');
  };

  // 导出：按该动作自己的帧尺寸与 fps 录制完整一轮（与上游 canvas-record 语义一致）
  const exportWebm = async (): Promise<void> => {
    if (selected === null || image === null) { toast.error('请先选择一个动作并等待精灵图加载'); return; }
    const canvas = document.querySelector<HTMLCanvasElement>('[data-preview-canvas]');
    if (canvas === null) { toast.error('预览画布未就绪'); return; }
    setExporting(true);
    const wasPaused = paused;
    stopAudio(); // 录制静音，按帧时钟走完整一轮
    setFrame(0);
    setPaused(false);
    try {
      const stream = canvas.captureStream(selected.sampleFps);
      const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm';
      const recorder = new MediaRecorder(stream, { mimeType });
      const chunks: Blob[] = [];
      recorder.ondataavailable = (event) => { if (event.data.size > 0) chunks.push(event.data); };
      const done = new Promise<Blob>((resolve) => { recorder.onstop = () => resolve(new Blob(chunks, { type: 'video/webm' })); });
      recorder.start();
      await new Promise((resolve) => setTimeout(resolve, Math.max(500, (selected.frameCount / Math.max(1, selected.sampleFps)) * 1000)));
      recorder.stop();
      stream.getTracks().forEach((track) => track.stop());
      const blob = await done;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${selected.slug}-${selected.clipId}.webm`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      toast.success(`已导出 ${selected.slug}-${selected.clipId}.webm（${selected.frameWidth}×${selected.frameHeight} · ${Math.round(blob.size / 1024)} KB）`);
    } catch (reason) {
      toast.error(`导出失败：${reason instanceof Error ? reason.message : String(reason)}`);
    } finally {
      setExporting(false);
      setPaused(wasPaused);
      if (image !== null) startAudio(selected);
    }
  };

  const totalSeconds = selected === null ? 0 : selected.frameCount / Math.max(1, selected.sampleFps);
  const selectedPackLabel = catalog?.packs.find((pack) => pack.slug === selected?.slug)?.displayName ?? selected?.displayName ?? '';

  return (
    <div data-pet-library data-action-scope={activeSlug === '' ? 'all' : 'character'}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="seg-tabs">
          {([
            ['actions', `动作库 (${scopedActions.length})`],
            ['slots', '11 语义槽位映射'],
            ['skins', `CrossPet 皮肤与彩蛋 (${catalog?.skins.length ?? 0})`],
          ] as Array<[LibTab, string]>).map(([id, label]) => (
            <button key={id} data-lib-tab={id} className={`seg-tab${libTab === id ? ' on' : ''}`} onClick={() => setLibTab(id)}>{label}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          {onOpenCreator !== undefined && <button className="btn-pill primary" data-open-creator onClick={onOpenCreator}><Clapperboard size={12} />创作中心</button>}
          {onOpenBench !== undefined && <button className="btn-pill ghost" data-open-bench onClick={onOpenBench}>验收台</button>}
          <button className="btn-pill ghost" disabled={exporting} onClick={() => void exportWebm()}>
            <Download size={12} />{exporting ? '录制中…' : '导出 WebM'}
          </button>
          <button
            className="btn-pill primary"
            data-push-preview
            data-push-enabled={canPushToDesktop ? 'true' : 'false'}
            disabled={!canPushToDesktop}
            title={canPushToDesktop ? '推送到桌面桌宠' : '当前视图是别的角色的动作；先切到该角色'}
            onClick={() => void pushToDesktop()}
          >
            <Send size={12} />推到桌面桌宠试播
          </button>
        </div>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2 text-[11px]" style={{ color: 'var(--text-2)' }}>
        <span style={{ color: 'var(--text-3)' }}>动作库范围：</span>
        <button
          type="button"
          data-action-scope-btn="character"
          disabled={!hasOwnPack}
          title={hasOwnPack ? `只看「${characterName}」自己的动作` : '当前角色没有随包精灵动作；请选 9 角色之一'}
          className={`seg-tab${scope === 'character' && hasOwnPack ? ' on' : ''}`}
          style={!hasOwnPack ? { opacity: 0.45, cursor: 'not-allowed' } : undefined}
          onClick={() => {
            setScope('character');
            setQuery('');
            const idle = catalog?.actions.find((action) => action.slug === currentSlug && action.clipId === currentPack?.idleClipId)
              ?? catalog?.actions.find((action) => action.slug === currentSlug)
              ?? null;
            selectAction(idle);
          }}
        >
          当前角色 · {currentPack?.actionCount ?? 0}
        </button>
        <button
          type="button"
          data-action-scope-btn="all"
          className={`seg-tab${activeSlug === '' ? ' on' : ''}`}
          onClick={() => { setScope('all'); setQuery(''); setPackFilter(''); }}
        >
          全部 9 包 · {catalog?.actions.length ?? 0}
        </button>
        {activeSlug !== '' && (
          <span className="pill pill-blue" style={{ fontSize: 10 }}>{selectedPackLabel || activeSlug} · {currentPack?.audioClipCount ?? 0} 条原声</span>
        )}
        <span className="ml-auto mono" data-action-count={scopedActions.length} style={{ color: 'var(--text-3)' }}>
          {filteredActions.length === scopedActions.length ? `${scopedActions.length} 个动作` : `${filteredActions.length} / ${scopedActions.length} 个动作`}
        </span>
      </div>

      {(error !== null) && (
        <div className="card mb-3 px-4 py-2 text-xs" style={{ color: 'var(--amber)' }}>
          {error} · 先运行 <span className="mono">pnpm sync:pet-packs</span>
        </div>
      )}

      <div className="grid items-start gap-4" style={{ gridTemplateColumns: 'minmax(430px, 1.08fr) 1fr' }}>
        <div>
          <div
            className="relative mb-2 overflow-hidden"
            style={{
              borderRadius: 'var(--r-xl)',
              border: '1px solid var(--stroke-2)',
              aspectRatio: '16 / 9',
              backgroundImage: 'linear-gradient(45deg, rgba(148,163,184,.12) 25%, transparent 25%), linear-gradient(-45deg, rgba(148,163,184,.12) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, rgba(148,163,184,.12) 75%), linear-gradient(-45deg, transparent 75%, rgba(148,163,184,.12) 75%)',
              backgroundSize: '20px 20px',
              backgroundPosition: '0 0, 0 10px, 10px -10px, -10px 0',
              backgroundColor: 'var(--inset)',
            }}
          >
            {selected !== null && (
              <FrameCanvas
                image={image}
                columns={selected.columns}
                rows={selected.rows}
                frameCount={selected.frameCount}
                frameWidth={selected.frameWidth}
                frameHeight={selected.frameHeight}
                fps={selected.sampleFps}
                paused={paused}
                audioPending={audioPending}
                frame={frame}
                onFrame={setFrame}
                getAudioFrame={getAudioFrame}
              />
            )}
            <div className="absolute left-3 top-2.5 flex flex-wrap gap-1.5">
              <span className="pill pill-blue" style={{ fontSize: 10 }}>{selectedPackLabel || characterName} · {selected?.packId ?? '—'}</span>
              <span className="pill pill-violet" style={{ fontSize: 10 }}>{selected?.hasAudio === true ? '原生音轨 .m4a' : '无原生音轨'}</span>
            </div>
            <div className="absolute right-3 top-2.5">
              <span className="pill mono" style={{ fontSize: 10 }}>{selected?.sampleFps ?? 12} FPS · {selected?.frameWidth ?? 640}×{selected?.frameHeight ?? 360}</span>
            </div>
          </div>

          <div className="card flex flex-col gap-2.5 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <button className="btn-pill primary" data-player-toggle onClick={() => setPaused((prev) => !prev)}>
                {paused ? <Play size={12} /> : <Pause size={12} />}{paused ? '播放' : '暂停'}
              </button>
              <button className="btn-pill ghost" onClick={() => stepFrame(-1)}><SkipBack size={12} />上一帧</button>
              <button className="btn-pill ghost" onClick={() => stepFrame(1)}><SkipForward size={12} />下一帧</button>
              <button className="btn-pill ghost" onClick={() => moveAction(-1)}><ArrowUp size={12} />上一动作</button>
              <button className="btn-pill ghost" onClick={() => moveAction(1)}><ArrowDown size={12} />下一动作</button>
              <label className="ml-auto flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--text-2)' }}>
                <span>动作原声</span>
                <input type="checkbox" data-sfx-toggle checked={sfx} onChange={(event) => setSfx(event.target.checked)} />
              </label>
            </div>
            <div className="flex items-center gap-2.5 text-[11px] mono" style={{ color: 'var(--text-2)' }}>
              <span data-frame-label>{String(frame + 1).padStart(2, '0')} / {selected?.frameCount ?? 0}</span>
              <input
                type="range"
                className="flex-1"
                aria-label="帧进度"
                min={0}
                max={Math.max(0, (selected?.frameCount ?? 1) - 1)}
                value={frame}
                onChange={(event) => scrubTo(Number(event.target.value))}
              />
              <span>{(frame / Math.max(1, selected?.sampleFps ?? 12)).toFixed(2)}s / {totalSeconds.toFixed(2)}s</span>
            </div>
            <div className="text-[11.5px]" style={{ color: 'var(--text-2)' }}>
              槽位：<b className="mono">{slotOfSelected?.slot ?? '—'}</b>（{SLOT_LABELS[slotOfSelected?.slot ?? ''] ?? '未映射'}）
              · 分类：{selected?.category ?? '—'}
              · 网格：<span className="mono">{selected?.columns ?? 0}×{selected?.rows ?? 0}</span>
              · 快捷键：<span className="mono">Space / ←→ / ↑↓</span>
            </div>
          </div>
        </div>

        <div>
          <div className="mb-2.5 flex items-center gap-2 rounded-full px-3 py-1.5" style={{ border: '1px solid var(--stroke-2)', background: 'var(--surface)' }}>
            <Search size={13} style={{ color: 'var(--text-3)' }} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={activeSlug === '' ? '搜索动作名 / 分类（全部 9 包）…' : `在「${selectedPackLabel || characterName}」内搜索动作 / 分类…`}
              className="flex-1 bg-transparent text-[12.5px] outline-none"
              style={{ color: 'var(--text-1)' }}
            />
            {activeSlug !== '' && (
              <span className="pill mono" style={{ fontSize: 9.5 }}>{selectedPackLabel || activeSlug}</span>
            )}
            <select
              value={packFilter}
              onChange={(event) => { setPackFilter(event.target.value); setScope('all'); }}
              className="rounded-full px-2 py-0.5 text-[11px] outline-none"
              style={{ border: '1px solid var(--stroke)', background: 'var(--inset)', color: 'var(--text-2)' }}
            >
              <option value="">全部 9 包</option>
              {(catalog?.packs ?? []).map((pack) => <option key={pack.slug} value={pack.slug}>{pack.displayName}（{pack.actionCount}）</option>)}
            </select>
          </div>

          {libTab === 'actions' && (
            <div className="max-h-[560px] space-y-1.5 overflow-y-auto pr-1" data-action-groups>
              {groupedActions.map(([category, actions]) => (
                <details key={category} open className="rounded-lg" style={{ border: '1px solid var(--stroke)', background: 'var(--surface)' }} data-action-category={category}>
                  <summary className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-[12px] font-semibold" style={{ color: 'var(--text-1)' }}>
                    <span>{category}</span>
                    <span className="mono text-[10px]" style={{ color: 'var(--text-3)' }}>{actions.length}</span>
                  </summary>
                  <div className="grid gap-1.5 px-2 pb-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))' }}>
                    {actions.map((action) => {
                      const active = selected?.clipId === action.clipId && selected.slug === action.slug;
                      return (
                        <button
                          key={`${action.slug}:${action.clipId}`}
                          data-action-item={action.clipId}
                          data-action-pack={action.slug}
                          data-selected={active ? 'true' : 'false'}
                          onClick={() => selectAction(action)}
                          className="card card-hover px-3 py-2 text-left"
                          style={active ? { borderColor: 'var(--blue-line)', background: 'var(--blue-dim)' } : undefined}
                        >
                          <div className="truncate text-[12px] font-semibold" style={{ color: active ? 'var(--blue)' : 'var(--text-1)' }}>{action.clipId}</div>
                          <div className="mt-0.5 flex items-center gap-1.5 text-[10px]" style={{ color: 'var(--text-3)' }}>
                            <span>{action.category}</span>
                            <span>· {action.frameCount} 帧</span>
                            <span>· {action.columns}×{action.rows}</span>
                            {action.hasAudio && <span>· ♪</span>}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </details>
              ))}
              {groupedActions.length === 0 && (
                <div className="p-4 text-center text-xs" style={{ color: 'var(--text-3)' }}>
                  {scopedActions.length === 0
                    ? '当前角色没有随包精灵动作：点上方「全部 9 包」或切换到 9 角色之一。'
                    : '没有匹配动作'}
                </div>
              )}
            </div>
          )}

          {libTab === 'slots' && (
            <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))' }} data-slot-grid>
              {filteredSlots.map((slot) => (
                <div key={`${slot.packId}:${slot.slot}`} data-slot-card={slot.slot} className="card p-3">
                  <div className="text-[12px] font-semibold">{SLOT_LABELS[slot.slot] ?? slot.slot} <span className="mono" style={{ color: 'var(--text-3)' }}>{slot.slot}</span></div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {slot.clipIds.map((clipId) => (
                      <button
                        key={clipId}
                        className="rounded-full px-2 py-0.5 text-[10.5px]"
                        style={{ border: '1px solid var(--stroke)', color: 'var(--text-2)' }}
                        onClick={() => {
                          const action = catalog?.actions.find((item) => item.clipId === clipId && item.packId === slot.packId);
                          if (action !== undefined) selectAction(action);
                        }}
                      >
                        {clipId}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
              {filteredSlots.length === 0 && <div className="p-4 text-center text-xs" style={{ color: 'var(--text-3)' }}>没有匹配槽位</div>}
            </div>
          )}

          {libTab === 'skins' && (
            <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))' }}>
              {filteredSkins.map((skin: PetStudioSkin) => (
                <div key={skin.id} data-skin-item={skin.id} className="card flex items-center gap-2.5 p-2.5">
                  {skin.previewUrl !== ''
                    ? <img src={skin.previewUrl} alt={skin.name} style={{ width: 44, height: 44, objectFit: 'cover', borderRadius: 10 }} />
                    : <div className="grid h-11 w-11 place-items-center rounded-xl" style={{ background: 'var(--inset)' }}><Clapperboard size={16} style={{ color: 'var(--text-3)' }} /></div>}
                  <div className="min-w-0">
                    <div className="truncate text-[12px] font-semibold">{skin.name}</div>
                    <div className="text-[10px]" style={{ color: 'var(--text-3)' }}>
                      {skin.kind === 'egg' ? '串门彩蛋' : skin.kind === 'skin' ? '换装皮肤' : '基础角色'} · {skin.outfit || skin.id}
                    </div>
                  </div>
                </div>
              ))}
              {filteredSkins.length === 0 && <div className="p-4 text-center text-xs" style={{ color: 'var(--text-3)' }}>没有匹配皮肤/彩蛋</div>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function slugOf(characterId: string): string {
  // aboutme-<slug> → <slug>；内置小鲸没有随包 slug
  return characterId.startsWith('aboutme-') ? characterId.slice('aboutme-'.length) : '';
}
