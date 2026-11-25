/**
 * Whale Isle V2 — 开放生态、插件进程隔离、Agent Skills、双向 MCP 与 Harness 契约（V2-P2-02 / Blueprint 04）
 */
import { z } from 'zod';

export const PluginTrustLevelSchema = z.enum(['builtin-trusted', 'third-party-isolated']);
export type PluginTrustLevel = z.infer<typeof PluginTrustLevelSchema>;

export const ToolRiskTierSchema = z.enum([
  'P0_READ',
  'P1_PREPARE',
  'P2_REVERSIBLE_WRITE',
  'P3_EXTERNAL_WRITE',
  'P4_SENSITIVE',
  'P5_FORBIDDEN',
]);
export type ToolRiskTier = z.infer<typeof ToolRiskTierSchema>;

export const PluginSandboxStatusSchema = z.enum(['idle', 'running', 'crashed', 'stopped']);
export type PluginSandboxStatus = z.infer<typeof PluginSandboxStatusSchema>;

export const PluginSandboxHealthSchema = z.object({
  pluginId: z.string().min(1),
  trustLevel: PluginTrustLevelSchema,
  isolated: z.boolean(),
  status: PluginSandboxStatusSchema,
  restarts: z.number().int().min(0),
  timeoutMs: z.number().int().positive(),
  lastError: z.string().optional(),
});
export type PluginSandboxHealth = z.infer<typeof PluginSandboxHealthSchema>;

export const SkillScopeSchema = z.enum(['global', 'character', 'task']);
export type SkillScope = z.infer<typeof SkillScopeSchema>;

export const SkillSafetyStatusSchema = z.enum(['clean', 'warning', 'blocked']);
export type SkillSafetyStatus = z.infer<typeof SkillSafetyStatusSchema>;

export const AgentSkillManifestSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().default(''),
  version: z.string().min(1).default('1.0.0'),
  source: z.string().min(1).default('local'),
  license: z.string().min(1).default('UNKNOWN'),
  scope: SkillScopeSchema.default('global'),
  declaredPermissions: z.array(z.string().min(1)).default([]),
  dependencies: z.array(z.string().min(1)).default([]),
  hasReferences: z.boolean().default(false),
  hasScripts: z.boolean().default(false),
  hasAssets: z.boolean().default(false),
  safetyStatus: SkillSafetyStatusSchema,
  safetyFindings: z.array(z.string().min(1)).default([]),
  enabled: z.boolean().default(false),
  rootDir: z.string().min(1),
});
export type AgentSkillManifest = z.infer<typeof AgentSkillManifestSchema>;

export const McpTransportTypeSchema = z.enum(['stdio', 'streamable-http']);
export type McpTransportType = z.infer<typeof McpTransportTypeSchema>;

export const McpServerConfigSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  transport: McpTransportTypeSchema,
  endpoint: z.string().min(1).optional(),
  command: z.string().min(1).optional(),
  args: z.array(z.string()).default([]),
  authHeader: z.string().min(1).optional(),
  timeoutMs: z.number().int().positive().default(10_000),
});
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

export const McpToolDescriptorSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(''),
  inputSchema: z.record(z.string(), z.unknown()).default({}),
});
export type McpToolDescriptor = z.infer<typeof McpToolDescriptorSchema>;

export const McpResourceDescriptorSchema = z.object({
  uri: z.string().min(1),
  name: z.string().min(1),
  mimeType: z.string().optional(),
  description: z.string().optional(),
});
export type McpResourceDescriptor = z.infer<typeof McpResourceDescriptorSchema>;

export const McpPromptDescriptorSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  arguments: z.array(z.object({
    name: z.string().min(1),
    required: z.boolean().default(false),
  })).default([]),
});
export type McpPromptDescriptor = z.infer<typeof McpPromptDescriptorSchema>;

export const McpAuditEntrySchema = z.object({
  timestamp: z.number().int().nonnegative(),
  method: z.string().min(1),
  scope: z.string().min(1),
  actor: z.string().min(1),
  allowed: z.boolean(),
  detail: z.string().default(''),
});
export type McpAuditEntry = z.infer<typeof McpAuditEntrySchema>;

export const HarnessProtocolTypeSchema = z.enum(['acp', 'cli-exec', 'mcp']);
export type HarnessProtocolType = z.infer<typeof HarnessProtocolTypeSchema>;

export const HarnessIntegrationLevelSchema = z.enum(['protocol', 'config', 'execution', 'deep']);
export type HarnessIntegrationLevel = z.infer<typeof HarnessIntegrationLevelSchema>;
