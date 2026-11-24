/** 免 Hook 日志监听（T-M6-65）：只读字段、启动 EOF、增量 offset、截断重置、坏行容错、零正文残留。 */
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCliLogWatcher, parseClaudeJsonlLine, parseCodexJsonlLine } from './cli-log-watcher';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cli-log-'));
  dirs.push(dir);
  return dir;
}

const SECRET = '超机密对话正文：API_KEY=sk-should-never-leak';

describe('parseClaudeJsonlLine：只取工具名/模型/时间', () => {
  it('assistant tool_use → tool/asking；end_turn → stop；compact 边界 → compact', () => {
    const tool = parseClaudeJsonlLine(JSON.stringify({
      type: 'assistant', sessionId: 's1', timestamp: '2026-11-24T10:00:00Z',
      message: { model: 'claude-sonnet', stop_reason: 'tool_use', content: [
        { type: 'text', text: SECRET },
        { type: 'tool_use', name: 'Read', input: { file_path: SECRET } },
        { type: 'tool_use', name: 'AskUserQuestion', input: { question: SECRET } },
      ] },
    }), 1);
    expect(tool?.sessionId).toBe('s1');
    expect(tool?.events).toHaveLength(2);
    expect(tool?.events[0]).toMatchObject({ source: 'claude', kind: 'tool', toolName: 'Read', modelName: 'claude-sonnet', origin: 'log-watch' });
    expect(tool?.events[1]).toMatchObject({ kind: 'asking', toolName: 'AskUserQuestion' });
    // 零正文残留：事件 JSON 里不出现对话文本/命令参数
    expect(JSON.stringify(tool?.events)).not.toContain('超机密');

    const end = parseClaudeJsonlLine(JSON.stringify({
      type: 'assistant', sessionId: 's1', message: { model: 'claude-sonnet', stop_reason: 'end_turn', content: [{ type: 'text', text: SECRET }] },
    }), 5);
    expect(end?.events).toEqual([expect.objectContaining({ kind: 'stop', toolName: '' })]);

    const compact = parseClaudeJsonlLine(JSON.stringify({ type: 'system', subtype: 'compact_boundary', sessionId: 's1' }), 9);
    expect(compact?.events[0]).toMatchObject({ kind: 'compact' });
  });

  it('坏 JSON/缺 sessionId/非工具 block 不产生事件', () => {
    expect(parseClaudeJsonlLine('{oops', 1)).toBeNull();
    expect(parseClaudeJsonlLine('[]', 1)).toBeNull();
    expect(parseClaudeJsonlLine(JSON.stringify({ type: 'assistant', message: {} }), 1)).toBeNull();
    const textOnly = parseClaudeJsonlLine(JSON.stringify({ type: 'assistant', sessionId: 's', message: { content: [{ type: 'text', text: SECRET }] } }), 1);
    expect(textOnly?.events).toEqual([]);
  });
});

describe('parseCodexJsonlLine：payload.type/name/model', () => {
  it('task_started/function_call/task_complete 映射 start/tool/stop', () => {
    const start = parseCodexJsonlLine(JSON.stringify({ timestamp: '2026-11-24T10:00:00Z', payload: { type: 'task_started', id: 'c1', model: 'gpt-5' } }), 1);
    expect(start?.events[0]).toMatchObject({ source: 'codex', kind: 'start', modelName: 'gpt-5' });
    const call = parseCodexJsonlLine(JSON.stringify({ payload: { type: 'function_call', name: 'shell', arguments: SECRET, session_id: 'c1' } }), 1);
    expect(call?.events[0]).toMatchObject({ kind: 'tool', toolName: 'shell', origin: 'log-watch' });
    expect(JSON.stringify(call?.events)).not.toContain('超机密');
    const done = parseCodexJsonlLine(JSON.stringify({ payload: { type: 'task_complete', session_id: 'c1' } }), 1);
    expect(done?.events[0]).toMatchObject({ kind: 'stop' });
  });

  it('session_id 回退 payload.id 与文件名兜底；坏行/空 payload 返回 null', () => {
    expect(parseCodexJsonlLine(JSON.stringify({ payload: { type: 'custom_tool_call', id: 'p1', name: 'apply_patch' } }), 1)?.sessionId).toBe('p1');
    expect(parseCodexJsonlLine(JSON.stringify({ payload: { type: 'task_started' } }), 1, 'fallback')?.sessionId).toBe('fallback');
    expect(parseCodexJsonlLine('{oops', 1)).toBeNull();
    expect(parseCodexJsonlLine(JSON.stringify({ payload: {} }), 1)).toBeNull();
  });
});

