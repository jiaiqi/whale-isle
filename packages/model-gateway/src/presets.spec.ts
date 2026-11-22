import { describe, expect, it } from 'vitest';
import type { ModelProviderConfig, StickyRoutingGroup } from '@workbench/shared-protocol';
import { ModelProviderConfigSchema } from '@workbench/shared-protocol';
import {
  BUILTIN_PROVIDER_PRESETS,
  PROVIDER_PRESET_IDS,
  buildChatUrl,
  resolveEndpoint,
  resolveProtocol,
} from './presets';
import { orderedCandidates, RouteError, StickyState } from './router';

/** T-M1-03：CC Switch 预设库/胶囊切换 + Magpie 路由候选序列 */

describe('内置供应商预设库（CC Switch 两步式）', () => {
  it('预设全部通过 ModelProviderConfigSchema 且 id 唯一', () => {
    expect(BUILTIN_PROVIDER_PRESETS.length).toBeGreaterThanOrEqual(9);
    const ids = new Set(PROVIDER_PRESET_IDS);
    expect(ids.size).toBe(BUILTIN_PROVIDER_PRESETS.length);
    for (const provider of BUILTIN_PROVIDER_PRESETS) {
      expect(ModelProviderConfigSchema.safeParse(provider).success, provider.id).toBe(true);
    }
    expect(ids.has('deepseek-official')).toBe(true);
    expect(ids.has('local-ollama')).toBe(true);
  });

  it('Region/Plan 胶囊切换：精确匹配优先', () => {
    const provider = BUILTIN_PROVIDER_PRESETS.find((p) => p.id === 'deepseek-official')!;
    const variant = resolveEndpoint({ ...provider, activeRegion: 'GLOBAL', activePlanType: 'PAY_AS_YOU_GO' });
    expect(variant.region).toBe('GLOBAL');
  });

  it('同 Region 回退与默认首变体', () => {
    const provider = BUILTIN_PROVIDER_PRESETS.find((p) => p.id === 'deepseek-official')!;
    expect(resolveEndpoint({ ...provider, activeRegion: 'GLOBAL', activePlanType: 'CODING_PLAN' }).planType).toBe('PAY_AS_YOU_GO');
    expect(resolveEndpoint(provider).region).toBe('CN');
  });

  it('空端点变体 → 显式抛错（防御直接构造的残缺配置）', () => {
    const provider = BUILTIN_PROVIDER_PRESETS.find((p) => p.id === 'deepseek-official')!;
    expect(() => resolveEndpoint({ ...provider, variants: [] })).toThrow(/未配置任何端点变体/);
  });

  it('拼接与免拼接（Full URL 开关）', () => {
    const deepseek = BUILTIN_PROVIDER_PRESETS.find((p) => p.id === 'deepseek-official')!;
    expect(buildChatUrl(deepseek)).toBe('https://api.deepseek.com/v1/chat/completions');
    const sovits = BUILTIN_PROVIDER_PRESETS.find((p) => p.id === 'local-gpt-sovits')!;
    expect(buildChatUrl(sovits)).toBe('http://127.0.0.1:9880'); // 免拼接
    const trailing = ModelProviderConfigSchema.parse({
      ...deepseek,
      variants: [{ ...deepseek.variants[0], baseUrl: 'https://api.deepseek.com/v1/' }],
    });
    expect(buildChatUrl(trailing)).toBe('https://api.deepseek.com/v1/chat/completions');
  });
});

