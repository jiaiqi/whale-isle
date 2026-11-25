/**
 * 模型供应商四级诚实额度探针（V2-P1-03 / ADR-002 D-109）：
 * - 统一查询余额、5 小时窗、周/月额度、请求次数、套餐权益与重置时间
 * - 强制记录 source / fetchedAt / scope / authState / errorDetail
 * - 严禁编造不可查询厂商的余额或配额数字（反例：dsh-live 虚假指标）
 * - 绝不把 API Key 明文写进 errorDetail / rawExcerpt / 返回体
 */
import {
  ProviderQuotaMatrixSchema,
  ProviderQuotaReportSchema,
  type ProviderQuotaMatrix,
  type ProviderQuotaReport,
  type QuotaAuthState,
  type QuotaBalanceMetric,
  type QuotaScope,
  type QuotaSourceTier,
  type QuotaWindowKind,
  type QuotaWindowMetric,
  type QuotaWindowStatus,
} from '@workbench/shared-protocol';
import { BUILTIN_PROVIDER_PRESETS } from './presets';

export type QuotaFetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

const CLI_BINARIES: Record<string, { name: string; binary: string }> = {
  'codex-cli': { name: 'Codex CLI', binary: 'codex' },
  'claude-cli': { name: 'Claude Code CLI', binary: 'claude' },
  'gemini-cli': { name: 'Gemini CLI', binary: 'gemini' },
  'opencode-cli': { name: 'OpenCode CLI', binary: 'opencode' },
};

export interface ProbeQuotaInput {
  providerId: string;
  providerName?: string;
  apiKey?: string | null;
  planType?: 'PAY_AS_YOU_GO' | 'CODING_PLAN' | 'LOCAL_GPU';
  region?: 'CN' | 'GLOBAL' | 'LOCAL';
  baseUrl?: string;
  fetchImpl?: QuotaFetchLike;
  probeCli?: (binary: string) => boolean;
  now?: () => number;
  timeoutMs?: number;
}

/** 对错误详情与响应摘要进行密钥脱敏并截断至安全长度 */
export function sanitizeQuotaText(text: string, secret?: string | null): string {
  let out = text;
  if (secret && secret.trim().length >= 4) {
    out = out.split(secret.trim()).join('{{MASKED}}');
  }
  out = out
    .replace(/\bBearer\s+[A-Za-z0-9_\-.]+\b/gi, 'Bearer {{MASKED}}')
    .replace(/\b(sk|ghp|AKIA)[A-Za-z0-9_\-]{8,}\b/g, '{{MASKED}}');
  return out.slice(0, 300);
}

function windowStatusOf(usedPercent: number | null): QuotaWindowStatus {
  if (usedPercent === null) return 'unknown';
  if (usedPercent >= 100) return 'exhausted';
  if (usedPercent >= 85) return 'warning';
  return 'ok';
}

function toNum(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const parsed = Number(v);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function defaultProviderName(providerId: string): string {
  return (
    CLI_BINARIES[providerId]?.name
    ?? BUILTIN_PROVIDER_PRESETS.find((p) => p.id === providerId)?.name
    ?? providerId
  );
}

function reportOf(base: {
  providerId: string;
  providerName: string;
  queryable: boolean;
  source: QuotaSourceTier;
  scope?: QuotaScope;
  authState: QuotaAuthState;
  planName?: string | null;
  balance?: QuotaBalanceMetric | null;
  windows?: QuotaWindowMetric[];
  summary: string;
  fetchedAt: number;
  errorDetail?: string | null;
  rawExcerpt?: string | null;
}): ProviderQuotaReport {
  return ProviderQuotaReportSchema.parse({
    scope: base.scope ?? 'unknown',
    planName: base.planName ?? null,
    balance: base.balance ?? null,
    windows: base.windows ?? [],
    errorDetail: base.errorDetail ?? null,
    rawExcerpt: base.rawExcerpt ?? null,
    ...base,
  });
}

function missingKeyReport(providerId: string, providerName: string, scope: QuotaScope, fetchedAt: number): ProviderQuotaReport {
  return reportOf({
    providerId,
    providerName,
    queryable: true,
    source: 'official_api',
    scope,
    authState: 'missing_key',
    summary: '未配置 API Key（需保存凭据后查询真实额度）',
    fetchedAt,
    errorDetail: 'missing_api_key',
  });
}

async function fetchJsonSafe(
  url: string,
  headers: Record<string, string>,
  fetchImpl: QuotaFetchLike,
  timeoutMs: number,
  secret: string | null,
): Promise<{ ok: true; status: number; body: unknown; rawText: string } | { ok: false; status: number; errorDetail: string; rawText: string | null }> {
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const rawText = await response.text();
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        errorDetail: sanitizeQuotaText(`HTTP ${response.status}：${rawText}`, secret),
        rawText: sanitizeQuotaText(rawText, secret),
      };
    }
    try {
      return { ok: true, status: response.status, body: JSON.parse(rawText) as unknown, rawText: sanitizeQuotaText(rawText, secret) };
    } catch {
      return { ok: false, status: response.status, errorDetail: '响应不是合法 JSON', rawText: sanitizeQuotaText(rawText, secret) };
    }
  } catch (err) {
    return {
      ok: false,
      status: 0,
      errorDetail: sanitizeQuotaText(err instanceof Error ? err.message : String(err), secret),
      rawText: null,
    };
  }
}

