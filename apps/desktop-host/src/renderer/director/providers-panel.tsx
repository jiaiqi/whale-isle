/**
 * 模型与服务商 v5（T-M6-09，按 design/providers.html 重构）：
 *   - 单一当前生效配置（取消三档干饭套餐心智；改动即写 Dexie 并 brainApplyConfig 热更新）
 *   - Master-Detail：256px 服务商目录（云端/自定义/本地）+ 专注配置面板
 *   - 默认模型 Tab：六槽位只从「已启用服务商 × 已启用模型」中选择
 *   - 自定义服务商全生命周期（Dexie customProviders）+ Magpie / CC Switch 只读导入
 * 密钥永远只在主进程 safeStorage；本组件只持有掩码。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  Activity, AudioLines, Box, Brain, Check, CheckCircle2, Compass, Copy, Database, Download, Eye,
  ExternalLink, FileJson, Fish, Flame, Info, MessageSquare, Music, Plug, Plus, RefreshCw, Rocket, Scale, Search,
  Server, Shield, SlidersHorizontal, Sparkles, Sprout, Swords, Trash2, TriangleAlert, Volume2, Waves, X, Zap,
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
/** 槽位自动挑选开关（渲染层专用 Dexie 键，不进契约：主进程只消费解析后的具体绑定） */
const AUTO_KEY = 'slotAutoFlags';

/** 支持查余额的厂商（与主进程 BALANCE_PROBES 对应） */
const BALANCE_SUPPORTED: ReadonlySet<string> = new Set(['openrouter', 'deepseek-official', 'siliconflow', 'opencode-go']);

interface ModelEntry {
  id: string;
  enabled: boolean;
  caps: string[];
}

interface ModelTestEntry {
  ok: boolean;
  latencyMs?: number;
  error?: string;
}

interface ProviderOverride {
  keyMask?: string;
  enabled?: boolean;
  models?: ModelEntry[];
  variants?: ProviderEndpointVariant[];
  activeVariant?: number;
  /** 最近一次「保存并检测」的连通结论：true=已连通；false=凭据已存但检测未通过；undefined=未检测过 */
  testOk?: boolean;
  /** 逐模型连通测试结果（自动挑选的依据，跨会话持久） */
  tested?: Record<string, ModelTestEntry>;
  /** 最近一次余额查询结果（可读文案 + 时间戳） */
  balance?: { text: string; at: number };
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
  logoSrc?: string;
  protocol: Protocol;
  variants: ProviderEndpointVariant[];
  activeVariant: number;
  models: ModelEntry[];
  enabled: boolean;
  configured: boolean;
  keyMask: string;
  testOk?: boolean;
  balance?: { text: string; at: number };
  local: boolean;
  audio: boolean;
  custom: boolean;
  note: string;
}

const SLOT_META: Array<{ slot: WorkbenchRoleSlot; name: string; desc: string; group: 'llm' | 'audio'; icon: LucideIcon }> = [
  { slot: 'MAIN_PERSONA_BRAIN', name: '主脑与内心戏', desc: '日常聊天、人设表达与 <think> 推理', group: 'llm', icon: Brain },
  { slot: 'STARDEW_GAME_PLANNER', name: '星露谷规划器', desc: '自动驾驶工具决策与攻略应用', group: 'llm', icon: Sprout },
  { slot: 'TERRARIA_GAME_PLANNER', name: '泰拉瑞亚规划器', desc: 'tModLoader 桥接动作决策与生存反射', group: 'llm', icon: Swords },
  { slot: 'DST_GAME_PLANNER', name: '饥荒 DST 规划器', desc: '专用服侧动作决策与昼夜生存', group: 'llm', icon: Flame },
  { slot: 'DANMAKU_FAST_ROUTER', name: '弹幕快反路由', desc: '低延迟弹幕清洗、打分与快速回应', group: 'llm', icon: MessageSquare },
  { slot: 'VISION_STORYBOARD', name: '翻车视觉复盘', desc: '截图与宫格分镜画面理解', group: 'llm', icon: Eye },
  { slot: 'VOICE_TTS_SPEECH', name: '日常说话 TTS', desc: '五档情绪台词与心声气声合成', group: 'audio', icon: Volume2 },
  { slot: 'VOICE_SVC_SINGING', name: '点歌演唱 SVC', desc: '伴奏分离与 RVC 变声演唱', group: 'audio', icon: Music },
];