// ---- OpenCode Go 双协议预设 ----
describe('opencode-go 预设（OpenAI / Anthropic 双协议端点）', () => {
  const opencode = BUILTIN_PROVIDER_PRESETS.find((p) => p.id === 'opencode-go')!;

  it('存在且为 AGGREGATOR_LLM：两变体同 region/plan、协议与 baseUrl 正确', () => {
    expect(opencode.name).toBe('OpenCode Go');
    expect(opencode.category).toBe('AGGREGATOR_LLM');
    expect(opencode.variants).toHaveLength(2);
    expect(opencode.variants.map((variant) => variant.protocol)).toEqual(['openai', 'anthropic']);
    for (const variant of opencode.variants) {
      expect(variant.region).toBe('GLOBAL');
      expect(variant.planType).toBe('CODING_PLAN');
    }
    expect(opencode.variants[0]?.baseUrl).toBe('https://opencode.ai/zen/v1');
    expect(opencode.variants[1]?.baseUrl).toBe('https://opencode.ai/zen/anthropic/v1');
  });

  it('预置 5 个模型：kimi-k3.1-pro 带 reasoning 标签，其余默认工具调用', () => {
    expect(opencode.discoveredModels.map((model) => model.id)).toEqual([
      'deepseek-v4.1-flash',
      'glm-5.3-flash',
      'kimi-k3.1-pro',
      'mimo-v2.6-flash',
      'minimax-m3.1-flash',
    ]);
    const kimi = opencode.discoveredModels.find((model) => model.id === 'kimi-k3.1-pro');
    expect(kimi?.supportsReasoningThink).toBe(true);
    expect(kimi?.supportsToolCalling).toBe(true);
    for (const model of opencode.discoveredModels.filter((item) => item.id !== 'kimi-k3.1-pro')) {
      expect(model.supportsReasoningThink).toBe(false);
      expect(model.supportsToolCalling).toBe(true);
    }
  });

  it('buildChatUrl：openai → /chat/completions；anthropic → /messages', () => {
    expect(buildChatUrl(opencode)).toBe('https://opencode.ai/zen/v1/chat/completions'); // 首变体为 OpenAI
    const anthropicProvider = ModelProviderConfigSchema.parse({
      ...opencode,
      variants: [opencode.variants[1]!],
    });
    expect(resolveProtocol(anthropicProvider)).toBe('anthropic');
    expect(buildChatUrl(anthropicProvider)).toBe('https://opencode.ai/zen/anthropic/v1/messages');
  });

  it('anthropic base 末尾带斜杠 / 已含 /v1 → 不重复拼接 /v1', () => {
    const trailing = ModelProviderConfigSchema.parse({
      ...opencode,
      variants: [{ ...opencode.variants[1], baseUrl: 'https://opencode.ai/zen/anthropic/v1/' }],
    });
    expect(buildChatUrl(trailing)).toBe('https://opencode.ai/zen/anthropic/v1/messages');
  });

  it('resolveProtocol：变体覆盖供应商 / 供应商兜底 / 缺省回退 openai', () => {
    expect(resolveProtocol(opencode)).toBe('openai'); // 首变体
    const anthropicPreset = BUILTIN_PROVIDER_PRESETS.find((p) => p.id === 'anthropic')!;
    expect(resolveProtocol(anthropicPreset)).toBe('anthropic');

    // 变体 protocol 优先于供应商默认 protocol
    const variantWins = ModelProviderConfigSchema.parse({
      ...anthropicPreset,
      variants: [{ ...anthropicPreset.variants[0], protocol: 'openai' }],
    });
    expect(resolveProtocol(variantWins)).toBe('openai');

    // 手写残缺配置：变体缺 protocol → 供应商兜底 anthropic
    const providerFallback = {
      ...anthropicPreset,
      variants: [
        { region: 'GLOBAL', planType: 'PAY_AS_YOU_GO', baseUrl: 'https://api.anthropic.com/v1', isFullUrl: false },
      ],
    } as unknown as ModelProviderConfig;
    expect(resolveProtocol(providerFallback)).toBe('anthropic');

    // 变体与供应商都缺 protocol → 默认 openai
    const bothMissing = { ...providerFallback, protocol: undefined } as unknown as ModelProviderConfig;
    expect(resolveProtocol(bothMissing)).toBe('openai');
  });

  it('现有预设补 protocol：anthropic 官方为 anthropic；其余（含 GPT-SoVITS）为 openai', () => {
    const anthropicPreset = BUILTIN_PROVIDER_PRESETS.find((p) => p.id === 'anthropic')!;
    expect(anthropicPreset.protocol).toBe('anthropic');
    expect(anthropicPreset.variants.every((variant) => variant.protocol === 'anthropic')).toBe(true);

    const sovits = BUILTIN_PROVIDER_PRESETS.find((p) => p.id === 'local-gpt-sovits')!;
    expect(sovits.variants.every((variant) => variant.protocol === 'openai')).toBe(true);
    expect(buildChatUrl(sovits)).toBe('http://127.0.0.1:9880'); // 免拼接且不参与 LLM 路由

    for (const provider of BUILTIN_PROVIDER_PRESETS) {
      if (provider.id === 'anthropic' || provider.id === 'opencode-go') continue;
      expect(provider.variants.every((variant) => variant.protocol === 'openai'), provider.id).toBe(true);
    }
  });
});

