/**
 * Coding Agent 适配接口与 CLI 实现（V2-P0-05）：
 * - 使用参数数组 spawn（零 shell 拼接），限定工作目录为隔离 worktreePath
 * - 支持超时强杀与 AbortSignal 取消
 */
import { execFileSync, spawn } from 'node:child_process';
import type { EvolutionTask } from './types';

export interface CodingAgentRequest {
  task: EvolutionTask;
  worktreePath: string;
  contextMarkdown: string;
}

export interface CodingAgentResponse {
  ok: boolean;
  summary: string;
  changedFiles: string[];
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

export interface CodingAgentAdapter {
  readonly name: string;
  isAvailable(): boolean;
  execute(request: CodingAgentRequest, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<CodingAgentResponse>;
}

export type SupportedCliAgent = 'codex' | 'claude' | 'gemini' | 'dsh';

export function buildCliAgentArgs(agent: SupportedCliAgent, prompt: string): { command: string; args: string[] } {
  switch (agent) {
    case 'codex':
      return { command: 'codex', args: ['exec', prompt] };
    case 'claude':
      return { command: 'claude', args: ['-p', prompt] };
    case 'gemini':
      return { command: 'gemini', args: ['-p', prompt] };
    case 'dsh':
      return { command: 'dsh', args: ['run', prompt] };
  }
}

export class CliCodingAgentAdapter implements CodingAgentAdapter {
  readonly name: string;
  private readonly spawnImpl: typeof spawn;

  constructor(
    private readonly agent: SupportedCliAgent,
    options: { spawnImpl?: typeof spawn } = {},
  ) {
    this.name = `cli:${agent}`;
    this.spawnImpl = options.spawnImpl ?? spawn;
  }

  isAvailable(): boolean {
    try {
      execFileSync('which', [this.agent], { stdio: 'ignore', timeout: 3_000 });
      return true;
    } catch {
      return false;
    }
  }

  execute(
    request: CodingAgentRequest,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<CodingAgentResponse> {
    const timeoutMs = options.timeoutMs ?? 600_000;
    const prompt = [
      `Task: ${request.task.id} - ${request.task.title}`,
      `Goal: ${request.task.goal}`,
      `Acceptance Criteria:\n${request.task.acceptanceCriteria.map((c) => `- ${c}`).join('\n')}`,
      request.contextMarkdown,
    ].join('\n\n');
    const { command, args } = buildCliAgentArgs(this.agent, prompt);

    return new Promise<CodingAgentResponse>((resolvePromise) => {
      const child = this.spawnImpl(command, args, {
        cwd: request.worktreePath,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
      child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, timeoutMs);

      const onAbort = (): void => {
        child.kill('SIGTERM');
      };
      options.signal?.addEventListener('abort', onAbort, { once: true });

      child.once('error', (error) => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        resolvePromise({
          ok: false,
          summary: `无法启动 ${command}: ${error.message}`,
          changedFiles: [],
          stdout,
          stderr,
          exitCode: null,
          timedOut,
        });
      });

      child.once('close', (code) => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        resolvePromise({
          ok: !timedOut && code === 0,
          summary: timedOut ? `${command} 执行超时` : `${command} 退出码 ${String(code)}`,
          changedFiles: [],
          stdout,
          stderr,
          exitCode: code,
          timedOut,
        });
      });
    });
  }
}
