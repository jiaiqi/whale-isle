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
    discoveredModels: [
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
        baseUrl: 'https://opencode.ai/zen/v1',
        isFullUrl: false,
        protocol: 'openai',
      },
      {
        region: 'GLOBAL',
        planType: 'CODING_PLAN',
        baseUrl: 'https://opencode.ai/zen/anthropic/v1',
        isFullUrl: false,
        protocol: 'anthropic',
      },
    ],
    apiKeyMaskedOrRef: '',
    discoveredModels: [
      model('deepseek-v4.1-flash'),
      model('glm-5.3-flash'),
      model('kimi-k3.1-pro', { reasoning: true }),
      model('mimo-v2.6-flash'),
      model('minimax-m3.1-flash'),
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
    discoveredModels: [model('MiniMax-M2.5')],
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

/** Region/Plan 胶囊切换：精确匹配 → 同 Region 任一 → 首个变体 */
export function resolveEndpoint(
  provider: ModelProviderConfig,
): ModelProviderConfig['variants'][number] {
  const exact = provider.variants.find(
    (variant) => variant.region === provider.activeRegion && variant.planType === provider.activePlanType,
  );
  const sameRegion = provider.variants.find((variant) => variant.region === provider.activeRegion);
  const variant = exact ?? sameRegion ?? provider.variants[0];
  if (!variant) throw new Error(`供应商 ${provider.id} 未配置任何端点变体`);
  return variant;
}

/** 变体协议优先，其次供应商默认协议，最后回退 OpenAI 兼容（手写残缺配置兜底） */
export function resolveProtocol(provider: ModelProviderConfig): ProviderProtocol {
  const variant = resolveEndpoint(provider);
  const protocol = variant.protocol ?? provider.protocol;
  return protocol === 'anthropic' ? 'anthropic' : 'openai';
}

/**
 * 允许免拼接的端点则直接使用；否则按协议拼接：
 * OpenAI 兼容 → /chat/completions；Anthropic 兼容 → /messages（base 已含 /v1 时不重复）。
 */
export function buildChatUrl(provider: ModelProviderConfig): string {
  const variant = resolveEndpoint(provider);
  if (variant.isFullUrl) return variant.baseUrl;
  const base = variant.baseUrl.replace(/\/+$/, '');
  return resolveProtocol(provider) === 'anthropic' ? `${base}/messages` : `${base}/chat/completions`;
}
