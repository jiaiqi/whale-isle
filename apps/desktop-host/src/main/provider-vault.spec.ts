/**
 * T-M6-66① 凭据库持久化回归：
 *   ① 写入后「重启」（重新读文件）仍能解密；
 *   ② mock keychain 与正常凭据库文件隔离，且拒绝覆盖正常文件；
 *   ③ 解密失败 / 身份不符 / 系统加密不可用 都进 inspectVault 状态，不再静默；
 *   ④ 日志零明文（成功与失败路径都不出现 Key 本体）；
 *   ⑤ 开发态环境变量兜底只读内存、不落盘，打包态禁用。
 */
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  appName: 'Electron',
  isPackaged: false,
  encryptionAvailable: true,
  mockKeychain: false,
  /** 当前 Keychain 主密钥；换值 = 换一台机器/换应用身份/换 mock keychain */
  secret: 'keychain-A',
  /** 用错密钥时是否抛错；false 模拟 macOS v10 AES-CBC 解出乱码但不报错 */
  throwOnWrongSecret: true,
  /** 钥匙串拒绝/不可用时 encryptString 抛错 */
  throwOnEncrypt: false,
}));

vi.mock('electron', () => ({
  app: {
    getName: (): string => state.appName,
    get isPackaged(): boolean { return state.isPackaged; },
    commandLine: { hasSwitch: (name: string): boolean => name === 'use-mock-keychain' && state.mockKeychain },
  },
  safeStorage: {
    isEncryptionAvailable: (): boolean => state.encryptionAvailable,
    encryptString: (plain: string): Buffer => {
      if (state.throwOnEncrypt) throw new Error('keychain access denied');
      return Buffer.from(`${state.secret}|${plain}`, 'utf8');
    },
    decryptString: (buf: Buffer): string => {
      const text = buf.toString('utf8');
      const sep = text.indexOf('|');
      const secret = sep >= 0 ? text.slice(0, sep) : '';
      if (secret !== state.secret) {
        if (state.throwOnWrongSecret) throw new Error('Error while decrypting the ciphertext');
        // 错误密钥解出的乱码（含替换字符/控制字符），必须被 looksLikeApiKey 拒绝
        return '�\u0001�garbage�';
      }
      return text.slice(sep + 1);
    },
  },
  ipcMain: { handle: vi.fn() },
  clipboard: { writeText: vi.fn() },
  shell: { openExternal: vi.fn() },
}));

import {
  hasVaultKey,
  inspectVault,
  isMockKeychainLaunch,
  logVaultStartup,
  maskKey,
  providerKeyEnvVar,
  readVaultKey,
  resolveVaultPath,
  vaultFileName,
  writeVaultKey,
} from './provider-vault';

let dir = '';
let vaultPath = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'whale-vault-'));
  vaultPath = join(dir, 'provider-vault.json');
  state.appName = 'Electron';
  state.isPackaged = false;
  state.encryptionAvailable = true;
  state.mockKeychain = false;
  state.secret = 'keychain-A';
  state.throwOnWrongSecret = true;
  state.throwOnEncrypt = false;
  delete process.env.WHALE_PROVIDER_KEY_DEEPSEEK_OFFICIAL;
});

