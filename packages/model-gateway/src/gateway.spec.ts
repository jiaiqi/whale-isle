import { describe, expect, it } from 'vitest';
import type { DiningProfilePreset, ModelProviderConfig, StickyRoutingGroup } from '@workbench/shared-protocol';
import { ModelGateway, GatewayError, type FetchLike, type UsageRecord } from './gateway';
import { BUILTIN_PROVIDER_PRESETS } from './presets';
import { MASK } from './sanitizer';

/** T-M1-03 门禁：模拟上游 429 → 100ms 内静默切换备用 Key；敏感路径 100% → {{MASKED}}；usage 计量与回执 */

const PROFILE: DiningProfilePreset = {
  profileId: 'DELUXE_LIVESTREAM',
  displayName: '🍱 豪华直播档',
  roleBindings: {
    MAIN_PERSONA_BRAIN: 'group/brain-pool',
    STARDEW_GAME_PLANNER: 'deepseek-official/deepseek-chat',
  },
  secretMaskingEnabled: true,
};

const PROVIDERS = [
  {
    id: 'deepseek-official',
    name: 'DeepSeek 官方',
    category: 'OFFICIAL_LLM',
    variants: [{ region: 'CN', planType: 'PAY_AS_YOU_GO', baseUrl: 'https://api.deepseek.com/v1', isFullUrl: false }],
    apiKeyMaskedOrRef: '',
    discoveredModels: [],
  },
  {
    id: 'siliconflow',
    name: 'SiliconFlow',
    category: 'AGGREGATOR_LLM',
    variants: [{ region: 'CN', planType: 'PAY_AS_YOU_GO', baseUrl: 'https://api.siliconflow.cn/v1', isFullUrl: false }],
    apiKeyMaskedOrRef: '',
    discoveredModels: [],
  },
];

const GROUP: StickyRoutingGroup = {
  groupId: 'brain-pool',
  strategy: 'PROMPT_CACHE_STICKY',
  candidates: [
    { providerId: 'deepseek-official', modelId: 'deepseek-reasoner', weight: 70 },
    { providerId: 'siliconflow', modelId: 'deepseek-v3', weight: 30 },
  ],
};

const KEYS = { 'deepseek-official': 'sk-live-primary-key-000000000001', siliconflow: 'sk-live-backup-key-0000000002' };

function okResponse(content = '哼，本鱼才没有偷懒！'): Awaited<ReturnType<FetchLike>> {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 1200, completion_tokens: 80, prompt_cache_hit_tokens: 900 },
    }),
  };
}

function statusResponse(status: number): Awaited<ReturnType<FetchLike>> {
  return { ok: false, status, json: async () => ({}) };
}

