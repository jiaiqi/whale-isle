import {
  ModelProviderConfigSchema,
  type DiningProfilePreset,
  type ModelProviderConfig,
  type ProviderEndpointVariant,
  type WorkbenchRoleSlot,
} from '@workbench/shared-protocol';
/**
 * 服务商页纯函数与共享类型（T-M6-26 合并：types + catalog + transforms）。
 * 不持有任何状态；页面状态与数据流仍由 providers-panel.tsx 容器独占。
 */

/**
 * 模型与服务商页共享类型与 Dexie 键（T-M6-26 自 providers-panel.tsx 拆出）。
 * 纯类型/常量模块：不持有任何状态，页面状态与数据流仍由 providers-panel.tsx 容器独占。
 */

export type Protocol = 'openai' | 'anthropic';

export const OVERRIDES_KEY = 'providerOverrides';
export const DINING_KEY = 'diningProfiles';
export const CUSTOM_KEY = 'customProviders';
/** 槽位自动挑选开关（渲染层专用 Dexie 键，不进契约：主进程只消费解析后的具体绑定） */
export const AUTO_KEY = 'slotAutoFlags';

export interface ModelEntry {
  id: string;
  enabled: boolean;
  caps: string[];
}

export interface ModelTestEntry {
  ok: boolean;
  latencyMs?: number;
  error?: string;
}

