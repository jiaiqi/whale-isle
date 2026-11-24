/**
 * 桌宠创作中心（T-M6-53，对齐 design/pet-stage.html）：
 * A AI 角色/皮肤生图提示词 · B AI 彩蛋生成器（5 态台词）· C 自定义建角与拖入处理。
 * 零 emoji；所有数据经真实 IPC，不伪造「已出图/已保存」。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CheckCheck, Copy, FolderOpen, ImagePlus, Layers, Link2, RefreshCw, Sparkles, UploadCloud, Wand2, X, Zap } from 'lucide-react';
import { toast } from 'sonner';
import type { ModelProviderConfig, StardewSpriteTier } from '@workbench/shared-protocol';
import type { DirectorStore } from '@workbench/local-store/dexie';
import { CUSTOM_KEY, type CustomProviderRecord } from '../providers/catalog';

type CreatorTab = 'char' | 'egg' | 'import' | 'pixel';
type TierId = 'A' | 'B' | 'C' | 'MEME';
type SpritePreviewMode = 'walk' | 'idle' | 'action' | 'emote';

const STARDEW_SPRITE_TIERS: Array<{
  tier: StardewSpriteTier;
  title: string;
  badge: string;
  spec: string;
  desc: string;
}> = [
  {
    tier: '2x',
    title: '2× 精致像素',
    badge: '推荐',
    spec: '192×256 · 每帧 32×64',
    desc: '64 色锐利像素，五官与发饰清晰，最贴合星露谷画风',
  },
  {
    tier: '4x',
    title: '4× 高清 Q 版',
    badge: '细腻',
    spec: '384×512 · 每帧 64×128',
    desc: '全彩平滑下采样，接近桌宠立绘质感，细节最丰富',
  },
  {
    tier: '1x',
    title: '1× 原版像素',
    badge: '复古',
    spec: '96×128 · 每帧 16×32',
    desc: '24 色经典硬边像素，与原版农夫 1:1 像素密度',
  },
];

interface ImageProviderView {
  id: string;
  name: string;
  protocol: 'openai' | 'gemini' | 'codex-cli';
  baseUrl: string;
  models: string[];
}

interface CodexInfoView {
  detected: boolean;
  backend: 'codex-imagegen' | 'codex-exec' | null;
  loggedIn: boolean;
  installHint: string;
  loginHint: string;
}

interface GenItemView {
  pose: string;
  status: 'queued' | 'generating' | 'done' | 'failed';
  dataUrl?: string;
  file?: string;
  error?: string;
}

const EGG_IMAGE_POSES = ['pop', 'pretend', 'caught', 'bye', 'escape'] as const;

const inputStyle: React.CSSProperties = { border: '1px solid var(--stroke)', background: 'var(--inset)', color: 'var(--text-1)', borderRadius: 8 };
const labelStyle: React.CSSProperties = { fontSize: 11, color: 'var(--text-2)' };

let eggSeq = 0;
function nextEggId(): string {
  eggSeq += 1;
  return `egg-custom-${Date.now().toString(36)}-${eggSeq}`;
}

export function CreatorCenter(props: {
  open: boolean;
  onClose: () => void;
  characterId: string;
  characterName: string;
  onReloaded: () => void;
  /** 打开时自动切到指定页签（如从星露谷共玩页直达 pixel） */
  initialTab?: CreatorTab;
  /** 已同步到主脑的供应商配置（渲染层只上送非敏感描述，Key 留在主进程 vault） */
  providers?: ModelProviderConfig[];
  /** 读取自定义服务商（Dexie customProviders） */
  store?: DirectorStore;
  /** 未配置生图供应商时一键跳「模型服务商」 */
  onOpenProviders?: () => void;
}): React.JSX.Element | null {
  const { open, onClose, characterId, characterName, onReloaded, initialTab, providers = [], store, onOpenProviders } = props;
  const [tab, setTab] = useState<CreatorTab>(initialTab ?? 'char');
  useEffect(() => {
    if (open && initialTab !== undefined) setTab(initialTab);
  }, [open, initialTab]);
  const [tiers, setTiers] = useState<Array<{ id: TierId; label: string; count: number; poses: Array<{ id: string; hint: string }> }>>([]);
  const [locks, setLocks] = useState<Array<{ id: string; label: string; reference: string; traits: string }>>([]);
  const [lock, setLock] = useState('deepseek');
  const [customName, setCustomName] = useState('');
  const [customTraits, setCustomTraits] = useState('');
  const [selectedTiers, setSelectedTiers] = useState<TierId[]>(['A', 'MEME']);
  const [charPrompt, setCharPrompt] = useState('');
  const [eggMode, setEggMode] = useState<'cosplay' | 'prank'>('cosplay');
  const [guest, setGuest] = useState('deepseek');
  const [host, setHost] = useState('claude');
  const [eggPrompt, setEggPrompt] = useState('');
  const [eggId, setEggId] = useState(() => nextEggId());
  const [eggName, setEggName] = useState('串门彩蛋');
  const [eggLines, setEggLines] = useState<Record<string, string[]> | null>(null);
  const [eggBusy, setEggBusy] = useState(false);
  const [importId, setImportId] = useState('my-character');
  const [importName, setImportName] = useState('');
  const [reactTo, setReactTo] = useState('*');
  const [longThinkAfter, setLongThinkAfter] = useState(20);
  const [longThinkPose, setLongThinkPose] = useState('deepthink');
  const [correctedPose, setCorrectedPose] = useState('sorry');
  const [fxText, setFxText] = useState('thinking: bubbles, proud: victory');
  const [images, setImages] = useState<string[]>([]);
  const [folder, setFolder] = useState('');
  const [importBusy, setImportBusy] = useState(false);
  const [importResult, setImportResult] = useState<{ poses: string[]; warnings: string[] } | null>(null);
  const [cloneId, setCloneId] = useState('deepseek-mine');
  const [cloneName, setCloneName] = useState('');
  const [cloneBuiltinId, setCloneBuiltinId] = useState('crosspet-deepseek');
  const [customList, setCustomList] = useState<Array<{ id: string; name: string; poses: string[] }>>([]);
  const [pixelCharacterId, setPixelCharacterId] = useState(characterId);
  const [pixelCharacters, setPixelCharacters] = useState<Array<{ id: string; displayName: string }>>([]);
  const [pixelTier, setPixelTier] = useState<StardewSpriteTier>('2x');
  const [pixelPrompt, setPixelPrompt] = useState('');
  const [pixelDataUrl, setPixelDataUrl] = useState('');
  const [pixelMeta, setPixelMeta] = useState<{ width?: number; height?: number; tier?: StardewSpriteTier; hasRaw?: boolean }>({});
  const [pixelEmptyCells, setPixelEmptyCells] = useState(-1); // -1 = 从磁盘读取的旧图，空格数未知，不臆造「全满」
  const [pixelBusy, setPixelBusy] = useState(false);
  const [pixelReprocessing, setPixelReprocessing] = useState(false);
  const [pixelSpriteReady, setPixelSpriteReady] = useState(false);
  const [pixelPreviewMode, setPixelPreviewMode] = useState<SpritePreviewMode>('walk');
  const [pixelAutoRef, setPixelAutoRef] = useState<{ dataUrl: string; label: string } | null>(null);
  const [renameTarget, setRenameTarget] = useState('');
  const [renameName, setRenameName] = useState('');
  const [imageProviders, setImageProviders] = useState<ImageProviderView[]>([]);
  const [imageProviderStats, setImageProviderStats] = useState({ detected: 0, configured: 0 });
  const [codexInfo, setCodexInfo] = useState<CodexInfoView | null>(null);
  const [imageProviderId, setImageProviderId] = useState('');
  const [imageModelId, setImageModelId] = useState('');
  const [referenceImage, setReferenceImage] = useState('');
  const [genJobId, setGenJobId] = useState('');
  const [genItems, setGenItems] = useState<GenItemView[]>([]);
  const [genBusy, setGenBusy] = useState(false);
  const genJobRef = useRef('');
  const dropRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    void window.directorBridge.creatorListCustom().then(setCustomList).catch(() => setCustomList([]));
    void window.directorBridge.creatorPoseTiers().then((data) => {
      setTiers(data.tiers as never);
      setLocks(data.locks);
      if (data.locks.length > 0) {
        setGuest(data.locks[0]!.id);
        setHost(data.locks[1]?.id ?? data.locks[0]!.id);
      }
    }).catch(() => undefined);
  }, [open]);

  /** 组装非敏感供应商描述：内置 + Dexie 自定义（只上送端点/模型候选，Key 永不进渲染进程）。 */
  const imageDescriptors = useCallback(async (): Promise<Array<{ id: string; name: string; baseUrl: string; protocol: 'openai' | 'gemini'; candidateModels: string[] }>> => {
    const list: Array<{ id: string; name: string; baseUrl: string; protocol: 'openai' | 'gemini'; candidateModels: string[] }> = [];
    const imageish = (ids: string[]): string[] => ids.filter((id) => /image|dall-e|imagen/i.test(id));
    for (const provider of providers) {
      const variant = provider.variants.find((entry) => entry.region === provider.activeRegion && entry.planType === provider.activePlanType) ?? provider.variants[0];
      if (variant === undefined) continue;
      const nativeGemini = /gemini|google|generativelanguage/i.test(`${provider.id} ${provider.name} ${variant.baseUrl}`);
      list.push({
        id: provider.id,
        name: provider.name,
        baseUrl: variant.baseUrl,
        protocol: nativeGemini ? 'gemini' : 'openai',
        candidateModels: imageish(provider.discoveredModels.map((model) => model.id).concat(provider.activeModelId)),
      });
    }
    if (store !== undefined) {
      const customs = await store.getConfig<CustomProviderRecord[]>(CUSTOM_KEY).catch(() => undefined);
      for (const custom of customs ?? []) {
        if (!custom.enabled) continue;
        const variant = custom.variants[0];
        if (variant === undefined) continue;
        const nativeGemini = /gemini|google|generativelanguage/i.test(`${custom.id} ${custom.name} ${variant.baseUrl}`);
        list.push({
          id: custom.id,
          name: custom.name,
          baseUrl: variant.baseUrl,
          protocol: nativeGemini ? 'gemini' : 'openai',
          candidateModels: imageish(custom.models.filter((model) => model.enabled).map((model) => model.id)),
        });
      }
    }
    return list;
  }, [providers, store]);

  useEffect(() => {
    if (!open) return;
    void (async () => {
      try {
        const result = await window.directorBridge.creatorImageGenProviders(await imageDescriptors());
        const next = result.providers ?? [];
        setImageProviders(next);
        setImageProviderStats({ detected: result.detected ?? next.length, configured: result.configured ?? next.length });
        setCodexInfo(result.codex ?? null);
        const first = next[0];
        if (first !== undefined) {
          setImageProviderId((prev) => (next.some((entry) => entry.id === prev) ? prev : first.id));
          setImageModelId((prev) => (prev !== '' && next.some((entry) => entry.models.includes(prev)) ? prev : first.models[0] ?? ''));
        } else {
          setImageProviderId('');
          setImageModelId('');
        }
      } catch {
        setImageProviders([]);
        setImageProviderStats({ detected: 0, configured: 0 });
      }
    })();
  }, [open, imageDescriptors]);

  useEffect(() => {
    if (!open) return undefined;
    // 进度事件按 jobId 过滤：上一次任务的迟到事件绝不能污染当前网格
    return window.directorBridge.onCreatorGenProgress((progress) => {
      if (progress.jobId !== genJobRef.current) return;
      setGenItems((prev) => prev.map((item) => (item.pose === progress.pose
        ? {
          ...item,
          status: progress.status,
          ...(progress.dataUrl === undefined ? {} : { dataUrl: progress.dataUrl }),
          ...(progress.file === undefined ? {} : { file: progress.file }),
          ...(progress.error === undefined ? {} : { error: progress.error }),
        }
        : item)));
    });
  }, [open]);

  // T-M6-62：像素表角色清单（内置 9 角色 + 默认小鲸 + 自定义角色）；优先默认到游戏内已同步角色
  const [pixelSynced, setPixelSynced] = useState<{ id: string; displayName: string } | null>(null);
  useEffect(() => {
    if (!open) return;
    void Promise.all([
      window.directorBridge.characterList(),
      window.directorBridge.stardewAvatarState().catch(() => null),
    ]).then(([list, avatar]) => {
      const eligible = list.filter((entry) => entry.id === 'blue-whale-maid' || entry.id.startsWith('aboutme-') || entry.id.startsWith('custom-'));
      setPixelCharacters(eligible);
      setPixelSynced(avatar?.syncedCharacterId == null
        ? null
        : { id: avatar.syncedCharacterId, displayName: avatar.syncedDisplayName ?? avatar.syncedCharacterId });
      // 默认目标 = 当前桌宠（它是同步的主状态），不是游戏里上一次的临时覆盖
      const preferred = [characterId, avatar?.syncedCharacterId ?? null]
        .find((id) => id !== null && eligible.some((entry) => entry.id === id)) ?? null;
      setPixelCharacterId(preferred ?? eligible[0]?.id ?? characterId);
    }).catch(() => setPixelCharacters([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open || tab !== 'pixel' || pixelCharacterId === '') return;
    const name = pixelCharacters.find((entry) => entry.id === pixelCharacterId)?.displayName ?? pixelCharacterId;
    void window.directorBridge.creatorCompileStardewSprite({ name, characterId: pixelCharacterId, tier: pixelTier })
      .then((result) => setPixelPrompt(result.prompt))
      .catch(() => undefined);
  }, [open, tab, pixelCharacterId, pixelCharacters, pixelTier]);

  useEffect(() => {
    if (!open || tab !== 'pixel' || pixelCharacterId === '') return;
    void window.directorBridge.creatorCharacterReference(pixelCharacterId)
      .then((result) => {
        if (result.ok && result.dataUrl !== undefined) setPixelAutoRef({ dataUrl: result.dataUrl, label: result.label ?? '角色默认立绘' });
        else setPixelAutoRef(null);
      })
      .catch(() => setPixelAutoRef(null));
    void window.directorBridge.creatorStardewSpriteGet(pixelCharacterId).then((result) => {
      setPixelDataUrl(result.ok && result.dataUrl !== undefined ? result.dataUrl : '');
      setPixelSpriteReady(result.ok === true);
      setPixelEmptyCells(-1);
      setPixelMeta({
        ...(result.width === undefined ? {} : { width: result.width }),
        ...(result.height === undefined ? {} : { height: result.height }),
        ...(result.tier === undefined ? {} : { tier: result.tier }),
        ...(result.hasRaw === undefined ? {} : { hasRaw: result.hasRaw }),
      });
      if (result.ok && (result.tier === '2x' || result.tier === '4x')) setPixelTier(result.tier);
    }).catch(() => {
      setPixelDataUrl('');
      setPixelSpriteReady(false);
      setPixelMeta({});
    });
  }, [open, tab, pixelCharacterId]);

  const generatePixelSprite = async (): Promise<void> => {
    if (selectedImageProvider === null || imageModelId === '') {
      toast.error('未配置可用的生图供应商/模型：请先在「模型服务商」保存 Key，或使用本机 Codex CLI');
      return;
    }
    if (pixelCharacterId === '') { toast.error('先选择要生成精灵表的角色'); return; }
    setPixelBusy(true);
    try {
      const result = await window.directorBridge.creatorGenerateStardewSprite({
        characterId: pixelCharacterId,
        tier: pixelTier,
        provider: {
          id: selectedImageProvider.id,
          name: selectedImageProvider.name,
          baseUrl: selectedImageProvider.baseUrl,
          protocol: selectedImageProvider.protocol,
          candidateModels: selectedImageProvider.models,
        },
        modelId: imageModelId,
        ...(referenceImage === '' ? {} : { referenceImagePath: referenceImage }),
        ...(pixelPrompt.trim() === '' ? {} : { prompt: pixelPrompt }),
      });
      if (!result.ok) { toast.error(result.error ?? '精灵表生成失败'); return; }
      setPixelDataUrl(result.dataUrl ?? '');
      setPixelEmptyCells(result.emptyCells ?? 0);
      setPixelSpriteReady(true);
      setPixelMeta({
        ...(result.width === undefined ? {} : { width: result.width }),
        ...(result.height === undefined ? {} : { height: result.height }),
        ...(result.tier === undefined ? {} : { tier: result.tier }),
        hasRaw: result.hasRaw === true,
      });
      const sizeText = result.width !== undefined && result.height !== undefined ? `${result.width}×${result.height}` : pixelTier;
      toast.success(`精灵表已生成（${sizeText}，${result.emptyCells ?? 0} 个空格）并保留原图；点「一键应用到星露谷」生效`);
    } finally {
      setPixelBusy(false);
    }
  };

  const reprocessPixelSprite = async (targetTier: StardewSpriteTier): Promise<void> => {
    if (pixelCharacterId === '') return;
    setPixelReprocessing(true);
    try {
      const result = await window.directorBridge.creatorReprocessStardewSprite({
        characterId: pixelCharacterId,
        tier: targetTier,
      });
      if (!result.ok) { toast.error(result.error ?? '重切清晰度失败'); return; }
      setPixelDataUrl(result.dataUrl ?? '');
      setPixelEmptyCells(result.emptyCells ?? 0);
      setPixelSpriteReady(true);
      setPixelMeta({
        ...(result.width === undefined ? {} : { width: result.width }),
        ...(result.height === undefined ? {} : { height: result.height }),
        ...(result.tier === undefined ? {} : { tier: result.tier }),
        hasRaw: true,
      });
      const spec = STARDEW_SPRITE_TIERS.find((entry) => entry.tier === targetTier);
      toast.success(`已从原图秒切至 ${spec?.title ?? targetTier}（${result.width ?? ''}×${result.height ?? ''}），点「一键应用到星露谷」即可热更新`);
    } finally {
      setPixelReprocessing(false);
    }
  };

  const applyPixelSprite = async (): Promise<void> => {
    const result = await window.directorBridge.stardewAvatarApplyCharacter(pixelCharacterId);
    if (!result.ok) { toast.error(result.error ?? '应用失败'); return; }
    // 应用后重新读取角色目录里的真实文件，避免预览停留在应用前的旧图
    const refreshed = await window.directorBridge.creatorStardewSpriteGet(pixelCharacterId);
    if (refreshed.ok && refreshed.dataUrl !== undefined) {
      setPixelDataUrl(refreshed.dataUrl);
      setPixelMeta({
        ...(refreshed.width === undefined ? {} : { width: refreshed.width }),
        ...(refreshed.height === undefined ? {} : { height: refreshed.height }),
        ...(refreshed.tier === undefined ? {} : { tier: refreshed.tier }),
        ...(refreshed.hasRaw === undefined ? {} : { hasRaw: refreshed.hasRaw }),
      });
    }
    setPixelSynced({
      id: pixelCharacterId,
      displayName: pixelCharacters.find((entry) => entry.id === pixelCharacterId)?.displayName ?? pixelCharacterId,
    });
    const tierLabel = result.tier === '4x' ? '4× 高清 Q 版' : result.tier === '2x' ? '2× 精致像素' : '1× 像素表';
    toast.success(result.sprite === true ? `已把 ${tierLabel} 写进星露谷 Mod 目录（游戏内 200ms 热变身）` : '已写入原版外观预设（该角色还没有精灵表）');
  };

  const selectedImageProvider = imageProviders.find((entry) => entry.id === imageProviderId) ?? null;
  const activePrompt = tab === 'egg' ? eggPrompt : charPrompt;

  const runBatch = async (poses: string[]): Promise<void> => {
    if (selectedImageProvider === null || imageModelId === '') {
      toast.error('未配置可用的生图供应商/模型：请先在「模型服务商」保存支持生图的 Key');
      return;
    }
    if (activePrompt.trim() === '') { toast.error('生图提示词还没编译完成'); return; }
    if (poses.length === 0) { toast.error('先选择要生成的姿态'); return; }
    setGenBusy(true);
    const jobId = `gen-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    genJobRef.current = jobId;
    setGenJobId(jobId);
    setGenItems(poses.map((pose) => ({ pose, status: 'queued' })));
    try {
      const result = await window.directorBridge.creatorGenerateBatch({
        provider: {
          id: selectedImageProvider.id,
          name: selectedImageProvider.name,
          baseUrl: selectedImageProvider.baseUrl,
          protocol: selectedImageProvider.protocol,
          candidateModels: selectedImageProvider.models,
        },
        modelId: imageModelId,
        prompt: activePrompt,
        poses,
        size: '1024x1024',
        jobId,
        ...(referenceImage === '' ? {} : { referenceImagePath: referenceImage }),
      });
      if (!result.ok) {
        toast.error(result.error ?? '批量出图失败');
        setGenItems((prev) => prev.map((item) => ({ ...item, status: item.status === 'queued' ? 'failed' : item.status, error: result.error })));
        return;
      }
      const summary = result.items ?? [];
      setGenItems((prev) => prev.map((item) => {
        const done = summary.find((entry) => entry.pose === item.pose);
        return done === undefined ? item : { ...item, status: done.status as GenItemView['status'], ...(done.file === undefined ? {} : { file: done.file }), ...(done.error === undefined ? {} : { error: done.error }) };
      }));
      const okCount = summary.filter((entry) => entry.status === 'done').length;
      if (okCount === 0) toast.error(`出图全部失败（${summary.length} 张）——检查模型是否支持图像生成`);
      else toast.success(`出图完成 ${okCount}/${summary.length} 张，可逐张重画或确认入库`);
    } finally {
      setGenBusy(false);
    }
  };

  const regenerate = async (pose: string): Promise<void> => {
    if (selectedImageProvider === null || imageModelId === '' || genJobId === '') return;
    setGenItems((prev) => prev.map((item) => (item.pose === pose ? { ...item, status: 'generating', error: undefined } : item)));
    const result = await window.directorBridge.creatorRegenerateOne({
      jobId: genJobId,
      provider: {
        id: selectedImageProvider.id,
        name: selectedImageProvider.name,
        baseUrl: selectedImageProvider.baseUrl,
        protocol: selectedImageProvider.protocol,
        candidateModels: selectedImageProvider.models,
      },
      modelId: imageModelId,
      prompt: activePrompt,
      pose,
      size: '1024x1024',
      ...(referenceImage === '' ? {} : { referenceImagePath: referenceImage }),
    });
    if (!result.ok) toast.error(result.error ?? '重画失败');
    else toast.success(`已重画 ${pose}`);
  };

  const commitDraft = async (): Promise<void> => {
    if (genJobId === '') { toast.error('还没有可入库的草稿'); return; }
    const targetId = tab === 'egg' ? eggId : importId;
    const targetName = tab === 'egg' ? eggName : (importName.trim() === '' ? targetId : importName.trim());
    const result = await window.directorBridge.creatorCommitDraft({
      jobId: genJobId,
      id: targetId,
      ...(targetName.trim() === '' ? {} : { displayName: targetName.trim() }),
      ...(tab === 'egg' ? { characterPatch: { egg: true } } : {}),
    });
    if (!result.ok) { toast.error(result.error ?? '入库失败'); return; }
    toast.success(`已入库 ${result.poses?.length ?? 0} 个姿态并完成后处理`);
    await window.directorBridge.customReload();
    await window.directorBridge.characterSelect(`custom-${result.id ?? targetId}`).catch(() => undefined);
    onReloaded();
  };

  const charInput = useMemo(() => ({
    lock,
    customName,
    customTraits,
    tiers: selectedTiers,
  }), [lock, customName, customTraits, selectedTiers]);

  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => {
      void window.directorBridge.creatorCompileCharacter(charInput).then((result) => setCharPrompt(result.prompt)).catch(() => undefined);
    }, 180);
    return () => clearTimeout(timer);
  }, [open, charInput]);

  useEffect(() => {
    if (!open) return;
    void window.directorBridge.creatorCompileEgg({ mode: eggMode, guest, host }).then((result) => setEggPrompt(result.prompt)).catch(() => undefined);
  }, [open, eggMode, guest, host]);

  const copy = useCallback(async (text: string, message: string) => {
    if (text === '') return;
    await navigator.clipboard.writeText(text);
    toast.success(message);
  }, []);

  const parseFx = (): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const part of fxText.split(/[,，]/)) {
      const [key, value] = part.split(':').map((item) => item.trim());
      if (key !== undefined && key !== '' && value !== undefined && value !== '') out[key] = value;
    }
    return out;
  };

  const characterPatch = (): Record<string, unknown> => ({
    reactTo: reactTo.trim() === '*' ? '*' : reactTo.split(/[,，]/).map((item) => item.trim()).filter((item) => item !== ''),
    longThink: { after: longThinkAfter, pose: longThinkPose },
    correctedPose,
    fx: parseFx(),
  });

  const importNow = async (): Promise<void> => {
    if (images.length === 0 && folder === '') { toast.error('先选择图片或角色文件夹'); return; }
    setImportBusy(true);
    try {
      const result = await window.directorBridge.creatorImport({
        id: importId,
        ...(importName.trim() === '' ? {} : { displayName: importName.trim() }),
        ...(folder === '' ? { paths: images } : { folder }),
        characterPatch: characterPatch(),
      });
      if (!result.ok) { toast.error(result.error ?? '导入失败'); return; }
      setImportResult({ poses: result.poses ?? [], warnings: result.warnings ?? [] });
      toast.success(`已处理 ${result.poses?.length ?? 0} 个姿态并写入 userData/pet-characters/${result.id ?? importId}/`);
      await window.directorBridge.customReload();
      // 导入后立刻切到新角色，验收台/桌面桌宠都直接用这套姿态
      await window.directorBridge.characterSelect(`custom-${result.id ?? importId}`).catch(() => undefined);
      onReloaded();
    } finally {
      setImportBusy(false);
    }
  };

  const generateEggLines = async (): Promise<void> => {
    setEggBusy(true);
    try {
      const result = await window.directorBridge.creatorGenerateEggLines({
        id: eggId,
        name: eggName,
        mode: eggMode,
        host,
        persona: guest === 'deepseek' ? '嘴硬心软的蓝鲸女仆' : undefined,
      });
      if (!result.ok) { toast.error(result.error ?? '台词生成失败'); return; }
      setEggLines(result.lines ?? null);
      toast.success('已生成 5 态台词并写入彩蛋配置');
      await window.directorBridge.customReload();
      onReloaded();
    } finally {
      setEggBusy(false);
    }
  };

  const cloneBuiltin = async (): Promise<void> => {
    const result = await window.directorBridge.customClone({ builtinId: cloneBuiltinId, newId: cloneId, ...(cloneName.trim() === '' ? {} : { displayName: cloneName.trim() }) });
    if (!result.ok) { toast.error(result.error ?? '克隆失败'); return; }
    toast.success(`已克隆到 userData/pet-characters/${cloneId}/ 并热重载`);
    await window.directorBridge.customReload();
    onReloaded();
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center px-4" style={{ background: 'rgba(2,6,16,.72)', backdropFilter: 'blur(6px)' }} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }} data-creator-center>
      <div className="card w-full max-w-[900px]" style={{ maxHeight: '88vh', overflow: 'auto', padding: 18 }}>
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-[15px] font-semibold"><Sparkles size={15} style={{ color: 'var(--violet)' }} />桌宠创作中心</h2>
            <p className="mt-1 text-[11px]" style={{ color: 'var(--text-2)' }}>零命令行建角 · 生图提示词编译器 · 当前角色 {characterName}（{characterId}）</p>
          </div>
          <button className="icon-btn" aria-label="关闭创作中心" onClick={onClose}><X size={14} /></button>
        </div>

        <div className="seg-tabs mb-3">
          {([
            ['char', 'AI 角色/皮肤生图'],
            ['egg', 'AI 彩蛋生成器 (5 态)'],
            ['pixel', '星露谷像素表'],
            ['import', '自定义建角与拖入处理'],
          ] as Array<[CreatorTab, string]>).map(([id, label]) => (
            <button key={id} className={`seg-tab${tab === id ? ' on' : ''}`} data-creator-tab={id} onClick={() => setTab(id)}>{label}</button>
          ))}
        </div>

        {(tab === 'char' || tab === 'egg' || tab === 'pixel') && (
          <div className="mb-3 rounded-xl p-3" style={{ border: '1px solid var(--stroke)', background: 'var(--surface-2)' }} data-image-gen-toolbar>
            {imageProviders.length === 0 ? (
              <div className="flex flex-wrap items-center justify-between gap-2 text-[11.5px]" style={{ color: 'var(--text-2)' }}>
                <span>
                  未检测到已配置 Key 的生图供应商（引擎探测到 {imageProviderStats.detected} 家，vault 中可用 {imageProviderStats.configured} 家）。
                  不会伪造出图结果，也不会用聊天模型冒充生图。
                </span>
                {onOpenProviders !== undefined && (
                  <button type="button" className="btn-pill ghost" data-gen-open-providers onClick={onOpenProviders}>
                    <Link2 size={12} />去「模型服务商」配置
                  </button>
                )}
              </div>
            ) : (
              <>
                <div className="grid gap-2 md:grid-cols-[1fr_1fr_auto]">
                  <label className="block" style={labelStyle}>生图供应商
                    <select
                      data-image-provider
                      value={imageProviderId}
                      onChange={(event) => {
                        const next = imageProviders.find((entry) => entry.id === event.target.value);
                        setImageProviderId(event.target.value);
                        setImageModelId(next?.models[0] ?? '');
                      }}
                      className="mt-1 w-full px-3 py-2 text-[12px]"
                      style={inputStyle}
                    >
                      {imageProviders.map((entry) => (
                        <option key={entry.id} value={entry.id}>{entry.name}（{entry.protocol === 'gemini' ? 'Gemini 原生' : 'OpenAI Images'}）</option>
                      ))}
                    </select>
                  </label>
                  <label className="block" style={labelStyle}>生图模型
                    <select data-image-model value={imageModelId} onChange={(event) => setImageModelId(event.target.value)} className="mt-1 w-full px-3 py-2 text-[12px] mono" style={inputStyle}>
                      {(selectedImageProvider?.models ?? []).map((model) => (
                        <option key={model} value={model}>
                          {model === 'codex-imagegen' ? '快速模式（codex-imagegen）' : model === 'codex-exec' ? '慢速兜底（codex exec）' : model}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="flex items-end gap-1.5">
                    <button
                      type="button"
                      className="btn-pill ghost"
                      data-gen-pick-reference
                      onClick={() => void window.directorBridge.creatorPickImages().then((result) => {
                        if (result.ok && result.paths !== undefined && result.paths.length > 0) setReferenceImage(result.paths[0]!);
                      })}
                    >
                      <ImagePlus size={12} />{referenceImage === '' ? '参考图（可选）' : '更换参考图'}
                    </button>
                    {referenceImage !== '' && (
                      <button type="button" className="btn-pill ghost" onClick={() => setReferenceImage('')}>清除</button>
                    )}
                  </div>
                </div>
                <div className="mt-1 text-[10px]" style={{ color: 'var(--text-3)' }}>
                  单张 60s 超时（Codex CLI 150s）· 并发 ≤2 · Key 只在主进程 vault 解密
                  {referenceImage !== '' && <span className="mono ml-2">参考图：{referenceImage.split('/').slice(-1)[0]}</span>}
                </div>
                {codexInfo !== null && (!codexInfo.detected || !codexInfo.loggedIn || codexInfo.backend !== 'codex-imagegen') && (
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px]" data-codex-hint style={{ color: 'var(--amber)' }}>
                    <span>
                      {!codexInfo.detected
                        ? '未检测到本机 Codex CLI；想用免 Key 订阅出图可安装开源封装：'
                        : !codexInfo.loggedIn
                          ? '已检测到 Codex CLI 但未登录，请先在终端运行：'
                          : '当前为官方 codex exec 慢速兜底；安装 codex-imagegen 可提速：'}
                    </span>
                    <code className="mono rounded px-1.5 py-0.5" style={{ background: 'var(--inset)', border: '1px solid var(--stroke)', color: 'var(--text-1)' }}>
                      {!codexInfo.detected || codexInfo.backend !== 'codex-imagegen' ? codexInfo.installHint : codexInfo.loginHint}
                    </code>
                    <button
                      type="button"
                      className="btn-pill ghost"
                      data-codex-copy-hint
                      onClick={() => void copy(!codexInfo.detected || codexInfo.backend !== 'codex-imagegen' ? codexInfo.installHint : codexInfo.loginHint, '已复制命令（不会替你静默安装/登录）')}
                    >
                      <Copy size={10} />复制
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {(tab === 'char' || tab === 'egg') && genItems.length > 0 && (
          <div className="mb-3 rounded-xl p-3" style={{ border: '1px solid var(--stroke)', background: 'var(--inset)' }} data-gen-grid>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <span className="text-[11.5px] font-semibold" style={{ color: 'var(--text-2)' }}>
                生成网格 · {genItems.filter((item) => item.status === 'done').length}/{genItems.length} 完成
                {genJobId !== '' && <span className="mono ml-2 text-[10px]" style={{ color: 'var(--text-3)' }}>{genJobId}</span>}
              </span>
              <button
                type="button"
                className="btn-pill primary"
                data-gen-commit
                disabled={genBusy || genItems.every((item) => item.status !== 'done')}
                onClick={() => void commitDraft()}
              >
                <CheckCheck size={12} />确认入库并后处理
              </button>
            </div>
            <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))' }}>
              {genItems.map((item) => (
                <div key={item.pose} data-gen-item={item.pose} data-gen-status={item.status} className="rounded-lg p-2" style={{ border: '1px solid var(--stroke)', background: 'var(--surface)' }}>
                  <div className="mono flex items-center justify-between text-[10px]" style={{ color: 'var(--text-2)' }}>
                    <span>{item.pose}</span>
                    <span style={{ color: item.status === 'done' ? 'var(--green)' : item.status === 'failed' ? 'var(--red)' : item.status === 'generating' ? 'var(--blue)' : 'var(--text-3)' }}>
                      {item.status === 'queued' ? '排队中' : item.status === 'generating' ? '生成中' : item.status === 'done' ? '已完成' : '失败'}
                    </span>
                  </div>
                  <div className="mt-1 grid h-[76px] place-items-center overflow-hidden rounded-md" style={{ background: 'var(--surface-2)' }}>
                    {item.dataUrl !== undefined
                      ? <img src={item.dataUrl} alt={item.pose} style={{ maxWidth: '100%', maxHeight: '76px', objectFit: 'contain' }} />
                      : <span className="text-[9.5px]" style={{ color: 'var(--text-3)' }}>{item.status === 'failed' ? '未生成' : '等待模型…'}</span>}
                  </div>
                  {item.error !== undefined && <div className="mt-1 text-[9px] leading-snug" style={{ color: 'var(--red)' }}>{item.error}</div>}
                  <button
                    type="button"
                    className="btn-pill ghost mt-1 w-full"
                    data-gen-regenerate={item.pose}
                    disabled={genBusy}
                    onClick={() => void regenerate(item.pose)}
                  >
                    <RefreshCw size={10} />重画此张
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {tab === 'char' && (
          <section data-creator-pane="char" className="space-y-3">
            <div className="grid gap-3 md:grid-cols-2">
              <label className="block" style={labelStyle}>角色锁定模板
                <select value={lock} onChange={(event) => setLock(event.target.value)} className="mt-1 w-full px-3 py-2 text-[12px]" style={inputStyle}>
                  {locks.map((item) => <option key={item.id} value={item.id}>{item.label}（{item.reference}）</option>)}
                  <option value="custom">自定义原创角色</option>
                </select>
              </label>
              <div className="text-[11px] rounded-lg px-3 py-2" style={{ ...inputStyle, color: 'var(--text-2)' }}>
                画幅规范：transparent_background · 1024×1024 · 2.5 头身 Q 版 · 90% 身高居中
              </div>
            </div>
            {lock === 'custom' && (
              <div className="grid gap-3 md:grid-cols-2">
                <label className="block" style={labelStyle}>角色名<input value={customName} onChange={(event) => setCustomName(event.target.value)} className="mt-1 w-full px-3 py-2 text-[12px]" style={inputStyle} placeholder="例如：小海豹" /></label>
                <label className="block" style={labelStyle}>外观特征<input value={customTraits} onChange={(event) => setCustomTraits(event.target.value)} className="mt-1 w-full px-3 py-2 text-[12px]" style={inputStyle} placeholder="发色 / 瞳色 / 服装 / 标志道具" /></label>
              </div>
            )}
            <div>
              <div className="mb-1.5 text-[11px] font-semibold" style={{ color: 'var(--text-2)' }}>选择要生成的姿态批次</div>
              <div className="flex flex-wrap gap-1.5">
                {tiers.map((tier) => {
                  const on = selectedTiers.includes(tier.id);
                  return (
                    <button key={tier.id} data-pose-tier={tier.id} onClick={() => setSelectedTiers((prev) => (on ? prev.filter((id) => id !== tier.id) : [...prev, tier.id]))} className="rounded-full px-3 py-1 text-[11px]" style={{ border: `1px solid ${on ? 'var(--blue-line)' : 'var(--stroke)'}`, background: on ? 'var(--blue-dim)' : 'var(--surface)', color: on ? 'var(--blue)' : 'var(--text-2)' }}>
                      {tier.label}（{tier.poses.length}）
                    </button>
                  );
                })}
              </div>
            </div>
            <pre data-char-prompt className="max-h-[260px] overflow-auto rounded-xl p-3 text-[10.5px] whitespace-pre-wrap" style={{ ...inputStyle, color: 'var(--text-2)' }}>{charPrompt}</pre>
            <div className="flex flex-wrap justify-end gap-2">
              <button className="btn-pill ghost" onClick={() => void copy(charPrompt, '已复制完整生图提示词')}><Copy size={12} />一键复制提示词</button>
              <button
                className="btn-pill primary"
                data-gen-batch
                disabled={genBusy}
                onClick={() => void runBatch(tiers.filter((tier) => selectedTiers.includes(tier.id)).flatMap((tier) => tier.poses.map((pose) => pose.id)))}
              >
                <Wand2 size={12} />{genBusy ? '出图中…' : '调用生图模型批量出图'}
              </button>
            </div>
          </section>
        )}

        {tab === 'egg' && (
          <section data-creator-pane="egg" className="space-y-3">
            <div className="grid gap-3 md:grid-cols-3">
              <label className="block" style={labelStyle}>彩蛋类型
                <select value={eggMode} onChange={(event) => setEggMode(event.target.value as 'cosplay' | 'prank')} className="mt-1 w-full px-3 py-2 text-[12px]" style={inputStyle}>
                  <option value="cosplay">Cosplay 冒充（穿对方衣服 + 假发箍）</option>
                  <option value="prank">对手串门捣乱（含 caught 双人同框）</option>
                </select>
              </label>
              <label className="block" style={labelStyle}>主角（串门者）
                <select value={guest} onChange={(event) => setGuest(event.target.value)} className="mt-1 w-full px-3 py-2 text-[12px]" style={inputStyle}>
                  {locks.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                </select>
              </label>
              <label className="block" style={labelStyle}>宿主
                <select value={host} onChange={(event) => setHost(event.target.value)} className="mt-1 w-full px-3 py-2 text-[12px]" style={inputStyle}>
                  {locks.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                </select>
              </label>
            </div>
            <pre data-egg-prompt className="max-h-[240px] overflow-auto rounded-xl p-3 text-[10.5px] whitespace-pre-wrap" style={{ ...inputStyle, color: 'var(--text-2)' }}>{eggPrompt}</pre>
            <div className="grid gap-3 md:grid-cols-3">
              <label className="block" style={labelStyle}>彩蛋目录 id<input value={eggId} onChange={(event) => setEggId(event.target.value)} className="mt-1 w-full px-3 py-2 text-[12px] mono" style={inputStyle} /></label>
              <label className="block" style={labelStyle}>彩蛋名<input value={eggName} onChange={(event) => setEggName(event.target.value)} className="mt-1 w-full px-3 py-2 text-[12px]" style={inputStyle} /></label>
              <div />
            </div>
            {eggLines !== null && (
              <div className="grid gap-2 md:grid-cols-5" data-egg-lines>
                {Object.entries(eggLines).map(([key, lines]) => (
                  <div key={key} className="rounded-lg p-2 text-[11px]" style={inputStyle}>
                    <div className="mono mb-1" style={{ color: 'var(--blue)' }}>{key}</div>
                    {lines.map((line) => <div key={line} style={{ color: 'var(--text-2)' }}>{line}</div>)}
                  </div>
                ))}
              </div>
            )}
            <div className="flex flex-wrap justify-end gap-2">
              <button className="btn-pill ghost" onClick={() => void copy(eggPrompt, '已复制双参考图彩蛋提示词')}><Copy size={12} />复制提示词</button>
              <button
                className="btn-pill primary"
                data-gen-batch-egg
                disabled={genBusy}
                onClick={() => void runBatch([...EGG_IMAGE_POSES])}
              >
                <Wand2 size={12} />{genBusy ? '出图中…' : '批量生成 5 态立绘'}
              </button>
              <button className="btn-pill violet" data-egg-generate disabled={eggBusy} onClick={() => void generateEggLines()}>
                <Sparkles size={12} />{eggBusy ? '生成中…' : '生成 5 态台词并入库'}
              </button>
            </div>
          </section>
        )}

        {tab === 'pixel' && (
          <section data-creator-pane="pixel" className="space-y-3">
            <div className="grid gap-3 md:grid-cols-2">
              <label className="block" style={labelStyle}>目标角色（内置 / 自定义角色）
                <select data-pixel-character value={pixelCharacterId} onChange={(event) => setPixelCharacterId(event.target.value)} className="mt-1 w-full px-3 py-2 text-[12px]" style={inputStyle}>
                  {pixelCharacters.map((entry) => <option key={entry.id} value={entry.id}>{entry.displayName}（{entry.id}）</option>)}
                </select>
                {pixelSynced !== null && (
                  <span className="mt-1 block text-[10px]" style={{ color: 'var(--text-3)' }}>
                    游戏内当前：{pixelSynced.displayName}（{pixelSynced.id}）
                  </span>
                )}
              </label>
              <div className="flex items-center gap-3 rounded-lg px-3 py-2 text-[11px]" style={{ ...inputStyle, color: 'var(--text-2)' }}>
                {referenceImage === '' && pixelAutoRef !== null && (
                  <img
                    src={pixelAutoRef.dataUrl}
                    alt={pixelAutoRef.label}
                    className="h-12 w-12 shrink-0 rounded-md object-contain"
                    style={{ background: 'var(--surface-2)', border: '1px solid var(--stroke)' }}
                  />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 font-medium" style={{ color: 'var(--text-1)' }}>
                    <Layers size={12} style={{ color: 'var(--blue)' }} />
                    {referenceImage !== ''
                      ? '已指定自定义参考图'
                      : pixelAutoRef !== null
                        ? `已自动锁定角色立绘（${pixelAutoRef.label}）`
                        : '4 行 × 6 列（待机 + 3 行走 + 动作 + 表情）'}
                  </div>
                  <div className="mt-0.5 text-[10px]" style={{ color: 'var(--text-3)' }}>
                    {referenceImage !== ''
                      ? `将使用「${referenceImage.split('/').slice(-1)[0]}」锁定外观（WebP 自动转 PNG）`
                      : '生成时自动携带该角色全身立绘（WebP 自动转 PNG）+ 精准外观锁定词，并防左右裁切。'}
                  </div>
                </div>
              </div>
            </div>

            <div>
              <div className="mb-1.5 flex items-center justify-between text-[11px] font-semibold" style={{ color: 'var(--text-2)' }}>
                <span>清晰度档位</span>
                {pixelMeta.width !== undefined && pixelMeta.height !== undefined && (
                  <span className="mono text-[10px] font-normal" style={{ color: 'var(--text-3)' }}>
                    当前已存：{pixelMeta.width}×{pixelMeta.height}（{pixelMeta.tier ?? '自定义'}）{pixelMeta.hasRaw === true ? ' · 已保留原图' : ''}
                  </span>
                )}
              </div>
              <div className="grid gap-2 md:grid-cols-3" data-pixel-tier-picker>
                {STARDEW_SPRITE_TIERS.map((option) => {
                  const active = pixelTier === option.tier;
                  const isCurrentSaved = pixelMeta.tier === option.tier;
                  return (
                    <button
                      key={option.tier}
                      type="button"
                      data-pixel-tier={option.tier}
                      onClick={() => setPixelTier(option.tier)}
                      className="rounded-xl p-2.5 text-left transition"
                      style={{
                        border: `1px solid ${active ? 'var(--blue-line)' : 'var(--stroke)'}`,
                        background: active ? 'var(--blue-dim)' : 'var(--inset)',
                      }}
                    >
                      <div className="flex items-center justify-between gap-1.5">
                        <span className="text-[12px] font-semibold" style={{ color: active ? 'var(--blue)' : 'var(--text-1)' }}>
                          {option.title}
                        </span>
                        <span
                          className="rounded-full px-1.5 py-0.5 text-[9.5px]"
                          style={{
                            background: isCurrentSaved ? 'var(--green-dim)' : active ? 'var(--surface)' : 'var(--surface-2)',
                            color: isCurrentSaved ? 'var(--green)' : active ? 'var(--blue)' : 'var(--text-3)',
                            border: `1px solid ${isCurrentSaved ? 'var(--green-line)' : 'var(--stroke)'}`,
                          }}
                        >
                          {isCurrentSaved ? '当前图' : option.badge}
                        </span>
                      </div>
                      <div className="mono mt-1 text-[10px]" style={{ color: 'var(--text-2)' }}>{option.spec}</div>
                      <div className="mt-1 text-[10px] leading-snug" style={{ color: 'var(--text-3)' }}>{option.desc}</div>
                    </button>
                  );
                })}
              </div>
            </div>

            {pixelMeta.tier === '1x' && pixelMeta.hasRaw !== true && pixelDataUrl !== '' && (
              <div className="rounded-lg px-3 py-2 text-[10.5px]" style={{ border: '1px solid var(--blue-line)', background: 'var(--blue-dim)', color: 'var(--text-1)' }}>
                当前是旧版 1×（96×128）像素表，细节较少。建议选择 <strong>2× 精致像素</strong> 或 <strong>4× 高清 Q 版</strong> 重新生成一次，清晰度提升 4–16 倍并自动保留原图。
              </div>
            )}

            {pixelCharacterId !== characterId && (
              <div className="rounded-lg px-3 py-2 text-[10.5px]" style={{ border: '1px solid var(--amber-line)', background: 'var(--amber-dim)', color: 'var(--amber)' }}>
                目标不是当前桌宠：应用只改游戏内形象；切换桌宠或重启工作台后，游戏会跟随当前桌宠「{characterName}」。
              </div>
            )}
            <label className="block" style={labelStyle}>精灵表提示词（随清晰度档位自动编译，可编辑；共享的「参考图」会随请求发给生图供应商锁定外观）
              <textarea data-pixel-prompt value={pixelPrompt} onChange={(event) => setPixelPrompt(event.target.value)} rows={6} className="mt-1 w-full px-3 py-2 text-[10.5px] mono" style={{ ...inputStyle, resize: 'vertical' }} />
            </label>
            <div className="flex flex-wrap items-center justify-end gap-2">
              {pixelMeta.hasRaw === true && (
                <button
                  type="button"
                  className="btn-pill violet"
                  data-pixel-reprocess
                  disabled={pixelReprocessing || pixelBusy}
                  onClick={() => void reprocessPixelSprite(pixelTier)}
                >
                  <Zap size={12} />{pixelReprocessing ? '正在重切…' : pixelMeta.tier !== pixelTier ? `从原图秒切至 ${pixelTier}（免重新生图）` : `用防裁切算法重切 ${pixelTier}`}
                </button>
              )}
              <button className="btn-pill primary" data-pixel-generate disabled={pixelBusy || pixelReprocessing} onClick={() => void generatePixelSprite()}>
                <Wand2 size={12} />{pixelBusy ? '生成中…（约 30–90 秒）' : `生成 ${pixelTier} 精灵表`}
              </button>
              <button className="btn-pill ghost" data-pixel-apply disabled={!pixelSpriteReady || pixelBusy || pixelReprocessing} onClick={() => void applyPixelSprite()} title="需先在游戏共玩页开启「同步桌宠形象进游戏」并安装 Mod">
                <CheckCheck size={12} />一键应用到星露谷
              </button>
            </div>
            <div className="text-right text-[10px]" style={{ color: 'var(--text-3)' }}>
              Codex CLI 最长 150 秒；OpenAI/Gemini 单张 60 秒。应用后游戏内 200ms 热切换，无需重启（Mod 需已升级至 0.3.0 以支持 2×/4× 与灵动动画）。
            </div>
            {pixelDataUrl !== '' && (
              <div className="grid gap-3 md:grid-cols-[200px_1fr]" data-pixel-preview>
                <div className="rounded-xl p-2.5 text-center" style={{ border: '1px solid var(--stroke)', background: 'var(--inset)' }}>
                  <div className="mb-1.5 flex justify-center gap-1">
                    {([
                      ['walk', '行走'],
                      ['idle', '呼吸'],
                      ['action', '动作'],
                      ['emote', '表情'],
                    ] as Array<[SpritePreviewMode, string]>).map(([mode, label]) => (
                      <button
                        key={mode}
                        type="button"
                        onClick={() => setPixelPreviewMode(mode)}
                        className="rounded px-1.5 py-0.5 text-[9.5px]"
                        style={{
                          border: `1px solid ${pixelPreviewMode === mode ? 'var(--blue-line)' : 'var(--stroke)'}`,
                          background: pixelPreviewMode === mode ? 'var(--blue-dim)' : 'var(--surface)',
                          color: pixelPreviewMode === mode ? 'var(--blue)' : 'var(--text-3)',
                        }}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <SpritePreview dataUrl={pixelDataUrl} mode={pixelPreviewMode} />
                  <div className="mt-1 text-[9.5px]" style={{ color: 'var(--text-3)' }}>
                    四方向实机效果预览（含呼吸/阴影）
                  </div>
                </div>
                <div className="rounded-xl p-2.5" style={{ border: '1px solid var(--stroke)', background: 'var(--inset)' }}>
                  <img
                    src={pixelDataUrl}
                    alt="stardew sprite sheet"
                    style={{
                      width: 240,
                      height: 320,
                      objectFit: 'contain',
                      imageRendering: pixelMeta.tier === '4x' ? 'auto' : 'pixelated',
                    }}
                  />
                  <div className="mt-1.5 text-[9.5px]" style={{ color: 'var(--text-3)' }}>
                    完整 {pixelMeta.width ?? 192}×{pixelMeta.height ?? 256} 精灵表（{pixelMeta.tier ?? '未知档位'}） · 行：下/右/上/左 · 列：待机/左脚/右脚/过渡/动作/表情
                    {pixelEmptyCells > 0 ? ` · ${pixelEmptyCells} 个空格` : pixelEmptyCells === 0 ? ' · 24 格全满' : ''}
                  </div>
                </div>
              </div>
            )}
            {pixelDataUrl === '' && (
              <div className="rounded-lg px-3 py-2 text-[11px]" style={{ border: '1px dashed var(--stroke)', color: 'var(--text-3)' }}>
                该角色还没有精灵表：选择清晰度后点「生成」即可预览；「一键应用到星露谷」需要先在游戏共玩页开启「同步桌宠形象进游戏」并安装 Mod。
              </div>
            )}
          </section>
        )}

        {tab === 'import' && (
          <section data-creator-pane="import" className="space-y-3">
            <div
              ref={dropRef}
              data-creator-drop
              className="rounded-xl p-5 text-center"
              style={{ border: '1px dashed var(--blue-line)', background: 'var(--blue-dim)' }}
              onDragOver={(event) => { event.preventDefault(); }}
              onDrop={(event) => {
                event.preventDefault();
                const paths = [...event.dataTransfer.files].map((file) => window.directorBridge.pathForFile(file)).filter((path) => path !== '');
                if (paths.length > 0) { setImages(paths); setFolder(''); toast.success(`已接收 ${paths.length} 个文件`); }
              }}
            >
              <UploadCloud size={24} style={{ color: 'var(--blue)', margin: '0 auto 6px' }} />
              <div className="text-[13px] font-semibold">拖入角色文件夹（character.json + 立绘）或 PNG/WebP 原图</div>
              <div className="mt-1 text-[11px]" style={{ color: 'var(--text-2)' }}>自动完成：白底抠像 → 90% 身高脚底对齐 → idle-blink 仅闭眼贴回 → avatar 192×192 / portrait-card 256×384</div>
              <div className="mt-3 flex justify-center gap-2">
                <button className="btn-pill ghost" onClick={() => void window.directorBridge.creatorPickImages().then((result) => { if (result.ok) { setImages(result.paths ?? []); setFolder(''); } })}><ImagePlus size={12} />选择图片</button>
                <button className="btn-pill ghost" onClick={() => void window.directorBridge.creatorPickFolder().then((result) => { if (result.ok && result.folder !== undefined) { setFolder(result.folder); setImages([]); } })}><FolderOpen size={12} />选择文件夹</button>
              </div>
              <div className="mt-2 text-[10.5px] mono" style={{ color: 'var(--text-3)' }}>{folder !== '' ? folder.split('/').slice(-1)[0] : images.length > 0 ? `${images.length} 张图片` : '尚未选择文件'}</div>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <label className="block" style={labelStyle}>目录 id（小写字母/数字/连字符）<input data-import-id value={importId} onChange={(event) => setImportId(event.target.value)} className="mt-1 w-full px-3 py-2 text-[12px] mono" style={inputStyle} /></label>
              <label className="block" style={labelStyle}>角色名称<input data-import-name value={importName} onChange={(event) => setImportName(event.target.value)} className="mt-1 w-full px-3 py-2 text-[12px]" style={inputStyle} placeholder="留空沿用 character.json" /></label>
              <label className="block" style={labelStyle}>reactTo（* 或 AI 列表）<input data-import-reactto value={reactTo} onChange={(event) => setReactTo(event.target.value)} className="mt-1 w-full px-3 py-2 text-[12px] mono" style={inputStyle} /></label>
              <label className="block" style={labelStyle}>出错/打断后姿态<input value={correctedPose} onChange={(event) => setCorrectedPose(event.target.value)} className="mt-1 w-full px-3 py-2 text-[12px] mono" style={inputStyle} /></label>
              <label className="block" style={labelStyle}>长思考 after（秒）
                <input type="number" min={1} max={600} value={longThinkAfter} onChange={(event) => setLongThinkAfter(Number(event.target.value))} className="mt-1 w-full px-3 py-2 text-[12px] mono" style={inputStyle} />
              </label>
              <label className="block" style={labelStyle}>长思考姿态<input value={longThinkPose} onChange={(event) => setLongThinkPose(event.target.value)} className="mt-1 w-full px-3 py-2 text-[12px] mono" style={inputStyle} /></label>
            </div>
            <label className="block" style={labelStyle}>fx 映射（pose: effect，逗号分隔）<input data-import-fx value={fxText} onChange={(event) => setFxText(event.target.value)} className="mt-1 w-full px-3 py-2 text-[12px] mono" style={inputStyle} /></label>

            {importResult !== null && (
              <div className="rounded-lg p-2.5 text-[11px]" style={inputStyle} data-import-result>
                <div>已生成姿态：{importResult.poses.join('、')}</div>
                {importResult.warnings.map((warning) => <div key={warning} style={{ color: 'var(--amber)' }}>{warning}</div>)}
              </div>
            )}

            <div className="flex flex-wrap items-center justify-end gap-2">
              <button className="btn-pill ghost" data-save-custom onClick={() => void window.directorBridge.customSave(importId, {
                name: importName.trim() || importId,
                reactTo: reactTo.trim() === '*' ? '*' : reactTo.split(/[,，]/).map((item) => item.trim()).filter((item) => item !== ''),
                longThink: { after: longThinkAfter, pose: longThinkPose },
                correctedPose,
                fx: parseFx(),
              }).then(async (result) => {
                if (!result.ok) { toast.error(result.error ?? '保存失败（需先导入姿态图）'); return; }
                toast.success('配置已保存并热重载');
                await window.directorBridge.customReload();
                onReloaded();
              })}>保存并热重载</button>
              <button className="btn-pill primary" data-import-run disabled={importBusy} onClick={() => void importNow()}>
                <Wand2 size={12} />{importBusy ? '处理中…' : '导入并后处理'}
              </button>
            </div>

            <div className="rounded-xl p-3" style={{ border: '1px solid var(--stroke)', background: 'var(--surface-2)' }}>
              <div className="mb-2 text-[12px] font-semibold">已有自定义角色改名（落盘本机设置，升级不丢）</div>
              <div className="grid gap-2 md:grid-cols-4">
                <select value={renameTarget} onChange={(event) => { setRenameTarget(event.target.value); setRenameName(customList.find((item) => item.id === event.target.value)?.name ?? ''); }} className="px-2 py-1.5 text-[11.5px]" style={inputStyle}>
                  <option value="">选择自定义角色</option>
                  {customList.map((item) => <option key={item.id} value={item.id}>{item.name}（{item.id}）</option>)}
                </select>
                <input value={renameName} onChange={(event) => setRenameName(event.target.value)} className="px-2 py-1.5 text-[11.5px]" style={inputStyle} placeholder="新名字" />
                <button
                  className="btn-pill ghost"
                  data-rename-custom
                  disabled={renameTarget === ''}
                  onClick={() => void window.directorBridge.customRename(renameTarget, renameName).then(async (result) => {
                    if (!result.ok) { toast.error(result.error ?? '改名失败'); return; }
                    toast.success('已改名并热重载');
                    await window.directorBridge.customReload();
                    setCustomList(await window.directorBridge.creatorListCustom());
                    onReloaded();
                  })}
                >保存新名字</button>
                <div />
              </div>
            </div>

            <div className="rounded-xl p-3" style={{ border: '1px solid var(--stroke)', background: 'var(--surface-2)' }}>
              <div className="mb-2 text-[12px] font-semibold">克隆内置角色到 userData（不覆盖随包素材）</div>
              <div className="grid gap-2 md:grid-cols-4">
                <select value={cloneBuiltinId} onChange={(event) => setCloneBuiltinId(event.target.value)} className="px-2 py-1.5 text-[11.5px]" style={inputStyle}>
                  {locks.map((item) => <option key={item.id} value={`crosspet-${item.id}`}>{item.label}</option>)}
                </select>
                <input value={cloneId} onChange={(event) => setCloneId(event.target.value)} className="px-2 py-1.5 text-[11.5px] mono" style={inputStyle} placeholder="新目录 id" />
                <input value={cloneName} onChange={(event) => setCloneName(event.target.value)} className="px-2 py-1.5 text-[11.5px]" style={inputStyle} placeholder="新角色名（可选）" />
                <button className="btn-pill ghost" data-clone-builtin onClick={() => void cloneBuiltin()}>克隆内置角色</button>
              </div>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

/** 星露谷精灵表四方向实机效果预览（自适应 1×/2×/4× 分辨率 + 模拟游戏内呼吸/弹跳/脚底阴影）。 */
function SpritePreview({ dataUrl, mode }: { dataUrl: string; mode: SpritePreviewMode }): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [smooth, setSmooth] = useState(false);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return undefined;
    const ctx = canvas.getContext('2d');
    if (ctx === null) return undefined;
    const img = new Image();
    let raf = 0;
    const start = performance.now();
    const walkOrder = [1, 3, 2, 3];
    img.onload = () => {
      const cellH = Math.max(16, Math.round(img.naturalHeight / 4));
      const cellW = Math.max(8, Math.round(cellH / 2));
      const cols = Math.max(1, Math.round(img.naturalWidth / cellW));
      const isHd = cellW >= 64;
      setSmooth(isHd);
      const draw = (now: number): void => {
        const t = (now - start) / 1000;
        const direction = Math.floor((now - start) / 1600) % 4;
        let col = 0;
        let squashX = 1;
        let squashY = 1;
        let bounceY = 0;
        let tilt = 0;
        if (mode === 'walk') {
          const step = Math.floor((now - start) / 210) % walkOrder.length;
          col = Math.min(cols - 1, walkOrder[step] ?? 0);
          const stride = Math.abs(Math.sin(t * 11.5));
          bounceY = -stride * 3.2;
          squashY = 1 + stride * 0.025;
          squashX = 1 - stride * 0.016;
          if (direction === 1) tilt = 0.032;
          else if (direction === 3) tilt = -0.032;
        } else if (mode === 'idle') {
          col = 0;
          const breath = Math.sin(t * 2.4);
          squashY = 1 + breath * 0.02;
          squashX = 1 - breath * 0.012;
        } else if (mode === 'action') {
          col = cols >= 5 ? 4 : Math.min(cols - 1, 3);
          const pulse = Math.sin(t * 10);
          squashY = 1 + pulse * 0.032;
          squashX = 1 - pulse * 0.022;
          bounceY = -Math.max(0, pulse) * 2.2;
        } else {
          col = cols >= 6 ? 5 : 0;
          const pulse = Math.sin(t * 8);
          squashY = 1 + pulse * 0.028;
          squashX = 1 - pulse * 0.018;
          bounceY = -Math.max(0, pulse) * 2;
        }

        ctx.clearRect(0, 0, canvas.width, canvas.height);
        // 脚底椭圆投影
        const footX = canvas.width / 2;
        const footY = canvas.height - 14;
        const shadowRx = 22 * (1 - Math.min(0.2, Math.abs(bounceY) * 0.03));
        ctx.save();
        ctx.fillStyle = 'rgba(0, 0, 0, 0.28)';
        ctx.beginPath();
        ctx.ellipse(footX, footY, shadowRx, 7, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

        ctx.save();
        ctx.imageSmoothingEnabled = isHd;
        ctx.imageSmoothingQuality = 'high';
        ctx.translate(footX, footY + bounceY);
        ctx.rotate(tilt);
        ctx.scale(squashX, squashY);
        const drawW = 84;
        const drawH = 168;
        ctx.drawImage(img, col * cellW, direction * cellH, cellW, cellH, -drawW / 2, -drawH, drawW, drawH);
        ctx.restore();
        raf = requestAnimationFrame(draw);
      };
      raf = requestAnimationFrame(draw);
    };
    img.src = dataUrl;
    return () => cancelAnimationFrame(raf);
  }, [dataUrl, mode]);
  return (
    <canvas
      ref={canvasRef}
      width={128}
      height={200}
      style={{ width: 128, height: 200, margin: '0 auto', imageRendering: smooth ? 'auto' : 'pixelated' }}
      data-sprite-preview
    />
  );
}
