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

const NO_MODELS: ModelProviderConfig['discoveredModels'] = [];

function preset(config: ProviderConfigInput): ModelProviderConfig {
  return ModelProviderConfigSchema.parse(config);
}

export const BUILTIN_PROVIDER_PRESETS: ModelProviderConfig[] = [
  preset({
    id: 'deepseek-official',
    name: 'DeepSeek 官方',
    category: 'OFFICIAL_LLM',
    variants: [
      { region: 'CN', planType: 'PAY_AS_YOU_GO', baseUrl: 'https://api.deepseek.com/v1', isFullUrl: false },
      { region: 'CN', planType: 'CODING_PLAN', baseUrl: 'https://api.deepseek.com/v1', isFullUrl: false },
      { region: 'GLOBAL', planType: 'PAY_AS_YOU_GO', baseUrl: 'https://api.deepseek.com/v1', isFullUrl: false },
    ],
    apiKeyMaskedOrRef: '',
    discoveredModels: NO_MODELS,
  }),
  preset({
    id: 'siliconflow',
    name: 'SiliconFlow 硅基流动',
    category: 'AGGREGATOR_LLM',
    variants: [{ region: 'CN', planType: 'PAY_AS_YOU_GO', baseUrl: 'https://api.siliconflow.cn/v1', isFullUrl: false }],
    apiKeyMaskedOrRef: '',
    discoveredModels: NO_MODELS,
  }),
  preset({
    id: 'openrouter',
    name: 'OpenRouter',
    category: 'AGGREGATOR_LLM',
    variants: [{ region: 'GLOBAL', planType: 'PAY_AS_YOU_GO', baseUrl: 'https://openrouter.ai/api/v1', isFullUrl: false }],
    apiKeyMaskedOrRef: '',
    discoveredModels: NO_MODELS,
  }),
  preset({
    id: 'volcano-ark',
    name: '火山方舟',
    category: 'OFFICIAL_LLM',
    variants: [{ region: 'CN', planType: 'PAY_AS_YOU_GO', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', isFullUrl: false }],
    apiKeyMaskedOrRef: '',
    discoveredModels: NO_MODELS,
  }),
  preset({
    id: 'openai',
    name: 'OpenAI',
    category: 'OFFICIAL_LLM',
    variants: [{ region: 'GLOBAL', planType: 'PAY_AS_YOU_GO', baseUrl: 'https://api.openai.com/v1', isFullUrl: false }],
    apiKeyMaskedOrRef: '',
    discoveredModels: NO_MODELS,
  }),
  preset({
    id: 'anthropic',
    name: 'Anthropic',
    category: 'OFFICIAL_LLM',
    variants: [{ region: 'GLOBAL', planType: 'PAY_AS_YOU_GO', baseUrl: 'https://api.anthropic.com/v1', isFullUrl: false }],
    apiKeyMaskedOrRef: '',
    discoveredModels: NO_MODELS,
  }),
  preset({
    id: 'minimax',
    name: 'MiniMax',
    category: 'OFFICIAL_LLM',
    variants: [{ region: 'CN', planType: 'PAY_AS_YOU_GO', baseUrl: 'https://api.minimaxi.com/v1', isFullUrl: false }],
    apiKeyMaskedOrRef: '',
    discoveredModels: NO_MODELS,
  }),
  preset({
    id: 'local-ollama',
    name: '本地 Ollama',
    category: 'LOCAL_LLM',
    activeRegion: 'LOCAL',
    variants: [{ region: 'LOCAL', planType: 'LOCAL_GPU', baseUrl: 'http://127.0.0.1:11434/v1', isFullUrl: false }],
    apiKeyMaskedOrRef: '',
    discoveredModels: NO_MODELS,
  }),
  preset({
    id: 'local-gpt-sovits',
    name: '本地 GPT-SoVITS',
    category: 'AUDIO_TTS',
    activeRegion: 'LOCAL',
    variants: [{ region: 'LOCAL', planType: 'LOCAL_GPU', baseUrl: 'http://127.0.0.1:9880', isFullUrl: true }],
    apiKeyMaskedOrRef: '',
    discoveredModels: NO_MODELS,
  }),
];

export const PROVIDER_PRESET_IDS = BUILTIN_PROVIDER_PRESETS.map((provider) => provider.id);

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

/** 允许免拼接的端点则直接使用；否则统一拼接 /chat/completions */
export function buildChatUrl(provider: ModelProviderConfig): string {
  const variant = resolveEndpoint(provider);
  if (variant.isFullUrl) return variant.baseUrl;
  return `${variant.baseUrl.replace(/\/+$/, '')}/chat/completions`;
}
