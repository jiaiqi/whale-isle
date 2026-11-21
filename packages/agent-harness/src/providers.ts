/**
 * Provider 注册表（T-M6-02）：本机 agent CLI 的 ACP 接入命令（真机探测 2026-11-21：
 * gemini --acp 原生 ✓ / dsh --profile acp ✓ / claude 与 codex CLI 当前版本无 --acp 旗标
 * ——预留 claude-agent-acp（Registry 包，npx 启动），可用性以探测为准）。
 */
export interface AgentProviderPreset {
  id: string;
  label: string;
  /** ACP 启动命令；null = 需要安装（UI 显示引导） */
  command: string | null;
  args: string[];
  /** 凭据说明（自管：我们不碰订阅） */
  authHint: string;
}

export const AGENT_PROVIDER_PRESETS: AgentProviderPreset[] = [
  {
    id: 'gemini-cli',
    label: 'Gemini CLI',
    command: 'gemini',
    args: ['--acp'],
    authHint: 'Google OAuth 登录或 GEMINI_API_KEY（agent 自管）',
  },
  {
    id: 'dsh-acp',
    label: 'DeepSeek Harness (dsh)',
    command: 'dsh',
    args: ['--profile', 'acp'],
    authHint: 'dsh 自身登录/供应商配置（agent 自管）',
  },
  {
    id: 'claude-acp',
    label: 'Claude (claude-agent-acp)',
    // t3code 文档：Registry 的 claude-agent-acp 命令；本机 claude CLI 无 --acp 旗标
    command: 'npx',
    args: ['-y', 'claude-agent-acp'],
    authHint: 'claude CLI 自身登录态',
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
