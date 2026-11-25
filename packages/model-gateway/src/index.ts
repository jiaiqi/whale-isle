/**
 * 模型网关层出口。
 * UI / persona-brain / live-stream-hub 一律经本包调用 LLM，严禁绕过。
 */
export * from './types';
export { createSanitizer, MASK, type SanitizerOptions, type Sanitize } from './sanitizer';
export {
  BUILTIN_PROVIDER_PRESETS,
  PROVIDER_PRESET_IDS,
  resolveEndpoint,
  resolveProtocol,
  buildChatUrl,
  type ProviderProtocol,
} from './presets';
export {
  orderedCandidates,
  recordStickyGood,
  StickyState,
  RouteError,
  type RouteCandidate,
  type CandidateOrderContext,
} from './router';
export {
  ModelGateway,
  GatewayError,
  type GatewayOptions,
  type ChatReceipt,
  type ChatMessage,
  type UsageRecord,
  type FetchLike,
  type GatewayErrorCode,
} from './gateway';
export {
  probeProviderQuota,
  probeQuotaMatrix,
  sanitizeQuotaText,
  type ProbeQuotaInput,
  type QuotaFetchLike,
} from './quota-probes';
