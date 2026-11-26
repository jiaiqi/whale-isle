import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createNativeAudioPlayer,
  ensureNativeAudioHelper,
  locateAudioHelperSource,
  parseAudioHelperLine,
} from './native-audio-player';

/** 假 helper 子进程：可手动灌 stdout 行、可控退出码 */
class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly signals: string[] = [];
  constructor() {
    super();
    this.stdout.setEncoding('utf8');
    this.stderr.setEncoding('utf8');
  }
  kill(signal: string): boolean {
    this.signals.push(signal);
    return true;
  }
  line(payload: Record<string, unknown>): void {
    this.stdout.write(`${JSON.stringify(payload)}\n`);
  }
  close(code: number | null): void {
    this.emit('close', code);
  }
}

describe('parseAudioHelperLine', () => {
  it('解析合法事件，忽略非 JSON、未知类型与空行', () => {
    expect(parseAudioHelperLine('{"type":"position","positionMs":120,"wallMs":100}')).toEqual({
      type: 'position',
      positionMs: 120,
      wallMs: 100,
    });
    expect(parseAudioHelperLine('{"type":"started","durationMs":25000}')).toEqual({ type: 'started', durationMs: 25000 });
    expect(parseAudioHelperLine('{"type":"error","reason":"decode_failed"}')).toEqual({ type: 'error', reason: 'decode_failed' });
    expect(parseAudioHelperLine('')).toBeNull();
    expect(parseAudioHelperLine('not json')).toBeNull();
    expect(parseAudioHelperLine('{"type":"unknown"}')).toBeNull();
    expect(parseAudioHelperLine('{"type":"position","positionMs":"abc"}')).toEqual({ type: 'position' });
  });
});

describe('createNativeAudioPlayer', () => {
  const created: Array<{ child: FakeChild; player: ReturnType<typeof createNativeAudioPlayer> }> = [];

  afterEach(() => {
    created.length = 0;
  });

  function setup(): { child: FakeChild; player: ReturnType<typeof createNativeAudioPlayer> } {
    const child = new FakeChild();
    const player = createNativeAudioPlayer({
      helperPath: '/tmp/fake-whale-audio-helper',
      // 测试替身：直接返回假子进程
      spawnImpl: (() => child) as never,
    });
    created.push({ child, player });
    return { child, player };
  }

  it('按真实播放头回报位置并以最远位置作为 playedMs', async () => {
    const { child, player } = setup();
    const positions: number[] = [];
    const pending = player.play({ filePath: '/tmp/song.wav', onPosition: (p) => positions.push(p) });
    expect(player.active()).toBe(true);
    child.line({ type: 'started', durationMs: 25000 });
    child.line({ type: 'position', positionMs: 0, wallMs: 0 });
    child.line({ type: 'position', positionMs: 104, wallMs: 101 });
    child.line({ type: 'position', positionMs: 210, wallMs: 202 });
    child.line({ type: 'ended', positionMs: 214 });
    child.close(0);
    const result = await pending;
    expect(result).toEqual({ ok: true, playedMs: 214, realPlayhead: true });
    expect(positions).toEqual([0, 104, 210]);
    expect(player.positionMs()).toBeNull();
    expect(player.active()).toBe(false);
  });

  it('被停止时返回失败并带上真实播放头位置', async () => {
    const { child, player } = setup();
    const pending = player.play({ filePath: '/tmp/song.wav' });
    child.line({ type: 'started', durationMs: 25000 });
    child.line({ type: 'position', positionMs: 583, wallMs: 600 });
    player.stop();
    expect(child.signals).toEqual(['SIGTERM']);
    child.line({ type: 'stopped', positionMs: 583 });
    child.close(0);
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('播放被停止');
    expect(result.playedMs).toBe(583);
  });

  it('helper 报错或异常退出都如实失败，不假装播放成功', async () => {
    const first = setup();
    const pendingError = first.player.play({ filePath: '/tmp/bad.wav' });
    first.child.line({ type: 'error', reason: 'file_not_found: /tmp/bad.wav' });
    first.child.close(4);
    const errorResult = await pendingError;
    expect(errorResult.ok).toBe(false);
    expect(errorResult.reason).toContain('file_not_found');

    const second = setup();
    const pendingCrash = second.player.play({ filePath: '/tmp/song.wav' });
    second.child.stderr.write('boom');
    second.child.close(9);
    const crashResult = await pendingCrash;
    expect(crashResult.ok).toBe(false);
    expect(crashResult.reason).toContain('退出码 9');
    expect(crashResult.reason).toContain('boom');
  });

  it('未收到 ended 的 0 退出码不算成功（防止把提前退出当播放完成）', async () => {
    const { child, player } = setup();
    const pending = player.play({ filePath: '/tmp/song.wav' });
    child.line({ type: 'started', durationMs: 25000 });
    child.line({ type: 'position', positionMs: 40 });
    child.close(0);
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.playedMs).toBe(40);
  });

  it('同一时刻只允许一路播放，非法行被忽略', async () => {
    const { child, player } = setup();
    const pending = player.play({ filePath: '/tmp/a.wav' });
    child.stdout.write('garbage line\n');
    child.line({ type: 'position', positionMs: 10 });
    const second = await player.play({ filePath: '/tmp/b.wav' });
    expect(second.ok).toBe(false);
    expect(second.reason).toBe('已有播放进行中');
    child.line({ type: 'ended', positionMs: 12 });
    child.close(0);
    expect((await pending).playedMs).toBe(12);
  });

  it('启动即失败（spawn 抛错）时如实返回原因', async () => {
    const player = createNativeAudioPlayer({
      helperPath: '/nope',
      spawnImpl: (() => { throw new Error('ENOENT'); }) as never,
    });
    const result = await player.play({ filePath: '/tmp/a.wav' });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('ENOENT');
  });
});

