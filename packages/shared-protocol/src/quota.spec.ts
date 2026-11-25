import { describe, expect, it } from 'vitest';
import {
  ProviderQuotaMatrixSchema,
  ProviderQuotaReportSchema,
  QuotaBalanceMetricSchema,
  QuotaWindowMetricSchema,
} from './quota';

describe('ProviderQuotaReport four-level honest quota schemas (V2-P1-03)', () => {
  it('parses full official_api reports and honest unknown reports with defaults', () => {
    const rich = ProviderQuotaReportSchema.parse({
      providerId: 'opencode-go',
      providerName: 'OpenCode Go',
      queryable: true,
      source: 'official_api',
      scope: 'subscription_plan',
      authState: 'authenticated',
      planName: 'Go $10/月',
      windows: [
        {
          windowKind: 'rolling_5h',
          label: '5小时窗口',
          status: 'ok',
          usedPercent: 18,
          remainingPercent: 82,
          resetsAt: '2026-11-26T01:00:00Z',
        },
      ],
      summary: '5小时窗口已用 18%',
      fetchedAt: 1_764_000_000_000,
    });
    expect(rich.balance).toBeNull();
    expect(rich.windows[0]?.remainingTokens).toBeNull();
    expect(rich.errorDetail).toBeNull();

    const unknown = ProviderQuotaReportSchema.parse({
      providerId: 'openai',
      providerName: 'OpenAI',
      queryable: false,
      source: 'unknown',
      authState: 'missing_key',
      summary: '未知 / 不可查询',
      fetchedAt: 1_764_000_000_000,
    });
    expect(unknown.scope).toBe('unknown');
    expect(unknown.windows).toEqual([]);

    const matrix = ProviderQuotaMatrixSchema.parse({
      generatedAt: 1_764_000_000_000,
      reports: [rich, unknown],
    });
    expect(matrix.reports).toHaveLength(2);
  });

  it('rejects invalid percentages, negative token counts, and oversized raw excerpts', () => {
    expect(QuotaWindowMetricSchema.safeParse({
      windowKind: 'rolling_5h',
      label: '5h',
      usedPercent: 120,
    }).success).toBe(false);

    expect(QuotaWindowMetricSchema.safeParse({
      windowKind: 'daily',
      label: 'day',
      usedTokens: -5,
    }).success).toBe(false);

    expect(QuotaBalanceMetricSchema.safeParse({
      currency: 'CNY',
      total: 42.5,
    }).success).toBe(true);

    expect(ProviderQuotaReportSchema.safeParse({
      providerId: 'x',
      providerName: 'X',
      queryable: false,
      source: 'unknown',
      authState: 'unknown',
      summary: 's',
      fetchedAt: 1,
      rawExcerpt: 'a'.repeat(401),
    }).success).toBe(false);
  });
});
