/** V2-P4-04C：Envoy 外部 MCP 只读适配。没有通用 callTool 出口，不转发外部工具描述/Prompt。 */
import { spawn, type ChildProcess } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  EnvoyToolResultSchema, KnowledgeSourceStatusSchema,
  type EnvoyReadResponse, type KnowledgeSourceStatus, type McpAuditEntry,
} from '@workbench/shared-protocol';
import { WhaleMcpClient } from './mcp-bridge';

export function findKnowledgeExecutable(name: string, searchPath = process.env.PATH ?? ''): string | null {
  for (const directory of searchPath.split(delimiter).filter(Boolean)) {
    const file = join(directory, process.platform === 'win32' ? `${name}.exe` : name);
    try { accessSync(file, constants.X_OK); if (statSync(file).isFile()) return file; } catch { /* 下一目录 */ }
  }
  return null;
}

export class EnvoyKnowledgeSource {
  private client: WhaleMcpClient | null = null;
  private child: ChildProcess | null = null;
  private starting: Promise<KnowledgeSourceStatus> | null = null;
  private current: KnowledgeSourceStatus;
  private closed = false;

  constructor(private readonly options: {
    materialsRoot: string; stateDir: string; enabled?: boolean; timeoutMs?: number;
    /** 仅由宿主/测试装配，IPC 不接受命令、参数或环境变量。 */
    command?: string; args?: string[]; uvCommand?: string;
    audit?: (entry: McpAuditEntry) => void;
  }) {
    this.current = this.status('unavailable', '外部知识源尚未探测');
  }

  private status(state: KnowledgeSourceStatus['state'], reason?: string, version?: string): KnowledgeSourceStatus {
    this.current = KnowledgeSourceStatusSchema.parse({
      sourceId: 'envoy', state, reason, version, materialsRoot: this.options.materialsRoot,
      readOnly: true, checkedAt: new Date().toISOString(),
    });
    return this.current;
  }

  snapshot(): KnowledgeSourceStatus { return { ...this.current }; }

  async probe(): Promise<KnowledgeSourceStatus> {
    if (this.closed) return this.status('unavailable', '知识源已关闭');
    if (this.options.enabled === false) return this.status('unavailable', 'Envoy 已停用，使用本地攻略');
    if (this.current.state === 'available' && this.client) return this.snapshot();
    if (this.starting) return this.starting;
    this.starting = this.start();
    try { return await this.starting; } finally { this.starting = null; }
  }