describe('ModelGateway', () => {
  it('门禁①：上游 429 → 100ms 内静默切换备用 Key（attempt=1）', async () => {
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      calls.push(url);
      return url.includes('deepseek.com') ? statusResponse(429) : okResponse();
    };
    const gateway = new ModelGateway({ profile: PROFILE, providers: PROVIDERS, groups: [GROUP], keys: KEYS, fetchImpl });
    const startedAt = Date.now();
    const receipt = await gateway.chat('MAIN_PERSONA_BRAIN', [{ role: 'user', content: '在摸鱼吗' }]);
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeLessThan(100); // 100ms 铁律（fake fetch 无 I/O，纯代码开销）
    expect(calls).toHaveLength(2); // 第一候选 429 → 第二候选立即接手
    expect(receipt.route).toEqual({ providerId: 'siliconflow', modelId: 'deepseek-v3', attempt: 1 });
    expect(receipt.content).toContain('本鱼');
    expect(calls[1]).toBe('https://api.siliconflow.cn/v1/chat/completions');
  });

  it('门禁②：敏感路径/密钥 100% → {{MASKED}} 才出网（捕获出站 body 断言）', async () => {
    const bodies: string[] = [];
    const fetchImpl: FetchLike = async (_url, init) => {
      bodies.push(init.body);
      return okResponse('收到');
    };
    const gateway = new ModelGateway({
      profile: PROFILE,
      providers: PROVIDERS,
      groups: [GROUP],
      keys: KEYS,
      fetchImpl,
      sanitizer: { username: 'jiaqi', homeDir: '/Users/jiaqi' },
    });
    await gateway.chat('MAIN_PERSONA_BRAIN', [
      { role: 'system', content: '主人的配置目录是 /Users/jiaqi/workbench，key=sk-abcDEF1234567890abcdef' },
      { role: 'user', content: '用户 jiaqi 说：今晚吃什么' },
    ]);
    const sent = bodies[0];
    expect(sent).not.toContain('/Users/jiaqi');
    expect(sent).not.toContain('sk-abcDEF');
    expect(sent).not.toContain('jiaqi');
    expect(sent).toContain(MASK);
    // 粘性路由记忆：第二次同会话直接命中上次成功的节点
    await gateway.chat('MAIN_PERSONA_BRAIN', [{ role: 'user', content: '普通内容' }], { sessionId: 'live-1' });
    await gateway.chat('MAIN_PERSONA_BRAIN', [{ role: 'user', content: '再次询问' }], { sessionId: 'live-1' });
  });

  it('500 / 网络错误同样静默 failover；全败 → ALL_CANDIDATES_FAILED 附尝试明细', async () => {
    const fetchImpl: FetchLike = async () => statusResponse(500);
    const gateway = new ModelGateway({ profile: PROFILE, providers: PROVIDERS, groups: [GROUP], keys: KEYS, fetchImpl });
    const startedAt = Date.now();
    const error = await gateway.chat('MAIN_PERSONA_BRAIN', [{ role: 'user', content: 'x' }]).catch((e) => e);
    expect(error).toBeInstanceOf(GatewayError);
    expect((error as GatewayError).code).toBe('ALL_CANDIDATES_FAILED');
    expect((error as GatewayError).detail?.attempts).toHaveLength(2);
    expect(Date.now() - startedAt).toBeLessThan(100);

    const networkGateway = new ModelGateway({
      profile: PROFILE,
      providers: PROVIDERS,
      groups: [GROUP],
      keys: KEYS,
      fetchImpl: (async () => {
        throw new Error('ECONNRESET');
      }) as unknown as FetchLike,
    });
    const netError = await networkGateway.chat('MAIN_PERSONA_BRAIN', [{ role: 'user', content: 'x' }]).catch((e) => e);
    expect((netError as GatewayError).detail?.attempts?.every((attempt) => attempt.reason.startsWith('NETWORK_ERROR'))).toBe(true);
  });

  it('400 请求级错误直接抛出（failover 无意义）', async () => {
    let callCount = 0;
    const fetchImpl: FetchLike = async () => {
      callCount += 1;
      return { ok: false, status: 400, json: async () => ({ error: { message: 'model not found' } }) };
    };
    const gateway = new ModelGateway({ profile: PROFILE, providers: PROVIDERS, groups: [GROUP], keys: KEYS, fetchImpl });
    const error = await gateway.chat('MAIN_PERSONA_BRAIN', [{ role: 'user', content: 'x' }]).catch((e) => e);
    expect((error as GatewayError).code).toBe('BAD_REQUEST');
    expect(callCount).toBe(1); // 不 failover
  });

  it('400 且响应体不可解析 → 仍报 BAD_REQUEST（错误信息兜底）', async () => {
    const gateway = new ModelGateway({
      profile: PROFILE,
      providers: PROVIDERS,
      groups: [GROUP],
      keys: KEYS,
      fetchImpl: async () => ({
        ok: false,
        status: 400,
        json: async () => {
          throw new Error('invalid json');
        },
      }),
    });
    const error = await gateway.chat('MAIN_PERSONA_BRAIN', [{ role: 'user', content: 'x' }]).catch((e) => e);
    expect((error as GatewayError).code).toBe('BAD_REQUEST');
    expect((error as GatewayError).message).toContain('unknown');
  });

  it('上游返回无 choices → 回执内容为空串（兜底不崩）', async () => {
    const gateway = new ModelGateway({
      profile: PROFILE,
      providers: PROVIDERS,
      groups: [GROUP],
      keys: KEYS,
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ usage: { prompt_tokens: 5 } }) }),
    });
    const receipt = await gateway.chat('MAIN_PERSONA_BRAIN', [{ role: 'user', content: 'x' }]);
    expect(receipt.content).toBe('');
    expect(receipt.usage.inputTokens).toBe(5);
  });

  it('usage 计量只记供应商实际回报（1 粒米 = 1 Token 流水口径）', async () => {
    const usages: UsageRecord[] = [];
    const gateway = new ModelGateway({
      profile: PROFILE,
      providers: PROVIDERS,
      groups: [GROUP],
      keys: KEYS,
      fetchImpl: async () => okResponse(),
      onUsage: (record) => usages.push(record),
    });
    const receipt = await gateway.chat('MAIN_PERSONA_BRAIN', [{ role: 'user', content: 'hi' }]);
    expect(usages).toHaveLength(1);
    expect(usages[0]).toMatchObject({
      slot: 'MAIN_PERSONA_BRAIN',
      providerId: 'deepseek-official',
      modelId: 'deepseek-reasoner',
      inputTokens: 1200,
      cachedInputTokens: 900,
      outputTokens: 80,
    });
    expect(receipt.usage.inputTokens).toBe(1200);
  });

  it('secretMaskingEnabled=false 出站原文直传；槽位未绑定 → ROUTE_UNBOUND；Key 缺失计入尝试', async () => {
    const bodies: string[] = [];
    const rawProfile: DiningProfilePreset = { ...PROFILE, secretMaskingEnabled: false };
    const gateway = new ModelGateway({
      profile: rawProfile,
      providers: PROVIDERS,
      groups: [GROUP],
      keys: KEYS,
      fetchImpl: async (_url, init) => {
        bodies.push(init.body);
        return okResponse();
      },
      sanitizer: { username: 'jiaqi', homeDir: '/Users/jiaqi' },
    });
    await gateway.chat('MAIN_PERSONA_BRAIN', [{ role: 'user', content: '路径 /Users/jiaqi/notes.md' }]);
    expect(bodies[0]).toContain('/Users/jiaqi/notes.md'); // 关闭脱敏 → 原文
    expect((await gateway.chat('STARDEW_GAME_PLANNER', [{ role: 'user', content: 'x' }])).sanitized).toBe(false);

    const unbound = new ModelGateway({
      profile: { ...PROFILE, roleBindings: {} },
      providers: PROVIDERS,
      groups: [GROUP],
      keys: KEYS,
      fetchImpl: async () => okResponse(),
    });
    const unboundError = await unbound.chat('MAIN_PERSONA_BRAIN', []).catch((e) => e);
    expect((unboundError as GatewayError).code).toBe('ROUTE_UNBOUND');

    // 绑定指向缺失粘性组 → RouteError 在 chat 内包装为 GROUP_MISSING
    const badGroup = new ModelGateway({
      profile: { ...PROFILE, roleBindings: { ...PROFILE.roleBindings, MAIN_PERSONA_BRAIN: 'group/missing' } },
      providers: PROVIDERS,
      groups: [GROUP],
      keys: KEYS,
      fetchImpl: async () => okResponse(),
    });
    const groupError = await badGroup.chat('MAIN_PERSONA_BRAIN', [{ role: 'user', content: 'x' }]).catch((e) => e);
    expect((groupError as GatewayError).code).toBe('GROUP_MISSING');

    const noKey = new ModelGateway({
      profile: PROFILE,
      providers: PROVIDERS,
      groups: [GROUP],
      keys: {},
      fetchImpl: async () => okResponse(),
    });
    const keyError = await noKey.chat('MAIN_PERSONA_BRAIN', [{ role: 'user', content: 'x' }]).catch((e) => e);
    expect((keyError as GatewayError).code).toBe('ALL_CANDIDATES_FAILED');
    expect((keyError as GatewayError).detail?.attempts?.every((attempt) => attempt.reason === 'KEY_MISSING')).toBe(true);
  });

  it('temperature/max_tokens 透传出站 body', async () => {
    const bodies: string[] = [];
    const directProfile: DiningProfilePreset = {
      ...PROFILE,
      roleBindings: { ...PROFILE.roleBindings, MAIN_PERSONA_BRAIN: 'deepseek-official/deepseek-reasoner' },
    };
    const gateway = new ModelGateway({
      profile: directProfile,
      providers: PROVIDERS,
      groups: [GROUP],
      keys: KEYS,
      fetchImpl: async (_url, init) => {
        bodies.push(init.body);
        return okResponse();
      },
    });
    const receipt = await gateway.chat(
      'MAIN_PERSONA_BRAIN',
      [{ role: 'user', content: 'x' }],
      { temperature: 0.7, maxTokens: 512 },
    );
    const body = JSON.parse(bodies[0] ?? '{}') as { temperature?: number; max_tokens?: number; model?: string };
    expect(body.temperature).toBe(0.7);
    expect(body.max_tokens).toBe(512);
    expect(body.model).toBe('deepseek-reasoner');
    expect(receipt.route.providerId).toBe('deepseek-official');
  });

  it('供应商未回报 usage/推理字段 → 回执零值兜底；非 Error 抛出同样静默切换', async () => {
    const fetchImpl: FetchLike = async (url) => {
      if (url.includes('deepseek.com')) {
        throw 'boom-string'; // 非 Error 抛出（网络层怪异行为也要兜住）
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: '回执' } }] }), // 无 usage / 无 reasoning_content
      };
    };
    const gateway = new ModelGateway({ profile: PROFILE, providers: PROVIDERS, groups: [GROUP], keys: KEYS, fetchImpl });
    const receipt = await gateway.chat('MAIN_PERSONA_BRAIN', [{ role: 'user', content: 'x' }]);
    expect(receipt.route.providerId).toBe('siliconflow');
    expect(receipt.reasoningContent).toBeNull();
    expect(receipt.usage).toEqual({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 });
    const error = await (() => {
      const ghost = new ModelGateway({
        profile: { ...PROFILE, roleBindings: { ...PROFILE.roleBindings, MAIN_PERSONA_BRAIN: 'deepseek-official/deepseek-reasoner' } },
        providers: PROVIDERS,
        groups: [GROUP],
        keys: KEYS,
        fetchImpl: (async () => {
          throw 'boom-string';
        }) as unknown as FetchLike,
      });
      return ghost.chat('MAIN_PERSONA_BRAIN', [{ role: 'user', content: 'x' }]).catch((e) => e);
    })();
    expect((error as GatewayError).detail?.attempts?.[0]?.reason).toBe('NETWORK_ERROR:boom-string');
  });

  it('PROVIDER_MISSING / PARSE_ERROR 均计入尝试并静默切换', async () => {
    // 直接绑定指向不存在的 provider → PROVIDER_MISSING
    const ghostGateway = new ModelGateway({
      profile: { ...PROFILE, roleBindings: { ...PROFILE.roleBindings, MAIN_PERSONA_BRAIN: 'ghost-provider/model-x' } },
      providers: PROVIDERS,
      groups: [GROUP],
      keys: KEYS,
      fetchImpl: async () => okResponse(),
    });
    const ghostError = await ghostGateway.chat('MAIN_PERSONA_BRAIN', [{ role: 'user', content: 'x' }]).catch((e) => e);
    expect((ghostError as GatewayError).detail?.attempts?.[0]?.reason).toBe('PROVIDER_MISSING');

    // 200 但 body 坏 JSON → PARSE_ERROR → failover 到第二候选成功（attempt=1）
    const parseCalls: string[] = [];
    const parseGateway = new ModelGateway({
      profile: PROFILE,
      providers: PROVIDERS,
      groups: [GROUP],
      keys: KEYS,
      fetchImpl: async (url) => {
        parseCalls.push(url);
        return url.includes('deepseek.com')
          ? { ok: true, status: 200, json: async () => { throw new Error('invalid json'); } }
          : okResponse();
      },
    });
    const parseReceipt = await parseGateway.chat('MAIN_PERSONA_BRAIN', [{ role: 'user', content: 'x' }]);
    expect(parseReceipt.route.attempt).toBe(1);
    expect(parseReceipt.route.providerId).toBe('siliconflow');
  });

  it('未注入 fetchImpl 时回退到全局 fetch（stub 验证）', async () => {
    const directProfile: DiningProfilePreset = {
      ...PROFILE,
      roleBindings: { ...PROFILE.roleBindings, MAIN_PERSONA_BRAIN: 'deepseek-official/deepseek-reasoner' },
    };
    const originalFetch = globalThis.fetch;
    let fetchedUrl = '';
    globalThis.fetch = (async (url: string | URL) => {
      fetchedUrl = String(url);
      return okResponse() as unknown as Response;
    }) as typeof fetch;
    try {
      const gateway = new ModelGateway({ profile: directProfile, providers: PROVIDERS, groups: [GROUP], keys: KEYS });
      const receipt = await gateway.chat('MAIN_PERSONA_BRAIN', [{ role: 'user', content: 'x' }]);
      expect(receipt.content).toContain('本鱼');
      expect(fetchedUrl).toBe('https://api.deepseek.com/v1/chat/completions');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('配置损坏时原样透传异常（防御分支：非 RouteError 不被吞）', async () => {
    // 损坏的粘性组：candidates 非数组 → orderedCandidates 抛 TypeError（非 RouteError）
    const brokenGroup = {
      groupId: 'broken-group',
      strategy: 'PROMPT_CACHE_STICKY',
      candidates: 'not-an-array',
    } as unknown as StickyRoutingGroup;
    const gateway = new ModelGateway({
      profile: { ...PROFILE, roleBindings: { ...PROFILE.roleBindings, MAIN_PERSONA_BRAIN: 'group/broken-group' } },
      providers: PROVIDERS,
      groups: [brokenGroup],
      keys: KEYS,
      fetchImpl: async () => okResponse(),
    });
    const error = await gateway.chat('MAIN_PERSONA_BRAIN', [{ role: 'user', content: 'x' }]).catch((e) => e);
    expect(error).toBeInstanceOf(TypeError);
    expect((error as TypeError).message).toContain('map');
  });

  it('switchProfile 清空粘性状态；ROUND_ROBIN 套餐直接绑定不受影响', async () => {
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      calls.push(url);
      return okResponse('ok');
    };
    const gateway = new ModelGateway({ profile: PROFILE, providers: PROVIDERS, groups: [GROUP], keys: KEYS, fetchImpl });
    await gateway.chat('MAIN_PERSONA_BRAIN', [{ role: 'user', content: 'a' }]);
    await gateway.chat('MAIN_PERSONA_BRAIN', [{ role: 'user', content: 'b' }], { sessionId: 'live-1' });
    // 粘性：第二次仍命中首候选 deepseek（首候选即成功）
    expect(calls.filter((url) => url.includes('siliconflow'))).toHaveLength(0);
    gateway.switchProfile({ ...PROFILE, roleBindings: { ...PROFILE.roleBindings, MAIN_PERSONA_BRAIN: 'siliconflow/deepseek-v3' } });
    await gateway.chat('MAIN_PERSONA_BRAIN', [{ role: 'user', content: 'c' }]);
    expect(calls.at(-1)).toBe('https://api.siliconflow.cn/v1/chat/completions');
  });
});

