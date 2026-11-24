/** Codex CLI 生图后端（T-M6-61）：探测优先级、参数数组、超时/脱敏、产出校验（execFile 全注入零外网）。 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildCodexArgs,
  detectCodexCli,
  redactCodexError,
  runCodexImage,
  sniffImageMime,
  type CodexCliDetection,
  type ExecFileLike,
} from './codex-image-backend';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'codex-img-'));
  dirs.push(dir);
  return dir;
}
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function detection(overrides: Partial<CodexCliDetection> = {}): CodexCliDetection {
  return {
    available: true,
    backend: 'codex-imagegen',
    binary: '/usr/local/bin/codex-imagegen',
    loggedIn: true,
    codexHome: '/home/u/.codex',
    installHint: 'npm install -g codex-imagegen-cli',
    loginHint: 'codex login',
    ...overrides,
  };
}

/** 记录调用参数并可选地写出 PNG 的 execFile 替身。 */
function fakeExec(options: { writePng?: boolean; stderr?: string; fail?: boolean; hang?: boolean } = {}) {
  const calls: Array<{ file: string; args: string[] }> = [];
  const impl: ExecFileLike = (file, args, _opts, callback) => {
    calls.push({ file, args });
    if (options.hang === true) return; // 永不回调 → 触发超时
    const outIndex = args.indexOf('--out');
    const execOut = args[0] === 'exec' ? /输出路径：(\S+)/.exec(args[1] ?? '')?.[1] : undefined;
    const target = outIndex >= 0 ? args[outIndex + 1] : execOut;
    if (options.writePng !== false && target !== undefined) {
      writeFileSync(target, PNG);
    }
    if (options.fail === true) callback(new Error('exit 1'), '', options.stderr ?? '');
    else callback(null, 'ok', options.stderr ?? '');
  };
  return { calls, impl };
}

describe('detectCodexCli', () => {
  it('优先级：codex-imagegen > codex > 缺失；PATH 之外补常见目录', () => {
    const home = temp();
    const both = detectCodexCli({
      homeDir: home,
      pathEnv: '/usr/bin:/bin',
      exists: (path) => path === '/usr/bin/codex' || path === join(home, '.local/bin/codex-imagegen') || path.endsWith('auth.json'),
    });
    expect(both).toMatchObject({ available: true, backend: 'codex-imagegen', binary: join(home, '.local/bin/codex-imagegen'), loggedIn: true });

    const onlyCodex = detectCodexCli({ homeDir: home, pathEnv: '/usr/bin', exists: (path) => path === '/usr/bin/codex' || path.endsWith('auth.json') });
    expect(onlyCodex).toMatchObject({ available: true, backend: 'codex-exec', binary: '/usr/bin/codex', loggedIn: true });

    const none = detectCodexCli({ homeDir: home, pathEnv: '/usr/bin', exists: () => false });
    expect(none).toMatchObject({ available: false, backend: null, binary: null, loggedIn: false });
  });

  it('auth.json 只检查存在性（$CODEX_HOME 优先），绝不读取内容', () => {
    const home = temp();
    const found = detectCodexCli({ homeDir: home, codexHome: '/custom/codex', pathEnv: '', exists: (path) => path === '/custom/codex/auth.json' });
    expect(found.loggedIn).toBe(true);
    expect(found.codexHome).toBe('/custom/codex');
  });
});

describe('buildCodexArgs', () => {
  it('generate 无参考图 / edit 有参考图，均为参数数组', () => {
    expect(buildCodexArgs({ backend: 'codex-imagegen', prompt: '画鲸鱼', size: '1024x1024', outPng: '/tmp/a.png' }))
      .toEqual(['generate', '--prompt', '画鲸鱼', '--size', '1024x1024', '--background', 'opaque', '--out', '/tmp/a.png']);
    expect(buildCodexArgs({ backend: 'codex-imagegen', prompt: '画鲸鱼', size: '1024x1024', refPath: '/tmp/ref.png', outPng: '/tmp/a.png' }))
      .toEqual(['edit', '--image', '/tmp/ref.png', '--prompt', '画鲸鱼', '--size', '1024x1024', '--background', 'opaque', '--out', '/tmp/a.png']);
  });

  it('codex exec 兜底：指令包含输出路径与「只写文件」要求', () => {
    const args = buildCodexArgs({ backend: 'codex-exec', prompt: '画鲸鱼', size: '1024x1024', outPng: '/tmp/a.png' });
    expect(args[0]).toBe('exec');
    expect(args[1]).toContain('/tmp/a.png');
    expect(args[1]).toContain('只写入该文件');
  });
});