  private async start(): Promise<KnowledgeSourceStatus> {
    const command = this.options.command ?? findKnowledgeExecutable('envoy');
    const uv = this.options.uvCommand ?? findKnowledgeExecutable('uv');
    const missing: string[] = [];
    if (!command) missing.push('未找到 envoy');
    if (!uv) missing.push('未找到 uv');
    if (!existsSync(this.options.materialsRoot)) missing.push('owner 授权材料目录不存在');
    if (missing.length > 0) return this.status('unavailable', `外部知识源不可用：${missing.join('；')}；回退本地攻略`);
    this.status('starting');
    try {
      mkdirSync(this.options.stateDir, { recursive: true });
      const isolatedSpawn: typeof spawn = ((cmd: string, args: string[]) => {
        const child = spawn(cmd, args, {
          cwd: this.options.stateDir,
          env: {
            PATH: process.env.PATH ?? '',
            HOME: this.options.stateDir,
            ENVOY_LOCAL_DATA_DIR: join(this.options.stateDir, 'materials'),
            ENVOY_CREDENTIAL_HANDOFF: '0', ENVOY_SIGN_IN: '0',
            ...(cmd === process.execPath ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
            ...(process.platform === 'win32' && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
          },
          detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
        });
        this.child = child;
        child.once('exit', () => {
          if (this.child === child) {
            this.child = null;
            this.client = null;
            this.status('unavailable', 'Envoy 进程已退出，回退本地攻略');
          }
          this.terminate(child);
        });
        return child;
      }) as typeof spawn;
      this.client = new WhaleMcpClient({
        id: 'envoy-knowledge', label: 'Envoy 只读材料', transport: 'stdio',
        command: command!, args: this.options.args ?? ['mcp'], timeoutMs: this.options.timeoutMs ?? 5_000,
      }, { spawnImpl: isolatedSpawn });
      const hello = await this.client.initialize();
      this.client.notifyInitialized();
      const tools = await this.client.listTools();
      if (!tools.some((tool) => tool.name === 'envoy_read')) throw new Error('Envoy 未提供 envoy_read 只读工具');
      if (this.closed) { this.disposeProcess(); return this.status('unavailable', '知识源已关闭'); }
      return this.status('available', undefined, hello.serverInfo?.version ?? 'unknown');
    } catch (error) {
      this.disposeProcess();
      return this.status('unavailable', `外部知识源不可用：${error instanceof Error ? error.message : String(error)}；回退本地攻略`);
    }
  }

  /** realpath 后校验根目录；拒绝 ../、软链接逃逸、目录、任意 URL 和超大材料。 */
  authorizedFile(filePath: string): { path: string; bytes: Buffer; revision: string } {
    if (!isAbsolute(filePath)) throw new Error('只接受 owner 授权目录内的绝对文件路径');
    const root = realpathSync(this.options.materialsRoot);
    const path = realpathSync(filePath);
    const rel = relative(root, path);
    if (rel === '' || rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) {
      throw new Error('材料路径不在 owner 授权目录内');
    }
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > 2_000_000) throw new Error('材料必须为不超过 2 MB 的普通文件');
    return { path, bytes: readFileSync(path), revision: `mtime:${stat.mtimeMs}:size:${stat.size}` };
  }

  private audit(allowed: boolean, detail: string): void {
    this.options.audit?.({ timestamp: Date.now(), method: 'tools/call:envoy_read', scope: 'knowledge.read', actor: 'knowledge-host', allowed, detail });
  }

  async read(filePath: string, tool = 'envoy_read'): Promise<{ payload: EnvoyReadResponse; version: string; file: ReturnType<EnvoyKnowledgeSource['authorizedFile']> }> {
    if (tool !== 'envoy_read') {
      this.options.audit?.({ timestamp: Date.now(), method: `tools/call:${tool}`, scope: 'knowledge.read', actor: 'knowledge-host', allowed: false, detail: 'TOOL_NOT_ALLOWED' });
      throw new Error(`只读白名单拒绝工具：${tool}`);
    }
    const file = this.authorizedFile(filePath);
    const status = await this.probe();
    if (status.state !== 'available' || !this.client) { this.audit(false, 'UNAVAILABLE'); throw new Error(status.reason); }
    try {
      // 第一切片只调用这一个工具，固定只读参数；不接受任意 URL、读侧复合操作或自动安装。
      const envelope = EnvoyToolResultSchema.parse(await this.client.callTool('envoy_read', {
        source: { url: pathToFileURL(file.path).href, kind: 'auto' },
        goal: '读取这份 owner 授权攻略的原文与来源定位，只返回材料，不生成策略或摘要事实。',
        budget: { max_work_seconds: 4, max_download_bytes: 0, max_response_chars: 100_000 },
      }));
      if (envelope.isError || !envelope.structuredContent) throw new Error('Envoy 未返回可校验的结构化材料');
      const payload = envelope.structuredContent;
      if (!payload.material_id || !payload.source_revision || !['ready', 'partial'].includes(payload.result)) {
        throw new Error(`材料读取未完成：${payload.result}；${payload.errors.map((error) => error.message).join('；')}`);
      }
      this.audit(true, `READ:${payload.material_id}`);
      return { payload, version: status.version ?? 'unknown', file };
    } catch (error) {
      this.audit(false, 'READ_FAILED');
      this.disposeProcess();
      this.status('unavailable', `材料读取失败：${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  private terminate(child: ChildProcess): void {
    const kill = (signal: NodeJS.Signals): void => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch { /* 已退出 */ }
    };
    kill('SIGTERM');
    const timer = setTimeout(() => kill('SIGKILL'), 250);
    timer.unref();
  }

  private disposeProcess(): void {
    const client = this.client;
    this.client = null;
    if (this.child) this.terminate(this.child);
    this.child = null;
    client?.close();
  }

  close(): void { this.closed = true; this.disposeProcess(); }
}
