/**
 * 模型网关（T-M1-03）：统一 LLM 调用出口（UI 严禁绕过本包直连 API）。
 *
 * 铁律（AGENTS §2.2）：
 *  - 回执仅由真实 HTTP 响应构建——严禁把"应该成功"当成功；
 *  - 429/5xx/401/403/网络错误 → 立即静默切换下一候选（100ms 内，不退避）；400 请求级错误直接抛出；
 *  - usage 只记录供应商实际回报字段（prompt/completion/prompt_cache_hit_tokens）；
 *  - 发往云端的文本先过脱敏（secretMaskingEnabled，Magpie 思想）。
 */
import type { z } from 'zod';
import {
  ModelProviderConfigSchema,
  type DiningProfilePreset,
  type ModelProviderConfig,
  type StickyRoutingGroup,
  type WorkbenchRoleSlot,
} from '@workbench/shared-protocol';

type ProviderConfigInput = z.input<typeof ModelProviderConfigSchema>;
import { createSanitizer, type Sanitize, type SanitizerOptions } from './sanitizer';
import { BUILTIN_PROVIDER_PRESETS, buildChatUrl } from './presets';
import { orderedCandidates, recordStickyGood, StickyState, RouteError } from './router';

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export interface GatewayOptions {
  profile: DiningProfilePreset;
  /** 供应商清单（缺省 = 内置预设库；入参为可省略默认值的 input 形态，构造时统一 Schema 校验） */
  providers?: ProviderConfigInput[];
  groups?: StickyRoutingGroup[];
  /** providerId → 真实 Key（仅内存；日志/回执只允许掩码） */
  keys: Record<string, string>;
  fetchImpl?: FetchLike;
  /** 脱敏配置；false 强制关闭（profile.secretMaskingEnabled=false 时同样关闭） */
  sanitizer?: SanitizerOptions | false;
  onUsage?: (record: UsageRecord) => void;
}

export interface UsageRecord {
  slot: WorkbenchRoleSlot;
  providerId: string;
  modelId: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatReceipt {
  content: string;
  reasoningContent: string | null;
  usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number };
  route: { providerId: string; modelId: string; attempt: number };
  sanitized: boolean;
  elapsedMs: number;
}

export type GatewayErrorCode =
  | 'ROUTE_UNBOUND'
  | 'BAD_BINDING'
  | 'GROUP_MISSING'
  | 'PROVIDER_MISSING'
  | 'KEY_MISSING'
  | 'BAD_REQUEST'
  | 'ALL_CANDIDATES_FAILED';

export class GatewayError extends Error {
  constructor(
    readonly code: GatewayErrorCode,
    message: string,
    readonly detail?: { attempts?: Array<{ providerId: string; modelId: string; reason: string }>; status?: number },
  ) {
    super(message);
    this.name = 'GatewayError';
  }
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_cache_hit_tokens?: number };
  error?: { message?: string };
}

export class ModelGateway {
  private readonly providers = new Map<string, ModelProviderConfig>();
  private readonly sticky = new StickyState();
  private readonly sanitize: Sanitize;

  constructor(private readonly options: GatewayOptions) {
    for (const provider of options.providers ?? BUILTIN_PROVIDER_PRESETS) {
      const parsed = ModelProviderConfigSchema.parse(provider);
      this.providers.set(parsed.id, parsed);
    }
    const sanitizerOptions =
      options.sanitizer === false || options.profile.secretMaskingEnabled === false ? null : (options.sanitizer ?? {});
    this.sanitize = sanitizerOptions ? createSanitizer(sanitizerOptions) : (text: string) => text;
  }

  /** 干饭套餐切换（运行期仅消费 Schema 校验过的配置） */
  switchProfile(profile: DiningProfilePreset): void {
    this.options.profile = profile;
    this.sticky.clearAll();
  }

