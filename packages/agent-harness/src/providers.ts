import type { HarnessIntegrationLevel, HarnessProtocolType } from '@workbench/shared-protocol';

/**
 * Provider 注册表（T-M6-02 + V2-P2-02 多 Harness 开放生态）：
 * 本机 agent CLI 统一注册表；`verifiedStatus` 诚实区分真机已测 vs 适配器就绪待实机验收。
 */
export interface AgentProviderPreset {
  id: string;
  label: string;
  /** 启动命令；null = 需要安装（UI 显示引导） */
  command: string | null;
  args: string[];
  /** 凭据说明（自管：我们不碰订阅） */
  authHint: string;
  protocol?: HarnessProtocolType;
  integrationLevel?: HarnessIntegrationLevel;
  verifiedStatus?: 'real-device-verified' | 'adapter-only';
}

export const AGENT_PROVIDER_PRESETS: AgentProviderPreset[] = [
  {
    id: 'gemini-cli',
    label: 'Gemini CLI',
    command: 'gemini',
    args: ['--acp'],
    authHint: 'Google OAuth 登录或 GEMINI_API_KEY（agent 自管）',
    protocol: 'acp',
    integrationLevel: 'execution',
    verifiedStatus: 'real-device-verified',
  },
  {
    id: 'dsh-acp',
    label: 'DeepSeek Harness (dsh)',
    command: 'dsh',
    args: ['--profile', 'acp'],
    authHint: 'dsh 自身登录/供应商配置（agent 自管）',
    protocol: 'acp',
    integrationLevel: 'execution',
    verifiedStatus: 'real-device-verified',
  },
  {
    id: 'claude-acp',
    label: 'Claude Code',
    command: 'npx',
    args: ['-y', 'claude-agent-acp'],
    authHint: 'claude CLI 自身登录态',
    protocol: 'acp',
    integrationLevel: 'protocol',
    verifiedStatus: 'adapter-only',
  },
  {
    id: 'codex-cli',
    label: 'OpenAI Codex CLI',
    command: 'codex',
    args: ['exec', '--full-auto'],
    authHint: 'OPENAI_API_KEY 或 codex login（agent 自管）',
    protocol: 'cli-exec',
    integrationLevel: 'execution',
    verifiedStatus: 'adapter-only',
  },
  {
    id: 'opencode-cli',
    label: 'OpenCode CLI',
    command: 'opencode',
    args: ['run'],
    authHint: 'opencode 本地供应商配置',
    protocol: 'cli-exec',
    integrationLevel: 'execution',
    verifiedStatus: 'adapter-only',
  },
  {
    id: 'pi-cli',
    label: 'Pi Coding Agent',
    command: 'pi',
    args: ['-p'],
    authHint: 'pi CLI 自管配置',
    protocol: 'cli-exec',
    integrationLevel: 'execution',
    verifiedStatus: 'adapter-only',
  },
  {
    id: 'openhands-cli',
    label: 'OpenHands CLI',
    command: 'openhands',
    args: ['--headless', '-t'],
    authHint: 'LLM_API_KEY / OpenHands 配置（agent 自管）',
    protocol: 'cli-exec',
    integrationLevel: 'execution',
    verifiedStatus: 'adapter-only',
  },
];

/** 探测 provider 可执行性（which 风格：--version 试跑）；超时即不可用 */
export async function probeCommand(
  command: string,
  args: string[],
  impl: { execFile: (cmd: string, a: string[], opts: { timeout?: number }, cb: (err: Error | null, stdout: string) => void) => void },
): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      impl.execFile(command, args.length ? args : ['--version'], { timeout: 8_000 }, (err) => {
        resolve(err === null);
      });
    } catch {
      /* v8 ignore next -- 防御层：execFile 同步抛（极端环境）——probeCommand：execFile 抛同步异常测试已覆盖 */
      resolve(false);
    }
  });
}
