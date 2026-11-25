/**
 * 现场包 → 剧本草稿（T-M6-68）：用 soak-real 的 writeStuckPack 造真实格式的假现场包，
 * 再走转换器；产物必须能被 loadScenarios 直接读取（expect 为占位，人工补全）。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeStuckPack } from '@workbench/soak-real/evidence';
import { failureSignature, type StuckVerdict } from '@workbench/soak-real/stuck-detector';
import { main, packToScenario, readPackEvents, rulesFromEvents } from './pack-to-scenario';
import { loadScenarios } from './stuck-scenario';

const VERDICT: StuckVerdict = {
  kind: 'repeat-failure',
  signature: 'fish|背包里没有鱼竿|Beach',
  detail: '同一失败签名 3 次（最近 30 条回执内）',
  at: Date.UTC(2026, 10, 24, 9, 30, 0),
  location: 'Beach',
  clock: '第1年夏2日 07:10',
};

const STATE = '## 基本状态\n时间：第1年夏2日 07:10，天气：晴\n## 当前界面\n无（可以自由行动）\n## 位置\n地点：Beach（沙滩）\n';

const EVENTS = [
  { type: 'state', clock: '第1年夏2日 07:10', location: 'Beach' },
  { type: 'decision', planner: 'llm-xiaojing', tool: 'fish', args: {}, intent: '去钓鱼' },
  { type: 'receipt', tool: 'fish', status: 'FAILED', summary: '失败：背包里没有鱼竿（第二天早上上海边找威利 Willy 会送你一根）' },
  { type: 'receipt', tool: 'fish', status: 'FAILED', summary: '失败：背包里没有鱼竿' },
  { type: 'receipt', tool: 'forage', status: 'COMPLETED', summary: 'OK forage: 采集到 2 个海草' },
  { type: 'receipt', tool: 'autodrive', status: 'COMPLETED', summary: '达到 maxCycles' },
];

function makePack(events: readonly unknown[] = EVENTS, verdict: StuckVerdict | null = VERDICT): string {
  const runDir = mkdtempSync(join(tmpdir(), 'pack-to-scenario-'));
  if (verdict === null) return runDir;
  const pack = writeStuckPack(
    {
      runDir,
      saveDir: null,
      captureScreen: (file) => { writeFileSync(file, 'png'); return { ok: true }; },
    },
    { index: 1, verdict, events, stateText: STATE, planner: { planner: 'llm-xiaojing' }, dayKey: 'Y1-夏-2', clock: VERDICT.clock },
  );
  return join(runDir, pack.dir);
}

describe('现场包 → 剧本草稿', () => {
  it('读 verdict/last50/state，生成可加载的剧本（signature 复用 failureSignature 口径）', () => {
    const packDir = makePack();
    const draft = packToScenario({ packDir });
    expect(draft.id).toMatch(/^S\d{2}-[a-z0-9-]+$/);
    expect(draft.id).toContain('repeat-failure');
    expect(draft.signature).toBe(VERDICT.signature);
    expect(draft.source).toContain(packDir);
    expect(draft.initialState).toContain('地点：Beach');
    expect(draft.rules[0]).toMatchObject({ tool: 'fish', receipt: { isError: true } });
    expect(draft.rules.at(-1)?.tool).toBe('*');
    expect(draft.rules.some((rule) => rule.tool === 'autodrive')).toBe(false);
    expect(draft.expect).toEqual({ maxCycles: 40, maxSameFailure: 2 });

    // 产物能被 loadScenarios 直接读取（草稿格式与正式剧本同构）
    const dir = mkdtempSync(join(tmpdir(), 'pack-draft-'));
    writeFileSync(join(dir, 'S99-draft.json'), JSON.stringify(draft), 'utf8');
    expect(loadScenarios(dir)[0]?.signature).toBe(VERDICT.signature);
  });

  it('verdict 没有 signature 时用 failureSignature 现场计算', () => {
    const packDir = makePack(EVENTS, { ...VERDICT, signature: undefined as unknown as string });
    const draft = packToScenario({ packDir });
    expect(draft.signature).toBe(failureSignature('fish', '失败：背包里没有鱼竿（第二天早上上海边找威利 Willy 会送你一根）', 'Beach'));
    expect(draft.signature).toContain('|Beach');
  });

  it('缺 verdict.json 直接报错；空 state.txt 用占位说明；坏行跳过', () => {
    const empty = makePack(EVENTS, null);
    expect(() => packToScenario({ packDir: empty })).toThrow(/verdict\.json/);

    const packDir = makePack();
    writeFileSync(join(packDir, 'last50.jsonl'), '{bad line\n[]\n{"type":"receipt","tool":"wait","status":"COMPLETED","summary":"OK wait"}\n', 'utf8');
    expect(readPackEvents(join(packDir, 'last50.jsonl'))).toHaveLength(1);
    expect(rulesFromEvents(readPackEvents(join(packDir, 'last50.jsonl'))).map((rule) => rule.tool)).toEqual(['wait', '*']);

    const stateFile = join(packDir, 'state.txt');
    writeFileSync(stateFile, '', 'utf8');
    expect(packToScenario({ packDir }).initialState).toBe('(空状态快照)');
    expect(readFileSync(stateFile, 'utf8')).toBe('');
  });

  it('idHint 参与 id；同一工具的多条回执只保留第一条', () => {
    const packDir = makePack();
    const draft = packToScenario({ packDir, idHint: 'field2' });
    expect(draft.id).toBe('S99-draft-repeat-failure-fish-field2');
    expect(draft.rules.filter((rule) => rule.tool === 'fish')).toHaveLength(1);
  });

  it('缺 state.txt 时用占位说明，不编造状态文本', () => {
    const packDir = makePack();
    rmSync(join(packDir, 'state.txt'));
    expect(packToScenario({ packDir }).initialState).toContain('缺少 state.txt');
  });
});

describe('CLI（pnpm tsx tools/mock-harness/src/pack-to-scenario.ts）', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('无参数 → 用法 + 退出码 2；--help → 退出码 0', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(main([])).toBe(2);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('用法'));
    expect(main(['--help'])).toBe(0);
  });

  it('成功：stdout 输出可解析的剧本 JSON；--out 落盘', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const packDir = makePack();
    expect(main([packDir])).toBe(0);
    const printed = String(log.mock.calls[0]?.[0] ?? '');
    expect(JSON.parse(printed)).toMatchObject({ signature: VERDICT.signature });

    const out = join(mkdtempSync(join(tmpdir(), 'pack-out-')), 'draft.json');
    expect(main([packDir, '--out', out])).toBe(0);
    expect(JSON.parse(readFileSync(out, 'utf8'))).toMatchObject({ signature: VERDICT.signature });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('expect 需人工补全'));
  });

  it('转换失败 → stderr 报错并退出码 1', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(main([mkdtempSync(join(tmpdir(), 'no-pack-'))])).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('转换失败'));
  });
});
