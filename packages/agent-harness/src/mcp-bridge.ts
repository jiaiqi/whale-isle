/**
 * Whale Isle V2 — 双向 MCP Client / 受控 Server 与多 Harness 隔离执行桥（V2-P2-02 / Blueprint 04）
 *
 * - WhaleMcpClient：支持 Streamable HTTP 与 STDIO 双向接入外部 MCP Server（tools / resources / prompts）；
 * - WhaleMcpServer：向外部 Harness 提供受控能力（角色状态、记忆、桌宠动作、游戏状态、脱敏模型配置、任务状态）+ 鉴权与审计；
 * - executeHarnessTask：隔离 env 与支持超时/取消的执行级 Harness 适配器。
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import {
  McpAuditEntrySchema,
  type McpAuditEntry,
  type McpPromptDescriptor,
  type McpResourceDescriptor,
  type McpServerConfig,
  type McpToolDescriptor,
} from '@workbench/shared-protocol';
import type { AgentProviderPreset } from './providers';

const SECRET_KEY_RE = /(?:api[-_]?key|secret|token|password|credential|private[-_]?key)/i;

export function redactSecrets<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => redactSecrets(v)) as unknown as T;
  if (typeof value !== 'object' || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEY_RE.test(k) ? '[REDACTED]' : redactSecrets(v);
  }
  return out as T;
}

export interface JsonRpcRequest {
  jsonrpc?: '2.0';
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface WhaleMcpClientDeps {
  fetchImpl?: typeof fetch;
  spawnImpl?: typeof spawn;
}

/** 双向 MCP 客户端：支持 STDIO 与 Streamable HTTP */
export class WhaleMcpClient {
  private seq = 0;
  private proc: import('node:child_process').ChildProcess | null = null;
  private readonly pending = new Map<number | string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();

  constructor(
    private readonly config: McpServerConfig,
    private readonly deps: WhaleMcpClientDeps = {},
  ) {}

  private nextId(): number {
    this.seq += 1;
    return this.seq;
  }

  private ensureStdio(): import('node:child_process').ChildProcess {
    if (this.proc !== null && this.proc.exitCode === null) return this.proc;
    if (!this.config.command) throw new Error(`MCP Server(${this.config.id}) 缺少 stdio command`);
    const spawnFn = this.deps.spawnImpl ?? spawn;
    const proc = spawnFn(this.config.command, this.config.args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = proc;
    if (proc.stdout !== null) {
      const rl = createInterface({ input: proc.stdout });
      rl.on('line', (line) => {
        if (line.trim() === '') return;
        try {
          const msg = JSON.parse(line) as JsonRpcResponse;
          const waiter = this.pending.get(msg.id);
          if (waiter === undefined) return;
          clearTimeout(waiter.timer);
          this.pending.delete(msg.id);
          if (msg.error !== undefined) waiter.reject(new Error(`${msg.error.code}: ${msg.error.message}`));
          else waiter.resolve(msg.result);
        } catch { /* 非 JSON 行忽略 */ }
      });
    }
    proc.on('exit', (code) => {
      for (const [id, waiter] of this.pending.entries()) {
        clearTimeout(waiter.timer);
        this.pending.delete(id);
        waiter.reject(new Error(`MCP stdio exited (code=${code})`));
      }
    });
    return proc;
  }

  async request<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId();
    if (this.config.transport === 'streamable-http') {
      if (!this.config.endpoint) throw new Error(`MCP Server(${this.config.id}) 缺少 HTTP endpoint`);
      const fetchFn = this.deps.fetchImpl ?? fetch;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
      try {
        const res = await fetchFn(this.config.endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(this.config.authHeader ? { Authorization: this.config.authHeader } : {}),
          },
          body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`MCP HTTP ${res.status}`);
        const payload = (await res.json()) as JsonRpcResponse;
        if (payload.error !== undefined) throw new Error(`${payload.error.code}: ${payload.error.message}`);
        return payload.result as T;
      } finally {
        clearTimeout(timer);
      }
    }

