/**
 * V2-P2-02 门禁测试：双向 MCP Client/Server（HTTP + STDIO）、受控脱敏与审计、多 Harness 隔离执行。
 */
import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import {
  AGENT_PROVIDER_PRESETS,
  executeHarnessTask,
  redactSecrets,
  WhaleMcpClient,
  WhaleMcpServer,
} from './index';

describe('WhaleMcpServer 受控暴露、鉴权、脱敏与审计', () => {
  it('拒绝无/错 token 或越权 scope，对 modelConfig 递归脱敏并记录审计', async () => {
    const tokens = new Map<string, string[]>([
      ['tok-reader', ['character.read', 'model.read']],
      ['tok-full', ['*']],
    ]);
    const server = new WhaleMcpServer({
      authTokens: tokens,
      handlers: {
        getCharacterState: () => ({ characterId: 'char_xiaojing', mood: 'happy' }),
        queryMemory: (q) => [{ q, text: '喜欢钓鱼' }],
        requestPetAction: (action, durationMs) => ({ action, durationMs }),
        getGameState: () => ({ season: '春', day: 5 }),
        getModelConfig: () => ({ provider: 'deepseek', apiKey: 'sk-secret-123', nested: { token: 'abc' } }),
        getTaskStatus: () => ({ running: false }),
      },
    });

    const initRes = await server.handleMessage({ id: 1, method: 'initialize' });
    expect((initRes.result as { serverInfo: { name: string } }).serverInfo.name).toBe('whale-isle-mcp');

    const unauth = await server.handleMessage({ id: 2, method: 'tools/list' });
    expect(unauth.error?.code).toBe(-32001);

    const forbidden = await server.handleMessage(
      { id: 3, method: 'tools/call', params: { name: 'whale_pet_action', arguments: { action: 'wave' } } },
      { token: 'tok-reader' },
    );
    expect(forbidden.error?.code).toBe(-32003);

    const toolsList = await server.handleMessage({ id: 4, method: 'tools/list' }, { token: 'tok-reader' });
    expect((toolsList.result as { tools: unknown[] }).tools).toHaveLength(6);

    const cfgCall = await server.handleMessage(
      { id: 5, method: 'tools/call', params: { name: 'whale_model_config', arguments: {} } },
      { token: 'tok-reader' },
    );
    const cfgText = (cfgCall.result as { content: Array<{ text: string }> }).content[0]!.text;
    expect(cfgText).not.toContain('sk-secret-123');
    expect(cfgText).toContain('[REDACTED]');

    expect((await server.handleMessage({ id: 6, method: 'tools/call', params: { name: 'whale_character_state' } }, { token: 'tok-full' })).error).toBeUndefined();
    expect((await server.handleMessage({ id: 7, method: 'tools/call', params: { name: 'whale_memory_query', arguments: { query: '钓鱼' } } }, { token: 'tok-full' })).error).toBeUndefined();
    expect((await server.handleMessage({ id: 8, method: 'tools/call', params: { name: 'whale_pet_action', arguments: { action: 'dance', durationMs: 2000 } } }, { token: 'tok-full' })).error).toBeUndefined();
    expect((await server.handleMessage({ id: 9, method: 'tools/call', params: { name: 'whale_game_state' } }, { token: 'tok-full' })).error).toBeUndefined();
    expect((await server.handleMessage({ id: 10, method: 'tools/call', params: { name: 'whale_task_status' } }, { token: 'tok-full' })).error).toBeUndefined();

    expect((await server.handleMessage({ id: 11, method: 'resources/list' }, { token: 'tok-reader' })).error).toBeUndefined();
    expect((await server.handleMessage({ id: 12, method: 'resources/read', params: { uri: 'whale://character/state' } }, { token: 'tok-reader' })).error).toBeUndefined();
    expect((await server.handleMessage({ id: 13, method: 'resources/read', params: { uri: 'whale://unknown' } }, { token: 'tok-reader' })).error?.code).toBe(-32004);
    expect((await server.handleMessage({ id: 14, method: 'tools/call', params: { name: 'unknown' } }, { token: 'tok-full' })).error?.code).toBe(-32601);
    expect((await server.handleMessage({ id: 15, method: 'unknown/method' }, { token: 'tok-full' })).error?.code).toBe(-32601);
    expect((await server.handleMessage({ id: 16, method: 'resources/list' })).error?.code).toBe(-32001);
    expect((await server.handleMessage({ id: 17, method: 'resources/read', params: { uri: 'whale://character/state' } })).error?.code).toBe(-32001);
    // 字符串/非对象 arguments 安全回退 + 空 handlers 默认不抛
    const bareServer = new WhaleMcpServer({ authTokens: tokens, handlers: {} });
    expect((await bareServer.handleMessage({ id: 18, method: 'tools/call', params: { name: 'whale_character_state', arguments: 'bad' as unknown as Record<string, unknown> } }, { token: 'tok-full' })).error).toBeUndefined();

    expect(redactSecrets({ token: 'x', ok: [1, { password: 'p' }] })).toEqual({ token: '[REDACTED]', ok: [1, { password: '[REDACTED]' }] });
    expect(server.auditLog().length).toBeGreaterThanOrEqual(8);
  });
});