describe('runCodexImage', () => {
  it('成功：写出 PNG → 返回 buffer 与 mime', async () => {
    const dir = temp();
    const out = join(dir, 'out.png');
    const { calls, impl } = fakeExec();
    const result = await runCodexImage({ detection: detection(), prompt: 'p', size: '1024x1024', outPng: out, execFileImpl: impl });
    expect(result.ok).toBe(true);
    expect(result.mimeType).toBe('image/png');
    expect(result.buffer?.subarray(0, 4)).toEqual(PNG.subarray(0, 4));
    expect(calls[0]?.file).toBe('/usr/local/bin/codex-imagegen');
    expect(calls[0]?.args.slice(0, 2)).toEqual(['generate', '--prompt']);
  });

  it('未安装 / 未登录：如实报错且不发进程', async () => {
    const { calls, impl } = fakeExec();
    const missing = await runCodexImage({ detection: detection({ available: false, backend: null, binary: null }), prompt: 'p', size: 's', outPng: '/tmp/x.png', execFileImpl: impl });
    expect(missing.ok).toBe(false);
    expect(missing.error).toContain('codex-imagegen-cli');
    const loggedOut = await runCodexImage({ detection: detection({ loggedIn: false }), prompt: 'p', size: 's', outPng: '/tmp/x.png', execFileImpl: impl });
    expect(loggedOut.ok).toBe(false);
    expect(loggedOut.error).toContain('codex login');
    expect(calls).toHaveLength(0);
  });

  it('CLI 失败：stderr 脱敏（sk-*/Bearer/token 不外泄）', async () => {
    const { impl } = fakeExec({ fail: true, stderr: '401 unauthorized sk-abcdef123456 Bearer tok_abcdef123456 {"access_token":"secret-value"}' });
    const result = await runCodexImage({ detection: detection(), prompt: 'p', size: 's', outPng: join(temp(), 'o.png'), execFileImpl: impl });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('401');
    expect(result.error).not.toContain('sk-abcdef123456');
    expect(result.error).not.toContain('tok_abcdef123456');
    expect(result.error).not.toContain('secret-value');
  });

  it('超时：如实报超时而非挂死', async () => {
    const { impl } = fakeExec({ hang: true });
    const result = await runCodexImage({ detection: detection(), prompt: 'p', size: 's', outPng: join(temp(), 'o.png'), execFileImpl: impl, timeoutMs: 1_000 });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('超时');
  }, 5_000);

  it('退出后无文件 / 空文件 / 非图片字节流：分别如实报错', async () => {
    const dir = temp();
    const noFile = await runCodexImage({ detection: detection(), prompt: 'p', size: 's', outPng: join(dir, 'none.png'), execFileImpl: fakeExec({ writePng: false }).impl });
    expect(noFile.error).toContain('没有产出图片文件');

    const emptyPath = join(dir, 'empty.png');
    writeFileSync(emptyPath, '');
    const empty = await runCodexImage({
      detection: detection(), prompt: 'p', size: 's', outPng: emptyPath,
      execFileImpl: fakeExec({ writePng: false }).impl,
    });
    expect(empty.error).toContain('为空');

    const badPath = join(dir, 'bad.png');
    writeFileSync(badPath, 'not an image');
    const bad = await runCodexImage({
      detection: detection(), prompt: 'p', size: 's', outPng: badPath,
      execFileImpl: fakeExec({ writePng: false }).impl,
    });
    expect(bad.error).toContain('不是合法 PNG/WebP/JPEG');
  });

  it('codex exec 兜底模式同样校验产出文件', async () => {
    const dir = temp();
    const out = join(dir, 'exec.png');
    const { calls, impl } = fakeExec();
    const result = await runCodexImage({ detection: detection({ backend: 'codex-exec', binary: '/usr/bin/codex' }), prompt: 'p', size: 's', outPng: out, execFileImpl: impl });
    expect(result.ok).toBe(true);
    expect(calls[0]?.args[0]).toBe('exec');
    expect(calls[0]?.args[1]).toContain(out);
  });
});

describe('sniffImageMime / redactCodexError', () => {
  it('PNG/WebP/JPEG 魔数识别；未知返回 null', () => {
    expect(sniffImageMime(PNG)).toBe('image/png');
    expect(sniffImageMime(Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP'), Buffer.alloc(4)]))).toBe('image/webp');
    expect(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImageMime(Buffer.from('hello'))).toBeNull();
  });

  it('脱敏覆盖 JWT 形态长 token', () => {
    const jwt = 'aaaaaaaabbbbccccddddeeee.ffffgggghhhhiiiijjjjkkkk.llllmmmmnnnn';
    const out = redactCodexError(`token=${jwt}`);
    expect(out).not.toContain(jwt);
    expect(out).toContain('••••');
  });
});