export interface ProviderOverride {
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

export interface CustomProviderRecord {
  id: string;
  name: string;
  protocol: Protocol;
  variants: ProviderEndpointVariant[];
  models: ModelEntry[];
  enabled: boolean;
  createdAt: number;
}

export type ProviderOverrides = Record<string, ProviderOverride>;
export type UiGroup = '云端服务' | '自定义服务商' | '本地引擎';

export interface UiProvider {
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

/** 槽位下拉候选项（父容器从已启用服务商 × 已启用模型解析后传入） */
export interface SlotOption {
  value: string;
  label: string;
  audio: boolean;
}

/**
 * 服务商静态目录与轻量文案工具（T-M6-26 自 providers-panel.tsx 拆出）。
 * 只含常量与纯函数：图标/logo/备注/Key 直达链接/Capability 徽标文案。
 */
import {
  AudioLines, Box, Brain, Compass, Eye, Fish, Flame, MessageSquare, Music, Rocket, Scale, Shield,
  Sparkles, Sprout, Swords, Volume2, Waves, Zap,
  type LucideIcon,
} from 'lucide-react';

/** 支持查余额的厂商（与主进程 BALANCE_PROBES 对应） */
export const BALANCE_SUPPORTED: ReadonlySet<string> = new Set(['openrouter', 'deepseek-official', 'siliconflow', 'opencode-go']);

export const SLOT_META: Array<{ slot: WorkbenchRoleSlot; name: string; desc: string; group: 'llm' | 'audio'; icon: LucideIcon }> = [
  { slot: 'MAIN_PERSONA_BRAIN', name: '主脑与内心戏', desc: '日常聊天、人设表达与 <think> 推理', group: 'llm', icon: Brain },
  { slot: 'STARDEW_GAME_PLANNER', name: '星露谷规划器', desc: '自动驾驶工具决策与攻略应用', group: 'llm', icon: Sprout },
  { slot: 'TERRARIA_GAME_PLANNER', name: '泰拉瑞亚规划器', desc: 'tModLoader 桥接动作决策与生存反射', group: 'llm', icon: Swords },
  { slot: 'DST_GAME_PLANNER', name: '饥荒 DST 规划器', desc: '专用服侧动作决策与昼夜生存', group: 'llm', icon: Flame },
  { slot: 'DANMAKU_FAST_ROUTER', name: '弹幕快反路由', desc: '低延迟弹幕清洗、打分与快速回应', group: 'llm', icon: MessageSquare },
  { slot: 'VISION_STORYBOARD', name: '翻车视觉复盘', desc: '截图与宫格分镜画面理解', group: 'llm', icon: Eye },
  { slot: 'VOICE_TTS_SPEECH', name: '日常说话 TTS', desc: '五档情绪台词与心声气声合成', group: 'audio', icon: Volume2 },
  { slot: 'VOICE_SVC_SINGING', name: '点歌演唱 SVC', desc: '伴奏分离与 RVC 变声演唱', group: 'audio', icon: Music },
];

export const TAG: Record<string, string> = {
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
export const ICON: Record<string, LucideIcon> = {
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
export const LOGO: Record<string, string> = {
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

export const CAP_LABEL: Record<string, { text: string; cls: string }> = {
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
export const KEY_URL: Record<string, string> = {
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

/** 面板备注（详情页 Base URL 下方）：OpenCode 两档计划的官方限制如实告知 */
export const NOTE: Record<string, string> = {
  'opencode-go': 'OpenCode 官方低价包月计划（Go $10 / Go Plus $40），同一服务商可切换 OpenAI / Anthropic 兼容端点。',
  'opencode-zen':
    '原 OpenCode Zen，现为 OpenCode Console：oc_sk_ 前缀 Key、按量计费 + 免费档 12 个（清单以「拉取模型」为准）。免费档 chat 官方仅保证在 OpenCode 客户端内可用，第三方客户端可能被拒（403 时如实显示）；jev 系列为 System One 决策协议模型、不适用聊天端点，测试连通请选 chat 模型，jev 待专用适配工单接入弹幕快反决策槽。',
  'typesafe-jev':
    'TypeSafe Jev 官方独立托管（jevmodel.org）：登录送 10 万输入 token，¥49 起 1500 万永不过期，成功按输入 token 扣费、输出免费。模型走 System One 决策协议（POST /v1/systemone，choice/noul/score 返回概率分布），不吃聊天端点——「测试」按钮已自动走原生决策探针，「保存并检测」用决策探针验证连通；T-M6-14 将把弹幕快反打分等判断点切到原生 choice/noul 调用。',
};

/** 副行 host 文案：无效/空地址如实兜底 */
export function safeHostOf(url: string): string {
  if (url === '') return '未设置地址';
  try { return new URL(url).hostname; } catch { return url; }
}

/** 测试错误短文案：优先抽 HTTP 状态码，悬浮提示里有原文 */
export function shortError(error?: string): string {
  const code = /HTTP (\d+)/.exec(error ?? '')?.[1];
  if (code !== undefined) return `HTTP ${code}`;
  return (error ?? '未知错误').slice(0, 40);
}

/**
 * 智能粘贴（Magpie 交互）：curl 命令 / export 环境变量 / 裸端点 URL → 自动填 Base URL + 协议 + isFullUrl。
 * 只识别明确可解析的形态，识别不了就原样交给输入框。
 */
export function parsePastedEndpoint(text: string): { baseUrl: string; protocol?: Protocol; isFullUrl?: boolean; note: string } | null {
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

/**
 * UI 视图模型与纯解析/合并逻辑（T-M6-26 自 providers-panel.tsx 拆出）。
 * 这里全部是无副作用函数：页面容器负责把结果写入 Dexie / 通知主脑 / toast。
 */
import { Plug, Server } from 'lucide-react';
import type { ImportedProviderMeta } from '../bridge';

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

export function toUiProvider(provider: ModelProviderConfig, override: ProviderOverride | undefined): UiProvider {
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

export function toUiCustom(record: CustomProviderRecord, keyMask: string): UiProvider {
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

export function toConfig(provider: UiProvider): ModelProviderConfig {
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
export function resolveAutoBindings(
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

/** 一次性清空命中条件的槽位绑定；返回新对象与是否真的有改动（与旧内联循环语义一致） */
export function clearRoleBindings(
  roleBindings: DiningProfilePreset['roleBindings'],
  match: (binding: string) => boolean,
): { roleBindings: DiningProfilePreset['roleBindings']; changed: boolean } {
  const next = { ...roleBindings };
  let changed = false;
  for (const [slot, binding] of Object.entries(next)) {
    if (match(binding)) {
      next[slot as WorkbenchRoleSlot] = '';
      changed = true;
    }
  }
  return { roleBindings: next, changed };
}

/** 把「拉取/检测」发现的新模型并入现有清单：保留原顺序，已知 id 不重复追加 */
export function mergeDiscoveredModels(models: ModelEntry[], added: ReadonlyArray<ModelEntry>): ModelEntry[] {
  const known = new Set(models.map((m) => m.id));
  return [...models, ...added.filter((m) => !known.has(m.id))];
}

/**
 * 「保存并检测」的探测选型（纯函数）：
 * 候选只取已启用且非决策协议的 chat 模型（有真实清单时以清单为准），免费档优先；
 * 首个非决策模型兜底（预设 ID 可能已不在清单里）；纯决策协议服务商回落 System One 探针。
 */
export function planProviderTest(
  models: ModelEntry[],
  discovered: Set<string> | null,
  freeIds: ReadonlySet<string>,
): { candidates: string[]; decisionModel?: string } {
  const chatEnabled = models.filter((m) => m.enabled && !m.caps.includes('decision')).map((m) => m.id);
  const pool = discovered !== null ? chatEnabled.filter((id) => discovered.has(id)) : chatEnabled;
  const candidates = [...pool.filter((id) => freeIds.has(id)), ...pool.filter((id) => !freeIds.has(id))];
  const fallbackId = models.find((m) => !m.caps.includes('decision'))?.id;
  if (fallbackId !== undefined && !candidates.includes(fallbackId)) candidates.push(fallbackId);
  return { candidates, decisionModel: models.find((m) => m.caps.includes('decision'))?.id };
}

/** 新建自定义服务商的 Dexie 记录（id/createdAt 均取当前时间） */
export function buildCustomProviderRecord(draft: {
  name: string;
  protocol: Protocol;
  baseUrl: string;
  isFullUrl: boolean;
  modelIds: string[];
}): CustomProviderRecord {
  return {
    id: `custom-${Date.now()}`,
    name: draft.name,
    protocol: draft.protocol,
    variants: [{ region: 'GLOBAL', planType: 'PAY_AS_YOU_GO', baseUrl: draft.baseUrl, isFullUrl: draft.isFullUrl, protocol: draft.protocol }],
    models: (draft.modelIds.length > 0 ? draft.modelIds : ['default-model']).map((id) => ({
      id,
      enabled: true,
      caps: [draft.protocol === 'anthropic' ? 'anth' : 'tool'],
    })),
    enabled: true,
    createdAt: Date.now(),
  };
}

/** 导入结果 → 本地 customs/overrides 的纯合并（skip 项不落盘） */
export function mergeImportedProviders(
  items: ImportedProviderMeta[],
  customs: CustomProviderRecord[],
  overrides: ProviderOverrides,
): { customs: CustomProviderRecord[]; overrides: ProviderOverrides } {
  let nextCustoms = customs;
  const nextOverrides: ProviderOverrides = { ...overrides };
  for (const item of items) {
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
  return { customs: nextCustoms, overrides: nextOverrides };
}
