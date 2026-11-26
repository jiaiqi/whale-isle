import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { nodeEngineFs, planVoiceFallback, resolveLocalEngine, type EngineFsPort } from './local-engine';

const marker = (engineId: string, files: Array<{ path: string; bytes: number }>) => ({
  engineId,
  version: '0.5b-test',
  installedAt: '2026-11-26T00:00:00.000Z',
  totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
  files: files.map((file) => ({ ...file, sha256: 'deadbeef' })),
});

/** 内存文件系统替身：单测不依赖真实磁盘布局 */
function fakeFs(init: Record<string, string | number>): EngineFsPort {
  const files = new Map<string, string>(Object.entries(init).filter(([, value]) => typeof value === 'string') as Array<[string, string]>);
  const sizes = new Map<string, number>(Object.entries(init).filter(([, value]) => typeof value === 'number') as Array<[string, number]>);
  return {
    exists: (path) => files.has(path),
    readFile: (path) => {
      const value = files.get(path);
      if (value === undefined) throw new Error('ENOENT');
      return value;
    },
    size: (path) => sizes.get(path) ?? (files.has(path) ? files.get(path)!.length : -1),
    listDirs: (path) => {
      const prefix = `${path}/`;
      const names = new Set<string>();
      for (const key of [...files.keys(), ...sizes.keys()]) {
        if (key.startsWith(prefix)) names.add(key.slice(prefix.length).split('/')[0]!);
      }
      return [...names];
    },
  };
}

const root = '/engines';

describe('本地引擎安装状态判定（item 10：--remove 之后产品必须读成未安装）', () => {
  it('没有 installed.json（= 刚跑过 --remove）→ 未安装 no_marker', () => {
    const state = resolveLocalEngine({ enginesRoot: root, engineId: 'cosyvoice2', version: '0.5b-test', fs: fakeFs({}) });
    expect(state.installed).toBe(false);
    if (state.installed) throw new Error('unreachable');
    expect(state.reason).toBe('no_marker');
    expect(state.detail).toContain('installed.json');
  });

  it('installed.json 不是合法 JSON → corrupt_marker（不当作已安装）', () => {
    const fs = fakeFs({ [`${root}/cosyvoice2/0.5b-test/installed.json`]: '{ not json' });
    const state = resolveLocalEngine({ enginesRoot: root, engineId: 'cosyvoice2', version: '0.5b-test', fs });
    expect(state.installed).toBe(false);
    if (state.installed) throw new Error('unreachable');
    expect(state.reason).toBe('corrupt_marker');
  });

  it('installed.json 属于别的引擎 → wrong_engine', () => {
    const fs = fakeFs({
      [`${root}/cosyvoice2/0.5b-test/installed.json`]: JSON.stringify(marker('gpt-sovits', [{ path: 'llm.pt', bytes: 2 }])),
      [`${root}/cosyvoice2/0.5b-test/llm.pt`]: 2,
    });
    const state = resolveLocalEngine({ enginesRoot: root, engineId: 'cosyvoice2', version: '0.5b-test', fs });
    expect(state.installed).toBe(false);
    if (state.installed) throw new Error('unreachable');
    expect(state.reason).toBe('wrong_engine');
  });

  it('权重文件被删掉 → file_missing（半包不算可用）', () => {
    const fs = fakeFs({
      [`${root}/cosyvoice2/0.5b-test/installed.json`]: JSON.stringify(marker('cosyvoice2', [{ path: 'llm.pt', bytes: 10 }])),
    });
    const state = resolveLocalEngine({ enginesRoot: root, engineId: 'cosyvoice2', version: '0.5b-test', fs });
    expect(state.installed).toBe(false);
    if (state.installed) throw new Error('unreachable');
    expect(state.reason).toBe('file_missing');
    expect(state.detail).toContain('llm.pt');
  });

  it('字节数不符 → size_mismatch', () => {
    const fs = fakeFs({
      [`${root}/cosyvoice2/0.5b-test/installed.json`]: JSON.stringify(marker('cosyvoice2', [{ path: 'llm.pt', bytes: 10 }])),
      [`${root}/cosyvoice2/0.5b-test/llm.pt`]: 9,
    });
    const state = resolveLocalEngine({ enginesRoot: root, engineId: 'cosyvoice2', version: '0.5b-test', fs });
    expect(state.installed).toBe(false);
    if (state.installed) throw new Error('unreachable');
    expect(state.reason).toBe('size_mismatch');
  });

  it('完整安装 → installed，并回传清单', () => {
    const files = [{ path: 'llm.pt', bytes: 10 }, { path: 'flow.pt', bytes: 5 }];
    const fs = fakeFs({
      [`${root}/cosyvoice2/0.5b-test/installed.json`]: JSON.stringify(marker('cosyvoice2', files)),
      [`${root}/cosyvoice2/0.5b-test/llm.pt`]: 10,
      [`${root}/cosyvoice2/0.5b-test/flow.pt`]: 5,
    });
    const state = resolveLocalEngine({ enginesRoot: root, engineId: 'cosyvoice2', version: '0.5b-test', fs });
    expect(state.installed).toBe(true);
    if (!state.installed) throw new Error('unreachable');
    expect(state.marker.files).toHaveLength(2);
    expect(state.path).toBe(`${root}/cosyvoice2/0.5b-test`);
  });

  it('不指定版本时取目录名倒序第一个（多版本共存不互相覆盖）', () => {
    const fs = fakeFs({
      [`${root}/cosyvoice2/0.5b-a/installed.json`]: JSON.stringify(marker('cosyvoice2', [{ path: 'llm.pt', bytes: 1 }])),
      [`${root}/cosyvoice2/0.5b-a/llm.pt`]: 1,
      [`${root}/cosyvoice2/0.5b-b/installed.json`]: JSON.stringify(marker('cosyvoice2', [{ path: 'llm.pt', bytes: 1 }])),
      [`${root}/cosyvoice2/0.5b-b/llm.pt`]: 1,
    });
    const state = resolveLocalEngine({ enginesRoot: root, engineId: 'cosyvoice2', fs });
    expect(state.installed).toBe(true);
    if (!state.installed) throw new Error('unreachable');
    expect(state.path).toBe(`${root}/cosyvoice2/0.5b-b`);
  });
});