describe('WhaleMcpClient 双向传输与多 Harness 隔离执行', () => {
  it('Streamable HTTP 客户端完整调用 tools / resources / prompts 及错误处理', async () => {
    const fetchMock: typeof fetch = async (_url, init) => {
      const rpc = JSON.parse(String(init?.body ?? '{}')) as { id: number; method: string; params?: Record<string, unknown> };
      if (rpc.method === 'fail/http') return new Response('err', { status: 502 });
      if (rpc.method === 'fail/rpc') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, error: { code: -32000, message: 'boom' } }), { status: 200 });
      }
      const map: Record<string, unknown> = {
        initialize: { protocolVersion: '2025-03-26', serverInfo: { name: 'mock', version: '1.0' } },
        'tools/list': { tools: [{ name: 'wiki_search', description: 'Search' }] },
        'tools/call': { ok: true, params: rpc.params },
        'resources/list': { resources: [{ uri: 'doc://1', name: 'Doc' }] },
        'resources/read': { contents: [{ uri: 'doc://1', text: 'hello' }] },
        'prompts/list': { prompts: [{ name: 'plan' }] },
        'prompts/get': { messages: [] },
      };
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: map[rpc.method] ?? {} }), { status: 200 });
    };

    const client = new WhaleMcpClient({
      id: 'ext',
      label: 'Ext HTTP',
      transport: 'streamable-http',
      endpoint: 'http://127.0.0.1:9999/mcp',
      authHeader: 'Bearer x',
      args: [],
      timeoutMs: 5000,
    }, { fetchImpl: fetchMock });

    expect((await client.initialize()).protocolVersion).toBe('2025-03-26');
    expect((await client.listTools())[0]?.name).toBe('wiki_search');
    expect(await client.callTool('wiki_search', { q: 'fish' })).toMatchObject({ ok: true });
    expect((await client.listResources())[0]?.uri).toBe('doc://1');
    expect(await client.readResource('doc://1')).toMatchObject({ contents: [{ text: 'hello' }] });
    expect((await client.listPrompts())[0]?.name).toBe('plan');
    expect(await client.getPrompt('plan', { goal: 'mine' })).toEqual({ messages: [] });
    await expect(client.request('fail/http')).rejects.toThrow('MCP HTTP 502');
    await expect(client.request('fail/rpc')).rejects.toThrow('-32000: boom');
  });

  it('STDIO MCP 客户端往返与关闭 + 缺参防御', async () => {
    const server = new WhaleMcpServer({
      authTokens: new Map([['dev', ['*']]]),
      handlers: { getCharacterState: () => ({ id: 'char_xiaojing' }) },
    });

    const spawnMock = (() => {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const proc = new EventEmitter() as EventEmitter & {
        stdin: PassThrough;
        stdout: PassThrough;
        stderr: PassThrough;
        exitCode: number | null;
        kill: () => void;
      };
      proc.stdin = stdin;
      proc.stdout = stdout;
      proc.stderr = new PassThrough();
      proc.exitCode = null;
      proc.kill = () => {
        proc.exitCode = 0;
        proc.emit('exit', 0);
      };
      let buf = '';
      stdin.on('data', (chunk) => {
        buf += String(chunk);
        const idx = buf.indexOf('\n');
        if (idx >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          const req = JSON.parse(line) as { id: number; method: string; params?: Record<string, unknown> };
          if (req.method === 'noise') {
            stdout.write('NOT_JSON\n\n');
            return;
          }
          void server.handleMessage(req, req.params?.['unauth'] ? undefined : { token: 'dev' }).then((resp) => {
            stdout.write(`${JSON.stringify(resp)}\n`);
          });
        }
      });
      return proc;
    }) as unknown as typeof import('node:child_process').spawn;

    const client = new WhaleMcpClient({
      id: 'local-stdio',
      label: 'Local STDIO',
      transport: 'stdio',
      command: 'mock-mcp',
      args: [],
      timeoutMs: 80,
    }, { spawnImpl: spawnMock });

    expect((await client.initialize()).serverInfo?.name).toBe('whale-isle-mcp');
    expect(await client.listTools()).toHaveLength(6);
    await expect(client.request('tools/list', { unauth: true })).rejects.toThrow('-32001');
    await expect(client.request('noise')).rejects.toThrow('MCP stdio timeout');
    client.close();

    const missingHttp = new WhaleMcpClient({ id: 'bad1', label: 'bad', transport: 'streamable-http', args: [], timeoutMs: 100 });
    await expect(missingHttp.initialize()).rejects.toThrow('缺少 HTTP endpoint');
    const missingCmd = new WhaleMcpClient({ id: 'bad2', label: 'bad', transport: 'stdio', args: [], timeoutMs: 100 });
    await expect(missingCmd.initialize()).rejects.toThrow('缺少 stdio command');
  });

  it('executeHarnessTask 隔离环境变量、支持成功/取消/超时；Preset 覆盖主流多 Harness', async () => {
    expect(AGENT_PROVIDER_PRESETS.map((p) => p.id)).toEqual(
      expect.arrayContaining(['gemini-cli', 'dsh-acp', 'claude-acp', 'codex-cli', 'opencode-cli', 'pi-cli', 'openhands-cli']),
    );

    const missingCmd = await executeHarnessTask({
      preset: { id: 'none', command: null, args: [] },
      prompt: 'hi',
      cwd: process.cwd(),
    });
    expect(missingCmd.ok).toBe(false);

    const acPre = new AbortController();
    acPre.abort();
    const aborted = await executeHarnessTask({
      preset: AGENT_PROVIDER_PRESETS[3]!,
      prompt: 'hi',
      cwd: process.cwd(),
      signal: acPre.signal,
    });
    expect(aborted.cancelled).toBe(true);

    let capturedEnv: Record<string, string | undefined> | undefined;
    const prevSecret = process.env['WHALE_SENSITIVE_TEST'];
    process.env['WHALE_SENSITIVE_TEST'] = 'do-not-leak';
    try {
      const fakeSpawn = ((_cmd: string, _args: string[], opts: { env?: Record<string, string | undefined> }) => {
        capturedEnv = opts?.env;
        const p = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: () => void };
        p.stdout = new PassThrough();
        p.stderr = new PassThrough();
        p.kill = () => {};
        queueMicrotask(() => { p.emit('close', 0); });
        return p;
      }) as unknown as typeof import('node:child_process').spawn;
      const okRes = await executeHarnessTask({
        preset: { id: 'node-test', command: process.execPath, args: [] },
        prompt: 'unused',
        extraArgs: [],
        cwd: process.cwd(),
        envAllowlist: { CUSTOM_SAFE: '1' },
        spawnImpl: fakeSpawn,
      });
      expect(okRes.ok).toBe(true);
      expect(capturedEnv?.['WHALE_SENSITIVE_TEST']).toBeUndefined();
      expect(capturedEnv?.['CUSTOM_SAFE']).toBe('1');

      // 真实 node 子进程执行级验证
      const realOk = await executeHarnessTask({
        preset: { id: 'node-real', command: process.execPath, args: ['-e', 'console.log(process.env.WHALE_SENSITIVE_TEST || "CLEAN")'] },
        prompt: 'x',
        extraArgs: [],
        cwd: process.cwd(),
      });
      expect(realOk.ok).toBe(true);
      expect(realOk.stdout.trim()).toBe('CLEAN');

      const realTimeout = await executeHarnessTask({
        preset: { id: 'node-slow', command: process.execPath, args: ['-e', 'console.error("err-line"); setInterval(() => {}, 1000)'] },
        prompt: 'x',
        extraArgs: [],
        cwd: process.cwd(),
        timeoutMs: 80,
      });
      expect(realTimeout.ok).toBe(false);
      expect(realTimeout.timedOut).toBe(true);

      // 运行中触发 AbortSignal 取消 + 不存在命令 error 事件
      const acMid = new AbortController();
      setTimeout(() => acMid.abort(), 50);
      const midAborted = await executeHarnessTask({
        preset: { id: 'node-abort', command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] },
        prompt: 'x',
        extraArgs: [],
        cwd: process.cwd(),
        signal: acMid.signal,
        timeoutMs: 5000,
      });
      expect(midAborted.cancelled).toBe(true);

      const spawnErr = await executeHarnessTask({
        preset: { id: 'bad-cmd', command: '/nonexistent-whale-bin-12345', args: [] },
        prompt: 'x',
        cwd: process.cwd(),
      });
      expect(spawnErr.ok).toBe(false);
    } finally {
      if (prevSecret === undefined) delete process.env['WHALE_SENSITIVE_TEST'];
      else process.env['WHALE_SENSITIVE_TEST'] = prevSecret;
    }
  });
});