// ---- Anthropic 协议（OpenCode Go /messages）----
const ANTHROPIC_PROVIDER: ModelProviderConfig = {
  id: 'opencode-go',
  name: 'OpenCode Go',
  category: 'AGGREGATOR_LLM',
  activeRegion: 'GLOBAL',
  activePlanType: 'CODING_PLAN',
  variants: [
    {
      region: 'GLOBAL',
      planType: 'CODING_PLAN',
      baseUrl: 'https://opencode.ai/inference/go/anthropic/v1',
      isFullUrl: false,
      protocol: 'anthropic',
    },
  ],
  apiKeyMaskedOrRef: '',
  activeModelId: 'deepseek-v4.1-flash',
  protocol: 'openai', // 供应商默认 openai：验证变体 protocol 优先生效
  discoveredModels: [],
};

const ANTHROPIC_PROFILE: DiningProfilePreset = {
  profileId: 'DELUXE_LIVESTREAM',
  displayName: '🍱 豪华直播档',
  roleBindings: { MAIN_PERSONA_BRAIN: 'opencode-go/deepseek-v4.1-flash' },
  secretMaskingEnabled: true,
};

const ANTHROPIC_KEYS = { 'opencode-go': 'oc_sk_live_0123456789abcdef' };

const MIXED_GROUP: StickyRoutingGroup = {
  groupId: 'brain-mixed',
  strategy: 'PROMPT_CACHE_STICKY',
  candidates: [
    { providerId: 'opencode-go', modelId: 'deepseek-v4.1-flash', weight: 70 },
    { providerId: 'siliconflow', modelId: 'deepseek-v3', weight: 30 },
  ],
};

