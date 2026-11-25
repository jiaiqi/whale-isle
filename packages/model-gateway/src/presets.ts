/**
 * 内置供应商预设库（T-M1-03，CC Switch 两步式思想重写）：
 * 第一步选供应商卡片 → 第二步 Region/Plan 胶囊切端点；isFullUrl 为"免拼接"开关。
 * 仓库未提供 CC Switch/Magpie 上游源码——本文件为思想重写，不复制任何上游代码。
 */
import type { z } from 'zod';
import {
  ModelProviderConfigSchema,
  type ModelProviderConfig,
} from '@workbench/shared-protocol';

type ProviderConfigInput = z.input<typeof ModelProviderConfigSchema>;

function preset(config: ProviderConfigInput): ModelProviderConfig {
  return ModelProviderConfigSchema.parse(config);
}

/** 模型标签：未声明时 reasoning/vision 关闭、工具调用默认开启 */
interface ModelFlags {
  reasoning?: boolean;
  vision?: boolean;
  toolCalling?: boolean;
}

/** discoveredModels 工厂：默认支持工具调用，reasoning/vision 按标签开启，成本暂记 0 */
function model(id: string, flags: ModelFlags = {}): ModelProviderConfig['discoveredModels'][number] {
  return {
    id,
    supportsReasoningThink: flags.reasoning ?? false,
    supportsVision: flags.vision ?? false,
    supportsToolCalling: flags.toolCalling ?? true,
    inputCostPer1M: 0,
    outputCostPer1M: 0,
  };
}

