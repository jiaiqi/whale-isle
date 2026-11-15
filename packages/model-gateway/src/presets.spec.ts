import { describe, expect, it } from 'vitest';
import type { StickyRoutingGroup } from '@workbench/shared-protocol';
import { ModelProviderConfigSchema } from '@workbench/shared-protocol';
import { BUILTIN_PROVIDER_PRESETS, PROVIDER_PRESET_IDS, buildChatUrl, resolveEndpoint } from './presets';
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