function anthropicOkResponse(content = '哼，本鱼才没有偷懒！'): Awaited<ReturnType<FetchLike>> {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: content }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 320, output_tokens: 45 },
    }),
  };
}

describe('ModelGateway · Anthropic 协议', () => {
  it('OpenCode Go 请求自动携带稳定 x-opencode-session 与自定义 User-Agent', async () => {
    const seen: Array<Record<string, string>> = [];
    const fetchImpl: FetchLike = async (_url, init) => {
      seen.push(init.headers);
      return okResponse('ok');
    };
    const gateway = new ModelGateway({
      profile: ANTHROPIC_PROFILE,
      providers: [ANTHROPIC_PROVIDER],
      keys: ANTHROPIC_KEYS,
      fetchImpl,
    });
    await gateway.chat('MAIN_PERSONA_BRAIN', [{ role: 'user', content: 'a' }], { sessionId: 'conv-1' });
    await gateway.chat('MAIN_PERSONA_BRAIN', [{ role: 'user', content: 'b' }], { sessionId: 'conv-1' });
    await gateway.chat('MAIN_PERSONA_BRAIN', [{ role: 'user', content: 'c' }], { sessionId: 'conv-2' });
    const sessions = seen.map((h) => h['x-opencode-session'] ?? '');
    expect(sessions[0]).toMatch(/^ses_[a-f0-9]{32}$/);
    expect(sessions[1]).toBe(sessions[0]);
    expect(sessions[2]).not.toBe(sessions[0]);
    expect(seen[0]?.['user-agent']).toBe('xiaojing-workbench/1.0');
  });

  it('请求 URL/headers/body：x-api-key + anthropic-version、无 authorization、system 抽为顶层字符串', async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    const gateway = new ModelGateway({
      profile: ANTHROPIC_PROFILE,
      providers: [ANTHROPIC_PROVIDER],
      keys: ANTHROPIC_KEYS,
      fetchImpl: async (url, init) => {
        calls.push({ url, headers: init.headers, body: init.body });
        return anthropicOkResponse();
      },
    });
    await gateway.chat('MAIN_PERSONA_BRAIN', [
      { role: 'system', content: '你是大肥鱼' },
      { role: 'system', content: '保持傲娇' },
      { role: 'user', content: '在摸鱼吗' },
      { role: 'assistant', content: '才没有' },
    ]);

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe('https://opencode.ai/inference/go/anthropic/v1/messages');
    expect(call.headers['x-api-key']).toBe(ANTHROPIC_KEYS['opencode-go']);
    expect(call.headers['anthropic-version']).toBe('2023-06-01');
    expect(call.headers['content-type']).toBe('application/json');
    expect(call.headers.authorization).toBeUndefined();

    const body = JSON.parse(call.body) as {
      model?: string;
      max_tokens?: number;
      system?: string;
      temperature?: number;
      messages?: Array<{ role: string; content: string }>;
    };
    expect(body.model).toBe('deepseek-v4.1-flash');
    expect(body.max_tokens).toBe(1024); // 未显式传 maxTokens → 默认 1024
    expect(body.system).toBe('你是大肥鱼\n\n保持傲娇');
    expect(body.messages).toEqual([
      { role: 'user', content: '在摸鱼吗' },
      { role: 'assistant', content: '才没有' },
    ]);
    expect(body.messages?.some((message) => message.role === 'system')).toBe(false);
    expect(body.temperature).toBeUndefined();
  });

  it('temperature 可选透传 + maxTokens 覆盖默认；无 system 消息时不发 system 字段', async () => {
    const bodies: string[] = [];
    const gateway = new ModelGateway({
      profile: ANTHROPIC_PROFILE,
      providers: [ANTHROPIC_PROVIDER],
      keys: ANTHROPIC_KEYS,
      fetchImpl: async (_url, init) => {
        bodies.push(init.body);
        return anthropicOkResponse();
      },
    });
    await gateway.chat('MAIN_PERSONA_BRAIN', [{ role: 'user', content: 'x' }], {
      temperature: 0.3,
      maxTokens: 256,
    });
    const body = JSON.parse(bodies[0] ?? '{}') as {
      max_tokens?: number;
      temperature?: number;
      system?: string;
      messages?: unknown[];
    };
    expect(body.max_tokens).toBe(256);
    expect(body.temperature).toBe(0.3);
    expect('system' in body).toBe(false);
    expect(body.messages).toEqual([{ role: 'user', content: 'x' }]);
  });

  it('双协议变体 + provider.protocol=anthropic（UI 选中 Anthropic）→ 不再命中首个 OpenAI 变体', async () => {
    // 审计缺陷回归：两个变体共享 GLOBAL/CODING_PLAN，旧 resolveEndpoint 永远命中第一个 OpenAI 变体。
    const dual = BUILTIN_PROVIDER_PRESETS.find((preset) => preset.id === 'opencode-go')!;
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const gateway = new ModelGateway({
      profile: ANTHROPIC_PROFILE,
      providers: [{ ...dual, protocol: 'anthropic' }],
      keys: ANTHROPIC_KEYS,
      fetchImpl: async (url, init) => {
        calls.push({ url, headers: init.headers });
        return anthropicOkResponse();
      },
    });
    await gateway.chat('MAIN_PERSONA_BRAIN', [{ role: 'user', content: 'x' }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://opencode.ai/inference/go/anthropic/v1/messages');
    expect(calls[0]?.headers['x-api-key']).toBe(ANTHROPIC_KEYS['opencode-go']);
    expect(calls[0]?.headers.authorization).toBeUndefined();
  });

  it('双协议变体 + provider.protocol=openai → 仍走 OpenAI 变体（向后兼容）', async () => {
    const dual = BUILTIN_PROVIDER_PRESETS.find((preset) => preset.id === 'opencode-go')!;
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const gateway = new ModelGateway({
      profile: ANTHROPIC_PROFILE,
      providers: [{ ...dual, protocol: 'openai' }],
      keys: ANTHROPIC_KEYS,
      fetchImpl: async (url, init) => {
        calls.push({ url, headers: init.headers });
        return okResponse();
      },
    });
    await gateway.chat('MAIN_PERSONA_BRAIN', [{ role: 'user', content: 'x' }]);
    expect(calls[0]?.url).toBe('https://opencode.ai/inference/go/openai/v1/chat/completions');
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${ANTHROPIC_KEYS['opencode-go']}`);
  });

  it('响应：仅拼接 text block、usage input/output 映射、reasoningContent=null、onUsage 真实用量', async () => {
    const usages: UsageRecord[] = [];
    const gateway = new ModelGateway({
      profile: ANTHROPIC_PROFILE,
      providers: [ANTHROPIC_PROVIDER],
      keys: ANTHROPIC_KEYS,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          content: [
            { type: 'thinking', thinking: '内部推理' },
            { type: 'text', text: '哼，' },
            { type: 'text' }, // 缺失 text → 空串
            { type: 'text', text: '本鱼才没有偷懒！' },
          ],
          stop_reason: 'end_turn',
          usage: { input_tokens: 320, output_tokens: 45 },
        }),
      }),
      onUsage: (record) => usages.push(record),
    });
    const receipt = await gateway.chat('MAIN_PERSONA_BRAIN', [{ role: 'user', content: 'x' }]);
    expect(receipt.content).toBe('哼，本鱼才没有偷懒！');
    expect(receipt.reasoningContent).toBeNull();
    expect(receipt.usage).toEqual({ inputTokens: 320, cachedInputTokens: 0, outputTokens: 45 });
    expect(receipt.sanitized).toBe(true);
    expect(usages).toHaveLength(1);
    expect(usages[0]).toMatchObject({
      slot: 'MAIN_PERSONA_BRAIN',
      providerId: 'opencode-go',
      modelId: 'deepseek-v4.1-flash',
      inputTokens: 320,
      cachedInputTokens: 0,
      outputTokens: 45,
    });
  });

  it('响应缺 content/usage → 空串与零值兜底', async () => {
    const gateway = new ModelGateway({
      profile: ANTHROPIC_PROFILE,
      providers: [ANTHROPIC_PROVIDER],
      keys: ANTHROPIC_KEYS,
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ stop_reason: 'end_turn' }) }),
    });
    const receipt = await gateway.chat('MAIN_PERSONA_BRAIN', [{ role: 'user', content: 'x' }]);
    expect(receipt.content).toBe('');
    expect(receipt.reasoningContent).toBeNull();
    expect(receipt.usage).toEqual({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 });
  });

  it('400 → 解析 error.message 抛 BAD_REQUEST，不 failover', async () => {
    let callCount = 0;
    const gateway = new ModelGateway({
      profile: ANTHROPIC_PROFILE,
      providers: [ANTHROPIC_PROVIDER],
      keys: ANTHROPIC_KEYS,
      fetchImpl: async () => {
        callCount += 1;
        return {
          ok: false,
          status: 400,
          json: async () => ({
            type: 'error',
            error: { type: 'invalid_request_error', message: 'max_tokens is required' },
          }),
        };
      },
    });
    const error = await gateway.chat('MAIN_PERSONA_BRAIN', [{ role: 'user', content: 'x' }]).catch((e) => e);
    expect(error).toBeInstanceOf(GatewayError);
    expect((error as GatewayError).code).toBe('BAD_REQUEST');
    expect((error as GatewayError).message).toContain('max_tokens is required');
    expect(callCount).toBe(1); // 不 failover
  });

  it('429 → 静默 failover 到 OpenAI 协议候选（协议按候选分别组装）', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const gateway = new ModelGateway({
      profile: { ...ANTHROPIC_PROFILE, roleBindings: { MAIN_PERSONA_BRAIN: 'group/brain-mixed' } },
      providers: [ANTHROPIC_PROVIDER, ...PROVIDERS],
      groups: [MIXED_GROUP],
      keys: { ...ANTHROPIC_KEYS, ...KEYS },
      fetchImpl: async (url, init) => {
        calls.push({ url, headers: init.headers });
        return url.includes('opencode.ai') ? statusResponse(429) : okResponse();
      },
    });
    const receipt = await gateway.chat('MAIN_PERSONA_BRAIN', [{ role: 'user', content: '在摸鱼吗' }]);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe('https://opencode.ai/inference/go/anthropic/v1/messages');
    expect(calls[0]?.headers['x-api-key']).toBe(ANTHROPIC_KEYS['opencode-go']);
    expect(calls[0]?.headers.authorization).toBeUndefined();
    expect(calls[1]?.url).toBe('https://api.siliconflow.cn/v1/chat/completions');
    expect(calls[1]?.headers.authorization).toBe(`Bearer ${KEYS.siliconflow}`);
    expect(calls[1]?.headers['x-api-key']).toBeUndefined();
    expect(receipt.route).toEqual({ providerId: 'siliconflow', modelId: 'deepseek-v3', attempt: 1 });
    expect(receipt.content).toContain('本鱼');
  });
});