afterEach(() => {
  delete process.env.WHALE_PROVIDER_KEY_DEEPSEEK_OFFICIAL;
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('凭据库持久化（T-M6-66①）', () => {
  it('写入后重启（重新读盘）仍能解密，并记录写入身份', () => {
    const key = 'sk-restart-1234567890';
    expect(writeVaultKey(vaultPath, 'deepseek-official', key).ok).toBe(true);

    const raw = JSON.parse(readFileSync(vaultPath, 'utf8')) as { version: number; entries: Record<string, { identity?: string }> };
    expect(raw.version).toBe(2);
    expect(raw.entries['deepseek-official']?.identity).toBe('Electron');

    // 模拟完全退出后重新启动：不依赖进程内缓存，重新读文件
    expect(readVaultKey(vaultPath, 'deepseek-official')).toBe(key);
    expect(hasVaultKey(vaultPath, 'deepseek-official')).toBe(true);
    expect(inspectVault(vaultPath).providers.find((p) => p.providerId === 'deepseek-official')).toMatchObject({
      state: 'loaded',
      source: 'keychain',
      mask: maskKey(key),
    });
  });

  it('兼容旧平铺格式（无 version / 无 identity）', () => {
    const cipher = Buffer.from(`${state.secret}|sk-legacy-123456`, 'utf8').toString('base64');
    writeFileSync(vaultPath, JSON.stringify({ 'opencode-go': cipher }), 'utf8');
    expect(readVaultKey(vaultPath, 'opencode-go')).toBe('sk-legacy-123456');
    // 写入新条目不破坏旧条目，并把文件升级为 v2
    expect(writeVaultKey(vaultPath, 'openrouter', 'sk-new-1234567890').ok).toBe(true);
    expect(readVaultKey(vaultPath, 'opencode-go')).toBe('sk-legacy-123456');
    const raw = JSON.parse(readFileSync(vaultPath, 'utf8')) as { version: number };
    expect(raw.version).toBe(2);
  });

  it('解密失败不再静默：状态为 decrypt-failed，旧条目被保留而不被覆盖', () => {
    const good = writeVaultKey(vaultPath, 'minimax', 'sk-old-1234567890');
    expect(good.ok).toBe(true);
    // 换身份/换机器后主密钥变了
    state.secret = 'keychain-B';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(readVaultKey(vaultPath, 'minimax')).toBeNull();
    const status = inspectVault(vaultPath).providers.find((p) => p.providerId === 'minimax');
    expect(status?.state).toBe('decrypt-failed');
    expect(warn.mock.calls.flat().join(' ')).not.toContain('sk-old-1234567890');

    // 重新保存：覆盖该条并恢复可用，且不出现明文
    const saved = writeVaultKey(vaultPath, 'minimax', 'sk-new-abcdefgh');
    expect(saved.ok).toBe(true);
    expect(readVaultKey(vaultPath, 'minimax')).toBe('sk-new-abcdefgh');
    expect(readFileSync(vaultPath, 'utf8')).not.toContain('sk-new-abcdefgh');
  });

  it('另一应用身份写入的条目明确报 identity-mismatch（dev Electron ↔ 打包鲸屿）', () => {
    expect(writeVaultKey(vaultPath, 'typesafe-jev', 'sk-jevm-12345678').ok).toBe(true);
    state.appName = '鲸屿';
    state.secret = 'keychain-whale';
    expect(readVaultKey(vaultPath, 'typesafe-jev')).toBeNull();
    const status = inspectVault(vaultPath).providers.find((p) => p.providerId === 'typesafe-jev');
    expect(status).toMatchObject({ state: 'identity-mismatch', savedBy: 'Electron' });
  });

  it('错误密钥解出乱码（不抛错）也判定为解密失败，绝不把乱码当 Key', () => {
    state.throwOnWrongSecret = false;
    const cipher = Buffer.from('keychain-A|sk-garbage-test', 'utf8').toString('base64');
    writeFileSync(vaultPath, JSON.stringify({ openrouter: cipher }), 'utf8');
    state.secret = 'keychain-B';
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(readVaultKey(vaultPath, 'openrouter')).toBeNull();
    expect(inspectVault(vaultPath).providers[0]?.state).toBe('decrypt-failed');
  });

  it('系统加密不可用时：拒绝写入，读取报 encryption-unavailable', () => {
    state.encryptionAvailable = false;
    const written = writeVaultKey(vaultPath, 'deepseek-official', 'sk-no-encryption');
    expect(written.ok).toBe(false);
    expect(written.error).toContain('系统加密服务不可用');
    expect(existsSync(vaultPath)).toBe(false);
    expect(inspectVault(vaultPath, ['deepseek-official']).providers[0]?.state).toBe('encryption-unavailable');
  });

  it('钥匙串拒绝加密（encryptString 抛错）时如实失败，不写文件、不回落明文', () => {
    state.throwOnEncrypt = true;
    const written = writeVaultKey(vaultPath, 'deepseek-official', 'sk-denied-1234567890');
    expect(written.ok).toBe(false);
    expect(written.error).toContain('系统加密失败');
    expect(existsSync(vaultPath)).toBe(false);
  });
});

describe('mock keychain 隔离', () => {
  it('mock keychain 使用独立文件，且拒绝写正常 provider-vault.json', () => {
    expect(isMockKeychainLaunch()).toBe(false);
    expect(vaultFileName()).toBe('provider-vault.json');
    expect(vaultFileName({ mockKeychain: true })).toBe('provider-vault.mock-keychain.json');
    expect(resolveVaultPath(dir, { mockKeychain: true })).toBe(join(dir, 'provider-vault.mock-keychain.json'));
    expect(resolveVaultPath(dir)).toBe(vaultPath);

    // 正常凭据库先有一条好数据
    expect(writeVaultKey(vaultPath, 'deepseek-official', 'sk-good-real-123456').ok).toBe(true);
    const before = readFileSync(vaultPath, 'utf8');

    state.mockKeychain = true;
    state.secret = 'mock-secret';
    expect(isMockKeychainLaunch()).toBe(true);
    const rejected = writeVaultKey(vaultPath, 'deepseek-official', 'sk-mock-should-not-land');
    expect(rejected.ok).toBe(false);
    expect(rejected.error).toContain('必须隔离');
    // 兜底：正常文件一个字节都没动
    expect(readFileSync(vaultPath, 'utf8')).toBe(before);

    // 写入 mock 隔离文件是允许的
    const mockPath = resolveVaultPath(dir, { mockKeychain: true });
    expect(writeVaultKey(mockPath, 'deepseek-official', 'sk-mock-only-123456').ok).toBe(true);
    expect(readVaultKey(mockPath, 'deepseek-official')).toBe('sk-mock-only-123456');
    // 正常文件仍然不可被 mock 密钥解密（证明两套密钥不通用）
    state.secret = 'keychain-A';
    expect(readVaultKey(vaultPath, 'deepseek-official')).toBe('sk-good-real-123456');
  });

  it('mock 启动时正常凭据库里的真实 Key 会被如实报为不可用', () => {
    expect(writeVaultKey(vaultPath, 'minimax', 'sk-real-1234567890').ok).toBe(true);
    state.mockKeychain = true;
    state.secret = 'mock-secret';
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const report = logVaultStartup(vaultPath);
    expect(report.backend).toBe('mock-keychain');
    expect(report.vaultFile).toBe('provider-vault.json');
    expect(report.providers.find((p) => p.providerId === 'minimax')?.state).toBe('decrypt-failed');
  });
});

describe('开发态环境变量兜底', () => {
  it('无 vault 条目时从 WHALE_PROVIDER_KEY_<PRESET> 读取，不落盘、状态标记 source=env', () => {
    process.env.WHALE_PROVIDER_KEY_DEEPSEEK_OFFICIAL = 'sk-env-fallback-1234';
    expect(providerKeyEnvVar('deepseek-official')).toBe('WHALE_PROVIDER_KEY_DEEPSEEK_OFFICIAL');

    expect(readVaultKey(vaultPath, 'deepseek-official')).toBe('sk-env-fallback-1234');
    const status = inspectVault(vaultPath, ['deepseek-official']).providers[0];
    expect(status).toMatchObject({ state: 'env', source: 'env' });
    // 环境变量不写文件
    expect(existsSync(vaultPath)).toBe(false);
  });

  it('vault 解密失败时环境变量可兜底救急', () => {
    expect(writeVaultKey(vaultPath, 'deepseek-official', 'sk-old-1234567890').ok).toBe(true);
    state.secret = 'keychain-B';
    process.env.WHALE_PROVIDER_KEY_DEEPSEEK_OFFICIAL = 'sk-env-rescue-1234';
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(readVaultKey(vaultPath, 'deepseek-official')).toBe('sk-env-rescue-1234');
  });

  it('打包态禁用环境变量兜底（发行版不允许绕过凭据库的隐式 Key）', () => {
    state.isPackaged = true;
    process.env.WHALE_PROVIDER_KEY_DEEPSEEK_OFFICIAL = 'sk-env-should-be-ignored';
    expect(readVaultKey(vaultPath, 'deepseek-official')).toBeNull();
    expect(inspectVault(vaultPath, ['deepseek-official']).providers[0]?.state).toBe('missing');
  });
});

describe('日志零明文', () => {
  it('启动状态与解密失败告警都不含 Key 本体', () => {
    const realKey = 'sk-very-secret-real-9876543210';
    const envKey = 'sk-very-secret-env-1234567890';
    expect(writeVaultKey(vaultPath, 'deepseek-official', realKey).ok).toBe(true);
    process.env.WHALE_PROVIDER_KEY_DEEPSEEK_OFFICIAL = envKey;
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const report = logVaultStartup(vaultPath);

    // 解密失败路径也走一遍
    state.secret = 'keychain-B';
    expect(readVaultKey(vaultPath, 'deepseek-official')).toBe(envKey);

    const output = [...log.mock.calls, ...warn.mock.calls].flat().join(' ');
    expect(output).not.toContain(realKey);
    expect(output).not.toContain(envKey);
    expect(output).not.toContain(realKey.slice(0, 8));
    expect(report.providers.some((p) => p.mask !== undefined)).toBe(true);
  });
});