describe('档位化降级链（item 10：显式离线档开关，禁止按「装没装」决定优先级）', () => {
  const missing = resolveLocalEngine({ enginesRoot: root, engineId: 'cosyvoice2', fs: fakeFs({}) });
  const installed = resolveLocalEngine({
    enginesRoot: root,
    engineId: 'cosyvoice2',
    version: '0.5b-test',
    fs: fakeFs({
      [`${root}/cosyvoice2/0.5b-test/installed.json`]: JSON.stringify(marker('cosyvoice2', [{ path: 'llm.pt', bytes: 1 }])),
      [`${root}/cosyvoice2/0.5b-test/llm.pt`]: 1,
    }),
  });
  if (!installed.installed) throw new Error('fixture 应为已安装');

  it('默认档（不传 tier）= 商业 API 优先；装了本地引擎也不改变主选', () => {
    const plan = planVoiceFallback({ local: installed, commercialAvailable: true });
    expect(plan.tier).toBe('commercial_default');
    expect(plan.tierHonored).toBe(true);
    expect(plan.primary).toBe('commercial_api');
    expect(plan.plan.map((step) => step.step)).toEqual(['commercial_api', 'local_engine', 'system_tts']);
    // 离线档列在可选位，且降级标记仍是「本地引擎本身不降级」
    expect(plan.plan[1]).toMatchObject({ role: 'optional', degraded: false });
    expect(plan.plan[1]?.reason).toContain('16–43 秒');
    expect(plan.plan[0]?.degraded).toBe(true);
  });

  it('显式离线档：本地引擎排第一且不标降级，商业与系统作为兜底', () => {
    const plan = planVoiceFallback({ local: installed, commercialAvailable: true, tier: 'offline_preferred' });
    expect(plan.tier).toBe('offline_preferred');
    expect(plan.tierHonored).toBe(true);
    expect(plan.primary).toBe('local_engine');
    expect(plan.plan.map((step) => step.step)).toEqual(['local_engine', 'commercial_api', 'system_tts']);
    expect(plan.plan[0]).toMatchObject({ role: 'primary', degraded: false });
    expect(plan.plan.slice(1).every((step) => step.degraded)).toBe(true);
  });

  it('选了离线档但本地未安装：回落商业 API，tierHonored=false 且原因写明未安装', () => {
    const plan = planVoiceFallback({ local: missing, commercialAvailable: true, tier: 'offline_preferred' });
    expect(plan.primary).toBe('commercial_api');
    expect(plan.tierHonored).toBe(false);
    expect(plan.plan[0]?.degraded).toBe(true);
    expect(plan.plan[0]?.reason).toContain('未安装');
  });

  it('默认档下商业 API 不可用但本地已装：本地顶上来做兜底，tierHonored=false', () => {
    const plan = planVoiceFallback({ local: installed, commercialAvailable: false });
    expect(plan.primary).toBe('local_engine');
    expect(plan.tierHonored).toBe(false);
    expect(plan.plan[0]?.role).toBe('primary');
  });

  it('本地与商业都不可用：只剩系统 TTS，仍然如实标注', () => {
    const plan = planVoiceFallback({ local: missing, commercialAvailable: false });
    expect(plan.primary).toBe('system_tts');
    expect(plan.plan).toHaveLength(1);
    expect(plan.plan[0]?.reason).toContain('system_fallback');
  });

  it('系统 TTS 也关掉时返回空计划，由调用方如实报「无可用后端」而不是假装成功', () => {
    const plan = planVoiceFallback({ local: missing, commercialAvailable: false, systemTtsAvailable: false });
    expect(plan.plan).toHaveLength(0);
    expect(plan.primary).toBe('system_tts');
    expect(plan.tierHonored).toBe(false);
  });
});

