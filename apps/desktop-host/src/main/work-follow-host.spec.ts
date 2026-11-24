/** 跨 AI 工作跟随（T-M6-49）：只读事件、模式策略、皇冠阈值、JSONL 钩子消费。 */
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));

import { characterForWorkFollow, createWorkFollowHost, CROWN_TOOL_THRESHOLD, SOURCE_CHARACTER } from './work-follow-host';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function makeHost(overrides: Partial<Parameters<typeof createWorkFollowHost>[0]> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'work-follow-'));
  dirs.push(dir);
  const summoned: string[] = [];
  const switched: string[] = [];
  const crowns: string[] = [];
  const host = createWorkFollowHost({
    userDataDir: dir,
    pollMs: 0,
    summon: (characterId) => summoned.push(characterId),
    switchCharacter: (characterId) => switched.push(characterId),
    onCrown: (session) => crowns.push(session.sessionId),
    ...overrides,
  });
  return { host, dir, summoned, switched, crowns };
}

describe('work-follow', () => {
  it('拒绝非法事件；multi 模式按来源召唤对应 CrossPet 角色', () => {
    const { host, summoned } = makeHost();
    expect(host.ingest({ source: 'nope', sessionId: 's1', kind: 'start' })).toMatchObject({ ok: false });
    expect(host.ingest({ source: 'claude', sessionId: '', kind: 'start' })).toMatchObject({ ok: false });
    expect(host.ingest({ source: 'claude', sessionId: 's1', kind: 'start', taskTitle: '重构' })).toEqual({ ok: true });
    expect(summoned).toEqual([SOURCE_CHARACTER.claude]);
    expect(host.status().sessions[0]).toMatchObject({ source: 'claude', sessionId: 's1', active: true, taskTitle: '重构', characterId: 'crosspet-claude' });
  });

  it('工具调用 ≥ 8 首次戴皇冠且只触发一次；stop 置为 inactive；recent 最多 20 条', () => {
    const { host, crowns } = makeHost();
    host.ingest({ source: 'codex', sessionId: 'c1', kind: 'start' });
    for (let index = 0; index < CROWN_TOOL_THRESHOLD + 2; index += 1) {
      host.ingest({ source: 'codex', sessionId: 'c1', kind: 'tool', toolName: 'shell' });
    }
    expect(crowns).toEqual(['c1']);
    expect(host.status().sessions[0]).toMatchObject({ toolCalls: CROWN_TOOL_THRESHOLD + 2, crowned: true });
    host.ingest({ source: 'codex', sessionId: 'c1', kind: 'stop' });
    expect(host.status().sessions[0]?.active).toBe(false);
    for (let index = 0; index < 30; index += 1) host.ingest({ source: 'gemini', sessionId: `g-${index}`, kind: 'start' });
    expect(host.status().recent).toHaveLength(20);
  });

  it('single 模式启动新会话时切换主宠角色，且持久化模式', () => {
    const { host, dir, switched, summoned } = makeHost();
    host.setMode('single');
    host.ingest({ source: 'qwen', sessionId: 'q1', kind: 'start' });
    expect(switched).toEqual(['crosspet-qwen']);
    expect(summoned).toEqual([]); // single 不召唤新窗
    expect(JSON.parse(readFileSync(join(dir, 'work-follow.json'), 'utf8'))).toEqual({ mode: 'single' });
    const reloaded = createWorkFollowHost({ userDataDir: dir, pollMs: 0 });
    expect(reloaded.mode()).toBe('single');
  });

  it('本机 CLI 钩子 JSONL：坏行跳过、按偏移增量消费', async () => {
    const { host, dir, summoned } = makeHost({ pollMs: 20 });
    const inbox = join(dir, 'work-follow', 'events.jsonl');
    appendFileSync(inbox, `${JSON.stringify({ source: 'kimi', sessionId: 'k1', kind: 'start' })}\nnot-json\n`);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(summoned).toEqual(['crosspet-kimi']);
    appendFileSync(inbox, `${JSON.stringify({ source: 'kimi', sessionId: 'k1', kind: 'tool', toolName: 'Read' })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(host.status().sessions[0]?.toolCalls).toBe(1);
    host.dispose();
  });

  it('连通性自检：写入受控事件 → 文件轮询消费 → 状态更新 ≤1.5s', async () => {
    const { host } = makeHost({ pollMs: 50 });
    const result = await host.selfTest();
    host.dispose();
    expect(result.ok).toBe(true);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(result.elapsedMs).toBeLessThanOrEqual(1_500);
    const selfTest = host.status().sessions.find((session) => session.sessionId.startsWith('self-test-'));
    expect(selfTest?.taskTitle).toBe('鲸屿连通性自检');
  });

  it('轮询关闭时自检如实失败（绝不伪造通过）', async () => {
    const { host } = makeHost({ pollMs: 0 });
    const result = await host.selfTest();
    host.dispose();
    expect(result.ok).toBe(false);
    expect(result.error).toContain('1.5s');
  }, 5_000);
});


describe('work-follow modelName 映射与闲置退场（T-M6-51）', () => {
  it('先按 modelName 匹配角色，未命中回退来源', () => {
    expect(characterForWorkFollow({ source: 'acp', modelName: 'claude-sonnet-4' })).toBe('crosspet-claude');
    expect(characterForWorkFollow({ source: 'qwen', modelName: 'gpt-4o' })).toBe('crosspet-gpt');
    expect(characterForWorkFollow({ source: 'acp', modelName: 'deepseek-v4' })).toBe('crosspet-deepseek');
    expect(characterForWorkFollow({ source: 'cursor', modelName: '' })).toBe(SOURCE_CHARACTER.cursor);
  });

  it('single 模式下 tool 事件命中新模型同样换装', () => {
    const switched: string[] = [];
    const { host } = makeHost({ switchCharacter: (id) => switched.push(id) });
    host.setMode('single');
    host.ingest({ source: 'acp', sessionId: 's1', kind: 'start', modelName: 'claude-3-7' });
    expect(switched).toEqual(['crosspet-claude']);
    host.ingest({ source: 'acp', sessionId: 's1', kind: 'tool', toolName: 'Bash', modelName: 'gemini-2.5' });
    expect(switched).toEqual(['crosspet-claude', 'crosspet-gemini']);
    // 同一角色继续调用不重复换装
    host.ingest({ source: 'acp', sessionId: 's1', kind: 'tool', toolName: 'Read', modelName: 'gemini-2.5' });
    expect(switched).toHaveLength(2);
  });

  it('multi 模式闲置 60s 自动退场并回调；single 模式不回调窗口关闭', async () => {
    vi.useFakeTimers();
    let clock = 1_000_000;
    const idled: string[] = [];
    const { host } = makeHost({ now: () => clock, idleTimeoutMs: 60_000, onSessionIdle: (session) => idled.push(session.sessionId) });
    host.ingest({ source: 'claude', sessionId: 'a1', kind: 'start' });
    clock += 30_000;
    vi.advanceTimersByTime(5_000);
    expect(idled).toEqual([]);
    clock += 31_000;
    vi.advanceTimersByTime(5_000);
    expect(idled).toEqual(['a1']);
    expect(host.status().sessions[0]?.active).toBe(false);
    host.dispose();

    const single = makeHost({ now: () => clock, idleTimeoutMs: 60_000, onSessionIdle: (session) => idled.push(session.sessionId) }).host;
    single.setMode('single');
    single.ingest({ source: 'claude', sessionId: 'b1', kind: 'start' });
    clock += 120_000;
    vi.advanceTimersByTime(5_000);
    expect(idled).toEqual(['a1']);
    single.dispose();
    vi.useRealTimers();
  });
});


describe('reactTo 代演与姿态回调（T-M6-53）', () => {
  it('resolveCharacter 命中自定义角色时优先于来源/modelName 映射', () => {
    const summoned: string[] = [];
    const { host } = makeHost({
      summon: (characterId) => summoned.push(characterId),
      resolveCharacter: (event) => (event.modelName.includes('claude') ? 'custom-seal' : null),
    });
    host.ingest({ source: 'acp', sessionId: 's1', kind: 'start', modelName: 'claude-sonnet' });
    expect(summoned).toEqual(['custom-seal']);
    expect(host.status().sessions[0]?.characterId).toBe('custom-seal');
  });

  it('start/tool/stop 分别回调 listening / compact / bye', () => {
    const poses: string[] = [];
    const { host } = makeHost({ onAgentPose: (_session, pose) => poses.push(pose) });
    host.ingest({ source: 'claude', sessionId: 'p1', kind: 'start' });
    host.ingest({ source: 'claude', sessionId: 'p1', kind: 'tool', toolName: 'CompactContext' });
    host.ingest({ source: 'claude', sessionId: 'p1', kind: 'tool', toolName: 'Read' });
    host.ingest({ source: 'claude', sessionId: 'p1', kind: 'stop' });
    expect(poses).toEqual(['listening', 'compact', 'writing', 'bye']);
  });
});
