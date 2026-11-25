import { describe, expect, it } from 'vitest';
import {
  AgentSkillManifestSchema,
  HarnessIntegrationLevelSchema,
  HarnessProtocolTypeSchema,
  McpAuditEntrySchema,
  McpPromptDescriptorSchema,
  McpResourceDescriptorSchema,
  McpServerConfigSchema,
  McpToolDescriptorSchema,
  PluginSandboxHealthSchema,
  PluginTrustLevelSchema,
  SkillScopeSchema,
  ToolRiskTierSchema,
} from './ecosystem';

describe('shared-protocol V2-P2-02 ecosystem contracts', () => {
  it('validates plugin trust, P0-P5 tiers, sandbox health, and skills manifest defaults', () => {
    expect(PluginTrustLevelSchema.parse('third-party-isolated')).toBe('third-party-isolated');
    for (const tier of ['P0_READ', 'P1_PREPARE', 'P2_REVERSIBLE_WRITE', 'P3_EXTERNAL_WRITE', 'P4_SENSITIVE', 'P5_FORBIDDEN']) {
      expect(ToolRiskTierSchema.safeParse(tier).success).toBe(true);
    }

    const health = PluginSandboxHealthSchema.parse({
      pluginId: 'hello-whale',
      trustLevel: 'third-party-isolated',
      isolated: true,
      status: 'running',
      restarts: 0,
      timeoutMs: 5000,
    });
    expect(health.isolated).toBe(true);

    const skill = AgentSkillManifestSchema.parse({
      id: 'stardew-cooperation',
      name: 'Stardew Co-op',
      safetyStatus: 'clean',
      rootDir: '/tmp/skills/stardew-cooperation',
    });
    expect(skill).toMatchObject({
      version: '1.0.0',
      source: 'local',
      license: 'UNKNOWN',
      scope: 'global',
      enabled: false,
      hasReferences: false,
    });
    expect(SkillScopeSchema.safeParse('character').success).toBe(true);
  });

  it('validates MCP server/tool/resource/prompt/audit & Harness schemas', () => {
    const mcp = McpServerConfigSchema.parse({
      id: 'ext-wiki',
      label: 'Wiki MCP',
      transport: 'streamable-http',
      endpoint: 'http://127.0.0.1:9001/mcp',
    });
    expect(mcp.timeoutMs).toBe(10_000);
    expect(McpToolDescriptorSchema.parse({ name: 'search' }).description).toBe('');
    expect(McpResourceDescriptorSchema.parse({ uri: 'whale://character/status', name: 'Status' }).uri).toBe('whale://character/status');
    expect(McpPromptDescriptorSchema.parse({ name: 'summarize' }).arguments).toEqual([]);
    expect(McpAuditEntrySchema.parse({ timestamp: 1, method: 'tools/call', scope: 'character.read', actor: 'codex', allowed: true }).detail).toBe('');
    expect(HarnessProtocolTypeSchema.safeParse('cli-exec').success).toBe(true);
    expect(HarnessIntegrationLevelSchema.safeParse('execution').success).toBe(true);
  });
});
