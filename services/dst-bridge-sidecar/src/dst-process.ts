/**
 * DST 专用服本地托管兜底（M7 / T-M7-D4）。
 *
 * 只做运维生命周期管理：目录重定向、stdin 管道 c_ 命令、日志转发、优雅关停。
 * 红线：
 *   · cluster_token.txt 必须由人类用 Klei 账号在官方页面生成——缺失即报错，绝不绕过。
 *   · c_ 命令严格白名单（仅运维），AI 动作一律走 mod 内 vanilla API + 四态回执。
 *   · 禁止 loadstring / require / os.execute / io.open / 换行注入。
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface DstProcessOptions {
  /** 本地集群目录（含 cluster_token.txt / Caves 与 Master 配置） */
  clusterDir: string;
  /** 可执行文件；macOS Steam 安装通常需要传绝对路径 */
  binary?: string;
  clusterName?: string;
  cwd?: string;
  extraArgs?: string[];
  log?: (line: string) => void;
  /** 测试注入：假 spawn 便于断言参数/白名单，不启动真实游戏 */
  spawnImpl?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
}

const OPS_COMMAND_RE = /^c_(announce|save|shutdown|listplayers)\s*\(/;
const FORBIDDEN_RE = /[\r\n;]|loadstring|require\s*\(|os\.execute|io\.open|assert\s*\(/i;

export class DstServerProcess {
  private child: ChildProcess | null = null;

  constructor(private readonly options: DstProcessOptions) {}

  isRunning(): boolean {
    return this.child !== null && this.child.exitCode === null;
  }

  /** 启动专用服；缺 token 直接抛错（人类步骤，不可伪造）。 */
  start(): void {
    if (this.child) return;
    const clusterDir = resolve(this.options.clusterDir);
    if (!existsSync(join(clusterDir, 'cluster_token.txt'))) {
      throw new Error(
        `缺少 ${join(clusterDir, 'cluster_token.txt')}：请人类用 Klei 账号在官方专用服页面生成 token 并写入该文件（真机验收前置，不可绕过）`,
      );
    }
    const binary = this.options.binary ?? 'dontstarve_dedicated_server_nullrenderer';
    const clusterName = this.options.clusterName ?? 'Cluster_1';
    const args = [
      '-persistent_storage_root', clusterDir,
      '-conf_dir', clusterName,
      '-cluster', clusterName,
      ...(this.options.extraArgs ?? []),
    ];
    const spawnFn = this.options.spawnImpl ?? spawn;
    const child = spawnFn(binary, args, {
      cwd: this.options.cwd ?? clusterDir,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    const log = this.options.log ?? (() => undefined);
    child.stdout?.on('data', (chunk: Buffer) => log(chunk.toString('utf8').slice(0, 2000)));
    child.stderr?.on('data', (chunk: Buffer) => log(`[stderr] ${chunk.toString('utf8').slice(0, 2000)}`));
    child.once('exit', () => { if (this.child === child) this.child = null; });
    log(`DST 专用服已拉起（${binary}），集群目录=${clusterDir}`);
  }

  /** 运维兜底命令（不用于 AI 动作）：仅允许白名单前缀且拒绝注入片段。 */
  sendOpsCommand(command: string): boolean {
    const text = command.trim();
    if (!OPS_COMMAND_RE.test(text) || FORBIDDEN_RE.test(text)) return false;
    const stdin = this.child?.stdin;
    if (!stdin || stdin.writable === false) return false;
    stdin.write(`${text}\n`);
    return true;
  }

  /** 优雅关停：先 c_shutdown()，3s 未退出再 SIGTERM。 */
  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    if (this.isRunning()) this.sendOpsCommand('c_shutdown()');
    if (child.exitCode === null) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { cleanup(); resolve(); }, 3_000);
        const done = () => { cleanup(); resolve(); };
        const cleanup = () => { clearTimeout(timer); child.off('exit', done); };
        child.once('exit', done);
      });
    }
    if (child.exitCode === null) child.kill('SIGTERM');
    this.child = null;
  }
}