// ---- 本地预设默认模型（UI 语音槽位可选项）----
describe('本地预设默认模型', () => {
  it('local-gpt-sovits：gpt-sovits-v2 / rvc-v2 存在且不声明工具调用', () => {
    const sovits = BUILTIN_PROVIDER_PRESETS.find((p) => p.id === 'local-gpt-sovits')!;
    expect(sovits.discoveredModels.map((model) => model.id)).toEqual(['gpt-sovits-v2', 'rvc-v2']);
    for (const model of sovits.discoveredModels) {
      expect(model.supportsToolCalling, model.id).toBe(false);
      expect(model.supportsReasoningThink).toBe(false);
      expect(model.supportsVision).toBe(false);
    }
  });

  it('local-ollama：qwen2.5:14b / 7b / vl:7b 三模型，仅 vl 带 vision', () => {
    const ollama = BUILTIN_PROVIDER_PRESETS.find((p) => p.id === 'local-ollama')!;
    expect(ollama.discoveredModels.map((model) => model.id)).toEqual([
      'qwen2.5:14b',
      'qwen2.5:7b',
      'qwen2.5-vl:7b',
    ]);
    for (const model of ollama.discoveredModels) {
      expect(model.supportsToolCalling, model.id).toBe(true);
    }
    expect(ollama.discoveredModels.find((model) => model.id === 'qwen2.5-vl:7b')?.supportsVision).toBe(true);
    expect(
      ollama.discoveredModels.filter((model) => model.id !== 'qwen2.5-vl:7b').every((model) => !model.supportsVision),
    ).toBe(true);
  });
});

// ---- 内置展示模型清单（UI 默认模型下拉）----
describe('内置展示模型清单', () => {
  const EXPECTED_MODELS: Record<string, string[]> = {
    'deepseek-official': ['deepseek-chat', 'deepseek-reasoner', 'deepseek-flash'],
    siliconflow: ['Qwen/Qwen2.5-7B-Instruct', 'Qwen/Qwen2.5-VL-7B-Instruct'],
    openrouter: ['anthropic/claude-sonnet', 'google/gemini-2.5-pro'],
    'volcano-ark': ['doubao-1-5-pro-32k'],
    openai: ['gpt-4.1-mini'],
    anthropic: ['claude-3-7-sonnet'],
    minimax: ['MiniMax-M2.5'],
    'opencode-go': ['deepseek-v4.1-flash', 'glm-5.3-flash', 'kimi-k3.1-pro', 'mimo-v2.6-flash', 'minimax-m3.1-flash'],
    'local-ollama': ['qwen2.5:14b', 'qwen2.5:7b', 'qwen2.5-vl:7b'],
    'local-gpt-sovits': ['gpt-sovits-v2', 'rvc-v2'],
  };

  it('每个内置预设的 discoveredModels 数量与 id 齐全', () => {
    for (const [id, expected] of Object.entries(EXPECTED_MODELS)) {
      const provider = BUILTIN_PROVIDER_PRESETS.find((preset) => preset.id === id);
      expect(provider, id).toBeDefined();
      expect(provider?.discoveredModels.map((model) => model.id), id).toEqual(expected);
    }
    expect(BUILTIN_PROVIDER_PRESETS.every((provider) => provider.discoveredModels.length > 0)).toBe(true);
  });

  it('展示模型标签：reasoning/vision 按清单声明，其余默认工具调用', () => {
    const findModel = (providerId: string, modelId: string) => {
      const provider = BUILTIN_PROVIDER_PRESETS.find((preset) => preset.id === providerId)!;
      return provider.discoveredModels.find((model) => model.id === modelId)!;
    };
    expect(findModel('deepseek-official', 'deepseek-reasoner').supportsReasoningThink).toBe(true);
    expect(findModel('deepseek-official', 'deepseek-chat').supportsReasoningThink).toBe(false);
    expect(findModel('deepseek-official', 'deepseek-flash').supportsReasoningThink).toBe(false);
    expect(findModel('siliconflow', 'Qwen/Qwen2.5-VL-7B-Instruct').supportsVision).toBe(true);
    expect(findModel('siliconflow', 'Qwen/Qwen2.5-7B-Instruct').supportsVision).toBe(false);
    expect(findModel('openrouter', 'anthropic/claude-sonnet')).toMatchObject({
      supportsReasoningThink: true,
      supportsVision: true,
    });
    expect(findModel('openrouter', 'google/gemini-2.5-pro')).toMatchObject({
      supportsReasoningThink: true,
      supportsVision: true,
    });
    expect(findModel('openai', 'gpt-4.1-mini')).toMatchObject({
      supportsReasoningThink: false,
      supportsVision: true,
    });
    expect(findModel('anthropic', 'claude-3-7-sonnet')).toMatchObject({
      supportsReasoningThink: true,
      supportsVision: true,
    });
    expect(findModel('volcano-ark', 'doubao-1-5-pro-32k')).toMatchObject({
      supportsReasoningThink: false,
      supportsVision: false,
      supportsToolCalling: true,
    });
    expect(findModel('minimax', 'MiniMax-M2.5')).toMatchObject({
      supportsReasoningThink: false,
      supportsVision: false,
      supportsToolCalling: true,
    });
  });
});

