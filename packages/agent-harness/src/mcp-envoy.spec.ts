import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EnvoyKnowledgeSource, findKnowledgeExecutable } from './mcp-envoy';
import { WhaleMcpClient } from './mcp-bridge';

const fixture = fileURLToPath(new URL('../../../tools/mock-harness/fixtures/knowledge-slice/envoy-fixture.cjs', import.meta.url));
const dirs: string[] = [];
const sources: EnvoyKnowledgeSource[] = [];
afterEach(() => { sources.forEach((source) => source.close()); sources.length = 0; dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })); vi.unstubAllEnvs(); });
function setup(mode = 'ready') {
  const dir = mkdtempSync(join(tmpdir(), 'envoy-mcp-')); dirs.push(dir);
  const root = join(dir, 'authorized'); mkdirSync(root);
  const file = join(root, 'spring.md'); writeFileSync(file, '春季给作物浇水。\n');
  const audit = vi.fn();
  const stateDir = join(dir, 'state');
  const source = new EnvoyKnowledgeSource({ materialsRoot: root, stateDir, command: process.execPath, uvCommand: process.execPath, args: [fixture, mode], timeoutMs: mode === 'hang' ? 100 : 2_000, audit });
  sources.push(source);
  return { dir, root, file, source, audit, stateDir };
}

