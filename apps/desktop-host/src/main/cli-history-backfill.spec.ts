/** 冷启动只读历史补录（T-M6-65）：只统计工具/模型/时间、幂等 marker、零正文残留。 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { backfillCliHistory, backfillMarkerPath, countToolsInLine, familyOfModel } from './cli-history-backfill';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'backfill-'));
  dirs.push(dir);
  return dir;
}
const SECRET = '机密正文：rm -rf / 与 API_KEY=sk-leak';

describe('countToolsInLine', () => {
  it('Claude tool_use 逐块计数 + 模型/时间；绝不读取 text/input', () => {
    const counted = countToolsInLine(JSON.stringify({
      type: 'assistant',
      timestamp: '2026-11-24T02:00:00Z',
      message: { model: 'claude-sonnet', content: [
        { type: 'text', text: SECRET },
        { type: 'tool_use', name: 'Bash', input: { command: SECRET } },
        { type: 'tool_use', name: 'Read', input: { path: SECRET } },
      ] },
    }));
    expect(counted).toMatchObject({ model: 'claude-sonnet', tools: 2 });
    expect(JSON.stringify(counted)).not.toContain('超机密');
    expect(JSON.stringify(counted)).not.toContain('机密正文');
  });

  it('Codex function_call/custom_tool_call 计数；坏行/null/无工具返回安全值', () => {
    expect(countToolsInLine(JSON.stringify({ payload: { type: 'function_call', name: 'shell', arguments: SECRET }, timestamp: 123 }))).toMatchObject({ tools: 1, ts: 123 });
    expect(countToolsInLine(JSON.stringify({ payload: { type: 'custom_tool_call' } }))).toMatchObject({ tools: 1 });
    expect(countToolsInLine('{oops')).toBeNull();
    expect(countToolsInLine('null')).toBeNull();
    expect(countToolsInLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: SECRET }] } }))).toMatchObject({ tools: 0 });
  });
});

describe('familyOfModel', () => {
  it('8 家 + unknown', () => {
    expect(familyOfModel('claude-sonnet')).toBe('claude');
    expect(familyOfModel('gpt-5-codex')).toBe('gpt');
    expect(familyOfModel('gemini-2.5')).toBe('gemini');
    expect(familyOfModel('deepseek-v4')).toBe('deepseek');
    expect(familyOfModel('qwen-max')).toBe('qwen');
    expect(familyOfModel('kimi-k2')).toBe('kimi');
    expect(familyOfModel('glm-5')).toBe('glm');
    expect(familyOfModel('grok-4')).toBe('grok');
    expect(familyOfModel('mystery')).toBe('unknown');
  });
});

describe('backfillCliHistory', () => {
  function fixture(): { root: string; userData: string } {
    const root = temp();
    const userData = join(root, 'user-data');
    const claudeDir = join(root, '.claude', 'projects', 'p1');
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, 'a.jsonl'), [
      JSON.stringify({ timestamp: '2026-11-20T10:00:00Z', message: { model: 'claude-sonnet', content: [{ type: 'tool_use', name: 'Read', input: { secret: SECRET } }] } }),
      JSON.stringify({ timestamp: '2026-11-20T10:01:00Z', message: { model: 'claude-sonnet', content: [{ type: 'tool_use', name: 'Bash' }, { type: 'text', text: SECRET }] } }),
      'not-json',
    ].join('\n'));
    const codexDir = join(root, '.codex', 'sessions', '2026', '11', '21');
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(join(codexDir, 'rollout-x.jsonl'), `${JSON.stringify({ timestamp: '2026-11-21T09:00:00Z', payload: { type: 'function_call', name: 'shell', model: 'gpt-5', arguments: SECRET } })}\n`);
    return { root, userData };
  }

  it('统计轮数/最忙日期/家族分布并写 marker；二次调用幂等不再扫描', async () => {
    const { root, userData } = fixture();
    const first = await backfillCliHistory({ userDataDir: userData, roots: [join(root, '.claude', 'projects'), join(root, '.codex', 'sessions')] });
    expect(first).toMatchObject({ ok: true, already: false, scannedFiles: 2, rounds: 3, busiestDate: '2026-11-20', byFamily: { claude: 2, gpt: 1 } });
    expect(existsSync(backfillMarkerPath(userData))).toBe(true);
    const marker = JSON.parse(readFileSync(backfillMarkerPath(userData), 'utf8'));
    expect(JSON.stringify(marker)).not.toContain('机密正文');
    expect(marker).toMatchObject({ version: 1, rounds: 3, scannedFiles: 2 });

    const second = await backfillCliHistory({ userDataDir: userData, roots: [join(root, '.claude', 'projects')] });
    expect(second).toMatchObject({ ok: true, already: true, rounds: 3, scannedFiles: 2 });
  });

  it('坏 marker 触发重新扫描；超大文件跳过；空目录如实返回 0', async () => {
    const { root, userData } = fixture();
    mkdirSync(join(userData, 'friendship'), { recursive: true });
    writeFileSync(backfillMarkerPath(userData), '{broken', 'utf8');
    const limited = await backfillCliHistory({ userDataDir: userData, roots: [join(root, '.claude', 'projects'), join(root, '.codex', 'sessions')], maxFileBytes: 10 });
    expect(limited).toMatchObject({ ok: true, scannedFiles: 0, rounds: 0, busiestDate: '' });

    const emptyUser = join(temp(), 'empty');
    const empty = await backfillCliHistory({ userDataDir: emptyUser, roots: [join(root, 'nope')] });
    expect(empty).toMatchObject({ scannedFiles: 0, rounds: 0, busiestDate: '' });
    expect(empty.byFamily).toEqual({});
  });
});