// ---- 路由候选序列 ----
const GROUP: StickyRoutingGroup = {
  groupId: 'brain-pool',
  strategy: 'PROMPT_CACHE_STICKY',
  candidates: [
    { providerId: 'deepseek-official', modelId: 'deepseek-reasoner', weight: 70 },
    { providerId: 'siliconflow', modelId: 'deepseek-v3', weight: 30 },
  ],
};

function makeContext(
  binding: string,
  overrides?: { groups?: StickyRoutingGroup[]; sessionId?: string; state?: StickyState },
) {
  return {
    binding,
    groups: overrides?.groups ?? [GROUP],
    state: overrides?.state ?? new StickyState(),
    sessionId: overrides?.sessionId ?? 'live-1',
    slot: 'MAIN_PERSONA_BRAIN' as const,
  };
}

describe('orderedCandidates（Magpie 路由）', () => {
  it('直接绑定 providerId/modelId', () => {
    expect(orderedCandidates(makeContext('deepseek-official/deepseek-chat'))).toEqual([
      { providerId: 'deepseek-official', modelId: 'deepseek-chat', groupId: null, weight: 100 },
    ]);
  });

  it('坏绑定 / 缺失粘性组 → GROUP_MISSING 等专属错误码', () => {
    expect(() => orderedCandidates(makeContext('just-a-word'))).toThrow(RouteError);
    let thrown: RouteError | null = null;
    try {
      orderedCandidates(makeContext('group/nope'));
    } catch (error) {
      thrown = error as RouteError;
    }
    expect(thrown).toBeInstanceOf(RouteError);
    expect(thrown?.code).toBe('GROUP_MISSING');
  });

  it('PROMPT_CACHE_STICKY：权重降序首选；成功后同会话粘住同节点', () => {
    const state = new StickyState();
    const first = orderedCandidates(makeContext('group/brain-pool', { state }));
    expect(first[0]?.providerId).toBe('deepseek-official'); // weight 70 优先

    // siliconflow 成功 → 写入 lastGood → 下次同会话粘住它
    const siliconflowCandidate = orderedCandidates(makeContext('group/brain-pool', { state })).find(
      (candidate) => candidate.providerId === 'siliconflow',
    );
    expect(siliconflowCandidate).toBeDefined();
    state.recordGood(StickyState.key('live-1', 'MAIN_PERSONA_BRAIN', 'brain-pool'), siliconflowCandidate!);

    const second = orderedCandidates(makeContext('group/brain-pool', { state }));
    expect(second[0]?.providerId).toBe('siliconflow');
    expect(second).toHaveLength(2); // deepseek 仍为 failover 池
  });

  it('ROUND_ROBIN 轮换', () => {
    const group: StickyRoutingGroup = { ...GROUP, strategy: 'ROUND_ROBIN' };
    const state = new StickyState();
    expect(orderedCandidates(makeContext('group/brain-pool', { groups: [group], state }))[0]?.providerId).toBe('deepseek-official');
    expect(orderedCandidates(makeContext('group/brain-pool', { groups: [group], state }))[0]?.providerId).toBe('siliconflow');
    expect(orderedCandidates(makeContext('group/brain-pool', { groups: [group], state }))[0]?.providerId).toBe('deepseek-official'); // 回绕
  });

  it('LOWEST_LATENCY：无时延记录时按权重降序（兜底分支）', () => {
    const group: StickyRoutingGroup = { ...GROUP, strategy: 'LOWEST_LATENCY' };
    const state = new StickyState(); // 无任何时延记录
    const ordered = orderedCandidates(makeContext('group/brain-pool', { groups: [group], state }));
    expect(ordered[0]?.providerId).toBe('deepseek-official'); // weight 70 优先
    expect(ordered).toHaveLength(2);
  });

  it('LOWEST_LATENCY：最快节点优先', () => {
    const group: StickyRoutingGroup = { ...GROUP, strategy: 'LOWEST_LATENCY' };
    const state = new StickyState();
    state.recordLatency('brain-pool', 1, 30); // siliconflow（index 1）更快
    const ordered = orderedCandidates(makeContext('group/brain-pool', { groups: [group], state }));
    expect(ordered[0]?.providerId).toBe('siliconflow');
  });
});