    const proc = this.ensureStdio();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP stdio timeout (${this.config.timeoutMs}ms): ${method}`));
      }, this.config.timeoutMs);
      this.pending.set(id, { resolve: (v) => resolve(v as T), reject, timer });
      if (!proc.stdin || proc.stdin.destroyed) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error('MCP stdio stdin 不可写'));
        return;
      }
      proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  async initialize(): Promise<{ protocolVersion: string; serverInfo?: { name: string; version: string } }> {
    return this.request('initialize', {
      protocolVersion: '2025-03-26',
      clientInfo: { name: 'whale-isle', version: '2.0.0' },
    });
  }

  async listTools(): Promise<McpToolDescriptor[]> {
    const res = await this.request<{ tools?: McpToolDescriptor[] }>('tools/list');
    return res.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    return this.request('tools/call', { name, arguments: args });
  }

  async listResources(): Promise<McpResourceDescriptor[]> {
    const res = await this.request<{ resources?: McpResourceDescriptor[] }>('resources/list');
    return res.resources ?? [];
  }

  async readResource(uri: string): Promise<unknown> {
    return this.request('resources/read', { uri });
  }

  async listPrompts(): Promise<McpPromptDescriptor[]> {
    const res = await this.request<{ prompts?: McpPromptDescriptor[] }>('prompts/list');
    return res.prompts ?? [];
  }

  async getPrompt(name: string, args: Record<string, string> = {}): Promise<unknown> {
    return this.request('prompts/get', { name, arguments: args });
  }

  close(): void {
    for (const [id, waiter] of this.pending.entries()) {
      clearTimeout(waiter.timer);
      this.pending.delete(id);
      waiter.reject(new Error('MCP client closed'));
    }
    if (this.proc !== null) {
      this.proc.kill();
      this.proc = null;
    }
  }
}

export interface WhaleMcpServerHandlers {
  getCharacterState?: () => Promise<unknown> | unknown;
  queryMemory?: (query: string) => Promise<unknown> | unknown;
  requestPetAction?: (action: string, durationMs?: number) => Promise<unknown> | unknown;
  getGameState?: () => Promise<unknown> | unknown;
  getModelConfig?: () => Promise<unknown> | unknown;
  getTaskStatus?: () => Promise<unknown> | unknown;
}

const TOOL_SCOPES: Record<string, string> = {
  whale_character_state: 'character.read',
  whale_memory_query: 'memory.read',
  whale_pet_action: 'pet.act',
  whale_game_state: 'game.read',
  whale_model_config: 'model.read',
  whale_task_status: 'task.read',
};

/** 对外部 Harness 暴露受控能力的鉴权 MCP Server */
export class WhaleMcpServer {
  private readonly audits: McpAuditEntry[] = [];

  constructor(
    private readonly options: {
      authTokens: ReadonlyMap<string, readonly string[]>;
      handlers: WhaleMcpServerHandlers;
    },
  ) {}

  auditLog(): McpAuditEntry[] {
    return this.audits.map((a) => ({ ...a }));
  }

  private recordAudit(entry: McpAuditEntry): void {
    this.audits.push(McpAuditEntrySchema.parse(entry));
    if (this.audits.length > 500) this.audits.splice(0, this.audits.length - 500);
  }

  private authorize(token: string | undefined, scope: string, method: string): { ok: true; actor: string; scopes: readonly string[] } | { ok: false; code: number; message: string } {
    if (!token || !this.options.authTokens.has(token)) {
      this.recordAudit({ timestamp: Date.now(), method, scope, actor: 'anonymous', allowed: false, detail: 'UNAUTHORIZED' });
      return { ok: false, code: -32001, message: 'UNAUTHORIZED: 缺少或无效 MCP Token' };
    }
    const scopes = this.options.authTokens.get(token) ?? [];
    if (!scopes.includes(scope) && !scopes.includes('*')) {
      this.recordAudit({ timestamp: Date.now(), method, scope, actor: `token:${token.slice(0, 4)}***`, allowed: false, detail: 'FORBIDDEN' });
      return { ok: false, code: -32003, message: `FORBIDDEN: 缺少权限范围 ${scope}` };
    }
    return { ok: true, actor: `token:${token.slice(0, 4)}***`, scopes };
  }

  async handleMessage(rpc: JsonRpcRequest, auth?: { token?: string }): Promise<JsonRpcResponse> {
    if (rpc.method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id: rpc.id,
        result: { protocolVersion: '2025-03-26', serverInfo: { name: 'whale-isle-mcp', version: '2.0.0' }, capabilities: { tools: {}, resources: {} } },
      };
    }

    if (rpc.method === 'tools/list') {
      const check = this.authorize(auth?.token, 'character.read', rpc.method);
      if (!check.ok) return { jsonrpc: '2.0', id: rpc.id, error: { code: check.code, message: check.message } };
      this.recordAudit({ timestamp: Date.now(), method: rpc.method, scope: 'character.read', actor: check.actor, allowed: true, detail: 'list' });
      const tools: McpToolDescriptor[] = [
        { name: 'whale_character_state', description: '查询受控角色状态', inputSchema: { type: 'object', properties: {} } },
        { name: 'whale_memory_query', description: '查询授权范围内记忆', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } },
        { name: 'whale_pet_action', description: '请求桌宠表情或动作', inputSchema: { type: 'object', properties: { action: { type: 'string' }, durationMs: { type: 'number' } } } },
        { name: 'whale_game_state', description: '查询当前游戏状态', inputSchema: { type: 'object', properties: {} } },
        { name: 'whale_model_config', description: '查询脱敏模型配置（不含密钥）', inputSchema: { type: 'object', properties: {} } },
        { name: 'whale_task_status', description: '查询当前任务执行状态', inputSchema: { type: 'object', properties: {} } },
      ];
      return { jsonrpc: '2.0', id: rpc.id, result: { tools } };
    }

    if (rpc.method === 'tools/call') {
      const name = typeof rpc.params?.['name'] === 'string' ? rpc.params['name'] : '';
      const args = (typeof rpc.params?.['arguments'] === 'object' && rpc.params['arguments'] !== null
        ? rpc.params['arguments']
        : {}) as Record<string, unknown>;
      const scope = TOOL_SCOPES[name];
      if (scope === undefined) {
        return { jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: `未知受控工具：${name}` } };
      }
      const check = this.authorize(auth?.token, scope, `tools/call:${name}`);
      if (!check.ok) return { jsonrpc: '2.0', id: rpc.id, error: { code: check.code, message: check.message } };

      let raw: unknown = null;
      if (name === 'whale_character_state') raw = await this.options.handlers.getCharacterState?.();
      else if (name === 'whale_memory_query') raw = await this.options.handlers.queryMemory?.(String(args['query'] ?? ''));
      else if (name === 'whale_pet_action') raw = await this.options.handlers.requestPetAction?.(String(args['action'] ?? 'idle'), Number(args['durationMs'] ?? 3000));
      else if (name === 'whale_game_state') raw = await this.options.handlers.getGameState?.();
      else if (name === 'whale_model_config') raw = await this.options.handlers.getModelConfig?.();
      else raw = await this.options.handlers.getTaskStatus?.();

      this.recordAudit({ timestamp: Date.now(), method: `tools/call:${name}`, scope, actor: check.actor, allowed: true, detail: 'ok' });
      return { jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: JSON.stringify(redactSecrets(raw)) }] } };
    }

    if (rpc.method === 'resources/list') {
      const check = this.authorize(auth?.token, 'character.read', rpc.method);
      if (!check.ok) return { jsonrpc: '2.0', id: rpc.id, error: { code: check.code, message: check.message } };
      return {
        jsonrpc: '2.0',
        id: rpc.id,
        result: { resources: [{ uri: 'whale://character/state', name: 'Character State', mimeType: 'application/json' }] },
      };
    }

    if (rpc.method === 'resources/read') {
      const uri = typeof rpc.params?.['uri'] === 'string' ? rpc.params['uri'] : '';
      const check = this.authorize(auth?.token, 'character.read', `resources/read:${uri}`);
      if (!check.ok) return { jsonrpc: '2.0', id: rpc.id, error: { code: check.code, message: check.message } };
      if (uri !== 'whale://character/state') {
        return { jsonrpc: '2.0', id: rpc.id, error: { code: -32004, message: `未知资源：${uri}` } };
      }
      const raw = await this.options.handlers.getCharacterState?.();
      return { jsonrpc: '2.0', id: rpc.id, result: { contents: [{ uri, text: JSON.stringify(redactSecrets(raw)) }] } };
    }

    return { jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: `不支持的 MCP 方法：${rpc.method}` } };
  }
}

export interface HarnessTaskExecutionResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  cancelled: boolean;
}

/** 执行级多 Harness Worker 任务封装（最小环境变量白名单 + 超时与取消信号） */
export async function executeHarnessTask(params: {
  preset: Pick<AgentProviderPreset, 'id' | 'command' | 'args'>;
  prompt: string;
  cwd: string;
  extraArgs?: string[];
  timeoutMs?: number;
  signal?: AbortSignal;
  envAllowlist?: Record<string, string>;
  spawnImpl?: typeof spawn;
}): Promise<HarnessTaskExecutionResult> {
  const startedAt = Date.now();
  if (!params.preset.command) {
    return {
      ok: false,
      exitCode: null,
      stdout: '',
      stderr: `Harness(${params.preset.id}) 未配置可执行命令`,
      durationMs: 0,
      timedOut: false,
      cancelled: false,
    };
  }
  if (params.signal?.aborted) {
    return { ok: false, exitCode: null, stdout: '', stderr: 'ABORTED_BEFORE_START', durationMs: 0, timedOut: false, cancelled: true };
  }

  const spawnFn = params.spawnImpl ?? spawn;
  const timeoutMs = params.timeoutMs ?? 60_000;
  const args = [...params.preset.args, ...(params.extraArgs ?? [params.prompt])];
  const isolatedEnv: Record<string, string> = {
    ...(process.env['PATH'] ? { PATH: process.env['PATH'] } : {}),
    ...(process.env['HOME'] ? { HOME: process.env['HOME'] } : {}),
    ...(params.envAllowlist ?? {}),
  };

  return new Promise<HarnessTaskExecutionResult>((resolve) => {
    const proc = spawnFn(params.preset.command!, args, { cwd: params.cwd, env: isolatedEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let cancelled = false;
    let settled = false;

    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      params.signal?.removeEventListener('abort', onAbort);
      resolve({
        ok: code === 0 && !timedOut && !cancelled,
        exitCode: code,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
        timedOut,
        cancelled,
      });
    };

    const onAbort = (): void => {
      cancelled = true;
      proc.kill();
    };
    params.signal?.addEventListener('abort', onAbort, { once: true });

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, timeoutMs);

    proc.stdout?.on('data', (chunk: Buffer | string) => { stdout += String(chunk); });
    proc.stderr?.on('data', (chunk: Buffer | string) => { stderr += String(chunk); });
    proc.on('error', (err) => { stderr += err.message; finish(null); });
    proc.on('close', (code) => finish(code));
  });
}
