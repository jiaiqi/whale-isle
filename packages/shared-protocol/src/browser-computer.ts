/**
 * Whale Isle V2 — 受控 Browser Use、Computer Use 与 Per-Character 凭据/Profile 隔离契约（V2-P3-03 · REQ-SEC-02 / REQ-AUTO-01）
 * - 零外部依赖（仅 zod），供 runtime-core / desktop-host / 未来 Digital Life 共用
 * - 强约束：明文密钥与原始 Cookie 绝不下行渲染层；严禁绕过验证码或平台风控；同一设备仅一个前台主控租约
 */
import { z } from 'zod';

export const PermissionRiskLevelSchema = z.enum(['P0', 'P1', 'P2', 'P3', 'P4', 'P5']);
export type PermissionRiskLevel = z.infer<typeof PermissionRiskLevelSchema>;

export const AccountVaultEntrySchema = z.object({
  accountId: z.string().min(1),
  characterId: z.string().min(1),
  platform: z.string().min(1),
  username: z.string().min(1),
  vaultKeyId: z.string().min(1),
  maskedSecret: z.string().default(''),
  active: z.boolean().default(true),
  expiresAt: z.number().int().nonnegative().nullable().default(null),
  rotatedAt: z.number().int().nonnegative().default(0),
});
export type AccountVaultEntry = z.output<typeof AccountVaultEntrySchema>;

export const BrowserProfileStatusSchema = z.enum([
  'ready',
  'active',
  'blocked_captcha',
  'awaiting_human',
  'revoked',
]);
export type BrowserProfileStatus = z.infer<typeof BrowserProfileStatusSchema>;

export const BrowserProfileSchema = z.object({
  profileId: z.string().min(1),
  characterId: z.string().min(1),
  accountId: z.string().min(1),
  profileDir: z.string().min(1),
  isolatedFromUserDaily: z.boolean().default(true),
  loggedInOrigins: z.array(z.string()).default([]),
  cookieCount: z.number().int().nonnegative().default(0),
  status: BrowserProfileStatusSchema.default('ready'),
  updatedAt: z.number().int().nonnegative().default(0),
});
export type BrowserProfile = z.output<typeof BrowserProfileSchema>;

export const BrowserStrategySchema = z.enum([
  'deterministic_dom',
  'accessibility_tree',
  'http_api',
  'vision_gui',
]);
export type BrowserStrategy = z.infer<typeof BrowserStrategySchema>;

export const BrowserPauseReasonSchema = z.enum([
  'none',
  'captcha_required',
  'anti_bot_gate',
  'login_required',
  'p4_approval_required',
  'p5_explicit_confirm',
  'lease_revoked',
  'profile_isolation_violation',
  'emergency_halt',
  'runner_unavailable',
]);
export type BrowserPauseReason = z.infer<typeof BrowserPauseReasonSchema>;

export const BrowserTaskRequestSchema = z.object({
  taskId: z.string().min(1),
  characterId: z.string().min(1),
  profileId: z.string().min(1),
  url: z.string().url(),
  action: z.enum(['read', 'extract_dom', 'click_selector', 'fill_form', 'publish', 'payment', 'delete']),
  riskLevel: PermissionRiskLevelSchema.default('P1'),
  selector: z.string().optional(),
  /** 仅来自用户显式授权或 AI 计划的结构化数据；网页正文永远不会写入此字段 */
  inputText: z.string().optional(),
  preferDeterministic: z.boolean().default(true),
  /** 兼容旧调用；P5 现要求一次性 confirmToken，单独的 boolean 不足以放行 */
  hasExplicitUserConfirm: z.boolean().default(false),
  hasP4Approval: z.boolean().default(false),
  /** P5 一次性确认令牌（由用户在主进程签发，单次消费，过期作废） */
  confirmToken: z.string().optional(),
  pageHints: z.array(z.string()).default([]),
  deviceId: z.string().min(1).default('host-primary'),
});
export type BrowserTaskRequest = z.output<typeof BrowserTaskRequestSchema>;
export type BrowserTaskRequestInput = z.input<typeof BrowserTaskRequestSchema>;

export const BrowserRunnerStatusSchema = z.enum([
  'executed',
  'plan_only',
  'runner_unavailable',
  'blocked',
  'handoff',
]);
export type BrowserRunnerStatus = z.infer<typeof BrowserRunnerStatusSchema>;

export const BrowserRunnerReportSchema = z.object({
  engine: z.enum(['electron', 'playwright', 'none']).default('none'),
  status: BrowserRunnerStatusSchema.default('runner_unavailable'),
  detail: z.string().default(''),
  stepCount: z.number().int().nonnegative().default(0),
  pageTextChars: z.number().int().nonnegative().default(0),
  injectionSignals: z.array(z.string()).default([]),
});
export type BrowserRunnerReport = z.output<typeof BrowserRunnerReportSchema>;