const TAG: Record<string, string> = {
  'opencode-go': '包月订阅 · 30+ 模型',
  'opencode-zen': '原 Zen · 免费档 + 按量',
  'typesafe-jev': '决策协议 · System One',
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
  'typesafe-jev': Scale,
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

/**
 * 供应商官方 logo（2026-11-22 从各家官网 favicon / GitHub 官方组织头像收集，
 * 台账见 docs/THIRD_PARTY_NOTICES.md §3；商标权属各公司，仅作身份识别的指称性使用）。
 * 无官方标识的（自定义 / GPT-SoVITS 等本地引擎）回落 lucide 图标，绝不生成或乱用替代图。
 */
const LOGO: Record<string, string> = {
  'opencode-go': '../brand/providers/opencode.svg',
  'opencode-zen': '../brand/providers/opencode.svg',
  'typesafe-jev': '../brand/providers/typesafe-jev.jpg',
  'deepseek-official': '../brand/providers/deepseek-official.png',
  siliconflow: '../brand/providers/siliconflow.png',
  openrouter: '../brand/providers/openrouter.png',
  'volcano-ark': '../brand/providers/volcano-ark.jpg',
  openai: '../brand/providers/openai.svg',
  anthropic: '../brand/providers/anthropic.png',
  minimax: '../brand/providers/minimax.png',
  'local-ollama': '../brand/providers/local-ollama.png',
};

/** logo 优先、lucide 兜底的供应商图标；className 控制外框尺寸与圆角 */
function ProviderLogo({ src, icon: Icon, size = 14, className = '' }: { src?: string; icon: LucideIcon; size?: number; className?: string }): React.JSX.Element {
  return src !== undefined
    ? <img src={src} alt="" className={`object-contain ${className}`} style={{ width: size, height: size }} />
    : <Icon size={size} />;
}

/** 侧栏供应商行（与「已关闭」折叠子区共用；dimmed = Magpie 停用沉降态） */
function ProviderRow({ p, activeId, dimmed, onSelect }: { p: UiProvider; activeId: string | undefined; dimmed?: boolean; onSelect: () => void }): React.JSX.Element {
  const Icon = p.icon;
  const on = p.id === activeId;
  return (
    <button
      data-provider-item={p.id}
      data-active={on ? 'true' : 'false'}
      onClick={onSelect}
      className="mb-0.5 flex w-full items-center gap-2.5 rounded-xl px-2.5 py-[7px] text-left text-[12.5px] transition-colors"
      style={on ? { background: 'var(--blue-dim)', color: 'var(--blue)', fontWeight: 600 } : { color: 'var(--text-2)', opacity: dimmed === true ? 0.55 : 1 }}
    >
      <span
        className="grid h-6 w-6 place-items-center rounded-lg"
        style={{ background: p.logoSrc !== undefined ? '#fff' : on ? 'var(--blue-dim)' : 'var(--inset)', border: `1px solid ${on ? 'var(--blue-line)' : 'var(--stroke)'}` }}
      >
        <ProviderLogo src={p.logoSrc} icon={Icon} size={p.logoSrc !== undefined ? 15 : 12} />
      </span>
      <span className="flex-1 truncate">{p.name}</span>
      <span
        className="h-1.5 w-1.5 rounded-full"
        style={{ background: p.enabled && p.configured ? 'var(--green)' : 'var(--text-3)', opacity: p.enabled && p.configured ? 1 : 0.3, boxShadow: p.enabled && p.configured ? '0 0 6px var(--green)' : 'none' }}
      />
    </button>
  );
}

/** 副行 host 文案：无效/空地址如实兜底 */
function safeHostOf(url: string): string {
  if (url === '') return '未设置地址';
  try { return new URL(url).hostname; } catch { return url; }
}

/** 测试错误短文案：优先抽 HTTP 状态码，悬浮提示里有原文 */
function shortError(error?: string): string {
  const code = /HTTP (\d+)/.exec(error ?? '')?.[1];
  if (code !== undefined) return `HTTP ${code}`;
  return (error ?? '未知错误').slice(0, 40);
}

const CAP_LABEL: Record<string, { text: string; cls: string }> = {
  reason: { text: '推理', cls: 'pill-violet' },
  vision: { text: '视觉', cls: 'pill-blue' },
  tool: { text: '工具', cls: 'pill-green' },
  cache: { text: '缓存', cls: '' },
  anth: { text: 'Anthropic', cls: 'pill-amber' },
  tts: { text: 'TTS', cls: 'pill-green' },
  svc: { text: 'SVC', cls: 'pill-violet' },
  decision: { text: '决策 S1', cls: 'pill-amber' },
  free: { text: '免费', cls: '' },
};

/** 「获取 Key ↗」直达各厂商控制台（Magpie 交互；主进程侧主机白名单校验） */
const KEY_URL: Record<string, string> = {
  'opencode-go': 'https://opencode.ai/go',
  'opencode-zen': 'https://opencode.ai/console',
  'typesafe-jev': 'https://jevmodel.org/zh/dashboard/',
  'deepseek-official': 'https://platform.deepseek.com/api_keys',
  siliconflow: 'https://cloud.siliconflow.cn/account/ak',
  openrouter: 'https://openrouter.ai/settings/keys',
  'volcano-ark': 'https://console.volcengine.com/ark',
  openai: 'https://platform.openai.com/api-keys',
  anthropic: 'https://console.anthropic.com/settings/keys',
  minimax: 'https://platform.minimaxi.com/',
};

/**
 * 智能粘贴（Magpie 交互）：curl 命令 / export 环境变量 / 裸端点 URL → 自动填 Base URL + 协议 + isFullUrl。
 * 只识别明确可解析的形态，识别不了就原样交给输入框。
 */
function parsePastedEndpoint(text: string): { baseUrl: string; protocol?: Protocol; isFullUrl?: boolean; note: string } | null {
  const trimmed = text.trim();
  const envMatch = /(?:export\s+)?(OPENAI_BASE_URL|OPENAI_API_BASE|ANTHROPIC_BASE_URL|BASE_URL)\s*=\s*["']?(https?:\/\/[^\s"']+)/.exec(trimmed);
  if (envMatch !== null) {
    return {
      baseUrl: envMatch[2] ?? '',
      protocol: (envMatch[1] ?? '').startsWith('ANTHROPIC') ? 'anthropic' : 'openai',
      note: `已从环境变量 ${envMatch[1]} 智能填充`,
    };
  }
  const urlMatch = /^curl\b/i.test(trimmed)
    ? /["'](https?:\/\/[^"']+)["']|(https?:\/\/[^\s'"]+)/.exec(trimmed)
    : /^(https?:\/\/\S+)$/i.exec(trimmed);
  if (urlMatch !== null) {
    const raw = urlMatch[1] ?? urlMatch[2] ?? '';
    if (/\/chat\/completions\/?$/i.test(raw)) {
      return { baseUrl: raw, protocol: 'openai', isFullUrl: true, note: '已按完整端点填充（OpenAI /chat/completions，isFullUrl 开启）' };
    }
    if (/\/messages\/?$/i.test(raw)) {
      return { baseUrl: raw, protocol: 'anthropic', isFullUrl: true, note: '已按完整端点填充（Anthropic /messages，isFullUrl 开启）' };
    }
    return { baseUrl: raw.replace(/\/+$/, ''), note: /^curl\b/i.test(trimmed) ? '已从 curl 命令填充 Base URL' : '已填充 Base URL' };
  }
  return null;
}

/** 面板备注（详情页 Base URL 下方）：OpenCode 两档计划的官方限制如实告知 */
const NOTE: Record<string, string> = {
  'opencode-go': 'OpenCode 官方低价包月计划（Go $10 / Go Plus $40），同一服务商可切换 OpenAI / Anthropic 兼容端点。',
  'opencode-zen':
    '原 OpenCode Zen，现为 OpenCode Console：oc_sk_ 前缀 Key、按量计费 + 免费档 12 个（清单以「拉取模型」为准）。免费档 chat 官方仅保证在 OpenCode 客户端内可用，第三方客户端可能被拒（403 时如实显示）；jev 系列为 System One 决策协议模型、不适用聊天端点，测试连通请选 chat 模型，jev 待专用适配工单接入弹幕快反决策槽。',
  'typesafe-jev':
    'TypeSafe Jev 官方独立托管（jevmodel.org）：登录送 10 万输入 token，¥49 起 1500 万永不过期，成功按输入 token 扣费、输出免费。模型走 System One 决策协议（POST /v1/systemone，choice/noul/score 返回概率分布），不吃聊天端点——「测试」按钮已自动走原生决策探针，「保存并检测」用决策探针验证连通；T-M6-14 将把弹幕快反打分等判断点切到原生 choice/noul 调用。',
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
        : m.supportsToolCalling === false
          ? ['decision']
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
    logoSrc: LOGO[provider.id],
    protocol,
    variants,
    activeVariant: variantIndex,
    models,
    enabled: override?.enabled ?? true,
    configured: (override?.keyMask ?? provider.apiKeyMaskedOrRef) !== '',
    keyMask: override?.keyMask ?? provider.apiKeyMaskedOrRef,
    testOk: override?.testOk,
    balance: override?.balance,
    local: group === '本地引擎' && !audio,
    audio,
    custom: false,
    note: NOTE[provider.id] ?? '',
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
    // 契约无 variant 索引字段：把 activeVariant 的协议写进 provider.protocol，主进程网关据此
    // 区分同 Region+Plan 的双协议变体（OpenCode Go / Console 的 OpenAI 与 Anthropic 端点）。
    protocol: variant?.protocol ?? provider.protocol,
    activeRegion: variant?.region ?? 'GLOBAL',
    activePlanType: variant?.planType ?? 'PAY_AS_YOU_GO',
    variants: provider.variants,
    apiKeyMaskedOrRef: provider.keyMask,
    activeModelId: provider.models.find((m) => m.enabled)?.id ?? '',
    discoveredModels: provider.models.map((m) => ({
      id: m.id,
      supportsReasoningThink: m.caps.includes('reason'),
      supportsVision: m.caps.includes('vision'),
      supportsToolCalling: !m.caps.includes('tts') && !m.caps.includes('svc') && !m.caps.includes('decision'),
    })),
  });
}

/**
 * 槽位自动挑选（2026-11-22 用户指令：从「已测通 + 已开启」的模型里选合适模型）——纯函数，
 * 挂载水合 / 批量测试完成 / 手动触发三处共用。主进程永远只见到解析后的具体绑定。
 * 评分：延迟为底（越快越高）；推理 +500（主脑/规划器）；免费 +300（同等条件白嫖优先）；
 * 弹幕快反槽 `typesafe/jev-router` +1000（TypeSafe Jev 决策路由的本职，充分利用 jev 能力）；
 * 视觉槽硬性要求 vision；音频槽只在音频商里挑延迟最低；决策协议（System One/jev 系）不进聊天槽。
 */
function resolveAutoBindings(
  builtin: ModelProviderConfig[],
  overrides: ProviderOverrides,
  customs: CustomProviderRecord[],
  slots: WorkbenchRoleSlot[],
): { bindings: Partial<Record<WorkbenchRoleSlot, string>>; missing: WorkbenchRoleSlot[] } {
  const ui = [
    ...builtin.map((p) => toUiProvider(p, overrides[p.id])),
    ...customs.map((c) => toUiCustom(c, overrides[c.id]?.keyMask ?? '')),
  ];
  const bindings: Partial<Record<WorkbenchRoleSlot, string>> = {};
  const missing: WorkbenchRoleSlot[] = [];
  for (const slot of slots) {
    const meta = SLOT_META.find((s) => s.slot === slot);
    if (meta === undefined) {
      missing.push(slot);
      continue;
    }
    const pool: Array<{ fullId: string; score: number }> = [];
    for (const p of ui) {
      if (!p.enabled) continue;
      const tested = overrides[p.id]?.tested ?? {};
      for (const m of p.models) {
        if (!m.enabled) continue;
        const t = tested[m.id];
        if (t === undefined || t.ok !== true) continue;
        if (meta.group === 'audio') {
          if (!p.audio) continue;
          pool.push({ fullId: `${p.id}/${m.id}`, score: -(t.latencyMs ?? 9999) });
          continue;
        }
        if (p.audio) continue;
        if (m.caps.includes('decision')) continue;
        if (slot === 'VISION_STORYBOARD' && !m.caps.includes('vision')) continue;
        let score = -(t.latencyMs ?? 9999);
        if (slot !== 'DANMAKU_FAST_ROUTER' && m.caps.includes('reason')) score += 500;
        if (m.caps.includes('free')) score += 300;
        if (slot === 'DANMAKU_FAST_ROUTER' && m.id === 'typesafe/jev-router') score += 1000;
        pool.push({ fullId: `${p.id}/${m.id}`, score });
      }
    }
    if (pool.length === 0) {
      missing.push(slot);
      continue;
    }
    pool.sort((a, b) => b.score - a.score);
    bindings[slot] = pool[0]?.fullId ?? '';
  }
  return { bindings, missing };
}

export function ProvidersPanel({ profiles, slotLabels, providers, store }: Props): React.JSX.Element {
  const [hydrated, setHydrated] = useState(false);
  const [tab, setTab] = useState<'providers' | 'defaults'>('providers');
  const [overrides, setOverrides] = useState<ProviderOverrides>({});
  const [customs, setCustoms] = useState<CustomProviderRecord[]>([]);
  const [profile, setProfile] = useState<DiningProfilePreset | null>(null);
  const [activeProvId, setActiveProvId] = useState<string>('opencode-go');
  const [search, setSearch] = useState('');
  const [modelSearch, setModelSearch] = useState('');
  /** 当前服务商的逐模型连通测试结果（Magpie「Test models」交互）：modelId → ✓延迟 / ✗原因 */
  const [modelTests, setModelTests] = useState<Record<string, { ok: boolean; latencyMs?: number; error?: string }>>({});
  const [rowTesting, setRowTesting] = useState<string | null>(null);
  const [batchProgress, setBatchProgress] = useState<{ done: number; total: number } | null>(null);
  const batchCancelRef = useRef(false);
  /** 槽位自动挑选开关（Dexie 持久；Partial——未开启的槽位无键） */
  const [autoFlags, setAutoFlags] = useState<Partial<Record<WorkbenchRoleSlot, boolean>>>({});
  /** overrides 的同步镜像：批量测试循环里逐条写 tested，函数式 setState 的闭包会过期 */
  const overridesRef = useRef<ProviderOverrides>({});
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
      store.getConfig<Partial<Record<WorkbenchRoleSlot, boolean>>>(AUTO_KEY),
    ]).then(async ([activeId, storedProfiles, storedOverrides, storedCustoms, storedAuto]) => {
      const base = (storedProfiles ?? []).find((p) => p.profileId === activeId) ?? storedProfiles?.[0] ?? profiles[0];
      if (base !== undefined) {
        setProfile({ ...base, displayName: '当前生效配置' });
        if (activeId === undefined) void store.setConfig('activeDiningProfile', base.profileId);
      }
      setOverrides(storedOverrides ?? {});
      overridesRef.current = storedOverrides ?? {};
      setCustoms(storedCustoms ?? []);
      const flags = storedAuto ?? {};
      setAutoFlags(flags);
      setHydrated(true);
      setModelTests((storedOverrides ?? {})['opencode-go']?.tested ?? {});
      // 凭据真相在主进程 vault：水合时对账掩码，修复历史 override 缺/残留 keyMask
      // （T-M6-09 遗留 bug——内置服务商保存 Key 后 keymask 未写 Dexie，重开面板显示未连接）
      const ids = [...providers.map((p) => p.id), ...(storedCustoms ?? []).map((c) => c.id)];
      const masks = await Promise.all(
        ids.map(async (id) => ({ id, mask: (await window.directorBridge.providerKeyMask(id)).mask ?? '' })),
      );
      const reconciled = { ...(storedOverrides ?? {}) };
      let changed = false;
      for (const { id, mask } of masks) {
        if ((reconciled[id]?.keyMask ?? '') !== mask) {
          reconciled[id] = { ...reconciled[id], keyMask: mask };
          changed = true;
        }
      }
      if (changed) {
        setOverrides(reconciled);
        overridesRef.current = reconciled;
        void store.setConfig(OVERRIDES_KEY, reconciled);
      }
      // 已启用自动挑选的槽位：按持久化测试结果静默重解析并落绑定
      const flagged = (Object.entries(flags) as Array<[WorkbenchRoleSlot, boolean]>).filter(([, v]) => v === true).map(([slot]) => slot);
      if (flagged.length > 0 && base !== undefined) {
        const resolved = resolveAutoBindings(providers, reconciled, storedCustoms ?? [], flagged);
        if (Object.keys(resolved.bindings).length > 0 || resolved.missing.length > 0) {
          const roleBindings = { ...base.roleBindings, ...resolved.bindings };
          const next = { ...base, roleBindings };
          setProfile({ ...next, displayName: '当前生效配置' });
          void store.setConfig(DINING_KEY, [{ ...next, displayName: '当前生效配置' }]);
          const uiMerged = [
            ...providers.map((p) => toUiProvider(p, reconciled[p.id])),
            ...(storedCustoms ?? []).map((c) => toUiCustom(c, reconciled[c.id]?.keyMask ?? '')),
          ];
          void window.directorBridge.brainApplyConfig({
            profile: { ...next, displayName: '当前生效配置' },
            providerModels: {},
            providers: uiMerged.filter((p) => p.enabled).map(toConfig),
          }).then((r) => {
            window.dispatchEvent(new CustomEvent('wb:brain', { detail: {
              mode: r.mode,
              llmReady: r.llmReady,
              mainModelId: next.roleBindings.MAIN_PERSONA_BRAIN ?? '',
            } }));
          });
        }
      }
    });
  }, [profiles, providers, store]);

  const merged = useMemo<UiProvider[]>(() => {
    const builtin = providers.map((p) => toUiProvider(p, overrides[p.id]));
    const custom = customs.map((c) => toUiCustom(c, overrides[c.id]?.keyMask ?? ''));
    return [...builtin, ...custom];
  }, [providers, customs, overrides]);

  const active = merged.find((p) => p.id === activeProvId) ?? merged[0];
  const ActiveIcon = active?.icon ?? Server;
  const providerUrl = active !== undefined ? (active.variants[active.activeVariant]?.baseUrl ?? '') : '';

  const persistOverrides = useCallback((next: ProviderOverrides): void => {
    overridesRef.current = next;
    setOverrides(next);
    void store.setConfig(OVERRIDES_KEY, next);
  }, [store]);

  /** 逐模型测试结果落 override.tested（跨会话持久，自动挑选的依据）；不触发主脑热更新——批量 58 次也不打主进程 */
  const persistTested = useCallback((providerId: string, modelId: string, entry: ModelTestEntry): void => {
    setModelTests((prev) => ({ ...prev, [modelId]: entry }));
    const current = overridesRef.current;
    const next: ProviderOverrides = {
      ...current,
      [providerId]: { ...current[providerId], tested: { ...(current[providerId]?.tested ?? {}), [modelId]: entry } },
    };
    overridesRef.current = next;
    void store.setConfig(OVERRIDES_KEY, next);
    setOverrides(next);
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
        window.dispatchEvent(new CustomEvent('wb:brain', { detail: {
          mode: r.mode,
          llmReady: r.llmReady,
          mainModelId: nextProfile.roleBindings.MAIN_PERSONA_BRAIN ?? '',
        } }));
        // 成功/失败都只 toast：异步回调若 setNotice 会把「保存并检测」刚显示的结果条
        // （已连接/凭据已保存·检测未通过）约 1s 后整个覆盖掉——真机实证：多内置商缺 Key 时
        // 失败回调用红色「主脑回落规则」盖掉了检测结果，用户误读成保存失败
        if (r.ok) {
          toast(`主脑已热更新：${r.providers.join(' / ') || '—'}${r.missingKeys.length > 0 ? `（缺 Key：${r.missingKeys.join(', ')}）` : ''}`);
        } else {
          toast.error(`主脑回落规则：${r.error ?? '未知错误'}（顶栏大脑状态同步）`);
        }
      });
  }, []);

  const commitProvider = useCallback((ui: UiProvider): void => {
    if (profile === null) return;
    const nextMerged = merged.map((p) => (p.id === ui.id ? ui : p));
    if (ui.custom) {
      persistCustoms(customs.map((c) =>
        c.id === ui.id ? { ...c, name: ui.name, protocol: ui.protocol, variants: ui.variants, models: ui.models, enabled: ui.enabled } : c,
      ));
      persistOverrides({ ...overridesRef.current, [ui.id]: { ...overridesRef.current[ui.id], keyMask: ui.keyMask, testOk: ui.testOk } });
    } else {
      // keyMask/testOk 必须一并落 Dexie：configured 是从 override.keyMask 派生的，
      // 漏存会让「保存并检测」刚成功就回退成「未配置」（OpenCode Go 已连接不显示的根因）。
      // 展开基准用 overridesRef：逐模型测试 persistTested 也会写 overrides，闭包态会把它冲掉
      persistOverrides({
        ...overridesRef.current,
        [ui.id]: { ...overridesRef.current[ui.id], keyMask: ui.keyMask, testOk: ui.testOk, enabled: ui.enabled, models: ui.models, variants: ui.variants, activeVariant: ui.activeVariant },
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

  /** 一键全开/全关当前服务商的全部模型（作用于全部而非仅搜索过滤结果）；全关时清空相关角色绑定 */
  const toggleAllModels = (enabled: boolean): void => {
    if (active === undefined || profile === null || active.models.length === 0) return;
    if (active.models.every((m) => m.enabled) === enabled) return;
    const models = active.models.map((m) => ({ ...m, enabled }));
    if (!enabled) {
      const roleBindings = { ...profile.roleBindings };
      let changed = false;
      for (const [slot, binding] of Object.entries(roleBindings)) {
        if (active.models.some((m) => binding === `${active.id}/${m.id}`)) {
          roleBindings[slot as WorkbenchRoleSlot] = '';
          changed = true;
        }
      }
      if (changed) persistProfile({ ...profile, roleBindings });
    }
    patchActive({ models });
    toast(
      enabled
        ? `已开启 ${active.name} 全部 ${active.models.length} 个模型`
        : `已关闭 ${active.name} 全部 ${active.models.length} 个模型（相关角色绑定已清空）`,
    );
  };

  /** 单模型连通测试（Magpie「Test this model」）：决策协议模型自动改走 System One 探针；结果持久化 */
  const testModelOne = useCallback(async (modelId: string): Promise<{ ok: boolean; latencyMs?: number; error?: string }> => {
    if (active === undefined) return { ok: false, error: '未选中服务商' };
    const isDecision = active.models.find((m) => m.id === modelId)?.caps.includes('decision') ?? false;
    const res = await window.directorBridge.testProviderChat({
      providerId: active.id,
      baseUrl: providerUrl,
      modelId,
      protocol: active.protocol,
      decision: isDecision,
    });
    const entry: ModelTestEntry = res.ok ? { ok: true, latencyMs: res.latencyMs } : { ok: false, error: res.error ?? '未知错误' };
    persistTested(active.id, modelId, entry);
    return entry;
  }, [active, providerUrl, persistTested]);

  const testRow = async (modelId: string): Promise<void> => {
    setRowTesting(modelId);
    try {
      const r = await testModelOne(modelId);
      if (!r.ok) toast.error(`${modelId}：${shortError(r.error)}`);
    } finally {
      setRowTesting(null);
    }
  };

  /**
   * 批量测试当前服务商全部开启的模型（Magpie「Test models」）：4 并发微型请求，
   * 行内 ✓延迟/✗状态码实时更新；再次点击 = 停止；>50 个先确认（防误点大清单烧 token/时间）。
   */
  const testAllModels = async (): Promise<void> => {
    if (active === undefined) return;
    if (batchProgress !== null) {
      batchCancelRef.current = true;
      return;
    }
    const targets = active.models.filter((m) => m.enabled);
    if (targets.length === 0) {
      toast.error('没有开启的模型可测试');
      return;
    }
    if (targets.length > 50 && !window.confirm(`将对 ${targets.length} 个开启的模型各发一次微型请求（约 ${Math.ceil((targets.length / 4) * 1.5)} 秒，消耗少量 token），继续？`)) {
      return;
    }
    batchCancelRef.current = false;
    setBatchProgress({ done: 0, total: targets.length });
    let done = 0;
    let okCount = 0;
    const queue = [...targets];
    const worker = async (): Promise<void> => {
      for (;;) {
        if (batchCancelRef.current) return;
        const m = queue.shift();
        if (m === undefined) return;
        const res = await testModelOne(m.id);
        if (res.ok) okCount += 1;
        done += 1;
        setBatchProgress({ done, total: targets.length });
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    setBatchProgress(null);
    const bad = targets.length - okCount;
    toast(
      bad === 0
        ? `全部 ${targets.length} 个模型应答正常`
        : `${bad}/${targets.length} 个模型未应答（行内红标，悬浮可看原因）`,
    );
    // 有槽位开着自动挑选 → 按最新测试结果立即重解析
    const flagged = (Object.entries(autoFlags) as Array<[WorkbenchRoleSlot, boolean]>).filter(([, v]) => v === true).map(([slot]) => slot);
    if (flagged.length > 0) applyAutoBindings(flagged, true);
  };

  /**
   * 自动挑选落绑定（纯解析在 resolveAutoBindings）：绑定值永远是具体 `${provider}/${model}`，
   * 主进程与 App 启动路径零改动；auto 标记单独存 Dexie。missing 槽位保留现有绑定只在提示里点名。
   */
  const applyAutoBindings = (slots: WorkbenchRoleSlot[], silent = false): void => {
    if (profile === null) return;
    const resolved = resolveAutoBindings(providers, overridesRef.current, customs, slots);
    if (Object.keys(resolved.bindings).length > 0) {
      const roleBindings = { ...profile.roleBindings, ...resolved.bindings };
      const next = { ...profile, roleBindings };
      persistProfile(next);
      syncBrain(next, merged);
    }
    const flags = { ...autoFlags };
    for (const slot of slots) flags[slot] = true;
    setAutoFlags(flags);
    void store.setConfig(AUTO_KEY, flags);
    if (!silent) {
      if (resolved.missing.length === slots.length) {
        toast.error('没有「已测通且开启」的模型：先对目标服务商点「测试模型」再自动挑选');
      } else if (resolved.missing.length > 0) {
        toast(`已自动分配 ${slots.length - resolved.missing.length} 个槽位；${resolved.missing.map((s) => slotLabels[s]).join('、')} 缺可测通模型（先「测试模型」）`);
      } else {
        toast(`已按测试结果自动分配 ${slots.length} 个槽位`);
      }
    }
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
    for (const [id, value] of Object.entries(overridesRef.current)) if (id !== active.id) rest[id] = value;
    persistOverrides(rest);
    const roleBindings = { ...profile.roleBindings };
    for (const [slot, binding] of Object.entries(roleBindings)) {
      if (binding.startsWith(`${active.id}/`)) roleBindings[slot as WorkbenchRoleSlot] = '';
    }
    persistProfile({ ...profile, roleBindings });
    setActiveProvId(providers[0]?.id ?? 'opencode-go');
    toast(`已删除自定义服务商「${active.name}」`);
  };

  /** 复制已保存 Key 到系统剪贴板（2026-11-22 用户指令）：主进程解密直写剪贴板，明文不回传渲染层、不在界面显示 */
  const copySavedKey = async (): Promise<void> => {
    if (active === undefined) return;
    const r = await window.directorBridge.copyProviderKey(active.id);
    if (r.ok && (r.mask ?? '') !== '') {
      toast(`Key 已复制到系统剪贴板（${r.mask}），可粘贴到任何地方`);
    } else {
      toast.error(r.error ?? '该供应商尚未保存 API Key');
    }
  };

  /** 查询余额/额度（Magpie keybalance 思想）：主进程持 key 请求厂商公开余额 API，结果持久化到 override.balance */
  const checkBalance = async (): Promise<void> => {
    if (active === undefined) return;
    setBusy(`balance:${active.id}`);
    try {
      const r = await window.directorBridge.checkProviderBalance(active.id);
      if (!r.ok || r.text === undefined) {
        toast.error(r.error ?? '查询失败');
        setNotice({ kind: 'err', text: `余额查询失败：${r.error ?? '未知错误'}` });
        return;
      }
      const entry = { text: r.text, at: Date.now() };
      const current = overridesRef.current;
      const next: ProviderOverrides = { ...current, [active.id]: { ...current[active.id], balance: entry } };
      overridesRef.current = next;
      void store.setConfig(OVERRIDES_KEY, next);
      setOverrides(next);
      setNotice({ kind: 'ok', text: `${active.name} 余额：${r.text}` });
      toast(`余额：${r.text}`);
    } finally {
      setBusy(null);
    }
  };

  const saveAndTest = async (): Promise<void> => {
    if (active === undefined) return;
    setBusy(`save:${active.id}`);
    setNotice(null);
    try {
      // 智能清洗：整段粘贴「Authorization: Bearer sk-xxx」时剥掉前缀与引号，只留 Key 本体
      const draft = (keyDrafts[active.id] ?? '').trim().replace(/^["']|["']$/g, '').replace(/^Bearer\s+/i, '');
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
      if (keyMask === '') {
        setNotice({ kind: 'err', text: '尚未保存凭据：先粘贴 Key 再点「保存并检测」' });
        return;
      }
      // 先拉真实模型清单（顺带校验 Key），测试模型以清单为准——
      // 预设模型 ID 失效（如 OpenRouter 下架旧型号）不再把「检测 404」误报成「保存失败」
      let models = active.models;
      let discovered: Set<string> | null = null;
      let freeIds: Set<string> = new Set();
      const decisionIds = new Set<string>();
      if (active.protocol === 'openai' && !active.local) {
        const res = await window.directorBridge.discoverModels({ providerId: active.id, baseUrl: providerUrl, protocol: active.protocol });
        if (res.ok && res.models !== undefined) {
          discovered = new Set(res.models);
          freeIds = new Set(res.freeModels ?? []);
          for (const id of res.decisionModels ?? []) decisionIds.add(id);
          const known = new Set(models.map((m) => m.id));
          // 元数据分类（Console 清单的 type+cost 是服务端真相）：决策协议 / 免费档 / 普通 chat
          const capsOfId = (id: string): string[] =>
            decisionIds.has(id) ? ['decision'] : freeIds.has(id) ? ['free'] : ['tool'];
          models = [...models, ...res.models.filter((id) => !known.has(id)).map((id) => ({ id, enabled: true, caps: capsOfId(id) }))];
        }
      }
      // 检测候选：决策协议模型（System One/jev）不吃 /chat/completions 必失败，排除；
      // 免费档优先（用户动机就是免费模型），清单内模型优先；Key 级/余额级错误（401/402）换模型无意义即止
      const chatEnabled = models.filter((m) => m.enabled && !m.caps.includes('decision')).map((m) => m.id);
      const pool = discovered !== null ? chatEnabled.filter((id) => discovered.has(id)) : chatEnabled;
      const candidates = [...pool.filter((id) => freeIds.has(id)), ...pool.filter((id) => !freeIds.has(id))];
      const fallbackId = models.find((m) => !m.caps.includes('decision'))?.id;
      if (fallbackId !== undefined && !candidates.includes(fallbackId)) candidates.push(fallbackId);
      if (candidates.length === 0) {
        // 纯决策协议服务商（TypeSafe Jev / Console jev 系）：没有 chat 模型不是错误——用原生 System One 探针做连通检测
        const decisionModel = models.find((m) => m.caps.includes('decision'))?.id;
        if (decisionModel === undefined) {
          setNotice({ kind: 'err', text: '没有可用于连通测试的模型，请先拉取或手动添加' });
          return;
        }
        const probe = await window.directorBridge.testProviderChat({ providerId: active.id, baseUrl: providerUrl, modelId: decisionModel, protocol: active.protocol, decision: true });
        persistTested(active.id, decisionModel, probe.ok ? { ok: true, latencyMs: probe.latencyMs } : { ok: false, error: probe.error ?? '未知错误' });
        commitProvider({ ...active, keyMask, configured: true, enabled: true, models, testOk: probe.ok });
        if (probe.ok) {
          setNotice({ kind: 'ok', text: `已连接（决策探针 ${decisionModel}）· 响应 ${probe.latencyMs ?? 0}ms · 已启用 ${models.filter((m) => m.enabled).length} 个模型` });
          toast(`${active.name} 凭据已加密保存，System One 决策探针通过（${probe.latencyMs ?? 0}ms）`);
        } else {
          setNotice({ kind: 'err', text: `凭据已加密保存（${keyMask}），但 System One 决策探针未通过（${decisionModel}）：${probe.error ?? '未知错误'}` });
          toast.error(`决策探针未通过：${probe.error ?? '未知错误'}`);
        }
        return;
      }
      const attempts: string[] = [];
      let okModel = '';
      let latencyMs = 0;
      // 定向两探：免费档一次（用户动机）+ 付费档一次（余额真相）——真机实证免费档全档同错（429 FreeUsageLimit），
      // 连试第二个免费模型毫无信息量；付费档失败即定论（402 无余额），Key 级错误（401）立即止
      const firstFree = candidates.find((id) => freeIds.has(id));
      const firstPaid = candidates.find((id) => !freeIds.has(id));
      const attemptIds = [...new Set([firstFree, firstPaid])].filter((id): id is string => id !== undefined);
      for (const modelId of attemptIds) {
        const tested = await window.directorBridge.testProviderChat({ providerId: active.id, baseUrl: providerUrl, modelId, protocol: active.protocol });
        // 两档结果同步进逐模型 tested（自动挑选据此避开通不过的模型）
        persistTested(active.id, modelId, tested.ok ? { ok: true, latencyMs: tested.latencyMs } : { ok: false, error: tested.error ?? '未知错误' });
        if (tested.ok) {
          okModel = modelId;
          latencyMs = tested.latencyMs ?? 0;
          break;
        }
        attempts.push(`${modelId}：${tested.error ?? '未知错误'}`);
        if (/HTTP 401|invalid credential|unauthorized/i.test(tested.error ?? '')) break;
      }
      if (okModel === '') {
        // Key 已成功加密落盘：不能把「检测失败」误报成「保存失败」——保留掩码与配置态，如实汇总每档失败原因
        // （真机实证：Console 免费档 403 官方锁客户端 + 付费档 402 无余额，逐条展示用户才能看懂该充哪边）
        commitProvider({ ...active, keyMask, configured: true, enabled: true, models, testOk: false });
        setNotice({ kind: 'err', text: `凭据已加密保存（${keyMask}），但连通检测未通过 — ${attempts.join('；')}` });
        toast.error(`连通检测未通过：${attempts[attempts.length - 1] ?? ''}`);
        return;
      }
      commitProvider({ ...active, keyMask, configured: true, enabled: true, models, testOk: true });
      setNotice({ kind: 'ok', text: `已连接（${okModel}${freeIds.has(okModel) ? ' · 免费档' : ''}）· 响应 ${latencyMs}ms · 已启用 ${models.filter((m) => m.enabled).length} 个模型` });
      toast(`${active.name} 凭据已加密保存，连通检测通过（${latencyMs}ms）`);
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
      const freeIds = new Set(res.freeModels ?? []);
      const decisionIds = new Set(res.decisionModels ?? []);
      const models = [...active.models, ...res.models.filter((id) => !known.has(id)).map((id) => ({
        id,
        enabled: true,
        caps: decisionIds.has(id) ? ['decision'] : freeIds.has(id) ? ['free'] : ['tool'],
      }))];
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
  const modelKeyword = modelSearch.trim().toLowerCase();
  const filteredModels = active === undefined
    ? []
    : active.models.filter((m) => modelKeyword === '' || m.id.toLowerCase().includes(modelKeyword));
  // 开启的模型排最前、停用的沉底（组内保持原相对顺序）——2026-11-22 用户指令
  const shownModels = [...filteredModels.filter((m) => m.enabled), ...filteredModels.filter((m) => !m.enabled)];
  const groups: UiGroup[] = ['云端服务', '自定义服务商', '本地引擎'];
  const enabledCount = merged.filter((p) => p.enabled).length;
  const configuredCount = merged.filter((p) => p.configured).length;
  const slotOptions = merged
    .filter((p) => p.enabled)
    .flatMap((p) => p.models
      // 决策协议（System One）模型暂不进聊天槽位下拉：网关尚无适配，绑定即坏；适配工单落地后放开
      .filter((m) => m.enabled && !m.caps.includes('decision'))
      .map((m) => ({ value: `${p.id}/${m.id}`, label: `${p.name} · ${m.id}`, audio: p.audio })));

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
                // Magpie「Turned off」交互：停用的服务商沉底到折叠子区，不与启用项混排
                const onList = list.filter((p) => p.enabled);
                const offList = list.filter((p) => !p.enabled);
                return (
                  <div key={group}>
                    <div className="flex justify-between px-2.5 pb-1 pt-2 text-[10px] font-semibold tracking-wider" style={{ color: 'var(--text-3)' }}>
                      <span>{group}</span><span className="mono">{list.length}</span>
                    </div>
                    {onList.map((p) => (
                      <ProviderRow key={p.id} p={p} activeId={active?.id} onSelect={() => { setActiveProvId(p.id); setModelSearch(''); setModelTests(overridesRef.current[p.id]?.tested ?? {}); batchCancelRef.current = true; }} />
                    ))}
                    {offList.length > 0 && (
                      <div className="mb-1 mt-1.5 rounded-xl px-2.5 py-1 text-[10px]" style={{ background: 'var(--inset)', color: 'var(--text-3)' }} data-off-section={offList.length}>
                        已关闭 · {offList.length}（配置保留，开关随时找回）
                      </div>
                    )}
                    {offList.map((p) => (
                      <ProviderRow key={p.id} p={p} activeId={active?.id} dimmed onSelect={() => { setActiveProvId(p.id); setModelSearch(''); setModelTests(overridesRef.current[p.id]?.tested ?? {}); batchCancelRef.current = true; }} />
                    ))}
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
                  <span
                    className="grid h-10 w-10 place-items-center rounded-xl"
                    style={active.logoSrc !== undefined ? { background: '#fff', border: '1px solid var(--stroke-2)' } : { background: 'var(--blue-dim)', border: '1px solid var(--blue-line)', color: 'var(--blue)' }}
                  >
                    <ProviderLogo src={active.logoSrc} icon={ActiveIcon} size={active.logoSrc !== undefined ? 24 : 18} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <h2 className="flex flex-wrap items-center gap-2 text-[17px] font-bold">
                      {active.name}
                      <span className="pill" style={{ fontSize: 10 }}>{active.tag}</span>
                    </h2>
                    <div className="mt-0.5 text-[11.5px]" style={{ color: 'var(--text-3)' }}>
                      {`${safeHostOf(providerUrl)} · ${active.models.length} 模型 · ${active.enabled ? '已启用，可在「默认模型」中选用' : '未启用，开启后进入模型选择器'}`}
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
                          {KEY_URL[active.id] !== undefined && (
                            <button
                              className="btn-pill ghost whitespace-nowrap"
                              data-get-key
                              onClick={() => { void window.directorBridge.openKeyConsole(KEY_URL[active.id] ?? ''); }}
                              title="直达该厂商的控制台/密钥页（主进程白名单校验后用系统浏览器打开）"
                            >
                              <ExternalLink size={13} />获取 Key
                            </button>
                          )}
                          {active.configured && (
                            <button
                              className="btn-pill ghost whitespace-nowrap"
                              data-copy-key
                              onClick={() => { void copySavedKey(); }}
                              title="把已保存的明文 Key 复制到系统剪贴板（主进程直写，界面不显示明文）"
                            >
                              <Copy size={13} />复制 Key
                            </button>
                          )}
                          {BALANCE_SUPPORTED.has(active.id) && !active.local && (
                            <button
                              className="btn-pill ghost whitespace-nowrap"
                              data-check-balance
                              onClick={() => { void checkBalance(); }}
                              disabled={busy !== null}
                              title="查询该厂商的余额/额度（走公开余额 API，主进程持 Key 请求）"
                            >
                              <Database size={13} />{busy === `balance:${active.id}` ? '查询中…' : '查余额'}
                            </button>
                          )}
                        </div>
                        <div
                          className="mt-1.5 flex items-center gap-1.5 text-[11px]"
                          style={{ color: active.configured ? (active.testOk === false ? 'var(--amber)' : 'var(--green)') : 'var(--text-3)' }}
                        >
                          {active.configured && active.testOk === false
                            ? <TriangleAlert size={12} />
                            : active.configured
                              ? <CheckCircle2 size={12} />
                              : <Info size={12} />}
                          {active.configured && active.testOk === false
                            ? `凭据已保存（${active.keyMask}）· 连通检测未通过，可修改后重试「保存并检测」`
                            : active.configured
                              ? `已连接 · 已启用 ${active.models.filter((m) => m.enabled).length} 个模型`
                              : '填写凭据后点「保存并检测」，自动验证连通性并尝试拉取模型列表'}
                        </div>
                        {active.balance !== undefined && (
                          <div className="mono mt-1 flex items-center gap-1.5 text-[10.5px]" style={{ color: 'var(--text-2)' }} data-balance={active.id}>
                            <Database size={11} style={{ color: 'var(--green)' }} />
                            余额 {active.balance.text}
                            <span style={{ color: 'var(--text-3)' }}>· {new Date(active.balance.at).toLocaleTimeString('zh-CN', { hour12: false })} 查询</span>
                          </div>
                        )}
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
                  <div className="flex items-center gap-1.5 rounded-lg px-2.5" style={{ background: 'var(--inset)', border: '1px solid var(--stroke)' }}>
                    <Search size={12} style={{ color: 'var(--text-3)' }} />
                    <input
                      data-model-search
                      value={modelSearch}
                      onChange={(e) => setModelSearch(e.target.value)}
                      placeholder="搜索模型…"
                      className="w-28 bg-transparent py-1.5 text-[12px] outline-none"
                      style={{ color: 'var(--text-1)' }}
                    />
                  </div>
                  <button className="btn-pill ghost" onClick={() => toggleAllModels(true)} data-models-all-on>全部开启</button>
                  <button className="btn-pill ghost" onClick={() => toggleAllModels(false)} data-models-all-off>全部关闭</button>
                  <button className="btn-pill ghost" onClick={() => { void testAllModels(); }} disabled={busy !== null} data-test-all>
                    <Activity size={12} />{batchProgress !== null ? `停止 ${batchProgress.done}/${batchProgress.total}` : '测试模型'}
                  </button>
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
                  {active.models.length > 0 && shownModels.length === 0 && (
                    <div className="px-4 py-6 text-center text-[12px]" style={{ color: 'var(--text-3)' }}>没有匹配「{modelSearch.trim()}」的模型</div>
                  )}
                  {shownModels.map((m) => (
                    <div key={m.id} className="flex items-center gap-2.5 px-3.5 py-2.5" style={{ borderBottom: '1px solid var(--stroke)' }}>
                      <span className="font-mono text-[12.5px] font-medium" style={{ color: 'var(--text-1)' }}>{m.id}</span>
                      <div className="flex flex-wrap gap-1">
                        {m.caps.map((c) => {
                          const cap = CAP_LABEL[c] ?? { text: c, cls: '' };
                          return <span key={c} className={`pill ${cap.cls}`} style={{ fontSize: 9.5, padding: '1px 7px' }}>{cap.text}</span>;
                        })}
                      </div>
                      <div className="flex-1" />
                      {(() => {
                        const testResult = modelTests[m.id];
                        if (testResult === undefined) return null;
                        return (
                          <span
                            className="mono whitespace-nowrap text-[10px]"
                            style={{ color: testResult.ok === true ? 'var(--green)' : 'var(--red)' }}
                            title={testResult.error ?? ''}
                            data-model-status={m.id}
                          >
                            {testResult.ok === true ? `✓ ${testResult.latencyMs ?? 0}ms` : `✗ ${shortError(testResult.error)}`}
                          </span>
                        );
                      })()}
                      <button
                        className="pill whitespace-nowrap"
                        style={{ fontSize: 10.5 }}
                        onClick={() => { void testRow(m.id); }}
                        data-model-test={m.id}
                        title="对该模型发一次微型请求验证连通（决策协议模型自动走 System One 探针）"
                      >
                        {rowTesting === m.id ? '测试中…' : '测试'}
                      </button>
                      {!active.audio && !m.caps.includes('decision') && (
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
              <button className="btn-pill ghost" onClick={() => applyAutoBindings(SLOT_META.map((s) => s.slot))} data-auto-assign>
                <Sparkles size={12} />一键智能分配
              </button>
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
                          value={autoFlags[meta.slot] === true ? 'auto' : optionExists ? current : ''}
                          onChange={(e) => {
                            if (e.target.value === 'auto') {
                              applyAutoBindings([meta.slot]);
                              return;
                            }
                            if (autoFlags[meta.slot] === true) {
                              const flags = { ...autoFlags, [meta.slot]: false };
                              setAutoFlags(flags);
                              void store.setConfig(AUTO_KEY, flags);
                            }
                            bindSlot(meta.slot, e.target.value);
                          }}
                        >
                          <option value="auto">自动挑选{autoFlags[meta.slot] === true && current !== '' ? ` → ${current.split('/').pop() ?? ''}` : '（按测试结果）'}</option>
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
              <input
                className="w-full rounded-lg px-3 py-2 font-mono text-[12.5px] outline-none"
                style={{ background: 'var(--inset)', border: '1px solid var(--stroke)', color: 'var(--text-1)' }}
                value={newUrl}
                onChange={(e) => setNewUrl(e.target.value)}
                onPaste={(e) => {
                  // Magpie 智能粘贴：curl / export 环境变量 / 带端点后缀的裸 URL → 自动填 URL + 协议 + isFullUrl
                  const parsed = parsePastedEndpoint(e.clipboardData.getData('text'));
                  if (parsed === null) return;
                  e.preventDefault();
                  setNewUrl(parsed.baseUrl);
                  if (parsed.protocol !== undefined) setNewProto(parsed.protocol);
                  setNewFullUrl(parsed.isFullUrl ?? false);
                  toast(parsed.note);
                }}
                placeholder="支持直接粘贴 curl / export 命令自动填充，例如：http://127.0.0.1:8000/v1"
                data-new-url
              />
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
