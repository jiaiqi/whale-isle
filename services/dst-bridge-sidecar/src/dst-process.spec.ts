/** [M7] 专用服托管门禁：缺 token 拒绝（人类步骤不可绕过）、目录重定向、c_ 命令白名单。 */
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DstServerProcess } from './dst-process';

interface FakeChild {
  child: ReturnType<typeof makeFakeChild>;
  writes: string[];
  args: string[];
  command: string;
}

function makeFakeChild() {
  const emitter = new EventEmitter() as EventEmitter & {
    stdin: { writable: boolean; write: (s: string) => void };
    stdout: EventEmitter;
    stderr: EventEmitter;
    exitCode: number | null;
    kill: ReturnType<typeof vi.fn>;
  };
  emitter.stdin = { writable: true, write: () => undefined };
  emitter.stdout = new EventEmitter();
  emitter.stderr = new EventEmitter();
  emitter.exitCode = null;
  emitter.kill = vi.fn();
  return emitter;
}

describe('DstServerProcess', () => {
  it('缺 cluster_token.txt 直接报错，提示人类 Klei 步骤；不启动任何进程', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dst-no-token-'));
    const spawnImpl = vi.fn();
    const proc = new DstServerProcess({ clusterDir: dir, spawnImpl: spawnImpl as never });
    expect(() => proc.start()).toThrow(/cluster_token\.txt.*Klei/);
    expect(spawnImpl).not.toHaveBeenCalled();
    rmSync(dir, { recursive: true, force: true });
  });

  it('有 token 时按目录重定向启动，c_ 命令仅放行运维白名单', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dst-token-'));
    writeFileSync(join(dir, 'cluster_token.txt'), 'HUMAN_SUPPLIED_TOKEN', 'utf8');
    const fake = makeFakeChild();
    const writes: string[] = [];
    fake.stdin.write = (s: string) => writes.push(s);
    let captured: FakeChild | null = null;
    const proc = new DstServerProcess({
      clusterDir: dir,
      binary: '/fake/dontstarve_dedicated_server_nullrenderer',
      spawnImpl: ((command: string, args: readonly string[]) => {
        captured = { child: fake, writes, args: [...args], command };
        return fake;
      }) as never,
    });
    proc.start();
    expect(proc.isRunning()).toBe(true);
    expect(captured).not.toBeNull();
    const record = captured as unknown as FakeChild;
    expect(record.command).toContain('dontstarve_dedicated_server_nullrenderer');
    expect(record.args).toContain('-persistent_storage_root');
    expect(record.args).toContain(dir);
    expect(record.args).toContain('-conf_dir');

    expect(proc.sendOpsCommand('c_announce("服务器维护中")')).toBe(true);
    expect(writes).toEqual(['c_announce("服务器维护中")\n']);
    expect(proc.sendOpsCommand('c_save()')).toBe(true);
    expect(proc.sendOpsCommand('c_announce("x"); loadstring("bad")')).toBe(false);
    expect(proc.sendOpsCommand('lua_exec("os.execute")')).toBe(false);
    expect(proc.sendOpsCommand('c_shutdown()\nc_save()')).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it('重复 start 幂等；默认二进制/集群名/cwd、extraArgs、日志转发、exit 后自动清理', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dst-token-'));
    writeFileSync(join(dir, 'cluster_token.txt'), 'TOKEN', 'utf8');
    const fake = makeFakeChild();
    const logs: string[] = [];
    let spawnCount = 0;
    const proc = new DstServerProcess({
      clusterDir: dir,
      clusterName: 'MyCluster',
      cwd: '/tmp/custom-cwd',
      extraArgs: ['-offline'],
      log: (line) => logs.push(line),
      spawnImpl: (() => { spawnCount++; return fake; }) as never,
    });
    proc.start();
    proc.start(); // child 已存在 → 直接返回，不重复拉起
    expect(spawnCount).toBe(1);
    expect(proc.isRunning()).toBe(true);

    // 日志转发：stdout/stderr 两路
    fake.stdout.emit('data', Buffer.from('hello world'));
    fake.stderr.emit('data', Buffer.from('warn line'));
    expect(logs.some((l) => l.includes('hello world'))).toBe(true);
    expect(logs.some((l) => l.includes('[stderr] warn line'))).toBe(true);

    // exit 事件把 child 清空（只清当前 child）
    fake.exitCode = 0;
    fake.emit('exit', 0);
    expect(proc.isRunning()).toBe(false);
    expect(proc.sendOpsCommand('c_save()')).toBe(false); // child=null → stdin 不存在
    rmSync(dir, { recursive: true, force: true });
  });

  it('stdin 不可写时拒绝运维命令', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dst-token-'));
    writeFileSync(join(dir, 'cluster_token.txt'), 'TOKEN', 'utf8');
    const fake = makeFakeChild();
    fake.stdin.writable = false;
    const proc = new DstServerProcess({ clusterDir: dir, spawnImpl: (() => fake) as never });
    proc.start();
    expect(proc.sendOpsCommand('c_save()')).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it('stop：无 child 直接返回；已退出仅清引用；运行中先 c_shutdown 后超时 SIGTERM', async () => {
    const idle = new DstServerProcess({ clusterDir: '/none' });
    await expect(idle.stop()).resolves.toBeUndefined(); // 无 child

    const dir = mkdtempSync(join(tmpdir(), 'dst-token-'));
    writeFileSync(join(dir, 'cluster_token.txt'), 'TOKEN', 'utf8');
    const fake = makeFakeChild();
    const writes: string[] = [];
    fake.stdin.write = (s: string) => writes.push(s);
    const proc = new DstServerProcess({ clusterDir: dir, spawnImpl: (() => fake) as never });
    proc.start();

    // 已退出（exitCode 非 null）→ 不发 c_shutdown、不等待、不 kill
    fake.exitCode = 0;
    await proc.stop();
    expect(writes).toEqual([]);
    expect(fake.kill).not.toHaveBeenCalled();

    // 重新拉起一个仍在运行的 child → c_shutdown → 3s 超时 → SIGTERM
    const fake2 = makeFakeChild();
    fake2.stdin.write = (s: string) => writes.push(s);
    const proc2 = new DstServerProcess({ clusterDir: dir, spawnImpl: (() => fake2) as never });
    proc2.start();
    await proc2.stop();
    expect(writes).toContain('c_shutdown()\n');
    expect(fake2.kill).toHaveBeenCalledWith('SIGTERM');
    expect(proc2.isRunning()).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});