describe('createCliLogWatcher：启动 EOF + 增量消费', () => {
  function setup(): { dir: string; claudeFile: string; roots: string[] } {
    const dir = temp();
    const claudeDir = join(dir, '.claude', 'projects', 'proj');
    mkdirSync(claudeDir, { recursive: true });
    const claudeFile = join(claudeDir, 'session.jsonl');
    writeFileSync(claudeFile, `${JSON.stringify({ type: 'assistant', sessionId: 'old', message: { content: [{ type: 'tool_use', name: 'Historical' }] } })}\n`);
    return { dir, claudeFile, roots: [join(dir, '.claude', 'projects'), join(dir, '.codex', 'sessions')] };
  }

  it('启动时已有文件定位末尾（不把历史当正在干活）；新增行增量解析且 start 只发一次', () => {
    const { dir, claudeFile, roots } = setup();
    const events: Array<Record<string, unknown>> = [];
    const watcher = createCliLogWatcher({
      homeDir: dir, roots, pollMs: 0, activeWindowMs: 60 * 60_000,
      now: () => 1_000_000,
      onEvent: (event) => events.push(event as unknown as Record<string, unknown>),
    });
    expect(watcher.scanOnce()).toBe(0); // prime + 现有文件 EOF
    expect(events).toEqual([]);
    appendFileSync(claudeFile, `${JSON.stringify({ type: 'assistant', sessionId: 'live', timestamp: 1_000_001, message: { model: 'glm-5', stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Read' }] } })}\n`);
    expect(watcher.scanOnce()).toBe(2); // start + tool
    expect(events.map((event) => event.kind)).toEqual(['start', 'tool']);
    expect(events[1]).toMatchObject({ source: 'claude', sessionId: 'live', toolName: 'Read', origin: 'log-watch' });
    expect(watcher.scanOnce()).toBe(0);
    appendFileSync(claudeFile, 'not-json\n');
    expect(watcher.scanOnce()).toBe(0);
    appendFileSync(claudeFile, `${JSON.stringify({ type: 'assistant', sessionId: 'live', message: { stop_reason: 'end_turn', content: [] } })}\n`);
    expect(watcher.scanOnce()).toBe(1);
    expect(events.at(-1)).toMatchObject({ kind: 'stop' });
    watcher.stop();
  });

  it('截断/轮转后 offset 重置；新出现文件从 0 读', () => {
    const { dir, claudeFile, roots } = setup();
    const events: Array<Record<string, unknown>> = [];
    const watcher = createCliLogWatcher({
      homeDir: dir, roots, pollMs: 0, activeWindowMs: 60 * 60_000, now: () => 2_000_000,
      onEvent: (event) => events.push(event as unknown as Record<string, unknown>),
    });
    watcher.scanOnce();
    const rewritten = `${JSON.stringify({ type: 'assistant', sessionId: 'rotated', message: { stop_reason: 'end_turn', content: [] } })}\n`;
    writeFileSync(claudeFile, rewritten); // 比原偏移短 → 重置
    expect(watcher.scanOnce()).toBe(2); // start + stop（start 由新 session 触发）
    expect(events.map((event) => event.kind)).toEqual(['start', 'stop']);

    const codexDir = join(dir, '.codex', 'sessions', '2026', '11', '24');
    mkdirSync(codexDir, { recursive: true });
    const codexFile = join(codexDir, 'rollout-2026-11-24T10-00-00-01a20c73-5182-7fb3-a663-1e22e0ba1582.jsonl');
    writeFileSync(codexFile, `${JSON.stringify({ payload: { type: 'function_call', name: 'shell', arguments: SECRET } })}\n`);
    const emitted = watcher.scanOnce();
    expect(emitted).toBe(2); // start（sessionId 来自文件名）+ tool
    expect(events.at(-1)).toMatchObject({ source: 'codex', toolName: 'shell' });
    expect(events.at(-1)).not.toMatchObject({ arguments: expect.anything() });
    expect(watcher.watchedFiles()).toHaveLength(2);
    watcher.stop();
  });

  it('enabled=false 时不读盘、不产生事件', () => {
    const { dir, claudeFile, roots } = setup();
    const events: unknown[] = [];
    const watcher = createCliLogWatcher({ homeDir: dir, roots, pollMs: 0, enabled: () => false, onEvent: (event) => events.push(event) });
    appendFileSync(claudeFile, `${JSON.stringify({ type: 'assistant', sessionId: 'x', message: { stop_reason: 'end_turn', content: [] } })}\n`);
    expect(watcher.scanOnce()).toBe(0);
    expect(events).toEqual([]);
    watcher.stop();
  });
});