describe('04C：独立 Envoy MCP 只读边界', () => {
  it('探测缺失的 envoy/uv/材料目录，明确 unavailable，不安装、不生成材料', async () => {
    expect(findKnowledgeExecutable('not-installed', '')).toBeNull();
    expect(findKnowledgeExecutable('not-installed', '/missing')).toBeNull();
    expect(findKnowledgeExecutable('node', dirname(process.execPath))).toBeTruthy();
    const source = new EnvoyKnowledgeSource({ materialsRoot: '/absent-owner-materials', stateDir: '/unused', command: '', uvCommand: '' });
    expect(await source.probe()).toMatchObject({ state: 'unavailable', readOnly: true });
    expect((await source.probe()).reason).toContain('未找到 envoy；未找到 uv；owner 授权材料目录不存在');
    source.close();
    expect((await source.probe()).reason).toContain('已关闭');
    const disabled = new EnvoyKnowledgeSource({ materialsRoot: '/absent', stateDir: '/unused', enabled: false });
    expect((await disabled.probe()).reason).toContain('停用');
    disabled.close();
  });
  it('真实子进程握手、并发探测共用同一进程，环境只含白名单，读取不改材料', async () => {
    vi.stubEnv('FUSION_TEST_SECRET', 'private-value');
    const { source, file, stateDir, audit } = setup();
    const [a, b] = await Promise.all([source.probe(), source.probe()]);
    expect(a.version).toBe('fixture-1'); expect(b).toEqual(a);
    expect(source.snapshot().state).toBe('available');
    const original = readFileSync(file, 'utf8');
    const response = await source.read(file);
    expect(response.payload.blocks[0]!.content.text).toBe(original.trim());
    expect(response.file.bytes.toString()).toBe(original);
    expect(response.version).toBe('fixture-1');
    expect(readFileSync(file, 'utf8')).toBe(original);
    const env = JSON.parse(readFileSync(join(stateDir, 'fixture-env.json'), 'utf8')) as { keys: string[]; pid: number };
    expect(env.keys).not.toContain('FUSION_TEST_SECRET');
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ allowed: true, detail: 'READ:mat-fixture-spring' }));
    source.close();
    await vi.waitFor(() => expect(() => process.kill(env.pid, 0)).toThrow(), { timeout: 2_000 });
  });
  it('白名单拒绝写/评论/发布工具并审计；拒绝目录外文件及软链接逃逸', async () => {
    const { source, file, dir, root, audit } = setup();
    for (const tool of ['envoy_knowledge', 'comment', 'publish', 'delete']) await expect(source.read(file, tool)).rejects.toThrow('白名单拒绝');
    expect(audit).toHaveBeenCalledTimes(4);
    expect(audit.mock.calls.every(([entry]) => entry.allowed === false)).toBe(true);
    expect(() => source.authorizedFile('https://example.test')).toThrow('绝对');
    const outside = join(dir, 'outside.md'); writeFileSync(outside, '外部');
    expect(() => source.authorizedFile(outside)).toThrow('授权目录');
    symlinkSync(outside, join(root, 'escape.md'));
    expect(() => source.authorizedFile(join(root, 'escape.md'))).toThrow('授权目录');
    mkdirSync(join(root, 'nested'));
    expect(() => source.authorizedFile(join(root, 'nested'))).toThrow('普通文件');
    writeFileSync(join(root, 'large.md'), 'x'.repeat(2_000_001));
    expect(() => source.authorizedFile(join(root, 'large.md'))).toThrow('2 MB');
  });
  it.each(['hang', 'exit', 'no-tool'])('启动异常 %s 明确降级并回收进程', async (mode) => {
    const { source } = setup(mode);
    expect((await source.probe()).state).toBe('unavailable');
    expect(source.snapshot().reason).toContain('外部知识源不可用');
  });
  it('可执行文件损坏触发 error，不产生未捕获进程异常', async () => {
    const { root, stateDir } = setup();
    const source = new EnvoyKnowledgeSource({ materialsRoot: root, stateDir, command: '/missing-envoy', uvCommand: process.execPath, timeoutMs: 100 });
    sources.push(source);
    expect((await source.probe()).state).toBe('unavailable');
  });
  it('真实协议拒绝 blocked 结果，并保留原因而非伪造证据', async () => {
    const { source, file, audit } = setup('blocked');
    await expect(source.read(file)).rejects.toThrow('不支持本地 Markdown');
    expect(source.snapshot().state).toBe('unavailable');
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ detail: 'READ_FAILED', allowed: false }));
  });
  it('未注入命令且 PATH 为空时逐项报告缺失，不安装任何依赖', async () => {
    const previous = process.env.PATH;
    delete process.env.PATH;
    try {
      const dir = mkdtempSync(join(tmpdir(), 'envoy-mcp-')); dirs.push(dir);
      const root = join(dir, 'authorized'); mkdirSync(root);
      const source = new EnvoyKnowledgeSource({ materialsRoot: root, stateDir: join(dir, 'state') });
      sources.push(source);
      const status = await source.probe();
      expect(status.state).toBe('unavailable');
      expect(status.reason).toContain('未找到 envoy');
      expect(status.reason).toContain('未找到 uv');
    } finally {
      if (previous !== undefined) process.env.PATH = previous;
    }
  });
  it('启动过程中关闭知识源，晚到结果不复活连接', async () => {
    const { source } = setup('slow-tools');
    const pending = source.probe();
    await new Promise((resolve) => setTimeout(resolve, 50));
    source.close();
    expect((await pending).state).toBe('unavailable');
  });
  it('探测不可用后读取直接拒绝，不返回空结构', async () => {
    const { source, file } = setup();
    source.close();
    await expect(source.read(file)).rejects.toThrow('已关闭');
  });
  it('Envoy 返回 isError 时判失败并降级，不伪造材料', async () => {
    const { source, file } = setup('is-error');
    await expect(source.read(file)).rejects.toThrow('未返回可校验的结构化材料');
    expect(source.snapshot().state).toBe('unavailable');
  });
  it('Envoy 未声明版本时记录 unknown，不猜版本', async () => {
    const { source, file } = setup('no-version');
    expect(await source.probe()).toMatchObject({ state: 'available', version: 'unknown' });
    expect((await source.read(file)).version).toBe('unknown');
  });
  it('未指定 args 时走既定 mcp 子命令，启动失败即降级', async () => {
    const { root, stateDir } = setup();
    const source = new EnvoyKnowledgeSource({ materialsRoot: root, stateDir, command: process.execPath, uvCommand: process.execPath, timeoutMs: 500 });
    sources.push(source);
    expect((await source.probe()).state).toBe('unavailable');
  });
  it('外部拒绝不是 Error 时也降级为可读原因', async () => {
    const spy = vi.spyOn(WhaleMcpClient.prototype, 'listTools').mockRejectedValue('非 Error 拒绝');
    try {
      const { source } = setup();
      const status = await source.probe();
      expect(status.state).toBe('unavailable');
      expect(status.reason).toContain('非 Error 拒绝');
    } finally { spy.mockRestore(); }
  });
  it('读取阶段非 Error 拒绝也保留原因并回收进程', async () => {
    const { source, file } = setup();
    await source.probe();
    const spy = vi.spyOn(WhaleMcpClient.prototype, 'callTool').mockRejectedValue('读取被拒');
    try { await expect(source.read(file)).rejects.toBe('读取被拒'); } finally { spy.mockRestore(); }
    expect(source.snapshot().state).toBe('unavailable');
  });
});