export const BrowserHumanHandoffSchema = z.object({
  handoffId: z.string().min(1),
  taskId: z.string().min(1),
  characterId: z.string().min(1),
  profileId: z.string().min(1),
  reason: BrowserPauseReasonSchema,
  url: z.string(),
  detail: z.string().default(''),
  requestedAt: z.number().int().nonnegative().default(0),
  completedAt: z.number().int().nonnegative().nullable().default(null),
  status: z.enum(['awaiting_human', 'completed', 'cancelled']).default('awaiting_human'),
});
export type BrowserHumanHandoff = z.output<typeof BrowserHumanHandoffSchema>;

export const BrowserTaskOutcomeSchema = z.object({
  ok: z.boolean(),
  taskId: z.string().min(1),
  strategyUsed: BrowserStrategySchema,
  pauseReason: BrowserPauseReasonSchema.default('none'),
  requiresHumanHandoff: z.boolean().default(false),
  detail: z.string().min(1),
  profileDir: z.string(),
  runner: BrowserRunnerReportSchema.prefault({}),
  handoff: BrowserHumanHandoffSchema.nullable().default(null),
});
export type BrowserTaskOutcome = z.output<typeof BrowserTaskOutcomeSchema>;

export const ComputerUseLeaseStatusSchema = z.enum([
  'active',
  'released',
  'expired',
  'preempted_by_human',
  'halted',
]);
export type ComputerUseLeaseStatus = z.infer<typeof ComputerUseLeaseStatusSchema>;

export const ComputerUseLeaseSchema = z.object({
  leaseId: z.string().min(1),
  deviceId: z.string().min(1),
  holderId: z.string().min(1),
  holderKind: z.enum(['agent', 'human']),
  characterId: z.string().min(1),
  controlOwner: z.enum(['ai', 'human', 'halted']),
  purpose: z.string().min(1),
  acquiredAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
  lastHeartbeatAt: z.number().int().nonnegative(),
  status: ComputerUseLeaseStatusSchema,
});
export type ComputerUseLease = z.output<typeof ComputerUseLeaseSchema>;

export const ComputerInputModeSchema = z.enum(['disabled', 'dry_run', 'live']);
export type ComputerInputMode = z.infer<typeof ComputerInputModeSchema>;

export const ComputerInputExecutorStatusSchema = z.object({
  enabled: z.boolean().default(false),
  mode: ComputerInputModeSchema.default('disabled'),
  permission: z.enum(['granted', 'denied', 'unknown']).default('unknown'),
  dryRunCount: z.number().int().nonnegative().default(0),
  executedCount: z.number().int().nonnegative().default(0),
  rejectedCount: z.number().int().nonnegative().default(0),
  lastIntentAt: z.number().int().nonnegative().nullable().default(null),
});
export type ComputerInputExecutorStatus = z.output<typeof ComputerInputExecutorStatusSchema>;

export const HumanInputMonitorStatusSchema = z.object({
  running: z.boolean().default(false),
  polls: z.number().int().nonnegative().default(0),
  detected: z.number().int().nonnegative().default(0),
  syntheticExcluded: z.number().int().nonnegative().default(0),
  lastIdleSeconds: z.number().nonnegative().nullable().default(null),
  lastHumanInputAt: z.number().int().nonnegative().nullable().default(null),
  lastSyntheticAt: z.number().int().nonnegative().nullable().default(null),
  pollIntervalMs: z.number().int().positive().default(250),
  userInputThresholdSeconds: z.number().nonnegative().default(1),
  syntheticExclusionMs: z.number().int().nonnegative().default(2_000),
});
export type HumanInputMonitorStatus = z.output<typeof HumanInputMonitorStatusSchema>;

export const BrowserComputerSnapshotSchema = z.object({
  accounts: z.array(AccountVaultEntrySchema),
  profiles: z.array(BrowserProfileSchema),
  activeLeases: z.array(ComputerUseLeaseSchema),
  humanOverrideDevices: z.array(z.string()),
  pendingHandoffs: z.array(BrowserHumanHandoffSchema).default([]),
  inputExecutor: ComputerInputExecutorStatusSchema.prefault({}),
  inputMonitor: HumanInputMonitorStatusSchema.prefault({}),
  p5ConfirmationCount: z.number().int().nonnegative().default(0),
  recentAuditCount: z.number().int().nonnegative().default(0),
  halted: z.boolean(),
});
export type BrowserComputerSnapshot = z.output<typeof BrowserComputerSnapshotSchema>;