export const BUILTIN_PROVIDER_PRESETS: ModelProviderConfig[] = [
  preset({
    id: 'deepseek-official',
    name: 'DeepSeek 官方',
    category: 'OFFICIAL_LLM',
    variants: [
      { region: 'CN', planType: 'PAY_AS_YOU_GO', baseUrl: 'https://api.deepseek.com/v1', isFullUrl: false, protocol: 'openai' },
      { region: 'CN', planType: 'CODING_PLAN', baseUrl: 'https://api.deepseek.com/v1', isFullUrl: false, protocol: 'openai' },
      { region: 'GLOBAL', planType: 'PAY_AS_YOU_GO', baseUrl: 'https://api.deepseek.com/v1', isFullUrl: false, protocol: 'openai' },
    ],
    apiKeyMaskedOrRef: '',
    discoveredModels: [
      model('deepseek-chat'),
      model('deepseek-reasoner', { reasoning: true }),
      model('deepseek-flash'),
    ],
  }),
  preset({
    id: 'siliconflow',
    name: 'SiliconFlow 硅基流动',
    category: 'AGGREGATOR_LLM',
    variants: [{ region: 'CN', planType: 'PAY_AS_YOU_GO', baseUrl: 'https://api.siliconflow.cn/v1', isFullUrl: false, protocol: 'openai' }],
    apiKeyMaskedOrRef: '',
    discoveredModels: [
      model('Qwen/Qwen2.5-7B-Instruct'),
      model('Qwen/Qwen2.5-VL-7B-Instruct', { vision: true }),
    ],
  }),
  preset({
    id: 'openrouter',
    name: 'OpenRouter',
    category: 'AGGREGATOR_LLM',
    variants: [{ region: 'GLOBAL', planType: 'PAY_AS_YOU_GO', baseUrl: 'https://openrouter.ai/api/v1', isFullUrl: false, protocol: 'openai' }],
    apiKeyMaskedOrRef: '',
    // 2026-11-22 真机实测（用户 OpenRouter key）：typesafe/jev-router 2070ms 回话——OpenRouter 把
    // TypeSafe 的 Jev（System One）包装成标准聊天模型，无需 System One 适配即可用；定价动态（路由子模型计费）。
    discoveredModels: [
      model('typesafe/jev-router', { reasoning: true, vision: true }),
      model('anthropic/claude-sonnet', { reasoning: true, vision: true }),
      model('google/gemini-2.5-pro', { reasoning: true, vision: true }),
    ],
  }),
  preset({
    id: 'opencode-go',
    name: 'OpenCode Go',
    category: 'AGGREGATOR_LLM',
    activeRegion: 'GLOBAL',
    activePlanType: 'CODING_PLAN',
    variants: [
      {
        region: 'GLOBAL',
        planType: 'CODING_PLAN',
        baseUrl: 'https://opencode.ai/inference/go/openai/v1',
        isFullUrl: false,
        protocol: 'openai',
      },
      {
        region: 'GLOBAL',
        planType: 'CODING_PLAN',
        baseUrl: 'https://opencode.ai/inference/go/anthropic/v1',
        isFullUrl: false,
        protocol: 'anthropic',
      },
    ],
    apiKeyMaskedOrRef: '',
    // 2026-11-22 真机实测（Go $10 订阅 key）：hy4-flash-free 走 Go 端点免费可用（不占 Go 配额，1396ms 回话）；
    // 其余为包月配额内主力。免费/分类以 /inference/go/v1/models 元数据为准。
    discoveredModels: [
      model('deepseek-v4.1-flash'),
      model('glm-5.3-flash'),
      model('kimi-k3.1-pro', { reasoning: true }),
      model('mimo-v2.6-flash'),
      model('minimax-m3.1-flash'),
      model('hy4-flash-free'),
    ],
  }),
  preset({
    id: 'opencode-zen',
    name: 'OpenCode Console（原 Zen）',
    category: 'AGGREGATOR_LLM',
    activeRegion: 'GLOBAL',
    activePlanType: 'PAY_AS_YOU_GO',
    variants: [
      {
        region: 'GLOBAL',
        planType: 'PAY_AS_YOU_GO',
        baseUrl: 'https://opencode.ai/inference/openai/v1',
        isFullUrl: false,
        protocol: 'openai',
      },
      {
        region: 'GLOBAL',
        planType: 'PAY_AS_YOU_GO',
        baseUrl: 'https://opencode.ai/inference/anthropic/v1',
        isFullUrl: false,
        protocol: 'anthropic',
      },
    ],
    apiKeyMaskedOrRef: '',
    // 2026-11-22 实证（https://opencode.ai/docs/console/models/）：原 Zen 已更名 Console，
    // 旧 /inference/zen/* 全 404；清单 105 个 = chat 83（免费 11）+ decision 4 + embedding/image/realtime/video 18。
    // 免费档 chat 是普通聊天模型（官方仅保证 OpenCode 客户端内可用，第三方可能 403）——免费≠决策协议，
    // 免费/决策分类以 /inference/v1/models 的 type/cost 元数据为准（vault discoverModels 解析）；
    // 仅 jev 系（System One 决策协议，不吃 /chat/completions）标 toolCalling=false 防误当聊天模型。
    discoveredModels: [
      model('jev-1.13-free', { toolCalling: false }),
      model('jev-1.13', { toolCalling: false }),
      model('big-pickle'),
      model('deepseek-v4.1-flash-free'),
      model('mimo-v2.6-flash-free'),
      model('longcat-2.5-free'),
      model('glm-5.3'),
      model('kimi-k3'),
      model('deepseek-v4.1-flash'),
      model('gpt-5'),
      model('claude-opus-5-5'),
    ],
  }),
  preset({
    id: 'typesafe-jev',
    name: 'TypeSafe Jev',
    category: 'AGGREGATOR_LLM',
    activeRegion: 'GLOBAL',
    activePlanType: 'PAY_AS_YOU_GO',
    variants: [
      {
        region: 'GLOBAL',
        planType: 'PAY_AS_YOU_GO',
        baseUrl: 'https://jevmodel.org/v1',
        isFullUrl: false,
        protocol: 'openai',
      },
    ],
    apiKeyMaskedOrRef: '',
    // 2026-11-22 实证（https://jevmodel.org/zh/playground/ + 真实 key 探针 200）：
    // TypeSafe Jev 官方独立托管，System One 决策协议 POST /v1/systemone（choice/noul/score，响应带概率分布），
    // 不吃 /chat/completions——全部模型标 toolCalling=false（决策类），行内「测试」自动走原生探针；
    // 计费：登录送 10 万输入 token，¥49 起 1500 万永不过期，成功按输入 token 扣费输出免费。
    // jev-latest 实测解析为 jev-1.14.0；1.13 为官方建议的阈值稳定版。
    discoveredModels: [
      model('jev-latest', { toolCalling: false }),
      model('jev-1.14.0', { toolCalling: false }),
      model('jev-1.13.0', { toolCalling: false }),
    ],
  }),
  preset({
    id: 'volcano-ark',
    name: '火山方舟',
    category: 'OFFICIAL_LLM',
    variants: [{ region: 'CN', planType: 'PAY_AS_YOU_GO', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', isFullUrl: false, protocol: 'openai' }],
    apiKeyMaskedOrRef: '',
    discoveredModels: [model('doubao-1-5-pro-32k')],
  }),
  preset({
    id: 'openai',
    name: 'OpenAI',
    category: 'OFFICIAL_LLM',
    variants: [{ region: 'GLOBAL', planType: 'PAY_AS_YOU_GO', baseUrl: 'https://api.openai.com/v1', isFullUrl: false, protocol: 'openai' }],
    apiKeyMaskedOrRef: '',
    discoveredModels: [model('gpt-4.1-mini', { vision: true })],
  }),
  preset({
    id: 'anthropic',
    name: 'Anthropic',
    category: 'OFFICIAL_LLM',
    protocol: 'anthropic',
    variants: [{ region: 'GLOBAL', planType: 'PAY_AS_YOU_GO', baseUrl: 'https://api.anthropic.com/v1', isFullUrl: false, protocol: 'anthropic' }],
    apiKeyMaskedOrRef: '',
    discoveredModels: [model('claude-3-7-sonnet', { reasoning: true, vision: true })],
  }),
  preset({
    id: 'minimax',
    name: 'MiniMax',
    category: 'OFFICIAL_LLM',
    variants: [{ region: 'CN', planType: 'PAY_AS_YOU_GO', baseUrl: 'https://api.minimaxi.com/v1', isFullUrl: false, protocol: 'openai' }],
    apiKeyMaskedOrRef: '',
    discoveredModels: [
      model('MiniMax-M3.1-Flash', { reasoning: true }),
      model('MiniMax-M2.5'),
    ],
  }),
  preset({
    id: 'local-ollama',
    name: '本地 Ollama',
    category: 'LOCAL_LLM',
    activeRegion: 'LOCAL',
    variants: [{ region: 'LOCAL', planType: 'LOCAL_GPU', baseUrl: 'http://127.0.0.1:11434/v1', isFullUrl: false, protocol: 'openai' }],
    apiKeyMaskedOrRef: '',
    discoveredModels: [
      model('qwen2.5:14b'),
      model('qwen2.5:7b'),
      model('qwen2.5-vl:7b', { vision: true }),
    ],
  }),
  preset({
    id: 'local-gpt-sovits',
    name: '本地 GPT-SoVITS',
    category: 'AUDIO_TTS',
    activeRegion: 'LOCAL',
    variants: [{ region: 'LOCAL', planType: 'LOCAL_GPU', baseUrl: 'http://127.0.0.1:9880', isFullUrl: true, protocol: 'openai' }],
    apiKeyMaskedOrRef: '',
    discoveredModels: [
      model('gpt-sovits-v2', { toolCalling: false }),
      model('rvc-v2', { toolCalling: false }),
    ],
  }),
];

export const PROVIDER_PRESET_IDS = BUILTIN_PROVIDER_PRESETS.map((provider) => provider.id);

export type ProviderProtocol = 'openai' | 'anthropic';

/**
 * Region/Plan 胶囊切换 + 协议变体显式选择：
 * - 传 `variant`：先按协议收窄候选（OpenCode Go / Console 的两个变体共享同一 Region+Plan，
 *   只有协议能区分），再走「精确匹配 → 同 Region 任一 → 首个变体」；
 *   目标协议无任何变体时整个候选集回退，保持旧行为不抛错；
 * - 不传：完全保持旧行为（既有调用方零改动）。
 */
export function resolveEndpoint(
  provider: ModelProviderConfig,
  variant?: ProviderProtocol,
): ModelProviderConfig['variants'][number] {
  const byProtocol = variant === undefined
    ? provider.variants
    : provider.variants.filter((item) => item.protocol === variant);
  const scoped = byProtocol.length > 0 ? byProtocol : provider.variants;
  const exact = scoped.find(
    (item) => item.region === provider.activeRegion && item.planType === provider.activePlanType,
  );
  const sameRegion = scoped.find((item) => item.region === provider.activeRegion);
  const resolved = exact ?? sameRegion ?? scoped[0];
  if (!resolved) throw new Error(`供应商 ${provider.id} 未配置任何端点变体`);
  return resolved;
}

/** 变体协议优先，其次供应商默认协议，最后回退 OpenAI 兼容（手写残缺配置兜底） */
export function resolveProtocol(provider: ModelProviderConfig, variant?: ProviderProtocol): ProviderProtocol {
  const endpoint = resolveEndpoint(provider, variant);
  const protocol = endpoint.protocol ?? provider.protocol;
  return protocol === 'anthropic' ? 'anthropic' : 'openai';
}

/**
 * 允许免拼接的端点则直接使用；否则按协议拼接：
 * OpenAI 兼容 → /chat/completions；Anthropic 兼容 → /messages（base 已含 /v1 时不重复）。
 */
export function buildChatUrl(provider: ModelProviderConfig, variant?: ProviderProtocol): string {
  const endpoint = resolveEndpoint(provider, variant);
  if (endpoint.isFullUrl) return endpoint.baseUrl;
  const base = endpoint.baseUrl.replace(/\/+$/, '');
  return resolveProtocol(provider, variant) === 'anthropic' ? `${base}/messages` : `${base}/chat/completions`;
}
