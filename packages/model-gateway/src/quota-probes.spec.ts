import { describe, expect, it } from 'vitest';
import { probeProviderQuota, probeQuotaMatrix, sanitizeQuotaText } from './quota-probes';

describe('Four-level honest provider quota probes (V2-P1-03)', () => {
  it('sanitizes secret strings and bearer tokens from error excerpts', () => {
    const clean = sanitizeQuotaText('Authorization: Bearer sk-1234567890abcdef secret=my-secret-key-99', 'my-secret-key-99');
    expect(clean).not.toContain('sk-1234567890abcdef');
    expect(clean).not.toContain('my-secret-key-99');
    expect(clean).toContain('{{MASKED}}');
  });

  it('parses DeepSeek, Kimi (CN/GLOBAL), OpenRouter, SiliconFlow, and OpenCode Go official APIs', async () => {
    const now = (): number => 1_764_000_000_000;

    const ds = await probeProviderQuota({
      providerId: 'deepseek-official',
      apiKey: 'ds-key-1234',
      now,
      fetchImpl: async () => new Response(JSON.stringify({
        balance_infos: [{ currency: 'CNY', total_balance: '25.50', granted_balance: '10.00', topped_up_balance: '15.50' }],
      }), { status: 200 }),
    });
    expect(ds).toMatchObject({
      queryable: true,
      source: 'official_api',
      authState: 'authenticated',
      balance: { currency: 'CNY', total: 25.5, granted: 10, toppedUp: 15.5 },
    });

    const kimiCn = await probeProviderQuota({
      providerId: 'kimi-moonshot',
      region: 'CN',
      apiKey: 'kimi-key-1234',
      now,
      fetchImpl: async (url) => {
        expect(url).toContain('api.moonshot.cn');
        return new Response(JSON.stringify({
          data: { available_balance: 48.2, voucher_balance: 15, cash_balance: 33.2 },
        }), { status: 200 });
      },
    });
    expect(kimiCn.balance?.currency).toBe('CNY');
    expect(kimiCn.balance?.total).toBe(48.2);

    const kimiGlobal = await probeProviderQuota({
      providerId: 'kimi-moonshot',
      region: 'GLOBAL',
      apiKey: 'kimi-key-1234',
      now,
      fetchImpl: async (url) => {
        expect(url).toContain('api.moonshot.ai');
        return new Response(JSON.stringify({ data: { available_balance: '12.5' } }), { status: 200 });
      },
    });
    expect(kimiGlobal.balance?.currency).toBe('USD');
    expect(kimiGlobal.balance?.total).toBe(12.5);

    const openrouter = await probeProviderQuota({
      providerId: 'openrouter',
      apiKey: 'or-key-1234',
      now,
      fetchImpl: async () => new Response(JSON.stringify({
        data: { usage: 1.5, limit: 10, limit_remaining: 8.5, is_free_tier: false, usage_daily: 0.2, usage_weekly: 0.9, usage_monthly: 1.5 },
      }), { status: 200 }),
    });
    expect(openrouter.balance?.remaining).toBe(8.5);
    expect(openrouter.windows.map((w) => w.windowKind)).toEqual(['daily', 'weekly', 'monthly']);

    const sf = await probeProviderQuota({
      providerId: 'siliconflow',
      apiKey: 'sf-key-1234',
      now,
      fetchImpl: async () => new Response(JSON.stringify({
        data: { balance: '3.00', chargeBalance: '10.00', totalBalance: '13.00', category: 'VIP' },
      }), { status: 200 }),
    });
    expect(sf.balance?.total).toBe(13);
    expect(sf.planName).toBe('VIP');

    const opencode = await probeProviderQuota({
      providerId: 'opencode-go',
      apiKey: 'oc-key-1234',
      now,
      fetchImpl: async () => new Response(JSON.stringify({
        usage: {
          rolling: { status: 'ok', percent: 90, resetsAt: '2026-11-26T02:00:00Z' },
          weekly: { status: 'ok', percent: 100, resetsAt: '2026-11-30T00:00:00Z' },
          monthly: { status: 'ok', percent: 25 },
        },
      }), { status: 200 }),
    });
    expect(opencode.windows).toHaveLength(3);
    expect(opencode.windows[0]).toMatchObject({ windowKind: 'rolling_5h', status: 'warning', remainingPercent: 10 });
    expect(opencode.windows[1]).toMatchObject({ windowKind: 'weekly', status: 'exhausted', remainingPercent: 0 });
  });

  it('handles MiniMax Coding Plan vs PAY_AS_YOU_GO honestly and never fabricates unknown balances', async () => {
    const now = (): number => 1_764_000_000_000;

    // 按量付费：诚实标记 unknown / 不可查询
    const payg = await probeProviderQuota({
      providerId: 'minimax',
      planType: 'PAY_AS_YOU_GO',
      apiKey: 'mm-key',
      now,
    });
    expect(payg).toMatchObject({ queryable: false, source: 'unknown', balance: null, windows: [] });

    // Coding Plan：探测 5 小时窗口
    const coding = await probeProviderQuota({
      providerId: 'minimax',
      planType: 'CODING_PLAN',
      apiKey: 'mm-key',
      now,
      fetchImpl: async () => new Response(JSON.stringify({
        model_remains: [{ current_interval_total_count: 100, current_interval_usage_count: 75, remains_time: 3_600_000 }],
      }), { status: 200 }),
    });
    expect(coding.queryable).toBe(true);
    expect(coding.source).toBe('official_api');
    expect(coding.windows[0]).toMatchObject({
      windowKind: 'rolling_5h',
      usedRequests: 25,
      remainingRequests: 75,
      usedPercent: 25,
      remainingPercent: 75,
    });
    expect(coding.windows[0]?.resetsAt).toBe(new Date(1_764_000_000_000 + 3_600_000).toISOString());

    // Coding Plan 401 vs 404 vs unexpected schema
    const mm401 = await probeProviderQuota({
      providerId: 'minimax',
      planType: 'CODING_PLAN',
      apiKey: 'mm-secret-1234',
      now,
      fetchImpl: async () => new Response('invalid mm-secret-1234', { status: 401 }),
    });
    expect(mm401.authState).toBe('auth_failed');
    expect(mm401.errorDetail).not.toContain('mm-secret-1234');

    const mm404 = await probeProviderQuota({
      providerId: 'minimax',
      planType: 'CODING_PLAN',
      apiKey: 'mm-key',
      now,
      fetchImpl: async () => new Response('not found', { status: 404 }),
    });
    expect(mm404.source).toBe('unknown');

    const mmBadSchema = await probeProviderQuota({
      providerId: 'minimax',
      planType: 'CODING_PLAN',
      apiKey: 'mm-key',
      now,
      fetchImpl: async () => new Response(JSON.stringify({ unexpected: true }), { status: 200 }),
    });
    expect(mmBadSchema.source).toBe('unknown');
    expect(mmBadSchema.errorDetail).toBe('unexpected_schema');

    // OpenAI / Anthropic / 自定义厂商：绝不编造余额
    for (const id of ['openai', 'anthropic', 'volcano-ark', 'custom-relay']) {
      const rep = await probeProviderQuota({ providerId: id, apiKey: null, now });
      expect(rep.queryable).toBe(false);
      expect(rep.source).toBe('unknown');
      expect(rep.balance).toBeNull();
      expect(rep.windows).toEqual([]);
    }
  });

  it('probes local Ollama, CLI status, missing keys, auth failures, malformed JSON, and matrix aggregation', async () => {
    const now = (): number => 1_764_000_000_000;

    const ollamaOnline = await probeProviderQuota({
      providerId: 'local-ollama',
      baseUrl: 'http://127.0.0.1:11434/v1',
      now,
      fetchImpl: async () => new Response(JSON.stringify({ models: [{ name: 'qwen2.5:7b' }] }), { status: 200 }),
    });
    expect(ollamaOnline).toMatchObject({ source: 'cli_status', scope: 'local_runtime', authState: 'no_auth_required' });
    expect(ollamaOnline.summary).toContain('1 个模型');

    const ollamaOffline = await probeProviderQuota({
      providerId: 'local-ollama',
      baseUrl: 'not-a-url',
      now,
      fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
    });
    expect(ollamaOffline.errorDetail).toContain('ECONNREFUSED');

    const cliOk = await probeProviderQuota({
      providerId: 'codex-cli',
      probeCli: (bin) => bin === 'codex',
      now,
    });
    expect(cliOk).toMatchObject({ source: 'cli_status', scope: 'local_runtime' });
    expect(cliOk.summary).toContain('已安装');

    const cliMissing = await probeProviderQuota({
      providerId: 'claude-cli',
      probeCli: () => false,
      now,
    });
    expect(cliMissing.errorDetail).toBe('cli_not_found');

    // 缺失 Key、401、非 JSON 与未知结构覆盖
    for (const id of ['deepseek-official', 'kimi-moonshot', 'openrouter', 'siliconflow', 'opencode-go', 'minimax']) {
      const missing = await probeProviderQuota({
        providerId: id,
        planType: id === 'minimax' ? 'CODING_PLAN' : 'PAY_AS_YOU_GO',
        apiKey: null,
        now,
      });
      expect(missing.authState).toBe('missing_key');
    }

    const badJson = await probeProviderQuota({
      providerId: 'deepseek-official',
      apiKey: 'k1234',
      now,
      fetchImpl: async () => new Response('not json', { status: 200 }),
    });
    expect(badJson.errorDetail).toBe('响应不是合法 JSON');

    const authErrOr = await probeProviderQuota({
      providerId: 'openrouter',
      apiKey: 'k1234',
      now,
      fetchImpl: async () => new Response('unauthorized', { status: 401 }),
    });
    expect(authErrOr.authState).toBe('auth_failed');

    const emptyDs = await probeProviderQuota({
      providerId: 'deepseek-official',
      apiKey: 'k1234',
      now,
      fetchImpl: async () => new Response(JSON.stringify({ balance_infos: [] }), { status: 200 }),
    });
    expect(emptyDs.errorDetail).toBe('unexpected_schema');

    const emptyKimi = await probeProviderQuota({
      providerId: 'kimi-moonshot',
      apiKey: 'k1234',
      now,
      fetchImpl: async () => new Response(JSON.stringify({ data: {} }), { status: 200 }),
    });
    expect(emptyKimi.errorDetail).toBe('unexpected_schema');

    const emptyOr = await probeProviderQuota({
      providerId: 'openrouter',
      apiKey: 'k1234',
      now,
      fetchImpl: async () => new Response(JSON.stringify({ data: {} }), { status: 200 }),
    });
    expect(emptyOr.errorDetail).toBe('unexpected_schema');

    const noLimitOr = await probeProviderQuota({
      providerId: 'openrouter',
      apiKey: 'k1234',
      now,
      fetchImpl: async () => new Response(JSON.stringify({ data: { usage: 2.34, is_free_tier: true } }), { status: 200 }),
    });
    expect(noLimitOr.summary).toContain('无上限');

    const emptySf = await probeProviderQuota({
      providerId: 'siliconflow',
      apiKey: 'k1234',
      now,
      fetchImpl: async () => new Response(JSON.stringify({ data: {} }), { status: 200 }),
    });
    expect(emptySf.errorDetail).toBe('unexpected_schema');

    const emptyOc = await probeProviderQuota({
      providerId: 'opencode-go',
      apiKey: 'k1234',
      now,
      fetchImpl: async () => new Response(JSON.stringify({ usage: {} }), { status: 200 }),
    });
    expect(emptyOc.errorDetail).toBe('unexpected_schema');

    const errKimi = await probeProviderQuota({
      providerId: 'kimi-moonshot',
      apiKey: 'k1234',
      now,
      fetchImpl: async () => new Response('err', { status: 500 }),
    });
    expect(errKimi.errorDetail).toContain('HTTP 500');

    const errSf = await probeProviderQuota({
      providerId: 'siliconflow',
      apiKey: 'k1234',
      now,
      fetchImpl: async () => new Response('err', { status: 403 }),
    });
    expect(errSf.authState).toBe('auth_failed');

    const errOc = await probeProviderQuota({
      providerId: 'opencode-go',
      apiKey: 'k1234',
      now,
      fetchImpl: async () => new Response('err', { status: 401 }),
    });
    expect(errOc.authState).toBe('auth_failed');

    const matrix = await probeQuotaMatrix(
      [{ providerId: 'openai' }, { providerId: 'gemini-cli' }],
      { probeCli: () => true, now },
    );
    expect(matrix.generatedAt).toBe(1_764_000_000_000);
    expect(matrix.reports).toHaveLength(2);

    // 补充 MiniMax 0 总数 / 无 remains_time / 403、SiliconFlow 缺失字段、OpenCode Go 空字段、non-Error 异常覆盖
    const mmZero = await probeProviderQuota({
      providerId: 'minimax',
      planType: 'CODING_PLAN',
      apiKey: 'k1234',
      now,
      fetchImpl: async () => new Response(JSON.stringify({
        model_remains: [{ current_interval_total_count: 0, current_interval_usage_count: 0, remains_time: 0 }],
      }), { status: 200 }),
    });
    expect(mmZero.windows[0]?.usedPercent).toBe(0);
    expect(mmZero.windows[0]?.resetsAt).toBeNull();

    const sfMinimal = await probeProviderQuota({
      providerId: 'siliconflow',
      apiKey: 'k1234',
      now,
      fetchImpl: async () => new Response(JSON.stringify({ data: { balance: '5' } }), { status: 200 }),
    });
    expect(sfMinimal.balance?.total).toBe(5);
    expect(sfMinimal.planName).toBeNull();

    const orNoLimitRem = await probeProviderQuota({
      providerId: 'openrouter',
      apiKey: 'k1234',
      now,
      fetchImpl: async () => new Response(JSON.stringify({ data: { limit_remaining: 4.5, limit: null } }), { status: 200 }),
    });
    expect(orNoLimitRem.summary).toContain('$4.50 剩余');

    const dsNullFields = await probeProviderQuota({
      providerId: 'deepseek-official',
      apiKey: 'k1234',
      now,
      fetchImpl: async () => new Response(JSON.stringify({ balance_infos: [{}] }), { status: 200 }),
    });
    expect(dsNullFields.summary).toContain('CNY ?');

    const kimiNullTotal = await probeProviderQuota({
      providerId: 'kimi-moonshot',
      apiKey: 'k1234',
      now,
      fetchImpl: async () => new Response(JSON.stringify({ data: { voucher_balance: 5 } }), { status: 200 }),
    });
    expect(kimiNullTotal.balance?.granted).toBe(5);

    const ocPartial = await probeProviderQuota({
      providerId: 'opencode-go',
      apiKey: 'k1234',
      now,
      fetchImpl: async () => new Response(JSON.stringify({ usage: { rolling: {} } }), { status: 200 }),
    });
    expect(ocPartial.windows[0]?.status).toBe('unknown');

    const nonErrThrow = await probeProviderQuota({
      providerId: 'deepseek-official',
      apiKey: 'k1234',
      now,
      fetchImpl: async () => { throw 'string-boom'; },
    });
    expect(nonErrThrow.errorDetail).toContain('string-boom');
  });
});
