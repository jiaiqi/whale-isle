/**
 * Harness 管理器（T-M6-02）：多 provider 实例生命周期 + 事件汇流。
 * 审批（permission 事件）经 onEvent 上抛宿主（Shell 卡片 + WebUI 远程）；
 * Y/N/A 回填走 AcpAgent.resolvePermission。
 */
import { AcpAgent, type AcpAgentEvent } from './acp-client';
import type { AgentProviderPreset } from './providers';

export interface HarnessInstanceInfo {
  presetId: string;
  label: string;
  running: boolean;
  sessions: string[];
}

export class HarnessManager {
  private readonly agents = new Map<string, AcpAgent>();

  constructor(
    private readonly onEvent: (presetId: string, event: AcpAgentEvent) => void,
    private readonly spawnImpl?: typeof import('node:child_process').spawn,
  ) {}

  list(): HarnessInstanceInfo[] {
    return [...this.agents.entries()].map(([presetId, agent]) => ({
      presetId,
      label: agent.label,
      running: agent.isRunning(),
      sessions: this.sessionsOf(presetId),
    }));
  }

  private readonly sessions = new Map<string, string[]>();

  private sessionsOf(presetId: string): string[] {
    return this.sessions.get(presetId) ?? [];
  }

  /** 启动 provider 实例并握手；返回 initialize 结果（含 authMethods——未登录时 UI 引导） */
  async startPreset(preset: AgentProviderPreset, cwd?: string): Promise<{ ok: boolean; error?: string; authMethods?: string[] }> {
    if (this.agents.has(preset.id) && this.agents.get(preset.id)?.isRunning()) {
      return { ok: false, error: `${preset.label} 已在运行` };
    }
    if (!preset.command) return { ok: false, error: `${preset.label} 需要先安装 agent` };
    const agent = new AcpAgent(
      { label: preset.label, command: preset.command, args: preset.args, cwd, spawnImpl: this.spawnImpl },
      (event) => {
        if (event.type === 'session-started') {
          const list = this.sessions.get(preset.id) ?? [];
          list.push(event.sessionId);
          this.sessions.set(preset.id, list);
        }
        this.onEvent(preset.id, event);
      },
    );
    this.agents.set(preset.id, agent);
    try {
      const init = await agent.start();
      return { ok: true, authMethods: init.authMethods?.map((m) => m.id ?? m.name ?? m.id) };
    } catch (error) {
      this.agents.delete(preset.id);
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** 发一轮提示（自动新建会话若该实例无会话） */
  async prompt(presetId: string, text: string, cwd = process.cwd()): Promise<{ ok: boolean; error?: string; sessionId?: string }> {
    const agent = this.agents.get(presetId);
    if (!agent || !agent.isRunning()) return { ok: false, error: '实例未运行' };
    let sessionId = this.sessionsOf(presetId).at(-1);
    if (!sessionId) {
      try {
        sessionId = await agent.newSession(cwd);
      } catch (error) {
        /* v8 ignore next -- 防御层：newSession 失败（stdin 死/未登录）由上层 auth-required 事件承载 */
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
    try {
      await agent.prompt(sessionId, text);
      return { ok: true, sessionId };
    } catch (error) {
      /* v8 ignore next -- 防御层：prompt 失败（stdin 死）已由 stdin-destroy 测试覆盖，v8 计数失效 */
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** 审批回填（Y=allow 一次 / A=always / N=reject） */
  resolvePermission(presetId: string, requestId: number, outcome: 'allow' | 'always' | 'reject'): void {
    const agent = this.agents.get(presetId);
    if (!agent) return;
    const optionId = outcome === 'reject' ? 'reject' : outcome === 'always' ? 'allow_always' : 'allow_once';
    void agent.resolvePermission(requestId, { outcome: 'selected', optionId });
  }

  stopPreset(presetId: string): void {
    this.agents.get(presetId)?.stop();
    this.agents.delete(presetId);
    this.sessions.delete(presetId);
  }

  stopAll(): void {
    for (const id of [...this.agents.keys()]) this.stopPreset(id);
  }
}