  async chat(
    slot: WorkbenchRoleSlot,
    messages: ChatMessage[],
    opts?: { sessionId?: string; temperature?: number; maxTokens?: number; signal?: AbortSignal },
  ): Promise<ChatReceipt> {
    const sessionId = opts?.sessionId ?? 'default';
    const binding = this.options.profile.roleBindings[slot];
    if (!binding) throw new GatewayError('ROUTE_UNBOUND', `套餐未绑定槽位：${slot}`);

    const routeContext = {
      binding,
      groups: this.options.groups ?? [],
      state: this.sticky,
      sessionId,
      slot,
    };
    let candidates: ReturnType<typeof orderedCandidates>;
    try {
      candidates = orderedCandidates(routeContext);
    } catch (error) {
      if (error instanceof RouteError) throw new GatewayError(error.code, error.message);
      throw error;
    }

    const sanitized = this.options.profile.secretMaskingEnabled;
    const outbound = messages.map((message) => ({ ...message, content: this.sanitize(message.content) }));

    const attempts: Array<{ providerId: string; modelId: string; reason: string }> = [];
    // 未注入 fetchImpl 时走全局 fetch（测试以 globalThis.fetch stub 覆盖此回退）
    const fetchImpl = this.options.fetchImpl ?? ((url, init) => fetch(url, init));
    let attemptIndex = 0;
    const startedAt = Date.now();

    for (const candidate of candidates) {
      const provider = this.providers.get(candidate.providerId);
      if (!provider) {
        attempts.push({ providerId: candidate.providerId, modelId: candidate.modelId, reason: 'PROVIDER_MISSING' });
        attemptIndex += 1;
        continue;
      }
      const apiKey = this.options.keys[candidate.providerId];
      if (!apiKey) {
        attempts.push({ providerId: candidate.providerId, modelId: candidate.modelId, reason: 'KEY_MISSING' });
        attemptIndex += 1;
        continue;
      }

      const url = buildChatUrl(provider);
      const t0 = Date.now();
      let response: Awaited<ReturnType<FetchLike>>;
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: candidate.modelId,
            messages: outbound,
            ...(opts?.temperature !== undefined ? { temperature: opts.temperature } : {}),
            ...(opts?.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
          }),
          signal: opts?.signal,
        });
      } catch (error) {
        attempts.push({ providerId: candidate.providerId, modelId: candidate.modelId, reason: `NETWORK_ERROR:${error instanceof Error ? error.message : String(error)}` });
        attemptIndex += 1;
        continue; // 静默切换下一候选（100ms 铁律：不退避）
      }

      // 400 = 请求本身有问题（模型名/参数），failover 无意义 → 立即抛出
      if (response.status === 400) {
        const body = (await response.json().catch(() => ({}))) as ChatCompletionResponse;
        throw new GatewayError('BAD_REQUEST', `请求被拒绝（400）：${body.error?.message ?? 'unknown'}`, { status: 400 });
      }
      if (!response.ok) {
        attempts.push({ providerId: candidate.providerId, modelId: candidate.modelId, reason: `HTTP_${response.status}` });
        attemptIndex += 1;
        continue; // 429/5xx/401/403 → 静默切换备用 Key
      }

      const body = (await response.json().catch(() => null)) as ChatCompletionResponse | null;
      if (!body) {
        attempts.push({ providerId: candidate.providerId, modelId: candidate.modelId, reason: 'PARSE_ERROR' });
        attemptIndex += 1;
        continue;
      }

      const latencyMs = Date.now() - t0;
      const usage = {
        inputTokens: body.usage?.prompt_tokens ?? 0,
        cachedInputTokens: body.usage?.prompt_cache_hit_tokens ?? 0,
        outputTokens: body.usage?.completion_tokens ?? 0,
      };
      const receipt: ChatReceipt = {
        content: body.choices?.[0]?.message?.content ?? '',
        reasoningContent: body.choices?.[0]?.message?.reasoning_content ?? null,
        usage,
        route: { providerId: candidate.providerId, modelId: candidate.modelId, attempt: attemptIndex },
        sanitized,
        elapsedMs: Date.now() - startedAt,
      };
      recordStickyGood(routeContext, candidate);
      this.sticky.recordLatency(candidate.groupId ?? '', attemptIndex, latencyMs);
      this.options.onUsage?.({
        slot,
        providerId: candidate.providerId,
        modelId: candidate.modelId,
        inputTokens: usage.inputTokens,
        cachedInputTokens: usage.cachedInputTokens,
        outputTokens: usage.outputTokens,
        latencyMs,
      });
      return receipt;
    }

    throw new GatewayError('ALL_CANDIDATES_FAILED', `所有候选均失败（${attempts.length} 次尝试）`, { attempts });
  }
}
