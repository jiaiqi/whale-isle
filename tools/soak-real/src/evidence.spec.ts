/**
 * T-M6-67 现场包：7 件文件齐全；截图/存档拷贝失败只写 .err 不抛异常。
 */
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  appendEventLine,
  captureScreenWith,
  createRunDir,
  defaultCopySave,
  writeJsonFile,
  writeStuckPack,
} from './evidence';
import type { StuckVerdict } from './stuck-detector';

const VERDICT: StuckVerdict = {
  kind: 'repeat-failure',
  signature: 'fish|背包里没有鱼竿|Beach',
  detail: '同一失败签名 3 次',
  at: Date.UTC(2026, 4, 1, 10, 0, 0),
  location: 'Beach',
  clock: '第1年春16日 10:00',
};

function tempRunDir(): string {
  return createRunDir(mkdtempSync(join(tmpdir(), 'soak-evidence-')), 'run-1');
}

type SpawnResult = { error?: Error; status?: number | null; stderr?: string };
const asSpawn = (impl: () => SpawnResult): typeof import('node:child_process').spawnSync =>
  ((..._args: unknown[]) => impl()) as unknown as typeof import('node:child_process').spawnSync;

describe('现场包落盘', () => {
  it('成功路径写出 7 件（verdict/last50/state/planner/screen/save）', () => {
    const runDir = tempRunDir();
    const saveDir = join(runDir, '..', 'save-src');
    mkdirSync(saveDir, { recursive: true });
    writeFileSync(join(saveDir, 'SaveGameInfo'), 'ok');
    const pack = writeStuckPack(
      {
        runDir,
        saveDir,
        captureScreen: (file) => {
          writeFileSync(file, 'png');
          return { ok: true };
        },
      },
      {
        index: 1,
        verdict: VERDICT,
        events: Array.from({ length: 60 }, (_, index) => ({ type: 'receipt', n: index })),
        stateText: '时间：第1年春16日 10:00',
        planner: { planner: 'rule-schedule', avoidTools: ['fish'] },
        dayKey: 'Y1-春-16',
        clock: '第1年春16日 10:00',
      },
    );
    expect(pack.errors).toEqual([]);
    expect(pack.dir).toBe(join('stuck', '01-repeat-failure'));
    const dir = join(runDir, pack.dir);
    const entries = readdirSync(dir).sort();
    expect(entries).toEqual(['last50.jsonl', 'planner.json', 'save', 'screen.png', 'state.txt', 'verdict.json']);
    const lines = readFileSync(join(dir, 'last50.jsonl'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(50);
    expect(lines[49]).toContain('"n":59');
    const verdict = JSON.parse(readFileSync(join(dir, 'verdict.json'), 'utf8')) as Record<string, unknown>;
    expect(verdict).toMatchObject({ kind: 'repeat-failure', dayKey: 'Y1-春-16', clock: '第1年春16日 10:00' });
    expect(typeof verdict.atIso).toBe('string');
    expect(readFileSync(join(dir, 'save', 'SaveGameInfo'), 'utf8')).toBe('ok');
  });

  it('截图与存档拷贝失败只写 .err，不抛异常', () => {
    const runDir = tempRunDir();
    const pack = writeStuckPack(
      {
        runDir,
        saveDir: join(runDir, '不存在的存档'),
        captureScreen: () => ({ ok: false, error: '屏幕录制权限未授予' }),
      },
      { index: 2, verdict: VERDICT, events: [], stateText: '', planner: {}, dayKey: null, clock: null },
    );
    const dir = join(runDir, pack.dir);
    expect(readFileSync(join(dir, 'screen.err'), 'utf8')).toContain('屏幕录制权限');
    expect(readFileSync(join(dir, 'save.err'), 'utf8')).toContain('不存在');
    expect(readFileSync(join(dir, 'state.txt'), 'utf8')).toContain('无状态快照');
    expect(readFileSync(join(dir, 'last50.jsonl'), 'utf8')).toBe('');
    // 证据文件仍然齐全
    expect(readdirSync(dir).sort()).toEqual(['last50.jsonl', 'planner.json', 'save.err', 'screen.err', 'state.txt', 'verdict.json']);
  });

  it('未配置存档目录时写 save.err 说明', () => {
    const runDir = tempRunDir();
    const pack = writeStuckPack(
      { runDir, saveDir: null, captureScreen: () => ({ ok: true }) },
      { index: 3, verdict: VERDICT, events: [], stateText: 'x', planner: {}, dayKey: null, clock: null },
    );
    expect(readFileSync(join(runDir, pack.dir, 'save.err'), 'utf8')).toContain('--save-dir');
  });

  it('planner 快照不可序列化时只记录错误，其余文件照写', () => {
    const runDir = tempRunDir();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const pack = writeStuckPack(
      { runDir, saveDir: null, captureScreen: () => ({ ok: true }) },
      { index: 4, verdict: VERDICT, events: [], stateText: 'x', planner: circular, dayKey: null, clock: null },
    );
    expect(pack.errors.some((error) => error.startsWith('planner.json'))).toBe(true);
    expect(pack.files).toContain('verdict.json');
  });

  it('失败结果没有 error 文本时用占位说明', () => {
    const runDir = tempRunDir();
    const pack = writeStuckPack(
      {
        runDir,
        saveDir: '/tmp/whatever',
        captureScreen: () => ({ ok: false }),
        copySave: () => ({ ok: false }),
      },
      { index: 6, verdict: VERDICT, events: [], stateText: 'x', planner: {}, dayKey: null, clock: null },
    );
    expect(readFileSync(join(runDir, pack.dir, 'screen.err'), 'utf8')).toContain('未知错误');
    expect(readFileSync(join(runDir, pack.dir, 'save.err'), 'utf8')).toContain('未知错误');
  });

  it('注入函数抛非 Error 值也能转成文本', () => {
    const runDir = tempRunDir();
    const pack = writeStuckPack(
      {
        runDir,
        saveDir: '/tmp/whatever',
        captureScreen: () => { throw '字符串炸弹'; },
        copySave: () => { throw 42; },
      },
      { index: 7, verdict: VERDICT, events: [], stateText: 'x', planner: {}, dayKey: null, clock: null },
    );
    expect(readFileSync(join(runDir, pack.dir, 'screen.err'), 'utf8')).toContain('字符串炸弹');
    expect(readFileSync(join(runDir, pack.dir, 'save.err'), 'utf8')).toContain('42');
  });

  it('注入函数抛异常也不影响主循环', () => {
    const runDir = tempRunDir();
    const pack = writeStuckPack(
      {
        runDir,
        saveDir: '/tmp/whatever',
        captureScreen: () => { throw new Error('截图爆炸'); },
        copySave: () => { throw new Error('拷贝爆炸'); },
      },
      { index: 5, verdict: VERDICT, events: [], stateText: 'x', planner: {}, dayKey: null, clock: null },
    );
    expect(readFileSync(join(runDir, pack.dir, 'screen.err'), 'utf8')).toContain('截图爆炸');
    expect(readFileSync(join(runDir, pack.dir, 'save.err'), 'utf8')).toContain('拷贝爆炸');
  });
});

describe('screencapture / 存档拷贝', () => {
  it('非 macOS 直接给出说明', () => {
    const result = captureScreenWith(asSpawn(() => ({ status: 0 })), '/tmp/x.png', 'linux');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('仅在 macOS');
  });

  it('spawn 失败 / 退出码非 0 / 文件缺失分别报错', () => {
    expect(captureScreenWith(asSpawn(() => ({ error: new Error('ENOENT') })), '/tmp/x.png', 'darwin'))
      .toMatchObject({ ok: false, error: 'ENOENT' });
    expect(captureScreenWith(asSpawn(() => ({ status: 1, stderr: '权限不足' })), '/tmp/x.png', 'darwin'))
      .toMatchObject({ ok: false, error: '权限不足' });
    expect(captureScreenWith(asSpawn(() => ({ status: 1 })), '/tmp/x.png', 'darwin').error)
      .toContain('退出码');
    expect(captureScreenWith(asSpawn(() => ({ status: 0 })), join(tmpdir(), 'soak-not-exist.png'), 'darwin').ok)
      .toBe(false);
    const throws = (() => { throw new Error('spawn 爆炸'); }) as unknown as typeof import('node:child_process').spawnSync;
    expect(captureScreenWith(throws, '/tmp/x.png', 'darwin')).toMatchObject({ ok: false, error: 'spawn 爆炸' });
  });

  it('截图成功：文件存在即 ok', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'soak-shot-')), 'screen.png');
    const result = captureScreenWith(asSpawn(() => {
      writeFileSync(file, 'png');
      return { status: 0 };
    }), file, 'darwin');
    expect(result.ok).toBe(true);
  });

  it('存档目录不存在时报错；存在时递归拷贝', () => {
    const root = mkdtempSync(join(tmpdir(), 'soak-save-'));
    expect(defaultCopySave(join(root, 'missing'), join(root, 'dest')).ok).toBe(false);
    const source = join(root, 'src');
    mkdirSync(join(source, 'nested'), { recursive: true });
    writeFileSync(join(source, 'nested', 'file.txt'), 'hello');
    const result = defaultCopySave(source, join(root, 'dest'));
    expect(result.ok).toBe(true);
    expect(readFileSync(join(root, 'dest', 'nested', 'file.txt'), 'utf8')).toBe('hello');

    // 目标落在普通文件下面 → cpSync 抛 ENOTDIR，被兜住
    const blocker = join(root, 'blocker');
    writeFileSync(blocker, 'x');
    const failed = defaultCopySave(source, join(blocker, 'dest'));
    expect(failed.ok).toBe(false);
    expect(failed.error).toBeTruthy();
  });
});

describe('事件流与 JSON 落盘', () => {
  it('appendEventLine 每行带 ts/at/event；writeJsonFile 稳定缩进', () => {
    const dir = mkdtempSync(join(tmpdir(), 'soak-json-'));
    const file = join(dir, 'events.jsonl');
    appendEventLine(file, { type: 'state' }, Date.UTC(2026, 4, 1, 0, 0, 0));
    appendEventLine(file, { type: 'receipt' }, Date.UTC(2026, 4, 1, 0, 0, 1));
    const lines = readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ ts: Date.UTC(2026, 4, 1, 0, 0, 0), at: '2026-05-01T00:00:00.000Z' });
    const jsonFile = join(dir, 'x.json');
    writeJsonFile(jsonFile, { a: 1 });
    expect(readFileSync(jsonFile, 'utf8')).toBe('{\n  "a": 1\n}\n');
  });
});