describe('ensureNativeAudioHelper', () => {
  let workDir = '';

  afterEach(() => {
    if (workDir !== '') rmSync(workDir, { recursive: true, force: true });
    workDir = '';
  });

  it('编译成功后按源码哈希复用缓存，源码变更即重编', () => {
    workDir = mkdtempSync(join(tmpdir(), 'whale-audio-helper-'));
    const appPath = join(workDir, 'app');
    mkdirSync(join(workDir, 'tools', 'native'), { recursive: true });
    const source = join(workDir, 'tools', 'native', 'macos-audio-helper.swift');
    writeFileSync(source, '// v1\n');
    expect(locateAudioHelperSource(appPath)).toBe(source);

    const compiles: string[] = [];
    const compile = (src: string, out: string): { ok: boolean } => {
      compiles.push(out);
      writeFileSync(out, 'binary');
      return { ok: true };
    };
    const cacheDir = join(workDir, 'cache');
    const first = ensureNativeAudioHelper({ appPath, cacheDir, compile, platform: 'darwin' });
    expect(first.ok).toBe(true);
    expect(compiles).toHaveLength(1);

    const second = ensureNativeAudioHelper({ appPath, cacheDir, compile, platform: 'darwin' });
    expect(second.ok).toBe(true);
    expect(second.helperPath).toBe(first.helperPath);
    expect(compiles).toHaveLength(1);

    writeFileSync(source, '// v2\n');
    const third = ensureNativeAudioHelper({ appPath, cacheDir, compile, platform: 'darwin' });
    expect(third.ok).toBe(true);
    expect(third.helperPath).not.toBe(first.helperPath);
    expect(compiles).toHaveLength(2);
  });

  it('编译失败与源码缺失都如实返回不可用', () => {
    workDir = mkdtempSync(join(tmpdir(), 'whale-audio-helper-'));
    const appPath = join(workDir, 'app');
    expect(ensureNativeAudioHelper({ appPath, cacheDir: join(workDir, 'c'), platform: 'darwin' }).ok).toBe(false);

    mkdirSync(join(workDir, 'tools', 'native'), { recursive: true });
    writeFileSync(join(workDir, 'tools', 'native', 'macos-audio-helper.swift'), '// v1\n');
    const failed = ensureNativeAudioHelper({
      appPath,
      cacheDir: join(workDir, 'c'),
      compile: () => ({ ok: false, stderr: 'swiftc missing' }),
      platform: 'darwin',
    });
    expect(failed.ok).toBe(false);
    expect(failed.reason).toContain('compile_failed');
  });

  it('非 darwin 平台一律如实报 unsupported_platform（CI 上可复跑）', () => {
    workDir = mkdtempSync(join(tmpdir(), 'whale-audio-helper-'));
    mkdirSync(join(workDir, 'tools', 'native'), { recursive: true });
    writeFileSync(join(workDir, 'tools', 'native', 'macos-audio-helper.swift'), '// v1\n');
    const result = ensureNativeAudioHelper({
      appPath: join(workDir, 'app'),
      cacheDir: join(workDir, 'c'),
      compile: () => ({ ok: true }),
      platform: 'linux',
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('unsupported_platform');
  });
});
