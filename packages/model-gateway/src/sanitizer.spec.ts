import { homedir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { createSanitizer, MASK } from './sanitizer';

/** T-M1-03 门禁：敏感路径/密钥/用户名 100% 替换为 {{MASKED}}，残留为 0 */

describe('createSanitizer（隐私脱敏）', () => {
  const sanitize = createSanitizer({ username: 'jiaqi', homeDir: '/Users/jiaqi' });

  it('POSIX 敏感路径 100% 替换', () => {
    const out = sanitize('我的项目在 /Users/jiaqi/dev/secret/keys.txt 里，别删');
    expect(out).toBe(`我的项目在 ${MASK} 里，别删`);
  });

  it('homeDir 路径整条替换（统一整路径掩码语义）', () => {
    expect(sanitize(`配置在 ${homedir()}/workbench/config.json`)).toBe(`配置在 ${MASK}`);
  });

  it('Windows 路径替换', () => {
    expect(sanitize(String.raw`日志在 C:\Users\jiaqi\AppData\Roaming\notes.md`)).toBe(`日志在 ${MASK}`);
  });

  it('API Key：sk-/ghp_/AKIA/Bearer/明文赋值', () => {
    const out = sanitize('key1=sk-abcDEF1234567890abcdef end ghp_0123456789abcdefghij token AKIAIOSFODNN7EXAMPLE');
    expect(out).not.toContain('sk-abcDEF');
    expect(out).not.toContain('ghp_0123');
    expect(out).not.toContain('AKIAIOSFODNN7');
    expect(out.split(MASK).length - 1).toBe(3);
    expect(sanitize('authorization: Bearer eyJhbGciOiJIUzI1NiJ9')).toBe(`authorization: Bearer ${MASK}`);
    expect(sanitize('apiKey: "abcd1234efgh5678"')).toBe(`apiKey: "${MASK}"`);
  });

  it('本机用户名（独立词）替换', () => {
    expect(sanitize('用户 jiaqi 今天写了 300 行')).toBe(`用户 ${MASK} 今天写了 300 行`);
  });

  it('正常内容不受影响（中文/数字/普通词）', () => {
    const text = '大肥鱼今天吃了 3 碗白米饭，weight=0.7，deepseek-reasoner 真香';
    expect(sanitize(text)).toBe(text);
  });

  it('100% 残留断言：混合敏感信息逐项归零', () => {
    const mixed = [
      '路径 /Users/jiaqi/.ssh/id_rsa',
      'home /Users/jiaqi/notes',
      'key sk-abcDEF1234567890abcdef',
      'token ghp_0123456789abcdefghij',
      'AKIAIOSFODNN7EXAMPLE',
      'Bearer eyJhbGciOiJIUzI1NiJ9.token',
      'user jiaqi 登录',
    ].join(' | ');
    const out = sanitize(mixed);
    expect(out).not.toMatch(/\/Users\//);
    expect(out).not.toMatch(/\bsk-[A-Za-z0-9]{16,}\b/);
    expect(out).not.toMatch(/\bghp_[A-Za-z0-9]{20,}\b/);
    expect(out).not.toMatch(/AKIA[0-9A-Z]{16}/);
    expect(out).not.toMatch(/Bearer\s+(?!{{MASKED}})[A-Za-z0-9._\-]{12,}/);
    expect(out).not.toMatch(/\bjiaqi\b/);
    expect(out.split(MASK).length - 1).toBeGreaterThanOrEqual(6);
  });

  it('默认取 os 信息（无显式注入）', () => {
    const osSanitize = createSanitizer();
    const out = osSanitize(`本机 ${homedir()}/x.txt`);
    expect(out).not.toContain(homedir());
    expect(out).toContain(MASK);
  });

  it('边界：homeDir=/ 与空用户名（两分支均不生效）', () => {
    const minimal = createSanitizer({ username: '', homeDir: '/' });
    expect(minimal('用户 /Users/jiaqi/notes 与 root')).not.toContain('/Users/jiaqi/notes');
    expect(minimal('普通文本')).toBe('普通文本');
  });

  it('显式传 undefined → 走 os 探测与 env 兜底（分支覆盖）', () => {
    const withUndefined = createSanitizer({ username: undefined, homeDir: undefined });
    const text = '普通文本 /Users/jiaqi/x';
    expect(withUndefined(text)).toContain(MASK);
  });

  it('extraRules：宿主扩展规则', () => {
    const custom = createSanitizer({
      username: 'x',
      homeDir: '/x',
      extraRules: [{ re: /摸鱼/g, replacement: '勤奋' }],
    });
    expect(custom('今天很摸鱼')).toBe('今天很勤奋');
  });
});
