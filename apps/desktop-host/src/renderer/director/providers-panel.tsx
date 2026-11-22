/**
 * 模型与服务商 v5（T-M6-09，按 design/providers.html 重构）：
 *   - 单一当前生效配置（取消三档干饭套餐心智；改动即写 Dexie 并 brainApplyConfig 热更新）
 *   - Master-Detail：256px 服务商目录（云端/自定义/本地）+ 专注配置面板
 *   - 默认模型 Tab：六槽位只从「已启用服务商 × 已启用模型」中选择
 *   - 自定义服务商全生命周期（Dexie customProviders）+ Magpie / CC Switch 只读导入
 * 密钥永远只在主进程 safeStorage；本组件只持有掩码。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  Activity, AudioLines, Box, Brain, Check, CheckCircle2, Compass, Database, Download, Eye,
  FileJson, Fish, Flame, Info, MessageSquare, Music, Plug, Plus, RefreshCw, Rocket, Search,
  Server, Shield, SlidersHorizontal, Sparkles, Sprout, Trash2, Volume2, Waves, X, Zap,
  type LucideIcon,
} from 'lucide-react';
import {
  ModelProviderConfigSchema,
  type DiningProfilePreset,
  type ModelProviderConfig,
  type ProviderEndpointVariant,
  type WorkbenchRoleSlot,
} from '@workbench/shared-protocol';
import type { DirectorStore } from '@workbench/local-store/dexie';
import type { ImportApplyView, ImportScanView } from './bridge';

type Protocol = 'openai' | 'anthropic';

const OVERRIDES_KEY = 'providerOverrides';
const DINING_KEY = 'diningProfiles';
const CUSTOM_KEY = 'customProviders';

interface ModelEntry {
  id: string;
  enabled: boolean;
  caps: string[];
}

interface ProviderOverride {
  keyMask?: string;
  enabled?: boolean;
  models?: ModelEntry[];
  variants?: ProviderEndpointVariant[];
  activeVariant?: number;
}

interface CustomProviderRecord {
  id: string;
  name: string;
  protocol: Protocol;
  variants: ProviderEndpointVariant[];
  models: ModelEntry[];
  enabled: boolean;
  createdAt: number;
}

type ProviderOverrides = Record<string, ProviderOverride>;
type UiGroup = '云端服务' | '自定义服务商' | '本地引擎';

interface UiProvider {
  id: string;
  name: string;
  tag: string;
  group: UiGroup;
  icon: LucideIcon;
  protocol: Protocol;
  variants: ProviderEndpointVariant[];
  activeVariant: number;
  models: ModelEntry[];
  enabled: boolean;
  configured: boolean;
  keyMask: string;
  local: boolean;
  audio: boolean;
  custom: boolean;
  note: string;
}

const SLOT_META: Array<{ slot: WorkbenchRoleSlot; name: string; desc: string; group: 'llm' | 'audio'; icon: LucideIcon }> = [
  { slot: 'MAIN_PERSONA_BRAIN', name: '主脑与内心戏', desc: '日常聊天、人设表达与 <think> 推理', group: 'llm', icon: Brain },
  { slot: 'STARDEW_GAME_PLANNER', name: '星露谷规划器', desc: '自动驾驶工具决策与攻略应用', group: 'llm', icon: Sprout },
  { slot: 'DANMAKU_FAST_ROUTER', name: '弹幕快反路由', desc: '低延迟弹幕清洗、打分与快速回应', group: 'llm', icon: MessageSquare },
  { slot: 'VISION_STORYBOARD', name: '翻车视觉复盘', desc: '截图与宫格分镜画面理解', group: 'llm', icon: Eye },
  { slot: 'VOICE_TTS_SPEECH', name: '日常说话 TTS', desc: '五档情绪台词与心声气声合成', group: 'audio', icon: Volume2 },
  { slot: 'VOICE_SVC_SINGING', name: '点歌演唱 SVC', desc: '伴奏分离与 RVC 变声演唱', group: 'audio', icon: Music },
];

const TAG: Record<string, string> = {
  'opencode-go': '包月订阅 · 30+ 模型',
  'deepseek-official': '官方直连',
  siliconflow: '模型聚合',
  openrouter: '全球聚合',
  'volcano-ark': '官方直连',
  openai: '官方直连',
  anthropic: '官方直连',
  minimax: '官方直连',
  'local-ollama': '零消耗离线',
  'local-gpt-sovits': 'TTS / SVC',
};
const ICON: Record<string, LucideIcon> = {
  'opencode-go': Rocket,
  'deepseek-official': Fish,
  siliconflow: Zap,
  openrouter: Compass,
  'volcano-ark': Flame,
  openai: Sparkles,
  anthropic: Shield,
  minimax: Waves,
  'local-ollama': Box,
  'local-gpt-sovits': AudioLines,
};

const CAP_LABEL: Record<string, { text: string; cls: string }> = {
  reason: { text: '推理', cls: 'pill-violet' },
  vision: { text: '视觉', cls: 'pill-blue' },
  tool: { text: '工具', cls: 'pill-green' },
  cache: { text: '缓存', cls: '' },
  anth: { text: 'Anthropic', cls: 'pill-amber' },
  tts: { text: 'TTS', cls: 'pill-green' },
  svc: { text: 'SVC', cls: 'pill-violet' },
};

interface Props {
  profiles: DiningProfilePreset[];
  slotLabels: Record<WorkbenchRoleSlot, string>;
  providers: ModelProviderConfig[];
  store: DirectorStore;
}

function capsOf(provider: ModelProviderConfig, modelId: string, protocol: Protocol): string[] {
  const found = provider.discoveredModels.find((m) => m.id === modelId);
  const caps: string[] = [];
  if (found?.supportsReasoningThink === true) caps.push('reason');
  if (found?.supportsVision === true) caps.push('vision');
  caps.push(protocol === 'anthropic' ? 'anth' : 'tool');
  return caps;
}

function groupOf(provider: ModelProviderConfig): UiGroup {
  if (provider.category === 'LOCAL_LLM' || provider.category === 'AUDIO_TTS' || provider.category === 'AUDIO_SVC') return '本地引擎';
  return '云端服务';
}

function toUiProvider(provider: ModelProviderConfig, override: ProviderOverride | undefined): UiProvider {
  const variants = override?.variants ?? provider.variants;
  const variantIndex = Math.min(Math.max(0, override?.activeVariant ?? 0), Math.max(0, variants.length - 1));
  const activeVariant = variants[variantIndex] ?? provider.variants[0];
  const protocol: Protocol = activeVariant?.protocol ?? provider.protocol;
  const group = groupOf(provider);
  const audio = provider.category === 'AUDIO_TTS' || provider.category === 'AUDIO_SVC';
  const overrideModels = override?.models;
  const models: ModelEntry[] = overrideModels !== undefined
    ? overrideModels
    : provider.discoveredModels.map((m) => ({
      id: m.id,
      enabled: true,
      caps: audio
        ? [/rvc|svc/i.test(m.id) ? 'svc' : 'tts']
        : [
          ...(m.supportsReasoningThink ? ['reason'] : []),
          ...(m.supportsVision ? ['vision'] : []),
          protocol === 'anthropic' ? 'anth' : 'tool',
        ],
    }));
  return {
    id: provider.id,
    name: provider.name,
    tag: TAG[provider.id] ?? provider.category,
    group,
    icon: ICON[provider.id] ?? Server,
    protocol,
    variants,
    activeVariant: variantIndex,
    models,
    enabled: override?.enabled ?? true,
    configured: (override?.keyMask ?? provider.apiKeyMaskedOrRef) !== '',
    keyMask: override?.keyMask ?? provider.apiKeyMaskedOrRef,
    local: group === '本地引擎' && !audio,
    audio,
    custom: false,
    note: provider.id === 'opencode-go' ? 'OpenCode 官方低价包月计划（Go $10 / Go Plus $40），同一服务商可切换 OpenAI / Anthropic 兼容端点。' : '',
  };
}

function toUiCustom(record: CustomProviderRecord, keyMask: string): UiProvider {
  return {
    id: record.id,
    name: record.name,
    tag: '自定义',
    group: '自定义服务商',
    icon: Plug,
    protocol: record.protocol,
    variants: record.variants,
    activeVariant: 0,
    models: record.models,
    enabled: record.enabled,
    configured: keyMask !== '',
    keyMask,
    local: false,
    audio: false,
    custom: true,
    note: '',
  };
}

function toConfig(provider: UiProvider): ModelProviderConfig {
  const variant = provider.variants[provider.activeVariant] ?? provider.variants[0];
  const category = provider.audio ? 'AUDIO_TTS' : provider.local ? 'LOCAL_LLM' : provider.custom ? 'AGGREGATOR_LLM' : 'OFFICIAL_LLM';
  return ModelProviderConfigSchema.parse({
    id: provider.id,
    name: provider.name,
    category,
    protocol: provider.protocol,
    activeRegion: variant?.region ?? 'GLOBAL',
    activePlanType: variant?.planType ?? 'PAY_AS_YOU_GO',
    variants: provider.variants,
    apiKeyMaskedOrRef: provider.keyMask,
    activeModelId: provider.models.find((m) => m.enabled)?.id ?? '',
    discoveredModels: provider.models.map((m) => ({
      id: m.id,
      supportsReasoningThink: m.caps.includes('reason'),
      supportsVision: m.caps.includes('vision'),
      supportsToolCalling: !m.caps.includes('tts') && !m.caps.includes('svc'),
    })),
  });
}

export function ProvidersPanel({ profiles, slotLabels, providers, store }: Props): React.JSX.Element {
  const [hydrated, setHydrated] = useState(false);
  const [tab, setTab] = useState<'providers' | 'defaults'>('providers');
  const [overrides, setOverrides] = useState<ProviderOverrides>({});
  const [customs, setCustoms] = useState<CustomProviderRecord[]>([]);
  const [profile, setProfile] = useState<DiningProfilePreset | null>(null);
  const [activeProvId, setActiveProvId] = useState<string>('opencode-go');
  const [search, setSearch] = useState('');
  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err' | 'info'; text: string } | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newProto, setNewProto] = useState<Protocol>('openai');
  const [newUrl, setNewUrl] = useState('');
  const [newFullUrl, setNewFullUrl] = useState(false);
  const [newModels, setNewModels] = useState('');
  const [impOpen, setImpOpen] = useState(false);
  const [impSource, setImpSource] = useState<'magpie' | 'ccswitch' | 'file'>('magpie');
  const [impFilePath, setImpFilePath] = useState<string | undefined>(undefined);
  const [impScan, setImpScan] = useState<ImportScanView | null>(null);
  const [impSelected, setImpSelected] = useState<Set<string>>(new Set());
  const [impPolicy, setImpPolicy] = useState<'skip' | 'overwrite'>('skip');
  const [impBusy, setImpBusy] = useState(false);

  useEffect(() => {
    void Promise.all([
      store.getConfig<string>('activeDiningProfile'),
      store.getConfig<DiningProfilePreset[]>(DINING_KEY),
      store.getConfig<ProviderOverrides>(OVERRIDES_KEY),
      store.getConfig<CustomProviderRecord[]>(CUSTOM_KEY),
    ]).then(([activeId, storedProfiles, storedOverrides, storedCustoms]) => {
      const base = (storedProfiles ?? []).find((p) => p.profileId === activeId) ?? storedProfiles?.[0] ?? profiles[0];
      if (base !== undefined) {
        setProfile({ ...base, displayName: '当前生效配置' });
        if (activeId === undefined) void store.setConfig('activeDiningProfile', base.profileId);
      }
      setOverrides(storedOverrides ?? {});
      setCustoms(storedCustoms ?? []);
      setHydrated(true);
    });
  }, [profiles, store]);

  const merged = useMemo<UiProvider[]>(() => {
    const builtin = providers.map((p) => toUiProvider(p, overrides[p.id]));
    const custom = customs.map((c) => toUiCustom(c, overrides[c.id]?.keyMask ?? ''));
    return [...builtin, ...custom];
  }, [providers, customs, overrides]);

  const active = merged.find((p) => p.id === activeProvId) ?? merged[0];
  const ActiveIcon = active?.icon ?? Server;
  const providerUrl = active !== undefined ? (active.variants[active.activeVariant]?.baseUrl ?? '') : '';

  const persistOverrides = useCallback((next: ProviderOverrides): void => {
    setOverrides(next);
    void store.setConfig(OVERRIDES_KEY, next);
  }, [store]);

  const persistCustoms = useCallback((next: CustomProviderRecord[]): void => {
    setCustoms(next);
    void store.setConfig(CUSTOM_KEY, next);
  }, [store]);

  const persistProfile = useCallback((next: DiningProfilePreset): void => {
    const clean: DiningProfilePreset = { ...next, displayName: '当前生效配置' };
    setProfile(clean);
    void store.setConfig(DINING_KEY, [clean]);
    void store.setConfig('activeDiningProfile', clean.profileId);
  }, [store]);

  const syncBrain = useCallback((nextProfile: DiningProfilePreset, nextProviders: UiProvider[]): void => {
    void window.directorBridge
      .brainApplyConfig({
        profile: nextProfile,
        providerModels: {},
        providers: nextProviders.filter((p) => p.enabled).map(toConfig),
      })
      .then((r) => {
        window.dispatchEvent(new CustomEvent('wb:brain', { detail: { mode: r.mode, llmReady: r.llmReady } }));
        setNotice(
          r.ok
            ? { kind: 'ok', text: `主脑已热更新：${r.providers.join(' / ') || '—'}${r.missingKeys.length > 0 ? `（缺 Key：${r.missingKeys.join(', ')}）` : ''}` }
            : { kind: 'err', text: `主脑回落规则：${r.error ?? '未知错误'}` },
        );
      });
  }, []);

  const commitProvider = useCallback((ui: UiProvider): void => {
    if (profile === null) return;
    const nextMerged = merged.map((p) => (p.id === ui.id ? ui : p));
    if (ui.custom) {
      persistCustoms(customs.map((c) =>
        c.id === ui.id ? { ...c, name: ui.name, protocol: ui.protocol, variants: ui.variants, models: ui.models, enabled: ui.enabled } : c,
      ));
      persistOverrides({ ...overrides, [ui.id]: { ...overrides[ui.id], keyMask: ui.keyMask } });
    } else {
      persistOverrides({
        ...overrides,
        [ui.id]: { ...overrides[ui.id], enabled: ui.enabled, models: ui.models, variants: ui.variants, activeVariant: ui.activeVariant },
      });
    }
    syncBrain(profile, nextMerged);
  }, [profile, merged, customs, overrides, persistCustoms, persistOverrides, syncBrain]);

  const patchActive = (patch: Partial<UiProvider>): void => {
    if (active === undefined) return;
    commitProvider({ ...active, ...patch });
  };

  const bindSlot = (slot: WorkbenchRoleSlot, value: string): void => {
    if (profile === null) return;
    const next: DiningProfilePreset = { ...profile, roleBindings: { ...profile.roleBindings, [slot]: value } };
    persistProfile(next);
    syncBrain(next, merged);
    setNotice({ kind: 'ok', text: `${slotLabels[slot]} 已更新为 ${value === '' ? '（未绑定）' : value}` });
  };

  const setVariant = (index: number): void => {
    if (active === undefined) return;
    const variant = active.variants[index];
    if (variant === undefined) return;
    patchActive({ activeVariant: index, protocol: variant.protocol });
  };

  const setUrl = (url: string): void => {
    if (active === undefined) return;
    patchActive({ variants: active.variants.map((v, i) => (i === active.activeVariant ? { ...v, baseUrl: url } : v)) });
  };

  const setFullUrl = (checked: boolean): void => {
    if (active === undefined) return;
    patchActive({ variants: active.variants.map((v, i) => (i === active.activeVariant ? { ...v, isFullUrl: checked } : v)) });
    toast(checked ? '已开启完整地址模式（isFullUrl）' : '已切回自动拼接端点后缀');
  };

  const setProtocol = (protocol: Protocol): void => {
    if (active === undefined) return;
    patchActive({ protocol, variants: active.variants.map((v, i) => (i === active.activeVariant ? { ...v, protocol } : v)) });
  };

  const toggleModel = (modelId: string): void => {
    if (active === undefined || profile === null) return;
    const models = active.models.map((m) => (m.id === modelId ? { ...m, enabled: !m.enabled } : m));
    const fullId = `${active.id}/${modelId}`;
    if (models.find((m) => m.id === modelId)?.enabled === false) {
      const roleBindings = { ...profile.roleBindings };
      let changed = false;
      for (const [slot, binding] of Object.entries(roleBindings)) {
        if (binding === fullId) {
          roleBindings[slot as WorkbenchRoleSlot] = '';
          changed = true;
        }
      }
      if (changed) persistProfile({ ...profile, roleBindings });
    }
    patchActive({ models });
  };

  const setAsMain = (fullId: string): void => {
    if (profile === null) return;
    const next = { ...profile, roleBindings: { ...profile.roleBindings, MAIN_PERSONA_BRAIN: fullId } };
    persistProfile(next);
    syncBrain(next, merged);
    toast(`主脑已切换为 ${fullId}`);
  };

  const addModelManual = (): void => {
    if (active === undefined) return;
    const id = window.prompt('输入模型 ID（例如：glm-5.3-flash）')?.trim() ?? '';
    if (id === '') return;
    if (active.models.some((m) => m.id === id)) {
      toast.error('该模型已存在');
      return;
    }
    const caps = active.protocol === 'anthropic' ? ['anth', 'tool'] : ['tool'];
    patchActive({ models: [{ id, enabled: true, caps }, ...active.models] });
    toast(`已添加模型 ${id}`);
  };

  const removeModel = (modelId: string): void => {
    if (active === undefined || profile === null) return;
    const fullId = `${active.id}/${modelId}`;
    const roleBindings = { ...profile.roleBindings };
    for (const [slot, binding] of Object.entries(roleBindings)) {
      if (binding === fullId) roleBindings[slot as WorkbenchRoleSlot] = '';
    }
    persistProfile({ ...profile, roleBindings });
    patchActive({ models: active.models.filter((m) => m.id !== modelId) });
  };

  const deleteCustom = (): void => {
    if (active === undefined || !active.custom || profile === null) return;
    if (!window.confirm(`确认删除自定义服务商「${active.name}」？相关角色绑定会同步清理。`)) return;
    persistCustoms(customs.filter((c) => c.id !== active.id));
    const rest: ProviderOverrides = {};
    for (const [id, value] of Object.entries(overrides)) if (id !== active.id) rest[id] = value;
    persistOverrides(rest);
    const roleBindings = { ...profile.roleBindings };
    for (const [slot, binding] of Object.entries(roleBindings)) {
      if (binding.startsWith(`${active.id}/`)) roleBindings[slot as WorkbenchRoleSlot] = '';
    }
    persistProfile({ ...profile, roleBindings });
    setActiveProvId(providers[0]?.id ?? 'opencode-go');
    toast(`已删除自定义服务商「${active.name}」`);
  };

  const saveAndTest = async (): Promise<void> => {
    if (active === undefined) return;
    setBusy(`save:${active.id}`);
    setNotice(null);
    try {
      const draft = (keyDrafts[active.id] ?? '').trim();
      let keyMask = active.keyMask;
      if (draft !== '') {
        const saved = await window.directorBridge.saveProviderKey(active.id, draft);
        if (!saved.ok) {
          setNotice({ kind: 'err', text: saved.error ?? '凭据保存失败' });
          toast.error(saved.error ?? '凭据保存失败');
          return;
        }
        keyMask = saved.mask ?? '';
        setKeyDrafts((d) => ({ ...d, [active.id]: '' }));
      }
      const modelId = active.models.find((m) => m.enabled)?.id ?? active.models[0]?.id;
      if (modelId === undefined) {
        setNotice({ kind: 'err', text: '请先拉取或手动添加至少一个模型' });
        return;
      }
      const tested = await window.directorBridge.testProviderChat({ providerId: active.id, baseUrl: providerUrl, modelId, protocol: active.protocol });
      if (!tested.ok) {
        setNotice({ kind: 'err', text: `连接失败：${tested.error ?? '未知错误'}` });
        toast.error(`连接失败：${tested.error ?? '未知错误'}`);
        return;
      }
      let models = active.models;
      if (active.protocol === 'openai' && !active.local) {
        const discovered = await window.directorBridge.discoverModels({ providerId: active.id, baseUrl: providerUrl, protocol: active.protocol });
        if (discovered.ok && discovered.models !== undefined) {
          const known = new Set(models.map((m) => m.id));
          models = [...models, ...discovered.models.filter((id) => !known.has(id)).map((id) => ({ id, enabled: true, caps: ['tool'] }))];
        }
      }
      commitProvider({ ...active, keyMask, configured: true, enabled: true, models });
      setNotice({ kind: 'ok', text: `已连接 · 响应 ${tested.latencyMs ?? 0}ms · 已启用 ${models.filter((m) => m.enabled).length} 个模型` });
      toast(`${active.name} 凭据已加密保存，连通检测通过（${tested.latencyMs ?? 0}ms）`);
    } finally {
      setBusy(null);
    }
  };

  const testLocal = async (): Promise<void> => {
    if (active === undefined) return;
    const modelId = active.models.find((m) => m.enabled)?.id;
    if (modelId === undefined) {
      toast.error('请先添加模型');
      return;
    }
    const res = await window.directorBridge.testProviderChat({ providerId: active.id, baseUrl: providerUrl, modelId, protocol: active.protocol });
    setNotice(res.ok ? { kind: 'ok', text: `健康检查通过（${res.latencyMs ?? 0}ms）` } : { kind: 'err', text: res.error ?? '检测失败' });
    if (res.ok) toast(`${active.name} 健康检查通过`);
  };

  const pullModels = async (): Promise<void> => {
    if (active === undefined) return;
    setBusy(`pull:${active.id}`);
    try {
      const res = await window.directorBridge.discoverModels({ providerId: active.id, baseUrl: providerUrl, protocol: active.protocol });
      if (!res.ok || res.models === undefined) {
        const text = res.error ?? '拉取模型失败';
        setNotice({ kind: 'err', text });
        toast.error(text);
        return;
      }
      const known = new Set(active.models.map((m) => m.id));
      const models = [...active.models, ...res.models.filter((id) => !known.has(id)).map((id) => ({ id, enabled: true, caps: ['tool'] }))];
      commitProvider({ ...active, models });
      toast(`已从 ${active.name} 同步 ${res.models.length} 个可用模型`);
    } finally {
      setBusy(null);
    }
  };

  const syncAllToMain = (): void => {
    if (profile === null) return;
    const main = profile.roleBindings.MAIN_PERSONA_BRAIN ?? '';
    if (main === '') {
      toast.error('主脑尚未绑定模型');
      return;
    }
    const roleBindings = { ...profile.roleBindings };
    for (const meta of SLOT_META) if (meta.group === 'llm') roleBindings[meta.slot] = main;
    persistProfile({ ...profile, roleBindings });
    syncBrain({ ...profile, roleBindings }, merged);
    toast(`对话与推理角色已全部对齐至 ${main}`);
  };

  const createCustom = (): void => {
    const name = newName.trim();
    if (name === '') {
      toast.error('请填写服务商名称');
      return;
    }
    const baseUrl = newUrl.trim() === '' ? 'http://127.0.0.1:8000/v1' : newUrl.trim();
    const modelIds = newModels.split(/[,，]/).map((s) => s.trim()).filter((s) => s !== '');
    const record: CustomProviderRecord = {
      id: `custom-${Date.now()}`,
      name,
      protocol: newProto,
      variants: [{ region: 'GLOBAL', planType: 'PAY_AS_YOU_GO', baseUrl, isFullUrl: newFullUrl, protocol: newProto }],
      models: (modelIds.length > 0 ? modelIds : ['default-model']).map((id) => ({
        id,
        enabled: true,
        caps: [newProto === 'anthropic' ? 'anth' : 'tool'],
      })),
      enabled: true,
      createdAt: Date.now(),
    };
    persistCustoms([...customs, record]);
    setAddOpen(false);
    setNewName('');
    setNewUrl('');
    setNewModels('');
    setNewFullUrl(false);
    setActiveProvId(record.id);
    toast(`已创建自定义服务商「${name}」，请保存凭据`);
  };

  const scanImport = useCallback(async (source: 'magpie' | 'ccswitch' | 'file', filePath?: string): Promise<void> => {
    setImpBusy(true);
    setImpScan(null);
    try {
      const res = await window.directorBridge.providerImportScan({ source, filePath });
      setImpScan(res);
      setImpSelected(new Set(res.items.filter((i) => i.hasKey).map((i) => i.id)));
      if (!res.ok) toast.error(res.error ?? '扫描失败');
    } finally {
      setImpBusy(false);
    }
  }, []);

  const openImport = (): void => {
    setImpOpen(true);
    setImpSource('magpie');
    setImpFilePath(undefined);
    void scanImport('magpie');
  };

  const pickImportFile = async (): Promise<void> => {
    const picked = await window.directorBridge.providerImportPickFile();
    if (!picked.ok || picked.path === undefined) {
      if (picked.error !== undefined && picked.error !== '已取消') toast.error(picked.error);
      return;
    }
    setImpSource('file');
    setImpFilePath(picked.path);
    await scanImport('file', picked.path);
  };

  const applyImport = async (): Promise<void> => {
    if (impScan === null || impSelected.size === 0) {
      toast.error('请至少勾选 1 个服务商');
      return;
    }
    setImpBusy(true);
    try {
      const res: ImportApplyView = await window.directorBridge.providerImportApply({
        source: impSource,
        filePath: impFilePath,
        selectedIds: [...impSelected],
        policy: impPolicy,
      });
      if (!res.ok) {
        toast.error(res.error ?? '导入失败');
        return;
      }
      let nextCustoms = customs;
      const nextOverrides: ProviderOverrides = { ...overrides };
      for (const item of res.items) {
        if (item.action === 'skip') continue;
        const models: ModelEntry[] = item.models.map((id) => ({
          id,
          enabled: true,
          caps: [item.protocol === 'anthropic' ? 'anth' : 'tool'],
        }));
        if (item.matchedBuiltin) {
          nextOverrides[item.id] = {
            ...nextOverrides[item.id],
            keyMask: item.keyMask,
            enabled: true,
            models,
            variants: [{ region: 'GLOBAL', planType: 'PAY_AS_YOU_GO', baseUrl: item.baseUrl, isFullUrl: item.isFullUrl, protocol: item.protocol }],
            activeVariant: 0,
          };
        } else {
          nextCustoms = [
            ...nextCustoms,
            {
              id: item.id,
              name: item.name,
              protocol: item.protocol,
              variants: [{ region: 'GLOBAL', planType: 'PAY_AS_YOU_GO', baseUrl: item.baseUrl, isFullUrl: item.isFullUrl, protocol: item.protocol }],
              models,
              enabled: true,
              createdAt: Date.now(),
            },
          ];
          nextOverrides[item.id] = { ...nextOverrides[item.id], keyMask: item.keyMask };
        }
      }
      persistCustoms(nextCustoms);
      persistOverrides(nextOverrides);
      if (profile !== null) {
        syncBrain(profile, [
          ...providers.map((p) => toUiProvider(p, nextOverrides[p.id])),
          ...nextCustoms.map((c) => toUiCustom(c, nextOverrides[c.id]?.keyMask ?? '')),
        ]);
      }
      const created = res.items.filter((i) => i.action === 'create').length;
      const updated = res.items.filter((i) => i.action === 'update').length;
      const skipped = res.items.filter((i) => i.action === 'skip').length;
      toast(`导入完成：新增 ${created} 家，更新 ${updated} 家${skipped > 0 ? `，跳过 ${skipped} 家（已有凭据）` : ''}`);
      setImpOpen(false);
    } finally {
      setImpBusy(false);
    }
  };

  if (!hydrated || profile === null) {
    return <div className="p-6 text-sm" style={{ color: 'var(--text-3)' }}>配置加载中…</div>;
  }

  const keyword = search.trim().toLowerCase();
  const groups: UiGroup[] = ['云端服务', '自定义服务商', '本地引擎'];
  const enabledCount = merged.filter((p) => p.enabled).length;
  const configuredCount = merged.filter((p) => p.configured).length;
  const slotOptions = merged
    .filter((p) => p.enabled)
    .flatMap((p) => p.models.filter((m) => m.enabled).map((m) => ({ value: `${p.id}/${m.id}`, label: `${p.name} · ${m.id}`, audio: p.audio })));

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex items-center justify-between gap-4 px-6 py-3.5" style={{ borderBottom: '1px solid var(--stroke)' }}>
        <div>
          <h1 className="text-base font-semibold">模型与服务商</h1>
          <div className="mt-0.5 text-[11px]" style={{ color: 'var(--text-3)' }}>内置主流服务商 + OpenCode Go + 自定义兼容端点 · 取消三档切换，改完即生效</div>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          <button className="btn-pill ghost" onClick={openImport} data-provider-import>
            <Download size={13} />导入 Magpie / CC Switch
          </button>
          <div className="seg-tabs">
            <button className={`seg-tab${tab === 'providers' ? ' on' : ''}`} data-ptab="providers" onClick={() => setTab('providers')}>
              <Server size={12} />服务商配置
            </button>
            <button className={`seg-tab${tab === 'defaults' ? ' on' : ''}`} data-ptab="defaults" onClick={() => setTab('defaults')}>
              <SlidersHorizontal size={12} />默认模型 (6)
            </button>
          </div>
        </div>
      </div>

      {notice !== null && (
        <div
          data-provider-notice
          className="mono mx-6 mt-3 flex items-center gap-2 rounded-xl px-3 py-2 text-[11px]"
          style={{
            background: notice.kind === 'ok' ? 'var(--green-dim)' : notice.kind === 'err' ? 'var(--red-dim)' : 'var(--blue-dim)',
            border: `1px solid ${notice.kind === 'ok' ? 'var(--green-line)' : notice.kind === 'err' ? 'var(--red-line)' : 'var(--blue-line)'}`,
            color: notice.kind === 'ok' ? 'var(--green)' : notice.kind === 'err' ? 'var(--red)' : 'var(--blue)',
          }}
        >
          {notice.kind === 'ok' ? <CheckCircle2 size={12} /> : <Info size={12} />}
          {notice.text}
        </div>
      )}

      {tab === 'providers' ? (
        <div className="grid min-h-0 flex-1" style={{ gridTemplateColumns: '256px 1fr' }}>
          <aside className="flex min-h-0 flex-col" style={{ borderRight: '1px solid var(--stroke)', background: 'color-mix(in srgb, var(--bg-elev) 32%, transparent)' }}>
            <div className="flex gap-1.5 px-3 py-2.5" style={{ borderBottom: '1px solid var(--stroke)' }}>
              <div className="flex flex-1 items-center gap-1.5 rounded-lg px-2.5" style={{ background: 'var(--inset)', border: '1px solid var(--stroke)' }}>
                <Search size={12} style={{ color: 'var(--text-3)' }} />
                <input
                  data-provider-search
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="搜索服务商…"
                  className="w-full bg-transparent py-1.5 text-[12px] outline-none"
                  style={{ color: 'var(--text-1)' }}
                />
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1.5">
              {groups.map((group) => {
                const list = merged.filter((p) => p.group === group && (keyword === '' || p.name.toLowerCase().includes(keyword)));
                if (list.length === 0) return null;
                return (
                  <div key={group}>
                    <div className="flex justify-between px-2.5 pb-1 pt-2 text-[10px] font-semibold tracking-wider" style={{ color: 'var(--text-3)' }}>
                      <span>{group}</span><span className="mono">{list.length}</span>
                    </div>
                    {list.map((p) => {
                      const Icon = p.icon;
                      const on = p.id === active?.id;
                      return (
                        <button
                          key={p.id}
                          data-provider-item={p.id}
                          data-active={on ? 'true' : 'false'}
                          onClick={() => setActiveProvId(p.id)}
                          className="mb-0.5 flex w-full items-center gap-2.5 rounded-xl px-2.5 py-[7px] text-left text-[12.5px] transition-colors"
                          style={on ? { background: 'var(--blue-dim)', color: 'var(--blue)', fontWeight: 600 } : { color: 'var(--text-2)' }}
                        >
                          <span className="grid h-6 w-6 place-items-center rounded-lg" style={{ background: on ? 'var(--blue-dim)' : 'var(--inset)', border: `1px solid ${on ? 'var(--blue-line)' : 'var(--stroke)'}` }}>
                            <Icon size={12} />
                          </span>
                          <span className="flex-1 truncate">{p.name}</span>
                          <span
                            className="h-1.5 w-1.5 rounded-full"
                            style={{ background: p.enabled && p.configured ? 'var(--green)' : 'var(--text-3)', opacity: p.enabled && p.configured ? 1 : 0.3, boxShadow: p.enabled && p.configured ? '0 0 6px var(--green)' : 'none' }}
                          />
                        </button>
                      );
                    })}
                  </div>
                );
              })}
            </div>
            <div className="px-3 py-2.5" style={{ borderTop: '1px solid var(--stroke)' }}>
              <button className="btn-pill ghost w-full" onClick={() => setAddOpen(true)} data-add-provider>
                <Plus size={13} />添加自定义服务商
              </button>
            </div>
          </aside>

          <div className="min-h-0 overflow-y-auto px-7 pb-12 pt-5">
            {active === undefined ? (
              <div className="text-sm" style={{ color: 'var(--text-3)' }}>无匹配服务商</div>
            ) : (
              <div className="mx-auto max-w-[780px]">
                <div className="mb-4 flex items-center gap-3 pb-4" style={{ borderBottom: '1px solid var(--stroke)' }}>
                  <span className="grid h-10 w-10 place-items-center rounded-xl" style={{ background: 'var(--blue-dim)', border: '1px solid var(--blue-line)', color: 'var(--blue)' }}>
                    <ActiveIcon size={18} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <h2 className="flex flex-wrap items-center gap-2 text-[17px] font-bold">
                      {active.name}
                      <span className="pill" style={{ fontSize: 10 }}>{active.tag}</span>
                    </h2>
                    <div className="mt-0.5 text-[11.5px]" style={{ color: 'var(--text-3)' }}>
                      {active.enabled ? '已启用 · 模型可在「默认模型」中直接选用' : '未启用 · 开启后将在模型选择器中显示'}
                    </div>
                  </div>
                  {active.custom && (
                    <button className="btn-pill red" style={{ padding: '5px 12px', fontSize: 11 }} onClick={deleteCustom} data-delete-provider>
                      <Trash2 size={12} />删除
                    </button>
                  )}
                  <button
                    className={`sw${active.enabled ? ' on' : ''}`}
                    data-provider-enabled={active.id}
                    aria-pressed={active.enabled}
                    onClick={() => patchActive({ enabled: !active.enabled })}
                    title="启用/停用该服务商"
                  />
                </div>

                <section className="card px-4 py-4" style={{ borderRadius: 'var(--r-lg)' }}>
                  {active.custom && (
                    <div className="mb-3">
                      <div className="mb-1.5 text-[11.5px] font-semibold" style={{ color: 'var(--text-2)' }}>服务商名称与协议</div>
                      <input
                        className="mb-2 w-full rounded-lg px-3 py-2 text-[12.5px] outline-none"
                        style={{ background: 'var(--inset)', border: '1px solid var(--stroke)', color: 'var(--text-1)' }}
                        value={active.name}
                        onChange={(e) => patchActive({ name: e.target.value })}
                        data-custom-name
                      />
                      <div className="flex flex-wrap gap-1.5">
                        {(['openai', 'anthropic'] as const).map((p) => (
                          <button key={p} className={`pill${active.protocol === p ? ' pill-blue' : ''}`} style={{ fontSize: 11 }} onClick={() => setProtocol(p)} data-custom-proto={p}>
                            {p === 'anthropic' ? 'Anthropic 兼容 (/messages)' : 'OpenAI 兼容 (/chat/completions)'}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {active.local ? (
                    <div>
                      <div className="mb-1.5 flex items-center justify-between text-[11.5px] font-semibold" style={{ color: 'var(--text-2)' }}>
                        <span>服务地址</span>
                        <span className="pill pill-green" style={{ fontSize: 10 }}>本地直连</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <input
                          className="min-w-0 flex-1 rounded-lg px-3 py-2 font-mono text-[12.5px] outline-none"
                          style={{ background: 'var(--inset)', border: '1px solid var(--stroke)', color: 'var(--text-1)' }}
                          value={providerUrl}
                          onChange={(e) => setUrl(e.target.value)}
                        />
                        <button className="btn-pill primary" onClick={() => void testLocal()} disabled={busy !== null}>
                          <Activity size={13} />检测服务
                        </button>
                      </div>
                      <div className="mt-1.5 flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--green)' }}>
                        <CheckCircle2 size={12} />本地引擎无需外部凭据，断网可用
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="mb-3">
                        <div className="mb-1.5 flex items-center justify-between text-[11.5px] font-semibold" style={{ color: 'var(--text-2)' }}>
                          <span>访问凭据</span>
                          <span className="font-normal" style={{ color: 'var(--text-3)' }}>仅保存在本机系统加密存储</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <input
                            data-key-input={active.id}
                            type="password"
                            className="min-w-0 flex-1 rounded-lg px-3 py-2 font-mono text-[12.5px] outline-none"
                            style={{ background: 'var(--inset)', border: '1px solid var(--stroke)', color: 'var(--text-1)' }}
                            placeholder={active.configured ? `已保存 ${active.keyMask}（留空保持不变）` : '粘贴服务访问凭据'}
                            value={keyDrafts[active.id] ?? ''}
                            onChange={(e) => setKeyDrafts((d) => ({ ...d, [active.id]: e.target.value }))}
                          />
                          <button className="btn-pill primary whitespace-nowrap" onClick={() => void saveAndTest()} disabled={busy !== null} data-save-test>
                            <Check size={13} />{busy === `save:${active.id}` ? '检测中…' : '保存并检测'}
                          </button>
                        </div>
                        <div className="mt-1.5 flex items-center gap-1.5 text-[11px]" style={{ color: active.configured ? 'var(--green)' : 'var(--text-3)' }}>
                          {active.configured ? <CheckCircle2 size={12} /> : <Info size={12} />}
                          {active.configured
                            ? `已连接 · 已启用 ${active.models.filter((m) => m.enabled).length} 个模型`
                            : '填写凭据后点「保存并检测」，自动验证连通性并尝试拉取模型列表'}
                        </div>
                      </div>

                      <div>
                        <div className="mb-1.5 flex items-center justify-between text-[11.5px] font-semibold" style={{ color: 'var(--text-2)' }}>
                          <span>接口地址（Base URL）</span>
                          <span className="pill" style={{ fontSize: 10 }}>{active.protocol === 'anthropic' ? 'Anthropic /messages' : 'OpenAI /chat/completions'}</span>
                        </div>
                        {active.variants.length > 1 && (
                          <div className="mb-2 flex flex-wrap gap-1.5">
                            {active.variants.map((v, i) => (
                              <button
                                key={`${v.region}-${v.planType}-${v.protocol}-${i}`}
                                className={`pill${i === active.activeVariant ? ' pill-blue' : ''}`}
                                style={{ fontSize: 11 }}
                                onClick={() => setVariant(i)}
                                data-variant={i}
                              >
                                {v.protocol === 'anthropic' ? 'Anthropic' : v.region}{v.planType === 'CODING_PLAN' ? ' · 包月' : ''}
                              </button>
                            ))}
                          </div>
                        )}
                        <input
                          data-base-url
                          className="w-full rounded-lg px-3 py-2 font-mono text-[12.5px] outline-none"
                          style={{ background: 'var(--inset)', border: '1px solid var(--stroke)', color: 'var(--text-1)' }}
                          value={providerUrl}
                          onChange={(e) => setUrl(e.target.value)}
                        />
                        <label className="mt-2 flex cursor-pointer items-center gap-2 text-[11.5px]" style={{ color: 'var(--text-2)' }}>
                          <input
                            type="checkbox"
                            checked={active.variants[active.activeVariant]?.isFullUrl ?? false}
                            onChange={(e) => setFullUrl(e.target.checked)}
                            style={{ accentColor: 'var(--blue)' }}
                            data-full-url
                          />
                          完整地址模式（isFullUrl：原样请求，不自动追加后缀）
                        </label>
                        {active.note !== '' && (
                          <div className="mt-1.5 flex items-start gap-1.5 text-[11px] leading-relaxed" style={{ color: 'var(--text-3)' }}>
                            <Sparkles size={12} style={{ color: 'var(--blue)', flexShrink: 0, marginTop: 2 }} />{active.note}
                          </div>
                        )}
                      </div>
                    </>
                  )}
                </section>

                <div className="mb-2 mt-4 flex flex-wrap items-center gap-2">
                  <h3 className="text-[13px] font-semibold">模型列表 ({active.models.filter((m) => m.enabled).length} / {active.models.length})</h3>
                  <div className="flex-1" />
                  <button className="btn-pill ghost" onClick={() => void pullModels()} disabled={busy !== null} data-pull-models>
                    <RefreshCw size={12} />{busy === `pull:${active.id}` ? '拉取中…' : '拉取模型'}
                  </button>
                  <button className="btn-pill ghost" onClick={addModelManual} data-add-model>
                    <Plus size={12} />手动添加
                  </button>
                </div>
                <div className="card overflow-hidden">
                  {active.models.length === 0 && (
                    <div className="px-4 py-6 text-center text-[12px]" style={{ color: 'var(--text-3)' }}>暂无模型，可点击「拉取模型」或「手动添加」</div>
                  )}
                  {active.models.map((m) => (
                    <div key={m.id} className="flex items-center gap-2.5 px-3.5 py-2.5" style={{ borderBottom: '1px solid var(--stroke)' }}>
                      <span className="font-mono text-[12.5px] font-medium" style={{ color: 'var(--text-1)' }}>{m.id}</span>
                      <div className="flex flex-wrap gap-1">
                        {m.caps.map((c) => {
                          const cap = CAP_LABEL[c] ?? { text: c, cls: '' };
                          return <span key={c} className={`pill ${cap.cls}`} style={{ fontSize: 9.5, padding: '1px 7px' }}>{cap.text}</span>;
                        })}
                      </div>
                      <div className="flex-1" />
                      {!active.audio && (
                        <button className="pill" style={{ fontSize: 10.5 }} onClick={() => setAsMain(`${active.id}/${m.id}`)} data-set-main={m.id}>设为主脑</button>
                      )}
                      {active.custom && (
                        <button className="icon-btn h-6 w-6" style={{ color: 'var(--text-3)' }} onClick={() => removeModel(m.id)} title="移除模型">
                          <Trash2 size={12} />
                        </button>
                      )}
                      <button className={`sw${m.enabled ? ' on' : ''}`} data-model-toggle={m.id} aria-pressed={m.enabled} onClick={() => toggleModel(m.id)} title="启用或隐藏此模型" />
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-7 pb-12 pt-6">
          <div className="mx-auto max-w-[780px]">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2.5">
              <div>
                <div className="text-sm font-semibold">功能默认模型</div>
                <div className="mt-0.5 text-[11.5px]" style={{ color: 'var(--text-3)' }}>仅从已启用的服务商模型中选择，修改后自动保存并立即同步主脑路由</div>
              </div>
              <button className="btn-pill ghost" onClick={syncAllToMain} data-sync-all-main>
                <SlidersHorizontal size={12} />文本角色全部跟随主脑
              </button>
            </div>

            {(['llm', 'audio'] as const).map((group) => (
              <div key={group}>
                <div className="mb-2 mt-4 text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-3)' }}>
                  {group === 'llm' ? '对话与推理（LLM / 视觉）' : '语音合成与演唱（TTS / SVC）'}
                </div>
                <div className="card overflow-hidden">
                  {SLOT_META.filter((s) => s.group === group).map((meta) => {
                    const Icon = meta.icon;
                    const options = slotOptions.filter((o) => o.audio === (group === 'audio'));
                    const current = profile.roleBindings[meta.slot] ?? '';
                    const optionExists = options.some((o) => o.value === current);
                    return (
                      <div key={meta.slot} className="grid items-center gap-4 px-4 py-3" style={{ gridTemplateColumns: '1fr 300px', borderBottom: '1px solid var(--stroke)' }}>
                        <div className="flex min-w-0 items-center gap-2.5">
                          <span className="grid h-8 w-8 place-items-center rounded-lg" style={{ background: 'var(--inset)', border: '1px solid var(--stroke)', color: 'var(--blue)' }}>
                            <Icon size={14} />
                          </span>
                          <div className="min-w-0">
                            <div className="text-[13px] font-semibold">{meta.name}</div>
                            <div className="mt-0.5 text-[11px]" style={{ color: 'var(--text-3)' }}>{meta.desc}</div>
                          </div>
                        </div>
                        <select
                          data-slot-select={meta.slot}
                          className="w-full rounded-lg px-2.5 py-2 font-mono text-[12px] outline-none"
                          style={{ background: 'var(--inset)', border: '1px solid var(--stroke)', color: 'var(--text-1)' }}
                          value={optionExists ? current : ''}
                          onChange={(e) => bindSlot(meta.slot, e.target.value)}
                        >
                          <option value="">（未绑定）</option>
                          {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </select>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}

            <div className="mt-4 flex items-center gap-2 text-[11px]" style={{ color: 'var(--text-3)' }}>
              <Database size={12} />{enabledCount} 家服务商已启用 · {configuredCount} 家已配置凭据 · 槽位改动即时写 Dexie 并热更新主脑
            </div>
          </div>
        </div>
      )}

      {addOpen && (
        <div className="fixed inset-0 z-[150] flex items-center justify-center" style={{ background: 'rgba(0,0,0,.52)', backdropFilter: 'blur(6px)' }} onClick={(e) => { if (e.target === e.currentTarget) setAddOpen(false); }}>
          <div className="w-[460px] max-w-[92vw] rounded-2xl p-5" style={{ background: 'var(--bg-elev)', border: '1px solid var(--stroke-2)', boxShadow: 'var(--shadow-2)' }}>
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-[15px] font-semibold">添加自定义服务商</h3>
              <button className="icon-btn" onClick={() => setAddOpen(false)}><X size={14} /></button>
            </div>
            <label className="mb-3 block">
              <span className="mb-1.5 block text-[11.5px] font-semibold" style={{ color: 'var(--text-2)' }}>服务商名称</span>
              <input className="w-full rounded-lg px-3 py-2 text-[12.5px] outline-none" style={{ background: 'var(--inset)', border: '1px solid var(--stroke)', color: 'var(--text-1)' }} value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="例如：自建 vLLM / 团队中转网关" data-new-name />
            </label>
            <div className="mb-3">
              <span className="mb-1.5 block text-[11.5px] font-semibold" style={{ color: 'var(--text-2)' }}>接口协议</span>
              <div className="flex flex-wrap gap-1.5">
                {(['openai', 'anthropic'] as const).map((p) => (
                  <button key={p} className={`pill${newProto === p ? ' pill-blue' : ''}`} style={{ fontSize: 11 }} onClick={() => setNewProto(p)} data-new-proto={p}>
                    {p === 'anthropic' ? 'Anthropic 兼容 (/messages)' : 'OpenAI 兼容 (/chat/completions)'}
                  </button>
                ))}
              </div>
            </div>
            <label className="mb-1 block">
              <span className="mb-1.5 block text-[11.5px] font-semibold" style={{ color: 'var(--text-2)' }}>接口地址（Base URL）</span>
              <input className="w-full rounded-lg px-3 py-2 font-mono text-[12.5px] outline-none" style={{ background: 'var(--inset)', border: '1px solid var(--stroke)', color: 'var(--text-1)' }} value={newUrl} onChange={(e) => setNewUrl(e.target.value)} placeholder="例如：http://127.0.0.1:8000/v1" data-new-url />
            </label>
            <label className="mb-3 flex cursor-pointer items-center gap-2 text-[11.5px]" style={{ color: 'var(--text-2)' }}>
              <input type="checkbox" checked={newFullUrl} onChange={(e) => setNewFullUrl(e.target.checked)} style={{ accentColor: 'var(--blue)' }} />
              完整端点地址（不自动拼接 /chat/completions 或 /messages）
            </label>
            <label className="mb-1 block">
              <span className="mb-1.5 block text-[11.5px] font-semibold" style={{ color: 'var(--text-2)' }}>初始模型 ID（可选，逗号分隔）</span>
              <input className="w-full rounded-lg px-3 py-2 font-mono text-[12.5px] outline-none" style={{ background: 'var(--inset)', border: '1px solid var(--stroke)', color: 'var(--text-1)' }} value={newModels} onChange={(e) => setNewModels(e.target.value)} placeholder="例如：deepseek-v4-flash, qwen3-32b" data-new-models />
            </label>
            <div className="mt-4 flex justify-end gap-2">
              <button className="btn-pill ghost" onClick={() => setAddOpen(false)}>取消</button>
              <button className="btn-pill primary" onClick={createCustom} data-create-provider>创建并配置</button>
            </div>
          </div>
        </div>
      )}

      {impOpen && (
        <div className="fixed inset-0 z-[150] flex items-center justify-center" style={{ background: 'rgba(0,0,0,.52)', backdropFilter: 'blur(6px)' }} onClick={(e) => { if (e.target === e.currentTarget) setImpOpen(false); }}>
          <div className="w-[560px] max-w-[92vw] rounded-2xl p-5" style={{ background: 'var(--bg-elev)', border: '1px solid var(--stroke-2)', boxShadow: 'var(--shadow-2)' }}>
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-[15px] font-semibold">导入外部配置（Magpie / CC Switch）</h3>
              <button className="icon-btn" onClick={() => setImpOpen(false)}><X size={14} /></button>
            </div>
            <div className="mb-3">
              <div className="mb-1.5 text-[11.5px] font-semibold" style={{ color: 'var(--text-2)' }}>选择来源（主进程只读解析，绝不修改原配置）</div>
              <div className="flex flex-wrap gap-1.5">
                <button className={`pill${impSource === 'magpie' ? ' pill-blue' : ''}`} style={{ fontSize: 11 }} onClick={() => { setImpSource('magpie'); setImpFilePath(undefined); void scanImport('magpie'); }}>
                  <FileJson size={11} />Magpie
                </button>
                <button className={`pill${impSource === 'ccswitch' ? ' pill-blue' : ''}`} style={{ fontSize: 11 }} onClick={() => { setImpSource('ccswitch'); setImpFilePath(undefined); void scanImport('ccswitch'); }}>
                  <Database size={11} />CC Switch
                </button>
                <button className={`pill${impSource === 'file' ? ' pill-blue' : ''}`} style={{ fontSize: 11 }} onClick={() => void pickImportFile()}>
                  <Download size={11} />手动选 JSON / DB
                </button>
              </div>
              <div className="mono mt-1.5 flex items-center gap-1.5 text-[10.5px]" style={{ color: impScan?.ok ? 'var(--green)' : impScan === null ? 'var(--text-3)' : 'var(--red)' }}>
                {impBusy ? <RefreshCw size={11} /> : <Info size={11} />}
                {impBusy ? '只读扫描中…' : impScan?.ok ? `已读取 ${impScan.detectedPath || '手动文件'} · 发现 ${impScan.items.length} 个可导入服务商` : (impScan?.error ?? '等待扫描')}
              </div>
            </div>
            <div className="mb-3">
              <div className="mb-1.5 flex items-center justify-between text-[11.5px] font-semibold" style={{ color: 'var(--text-2)' }}>
                <span>预览待导入项（勾选需迁移的服务商）</span>
                <span className="mono font-normal" style={{ color: 'var(--text-3)' }}>已选 {impSelected.size} 项</span>
              </div>
              <div className="card max-h-[220px] overflow-y-auto">
                {impScan?.items.map((item) => (
                  <div
                    key={item.id}
                    className="flex cursor-pointer items-center gap-2 px-3 py-2"
                    style={{ borderBottom: '1px solid var(--stroke)' }}
                    onClick={() => setImpSelected((prev) => {
                      const next = new Set(prev);
                      if (next.has(item.id)) next.delete(item.id); else next.add(item.id);
                      return next;
                    })}
                  >
                    <input type="checkbox" checked={impSelected.has(item.id)} readOnly style={{ accentColor: 'var(--blue)' }} />
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 text-[12.5px] font-semibold">
                        {item.name}
                        <span className={`pill ${item.protocol === 'anthropic' ? 'pill-amber' : 'pill-green'}`} style={{ fontSize: 9.5 }}>{item.protocol}</span>
                      </div>
                      <div className="mono mt-0.5 truncate text-[10.5px]" style={{ color: 'var(--text-3)' }}>
                        {item.baseUrl} · {item.models.length} 个模型 · {item.hasKey ? `凭据 ${item.keyMask}` : '无凭据'}
                      </div>
                    </div>
                    <div className="flex-1" />
                    <span className={`pill ${item.matchedBuiltin ? 'pill-blue' : 'pill-violet'}`} style={{ fontSize: 9.5 }}>
                      {item.matchedBuiltin ? '匹配内置项' : '新增为自定义'}
                    </span>
                  </div>
                ))}
                {impScan !== null && impScan.items.length === 0 && (
                  <div className="px-4 py-5 text-center text-[12px]" style={{ color: 'var(--text-3)' }}>没有可导入的服务商</div>
                )}
              </div>
            </div>
            <div className="mb-4">
              <div className="mb-1.5 text-[11.5px] font-semibold" style={{ color: 'var(--text-2)' }}>同名服务商冲突策略</div>
              <div className="flex flex-wrap gap-1.5">
                <button className={`pill${impPolicy === 'skip' ? ' pill-blue' : ''}`} style={{ fontSize: 11 }} onClick={() => setImpPolicy('skip')}>跳过已有凭据（默认安全）</button>
                <button className={`pill${impPolicy === 'overwrite' ? ' pill-blue' : ''}`} style={{ fontSize: 11 }} onClick={() => setImpPolicy('overwrite')}>覆盖已有凭据与地址</button>
              </div>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[11px]" style={{ color: 'var(--text-3)' }}>导入后自动加密转存至本机安全存储</span>
              <div className="flex gap-2">
                <button className="btn-pill ghost" onClick={() => setImpOpen(false)}>取消</button>
                <button className="btn-pill primary" onClick={() => void applyImport()} disabled={impBusy || impSelected.size === 0} data-import-apply>
                  <Download size={13} />加密导入所选
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