describe('真实 fs 端口（不注入替身时的行为）', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('空目录 → no_marker；写入完整 installed.json + 文件 → installed；删掉 marker → 回到 no_marker', () => {
    const enginesRoot = mkdtempSync(join(tmpdir(), 'whale-engines-'));
    dirs.push(enginesRoot);
    expect(resolveLocalEngine({ enginesRoot, engineId: 'cosyvoice2', version: 'v1' }).installed).toBe(false);

    const versionDir = join(enginesRoot, 'cosyvoice2', 'v1');
    mkdirSync(versionDir, { recursive: true });
    writeFileSync(join(versionDir, 'llm.pt'), 'hello');
    writeFileSync(join(versionDir, 'installed.json'), JSON.stringify(marker('cosyvoice2', [{ path: 'llm.pt', bytes: 5 }])));
    expect(resolveLocalEngine({ enginesRoot, engineId: 'cosyvoice2', version: 'v1' }).installed).toBe(true);

    // 等价于 fetch-engine.mjs --remove：marker 删掉 → 产品必须立刻读成未安装
    rmSync(join(versionDir, 'installed.json'));
    const after = resolveLocalEngine({ enginesRoot, engineId: 'cosyvoice2', version: 'v1' });
    expect(after.installed).toBe(false);
    if (after.installed) throw new Error('unreachable');
    expect(after.reason).toBe('no_marker');
  });

  it('nodeEngineFs 对不存在的路径返回 -1 / 空数组（不抛错）', () => {
    expect(nodeEngineFs.size('/definitely/not/here')).toBe(-1);
    expect(nodeEngineFs.listDirs('/definitely/not/here')).toEqual([]);
    expect(nodeEngineFs.exists('/definitely/not/here')).toBe(false);
  });
});