export async function probeProviderQuota(input: ProbeQuotaInput): Promise<ProviderQuotaReport> {
  const providerId = input.providerId.trim();
  const providerName = input.providerName ?? defaultProviderName(providerId);
  const fetchedAt = (input.now ?? Date.now)();
  const fetchImpl = input.fetchImpl ?? (fetch as unknown as QuotaFetchLike);
  const timeoutMs = Math.max(500, input.timeoutMs ?? 12_000);
  const key = input.apiKey?.trim() ? input.apiKey.trim() : null;

  // 1) 本地 CLI 工具链状态探测（cli_status，不编造云端余额）
  const cliInfo = CLI_BINARIES[providerId];
  if (cliInfo) {
    const installed = input.probeCli ? input.probeCli(cliInfo.binary) : false;
    return reportOf({
      providerId,
      providerName,
      queryable: true,
      source: 'cli_status',
      scope: 'local_runtime',
      authState: 'no_auth_required',
      planName: installed ? '本地 CLI 已就绪' : '未检测到本地 CLI',
      summary: installed
        ? `${cliInfo.name}（${cliInfo.binary}）已安装；云端账单由对应账号上游托管`
        : `未在 PATH 中检测到 ${cliInfo.binary}`,
      fetchedAt,
      errorDetail: installed ? null : 'cli_not_found',
    });
  }

  // 2) 本地 Ollama 状态探针
  if (providerId === 'local-ollama') {
    const origin = (() => {
      try {
        return new URL(input.baseUrl ?? 'http://127.0.0.1:11434').origin;
      } catch {
        return 'http://127.0.0.1:11434';
      }
    })();
    const res = await fetchJsonSafe(`${origin}/api/tags`, {}, fetchImpl, Math.min(timeoutMs, 2500), null);
    if (!res.ok) {
      return reportOf({
        providerId,
        providerName,
        queryable: true,
        source: 'cli_status',
        scope: 'local_runtime',
        authState: 'no_auth_required',
        planName: '本地离线免费',
        summary: `Ollama 未启动或不可达（${res.errorDetail}）`,
        fetchedAt,
        errorDetail: res.errorDetail,
      });
    }
    const models = (res.body as { models?: unknown[] }).models;
    const count = Array.isArray(models) ? models.length : 0;
    return reportOf({
      providerId,
      providerName,
      queryable: true,
      source: 'cli_status',
      scope: 'local_runtime',
      authState: 'no_auth_required',
      planName: '本地离线免费',
      summary: `本地 Ollama 在线，已安装 ${count} 个模型（无云端 Token 消耗）`,
      fetchedAt,
      rawExcerpt: res.rawText,
    });
  }

  // 3) DeepSeek 官方余额 API
  if (providerId === 'deepseek-official') {
    if (!key) return missingKeyReport(providerId, providerName, 'account', fetchedAt);
    const res = await fetchJsonSafe('https://api.deepseek.com/user/balance', { Authorization: `Bearer ${key}` }, fetchImpl, timeoutMs, key);
    if (!res.ok) {
      return reportOf({
        providerId,
        providerName,
        queryable: true,
        source: 'official_api',
        scope: 'account',
        authState: res.status === 401 || res.status === 403 ? 'auth_failed' : 'authenticated',
        summary: `DeepSeek 余额查询失败：${res.errorDetail}`,
        fetchedAt,
        errorDetail: res.errorDetail,
        rawExcerpt: res.rawText,
      });
    }
    const infos = (res.body as { balance_infos?: Array<{ currency?: string; total_balance?: string | number; granted_balance?: string | number; topped_up_balance?: string | number }> }).balance_infos;
    const first = Array.isArray(infos) ? infos[0] : undefined;
    if (!first) {
      return reportOf({
        providerId,
        providerName,
        queryable: true,
        source: 'official_api',
        scope: 'account',
        authState: 'authenticated',
        summary: 'DeepSeek 响应字段未知，未解析出余额',
        fetchedAt,
        errorDetail: 'unexpected_schema',
        rawExcerpt: res.rawText,
      });
    }
    const currency = first.currency ?? 'CNY';
    const total = toNum(first.total_balance);
    const granted = toNum(first.granted_balance);
    const toppedUp = toNum(first.topped_up_balance);
    return reportOf({
      providerId,
      providerName,
      queryable: true,
      source: 'official_api',
      scope: 'account',
      authState: 'authenticated',
      balance: { currency, total, granted, toppedUp, used: null, limit: null, remaining: total },
      summary: `${currency} ${total ?? '?'}（赠送 ${granted ?? '?'} + 充值 ${toppedUp ?? '?'}）`,
      fetchedAt,
      rawExcerpt: res.rawText,
    });
  }

  // 4) Kimi (Moonshot AI) 官方余额 API
  if (providerId === 'kimi-moonshot') {
    if (!key) return missingKeyReport(providerId, providerName, 'account', fetchedAt);
    const host = input.region === 'GLOBAL' ? 'https://api.moonshot.ai' : 'https://api.moonshot.cn';
    const res = await fetchJsonSafe(`${host}/v1/users/me/balance`, { Authorization: `Bearer ${key}` }, fetchImpl, timeoutMs, key);
    if (!res.ok) {
      return reportOf({
        providerId,
        providerName,
        queryable: true,
        source: 'official_api',
        scope: 'account',
        authState: res.status === 401 || res.status === 403 ? 'auth_failed' : 'authenticated',
        summary: `Kimi 余额查询失败：${res.errorDetail}`,
        fetchedAt,
        errorDetail: res.errorDetail,
        rawExcerpt: res.rawText,
      });
    }
    const data = (res.body as { data?: { available_balance?: number | string; voucher_balance?: number | string; cash_balance?: number | string } }).data;
    const total = toNum(data?.available_balance);
    const granted = toNum(data?.voucher_balance);
    const toppedUp = toNum(data?.cash_balance);
    if (total === null && granted === null && toppedUp === null) {
      return reportOf({
        providerId,
        providerName,
        queryable: true,
        source: 'official_api',
        scope: 'account',
        authState: 'authenticated',
        summary: 'Kimi 响应字段未知，未解析出余额',
        fetchedAt,
        errorDetail: 'unexpected_schema',
        rawExcerpt: res.rawText,
      });
    }
    const currency = input.region === 'GLOBAL' ? 'USD' : 'CNY';
    return reportOf({
      providerId,
      providerName,
      queryable: true,
      source: 'official_api',
      scope: 'account',
      authState: 'authenticated',
      balance: { currency, total, granted, toppedUp, used: null, limit: null, remaining: total },
      summary: `${currency} ${total ?? '?'}（代金券 ${granted ?? '?'} + 现金 ${toppedUp ?? '?'}）`,
      fetchedAt,
      rawExcerpt: res.rawText,
    });
  }

  // 5) OpenRouter Key 额度 API
  if (providerId === 'openrouter') {
    if (!key) return missingKeyReport(providerId, providerName, 'api_key', fetchedAt);
    const res = await fetchJsonSafe('https://openrouter.ai/api/v1/key', { Authorization: `Bearer ${key}` }, fetchImpl, timeoutMs, key);
    if (!res.ok) {
      return reportOf({
        providerId,
        providerName,
        queryable: true,
        source: 'official_api',
        scope: 'api_key',
        authState: res.status === 401 || res.status === 403 ? 'auth_failed' : 'authenticated',
        summary: `OpenRouter 额度查询失败：${res.errorDetail}`,
        fetchedAt,
        errorDetail: res.errorDetail,
        rawExcerpt: res.rawText,
      });
    }
    const data = (res.body as { data?: { usage?: number; limit?: number | null; limit_remaining?: number | null; is_free_tier?: boolean; usage_daily?: number; usage_weekly?: number; usage_monthly?: number } }).data;
    const used = toNum(data?.usage);
    const limit = toNum(data?.limit);
    const remaining = toNum(data?.limit_remaining);
    if (used === null && remaining === null) {
      return reportOf({
        providerId,
        providerName,
        queryable: true,
        source: 'official_api',
        scope: 'api_key',
        authState: 'authenticated',
        summary: 'OpenRouter 响应字段未知',
        fetchedAt,
        errorDetail: 'unexpected_schema',
        rawExcerpt: res.rawText,
      });
    }
    const windows: QuotaWindowMetric[] = [];
    if (toNum(data?.usage_daily) !== null) {
      windows.push({ windowKind: 'daily', label: '今日已用', status: 'ok', usedPercent: null, remainingPercent: null, usedTokens: null, remainingTokens: null, usedRequests: null, remainingRequests: null, resetsAt: null });
    }
    if (toNum(data?.usage_weekly) !== null) {
      windows.push({ windowKind: 'weekly', label: '本周已用', status: 'ok', usedPercent: null, remainingPercent: null, usedTokens: null, remainingTokens: null, usedRequests: null, remainingRequests: null, resetsAt: null });
    }
    if (toNum(data?.usage_monthly) !== null) {
      windows.push({ windowKind: 'monthly', label: '本月已用', status: 'ok', usedPercent: null, remainingPercent: null, usedTokens: null, remainingTokens: null, usedRequests: null, remainingRequests: null, resetsAt: null });
    }
    return reportOf({
      providerId,
      providerName,
      queryable: true,
      source: 'official_api',
      scope: 'api_key',
      authState: 'authenticated',
      planName: data?.is_free_tier ? 'Free Tier' : 'Pay-as-you-go',
      balance: { currency: 'USD', total: limit, granted: null, toppedUp: null, used, limit, remaining },
      windows,
      summary: remaining !== null
        ? `$${remaining.toFixed(2)} 剩余${limit !== null ? ` / 上限 $${limit.toFixed(2)}` : ''}`
        : `已用 $${(used ?? 0).toFixed(2)}（无上限）`,
      fetchedAt,
      rawExcerpt: res.rawText,
    });
  }

  // 6) SiliconFlow 余额 API
  if (providerId === 'siliconflow') {
    if (!key) return missingKeyReport(providerId, providerName, 'account', fetchedAt);
    const res = await fetchJsonSafe('https://api.siliconflow.cn/v1/user/info', { Authorization: `Bearer ${key}` }, fetchImpl, timeoutMs, key);
    if (!res.ok) {
      return reportOf({
        providerId,
        providerName,
        queryable: true,
        source: 'official_api',
        scope: 'account',
        authState: res.status === 401 || res.status === 403 ? 'auth_failed' : 'authenticated',
        summary: `硅基流动余额查询失败：${res.errorDetail}`,
        fetchedAt,
        errorDetail: res.errorDetail,
        rawExcerpt: res.rawText,
      });
    }
    const data = (res.body as { data?: { balance?: string | number; chargeBalance?: string | number; totalBalance?: string | number; category?: string } }).data;
    const balance = toNum(data?.balance);
    const toppedUp = toNum(data?.chargeBalance);
    const total = toNum(data?.totalBalance) ?? balance;
    if (total === null) {
      return reportOf({
        providerId,
        providerName,
        queryable: true,
        source: 'official_api',
        scope: 'account',
        authState: 'authenticated',
        summary: '硅基流动响应字段未知',
        fetchedAt,
        errorDetail: 'unexpected_schema',
        rawExcerpt: res.rawText,
      });
    }
    return reportOf({
      providerId,
      providerName,
      queryable: true,
      source: 'official_api',
      scope: 'account',
      authState: 'authenticated',
      planName: data?.category ?? null,
      balance: { currency: 'CNY', total, granted: balance, toppedUp, used: null, limit: null, remaining: total },
      summary: `CNY ${total}（充值 ${toppedUp ?? '?'} · 赠送 ${balance ?? '?'}）`,
      fetchedAt,
      rawExcerpt: res.rawText,
    });
  }

  // 7) OpenCode Go 5h / 周 / 月订阅窗口 API
  if (providerId === 'opencode-go') {
    if (!key) return missingKeyReport(providerId, providerName, 'subscription_plan', fetchedAt);
    const res = await fetchJsonSafe(
      'https://opencode.ai/inference/go/v1/usage',
      {
        Authorization: `Bearer ${key}`,
        'x-opencode-session': `ses_quota_${fetchedAt}`,
        'User-Agent': 'Whale-Isle/2.0',
      },
      fetchImpl,
      timeoutMs,
      key,
    );
    if (!res.ok) {
      return reportOf({
        providerId,
        providerName,
        queryable: true,
        source: 'official_api',
        scope: 'subscription_plan',
        authState: res.status === 401 || res.status === 403 ? 'auth_failed' : 'authenticated',
        summary: `OpenCode Go 配额查询失败：${res.errorDetail}`,
        fetchedAt,
        errorDetail: res.errorDetail,
        rawExcerpt: res.rawText,
      });
    }
    const usage = (res.body as { usage?: Record<string, { status?: string; percent?: number; resetsAt?: string } | null> }).usage ?? {};
    const mapping: Array<[string, QuotaWindowKind, string]> = [
      ['rolling', 'rolling_5h', '5小时窗口'],
      ['weekly', 'weekly', '本周配额'],
      ['monthly', 'monthly', '本月配额'],
    ];
    const windows: QuotaWindowMetric[] = [];
    for (const [k, kind, label] of mapping) {
      const w = usage[k];
      if (!w) continue;
      const usedPct = toNum(w.percent);
      const remPct = usedPct === null ? null : Math.max(0, Math.min(100, Number((100 - usedPct).toFixed(2))));
      windows.push({
        windowKind: kind,
        label,
        status: windowStatusOf(usedPct),
        usedPercent: usedPct,
        remainingPercent: remPct,
        usedTokens: null,
        remainingTokens: null,
        usedRequests: null,
        remainingRequests: null,
        resetsAt: w.resetsAt ?? null,
      });
    }
    if (windows.length === 0) {
      return reportOf({
        providerId,
        providerName,
        queryable: true,
        source: 'official_api',
        scope: 'subscription_plan',
        authState: 'authenticated',
        planName: 'OpenCode Go',
        summary: 'OpenCode Go 响应字段未知',
        fetchedAt,
        errorDetail: 'unexpected_schema',
        rawExcerpt: res.rawText,
      });
    }
    const summary = windows.map((w) => `${w.label}已用 ${w.usedPercent ?? '?'}%`).join(' · ');
    return reportOf({
      providerId,
      providerName,
      queryable: true,
      source: 'official_api',
      scope: 'subscription_plan',
      authState: 'authenticated',
      planName: 'OpenCode Go 订阅',
      windows,
      summary: `Go 配额：${summary}`,
      fetchedAt,
      rawExcerpt: res.rawText,
    });
  }

  // 8) MiniMax：按量付费无公开余额 API（诚实标 unknown）；Coding Plan 探测 5h 窗口残余次数
  if (providerId === 'minimax') {
    if (input.planType !== 'CODING_PLAN') {
      return reportOf({
        providerId,
        providerName,
        queryable: false,
        source: 'unknown',
        scope: 'unknown',
        authState: key ? 'authenticated' : 'missing_key',
        summary: '未知 / 不可查询（MiniMax 按量付费暂无公开余额 API；切换 Coding Plan 可探测 5h 窗口）',
        fetchedAt,
      });
    }
    if (!key) return missingKeyReport(providerId, providerName, 'subscription_plan', fetchedAt);
    const res = await fetchJsonSafe(
      'https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains',
      { Authorization: `Bearer ${key}` },
      fetchImpl,
      timeoutMs,
      key,
    );
    if (!res.ok) {
      const authFailed = res.status === 401 || res.status === 403;
      return reportOf({
        providerId,
        providerName,
        queryable: authFailed,
        source: authFailed ? 'official_api' : 'unknown',
        scope: 'subscription_plan',
        authState: authFailed ? 'auth_failed' : 'authenticated',
        planName: 'MiniMax Coding Plan',
        summary: authFailed ? `MiniMax Coding Plan 鉴权失败：${res.errorDetail}` : `未知 / 暂不可查询（${res.errorDetail}）`,
        fetchedAt,
        errorDetail: res.errorDetail,
        rawExcerpt: res.rawText,
      });
    }
    const modelRemains = (res.body as { model_remains?: Array<{ current_interval_total_count?: number; current_interval_usage_count?: number; remains_time?: number }> }).model_remains;
    const first = Array.isArray(modelRemains) ? modelRemains[0] : undefined;
    const totalReq = toNum(first?.current_interval_total_count);
    const remainingReq = toNum(first?.current_interval_usage_count);
    if (totalReq === null || remainingReq === null) {
      return reportOf({
        providerId,
        providerName,
        queryable: false,
        source: 'unknown',
        scope: 'subscription_plan',
        authState: 'authenticated',
        planName: 'MiniMax Coding Plan',
        summary: '未知 / 不可查询（MiniMax Coding Plan 响应结构未识别）',
        fetchedAt,
        errorDetail: 'unexpected_schema',
        rawExcerpt: res.rawText,
      });
    }
    const usedReq = Math.max(0, totalReq - remainingReq);
    const usedPct = totalReq > 0 ? Number(((usedReq / totalReq) * 100).toFixed(2)) : 0;
    const remPct = Math.max(0, Number((100 - usedPct).toFixed(2)));
    const resetsAt = typeof first?.remains_time === 'number' && first.remains_time > 0
      ? new Date(fetchedAt + first.remains_time).toISOString()
      : null;
    return reportOf({
      providerId,
      providerName,
      queryable: true,
      source: 'official_api',
      scope: 'subscription_plan',
      authState: 'authenticated',
      planName: 'MiniMax Coding Plan',
      windows: [{
        windowKind: 'rolling_5h',
        label: '5小时窗口',
        status: windowStatusOf(usedPct),
        usedPercent: usedPct,
        remainingPercent: remPct,
        usedTokens: null,
        remainingTokens: null,
        usedRequests: usedReq,
        remainingRequests: remainingReq,
        resetsAt,
      }],
      summary: `Coding Plan 5h 窗口：剩余 ${remainingReq}/${totalReq} 次（已用 ${usedPct}%）`,
      fetchedAt,
      rawExcerpt: res.rawText,
    });
  }

  // 9) 其余无公开额度 API 的厂商（OpenAI / Anthropic / 火山方舟 / OpenCode Console / Jev / 自定义）
  return reportOf({
    providerId,
    providerName,
    queryable: false,
    source: 'unknown',
    scope: 'unknown',
    authState: key ? 'authenticated' : 'missing_key',
    summary: '未知 / 不可查询（该供应商未提供公开额度查询 API）',
    fetchedAt,
  });
}

export async function probeQuotaMatrix(
  entries: ProbeQuotaInput[],
  shared: Omit<ProbeQuotaInput, 'providerId' | 'providerName' | 'apiKey' | 'planType' | 'region' | 'baseUrl'> = {},
): Promise<ProviderQuotaMatrix> {
  const generatedAt = (shared.now ?? Date.now)();
  const reports = await Promise.all(
    entries.map((entry) => probeProviderQuota({ ...shared, ...entry })),
  );
  return ProviderQuotaMatrixSchema.parse({ generatedAt, reports });
}
