/**
 * Whale Isle V2 — 四级诚实额度矩阵共享契约（V2-P1-03 / ADR-002 D-109）
 * - 严格标明数据来源（official_api | verifiable_third_party | cli_status | unknown）、
 *   获取时间、适用范围、认证状态与原始错误
 * - 未经实测或不支持查询的供应商强制标记 queryable=false, source='unknown'，严禁编造余额或配额数值
 */
import { z } from 'zod';

export const QuotaSourceTierSchema = z.enum([
  'official_api',
  'verifiable_third_party',
  'cli_status',
  'unknown',
]);
export type QuotaSourceTier = z.infer<typeof QuotaSourceTierSchema>;

export const QuotaAuthStateSchema = z.enum([
  'authenticated',
  'missing_key',
  'auth_failed',
  'no_auth_required',
  'unknown',
]);
export type QuotaAuthState = z.infer<typeof QuotaAuthStateSchema>;

export const QuotaScopeSchema = z.enum([
  'account',
  'api_key',
  'subscription_plan',
  'local_runtime',
  'unknown',
]);
export type QuotaScope = z.infer<typeof QuotaScopeSchema>;

export const QuotaWindowKindSchema = z.enum([
  'rolling_5h',
  'daily',
  'weekly',
  'monthly',
  'total',
]);
export type QuotaWindowKind = z.infer<typeof QuotaWindowKindSchema>;

export const QuotaWindowStatusSchema = z.enum([
  'ok',
  'warning',
  'exhausted',
  'unknown',
]);
export type QuotaWindowStatus = z.infer<typeof QuotaWindowStatusSchema>;

export const QuotaWindowMetricSchema = z.object({
  windowKind: QuotaWindowKindSchema,
  label: z.string().min(1),
  status: QuotaWindowStatusSchema.default('unknown'),
  usedPercent: z.number().min(0).max(100).nullable().default(null),
  remainingPercent: z.number().min(0).max(100).nullable().default(null),
  usedTokens: z.number().nonnegative().nullable().default(null),
  remainingTokens: z.number().nonnegative().nullable().default(null),
  usedRequests: z.number().nonnegative().nullable().default(null),
  remainingRequests: z.number().nonnegative().nullable().default(null),
  resetsAt: z.string().nullable().default(null),
});
export type QuotaWindowMetric = z.output<typeof QuotaWindowMetricSchema>;

export const QuotaBalanceMetricSchema = z.object({
  currency: z.string().nullable().default(null),
  total: z.number().nullable().default(null),
  granted: z.number().nullable().default(null),
  toppedUp: z.number().nullable().default(null),
  used: z.number().nullable().default(null),
  limit: z.number().nullable().default(null),
  remaining: z.number().nullable().default(null),
});
export type QuotaBalanceMetric = z.output<typeof QuotaBalanceMetricSchema>;

export const ProviderQuotaReportSchema = z.object({
  providerId: z.string().min(1),
  providerName: z.string().min(1),
  queryable: z.boolean(),
  source: QuotaSourceTierSchema,
  scope: QuotaScopeSchema.default('unknown'),
  authState: QuotaAuthStateSchema,
  planName: z.string().nullable().default(null),
  balance: QuotaBalanceMetricSchema.nullable().default(null),
  windows: z.array(QuotaWindowMetricSchema).default([]),
  summary: z.string().min(1),
  fetchedAt: z.number().int().nonnegative(),
  errorDetail: z.string().nullable().default(null),
  rawExcerpt: z.string().max(400).nullable().default(null),
});
export type ProviderQuotaReport = z.output<typeof ProviderQuotaReportSchema>;
export type ProviderQuotaReportInput = z.input<typeof ProviderQuotaReportSchema>;

export const ProviderQuotaMatrixSchema = z.object({
  generatedAt: z.number().int().nonnegative(),
  reports: z.array(ProviderQuotaReportSchema),
});
export type ProviderQuotaMatrix = z.output<typeof ProviderQuotaMatrixSchema>;
