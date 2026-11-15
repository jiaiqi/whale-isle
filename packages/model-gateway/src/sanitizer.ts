/**
 * 隐私脱敏网关（T-M1-03，Magpie 思想重写）：发往云端前屏蔽本机隐私。
 * 规则：本机用户名（独立词）、homeDir 前缀、绝对路径（POSIX/Windows）、
 *       API Key（sk-/ghp_/AKIA/Bearer/明文 apiKey 赋值）→ {{MASKED}}。
 */
import { homedir, userInfo } from 'node:os';

export const MASK = '{{MASKED}}';

export interface SanitizerOptions {
  /** 本机用户名（缺省取 os.userInfo().username） */
  username?: string;
  /** home 目录前缀（缺省取 os.homedir()） */
  homeDir?: string;
  /** 额外规则（宿主扩展，如剪贴板关键词） */
  extraRules?: Array<{ re: RegExp; replacement?: string }>;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function resolveDefaults(options: SanitizerOptions): Required<Pick<SanitizerOptions, 'username' | 'homeDir'>> {
  let username = options.username;
  let homeDir = options.homeDir;
  if (username === undefined) {
    try {
      username = userInfo().username;
    } catch {
      username = process.env.USER ?? '';
    }
  }
  if (homeDir === undefined) homeDir = homedir();
  return { username, homeDir };
}

export type Sanitize = (text: string) => string;

export function createSanitizer(options: SanitizerOptions = {}): Sanitize {
  const { username, homeDir } = resolveDefaults(options);

  return function sanitize(text: string): string {
    let out = text;

    // 绝对路径整条掩码（敏感路径 100% → {{MASKED}}，避免泄露目录结构）
    // POSIX 绝对路径（/Users/<u>/… 或 /home/<u>/…）
    out = out.replace(/\/(?:Users|home)\/[\w.\- ]+(?:\/[^\s"'`，。；、]*)?/g, MASK);
    // Windows 绝对路径（C:\Users\<u>\…）
    out = out.replace(/[A-Za-z]:\\Users\\[\w.\- ]+(?:\\[^\s"';，。；、]*)?/g, MASK);
    // 其他形态的 homeDir（非常规安装路径兜底）
    if (homeDir && homeDir !== '/') {
      out = out.split(homeDir).join(MASK);
    }
    // 明文密钥特征
    out = out.replace(/\bsk-[A-Za-z0-9]{16,}\b/g, MASK);
    out = out.replace(/\bghp_[A-Za-z0-9]{20,}\b/g, MASK);
    out = out.replace(/\bAKIA[0-9A-Z]{16}\b/g, MASK);
    out = out.replace(/Bearer\s+[A-Za-z0-9._\-]{12,}/gi, `Bearer ${MASK}`);
    out = out.replace(
      /(api[_-]?key\s*[:=]\s*["']?)[A-Za-z0-9_\-.]{12,}(["']?)/gi,
      `$1${MASK}$2`,
    );
    // 本机用户名（独立词）
    if (username) {
      out = out.replace(new RegExp(`\\b${escapeRegExp(username)}\\b`, 'g'), MASK);
    }
    for (const rule of options.extraRules ?? []) {
      out = out.replace(rule.re, rule.replacement ?? MASK);
    }
    return out;
  };
}
