/**
 * T-M6-39：CoopHost 群聊路由与求助接力单测（IPC 处理器级，零网络/零 Electron）。
 * 覆盖：@单角色 → Runner directive；@全队 → Huddle 计划并分发 objective；@未指定普通闲聊不触发任务。
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RulePlanner, type AutodriveEvent, type GameAdapter } from '@workbench/game-bridge-mcp';
import type { McpEndpoint, PetCharacter } from '@workbench/shared-protocol';

const { handlers } = vi.hoisted(() => ({ handlers: new Map<string, (...args: unknown[]) => unknown>() }));
vi.mock('./character-persona', () => ({ characterReflex: () => null }));
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler),
  },
}));

import { createCoopHost, endpointRoutingId, parseChestWood, resolveCoopChatRoute, type CoopBrainHost, type CoopRunnerLike } from './coop-host';

const dirs: string[] = [];
function endpoint(id: string, name: string): McpEndpoint {
  const suffix = id.slice(-1);
  return { id, displayName: name, gameId: 'stardew', endpoint: `http://127.0.0.1:${18080 + Number(suffix)}/mcp`, characterId: suffix === '1' ? 'char-a' : 'char-b', routingId: '', enabled: true };
}

function chars(): PetCharacter[] {
  return [
    { id: 'char-a', displayName: '小鲸（蓝鲸女仆）', manifestPath: '', personaPrompt: '傲娇小鲸', voiceId: 'qiaopi_mengmei', voiceRatePercent: 100, voicePitchMul: 1, packId: '', actionCount: 0, audioClipCount: 0, anchorRatio: 0.5, licenseScope: 'DEV_ONLY_NON_COMMERCIAL', builtin: true, skins: [] },
    { id: 'char-b', displayName: '泡芙（柴犬）', manifestPath: '', personaPrompt: '软萌泡芙', voiceId: 'diadia_xuemei', voiceRatePercent: 100, voicePitchMul: 1, packId: '', actionCount: 0, audioClipCount: 0, anchorRatio: 0.5, licenseScope: 'DEV_ONLY_NON_COMMERCIAL', builtin: true, skins: [] },
  ];
}

class FakeRunner implements CoopRunnerLike {
  readonly sessionId = 'session';
  constructor(private readonly onEvent?: (event: AutodriveEvent) => void) {}
  emit(event: AutodriveEvent): void { this.onEvent?.(event); }
  readonly client = {
    callTool: async (tool: string) => tool === 'list_chests'
      ? { kind: 'ok', text: '成功：“木材”箱子里一共 42 个，在：\nFarm (70,15)：木材 x42\n背包里还有：木材 x6' }
      : { kind: 'ok', text: '位置：农场 体力：80/100 金币：100' },
  };
  running = false;
  directives: Array<{ tool: string; args: Record<string, unknown> }> = [];
  objectives: string[] = [];
  planner: unknown = null;
  isRunning = (): boolean => this.running;
  start = async (): Promise<void> => { this.running = true; };
  stop = (): void => { this.running = false; };
  submitDirective = (tool: string, args: Record<string, unknown>): void => { this.directives.push({ tool, args }); };
  submitObjective = (objective: string): void => { this.objectives.push(objective); };
  setPlanner = (planner: unknown): void => { this.planner = planner; };
}

function fakeAdapter(): GameAdapter {
  return {
    gameId: 'stardew',
    displayName: '星露谷',
    transport: { callTool: async () => ({ kind: 'ok', text: '', isError: false }) },
    ping: async () => true,
    unreachableMessage: '',
    extractClock: () => null,
    isLongAction: () => false,
    classifyReceipt: () => ({ status: 'COMPLETED', summary: 'ok' }),
    toolWhitelist: ['fish'],
    createRulePlanner: () => new RulePlanner(),
  };
}

function fakeBrain(runnerByAgent: Map<string, FakeRunner>): CoopBrainHost {
  void runnerByAgent;
  return {
    createPlanner: () => null,
    tokenBalance: () => 100_000,
    completeForCoop: async (_slot, system) => {
      if (system.includes('把主人的一句指令')) {
        return { content: '{"tool":"fish","args":{"casts":2},"intent":"去钓鱼"}', tokensUsed: 20 };
      }
      if (system.includes('开麦商量')) {
        return { content: '我去海滩钓鱼，泡芙去农场砍树。', tokensUsed: 20 };
      }
      if (system.includes('主持人')) {
        return {
          content: JSON.stringify({
            id: 'plan-team',
            title: '建鸡舍',
            summary: '小鲸钓鱼，泡芙砍树',
            assignments: [
              { agentId: 'agent-1', displayName: '小鲸', task: '钓鱼凑钱', zone: '海滩' },
              { agentId: 'agent-2', displayName: '泡芙', task: '砍 150 木材', zone: '农场' },
            ],
          }),
          tokensUsed: 30,
        };
      }
      return { content: '收到。', tokensUsed: 5 };
    },
  };
}

function setup(initialEndpoints: McpEndpoint[] = [endpoint('agent-1', '小鲸'), endpoint('agent-2', '泡芙')], clock = { value: 1_000_000 }): { call: (channel: string, ...args: unknown[]) => Promise<unknown>; runners: Map<string, FakeRunner>; clock: { value: number } } {
  handlers.clear();
  const dir = mkdtempSync(join(tmpdir(), 'coop-host-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'mcp-endpoints.json'), JSON.stringify(initialEndpoints), 'utf8');
  const runners = new Map<string, FakeRunner>();
  let index = 0;
  createCoopHost({
    userDataDir: dir,
    windows: () => [],
    brain: fakeBrain(runners),
    now: () => clock.value,
    characters: { list: chars, selected: () => chars()[0]!, manifestOf: () => ({ ok: false, error: 'test' }) },
    petWindows: { open: async () => ({ ok: true }), sendAgent: () => undefined } as never,
    voiceHost: { speak: vi.fn(), config: { enabled: true }, setConfig: vi.fn(), speakerState: vi.fn(), stopAll: vi.fn() } as never,
    createAdapter: fakeAdapter,
    createRunner: (onEvent, _options, _adapter) => {
      const runner = new FakeRunner(onEvent);
      const id = `agent-${index + 1}`;
      index++;
      runners.set(id, runner);
      return runner;
    },
  });
  const call = async (channel: string, ...args: unknown[]): Promise<unknown> => {
    const handler = handlers.get(channel);
    if (handler === undefined) throw new Error(`missing handler ${channel}`);
    return handler({}, ...args);
  };
  return { call, runners, clock };
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('resolveCoopChatRoute', () => {
  const targets = [{ agentId: 'a', displayName: '小鲸' }, { agentId: 'b', displayName: '泡芙' }];
  it('@单角色定向，@全队重议，普通闲聊不派活', () => {
    expect(resolveCoopChatRoute('@小鲸 去钓鱼', [], targets)).toEqual({ kind: 'agents', agents: ['a'] });
    expect(resolveCoopChatRoute('@全队 重新分工', [], targets)).toEqual({ kind: 'team', agents: ['a', 'b'] });
    expect(resolveCoopChatRoute('今天大家辛苦啦', [], targets)).toEqual({ kind: 'chat', agents: [] });
    expect(resolveCoopChatRoute('把目标改成先攒木材', [], targets).kind).toBe('team');
  });
});


describe('DST 逻辑玩家路由', () => {
  it('routingId 优先，留空回退端点 id', () => {
    expect(endpointRoutingId({ id: 'agent-1', routingId: '7656119' })).toBe('7656119');
    expect(endpointRoutingId({ id: 'agent-1', routingId: '   ' })).toBe('agent-1');
  });

  it('DST 未配置 Klei UserID 时拒绝接管，避免同 sidecar 串角色', async () => {
    const dst: McpEndpoint = { ...endpoint('agent-dst', '温蒂'), gameId: 'dst', endpoint: 'http://127.0.0.1:18100', routingId: '' };
    const { call } = setup([dst]);
    const result = await call('coop:start', 'agent-dst') as { ok: boolean; error?: string };
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Klei UserID');
  });
});



describe('共同目标真实进度', () => {
  it('list_chests 只统计箱子木材，不把背包木材算进公共进度', () => {
    expect(parseChestWood('“木材”箱子里一共 42 个，在：Farm：木材 x42\n背包里还有：木材 x6')).toBe(42);
    expect(parseChestWood('箱子 A：木材 x10\n箱子 B：木材 x5')).toBe(15);
    expect(parseChestWood('背包里还有：木材 x9')).toBeNull();
  });

  it('goal-set 拉取真实共享木材；状态事件更新团队金币', async () => {
    const { call, runners } = setup();
    await call('coop:start', 'agent-1');
    const saved = await call('coop:goal-set', {
      id: 'goal-1',
      title: '建鸡舍',
      gameId: 'stardew',
      deadline: '',
      status: 'active',
      metrics: [
        { label: '团队金币', current: 0, target: 4_000, unit: 'g', source: 'team_money' },
        { label: '公共木材', current: 0, target: 300, unit: '', source: 'shared_wood' },
      ],
    }) as { ok: boolean };
    expect(saved.ok).toBe(true);
    let board = await call('coop:blackboard-get') as { snapshot: { goal: { metrics: Array<{ source: string; current: number }> } } };
    expect(board.snapshot.goal.metrics.find((metric) => metric.source === 'shared_wood')?.current).toBe(42);
    runners.get('agent-1')?.emit({ type: 'state', clock: '第1天 10:00', stamina: 90, staminaMax: 100, money: 1_234, location: '农场', health: 100, healthMax: 100, freeSlots: 10 });
    board = await call('coop:blackboard-get') as { snapshot: { goal: { metrics: Array<{ source: string; current: number }> } } };
    expect(board.snapshot.goal.metrics.find((metric) => metric.source === 'team_money')?.current).toBe(1_234);
  });
});

describe('自动求助', () => {
  it('低体力持续 ≥30s 自动发起 need_help 并交接给空闲队友', async () => {
    const clock = { value: 1_000_000 };
    const { call, runners } = setup(undefined, clock);
    await call('coop:start', 'agent-1');
    await call('coop:start', 'agent-2');
    const low = { type: 'state' as const, clock: '第1天 10:00', stamina: 5, staminaMax: 100, money: 100, location: '农场', health: 80, healthMax: 100, freeSlots: 4 };
    runners.get('agent-1')?.emit(low);
    clock.value += 31_000;
    runners.get('agent-1')?.emit({ ...low, clock: '第1天 10:10' });
    await vi.waitFor(() => {
      expect(runners.get('agent-2')?.objectives.some((item) => item.includes('支援'))).toBe(true);
    });
    const board = await call('coop:blackboard-get') as { snapshot: { assignments: Array<{ agentId: string; status: string; task: string }> }; messages: Array<{ kind: string }> };
    expect(board.snapshot.assignments.find((item) => item.agentId === 'agent-1')?.status).toBe('idle');
    expect(board.messages.some((item) => item.kind === 'need_help')).toBe(true);
    expect(board.messages.some((item) => item.kind === 'handoff')).toBe(true);
  });

  it('短时低体力抖动不求助', async () => {
    const clock = { value: 2_000_000 };
    const { call, runners } = setup(undefined, clock);
    await call('coop:start', 'agent-1');
    await call('coop:start', 'agent-2');
    const low = { type: 'state' as const, clock: '第1天 10:00', stamina: 5, staminaMax: 100, money: 100, location: '农场', health: 80, healthMax: 100, freeSlots: 4 };
    runners.get('agent-1')?.emit(low);
    clock.value += 10_000;
    runners.get('agent-1')?.emit({ ...low, clock: '第1天 10:02' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(runners.get('agent-2')?.objectives).toEqual([]);
  });
});

describe('CoopHost IPC（T-M6-39）', () => {
  it('@单角色 → 该 Agent Runner 收到 P0 directive，另一只不接单', async () => {
    const { call, runners } = setup();
    await call('coop:start', 'agent-1');
    await call('coop:start', 'agent-2');
    const result = await call('coop:chat-send', { text: '@小鲸 去钓两条鱼' }) as { ok: boolean; route?: string };
    expect(result).toMatchObject({ ok: true, route: 'agents' });
    expect(runners.get('agent-1')?.directives[0]).toMatchObject({ tool: 'fish', args: { casts: 2 } });
    expect(runners.get('agent-2')?.directives).toEqual([]);
  });

  it('@全队 → Huddle 写入两份分工并向两个 Runner 下发 objective', async () => {
    const { call, runners } = setup();
    await call('coop:start', 'agent-1');
    await call('coop:start', 'agent-2');
    const result = await call('coop:chat-send', { text: '@全队 我们重新分工建鸡舍' }) as { ok: boolean; route?: string; fallback?: boolean };
    expect(result).toMatchObject({ ok: true, route: 'team', fallback: false });
    expect(runners.get('agent-1')?.objectives.some((item) => item.includes('钓鱼'))).toBe(true);
    expect(runners.get('agent-2')?.objectives.some((item) => item.includes('砍'))).toBe(true);
    const board = await call('coop:blackboard-get') as { snapshot: { assignments: Array<{ agentId: string; task: string }> } };
    expect(board.snapshot.assignments.find((item) => item.agentId === 'agent-1')?.task).toBe('钓鱼凑钱');
  });

  it('普通闲聊只进群聊，不触发 Huddle 或 directive', async () => {
    const { call, runners } = setup();
    await call('coop:start', 'agent-1');
    const result = await call('coop:chat-send', { text: '今天大家辛苦啦' }) as { ok: boolean; route?: string };
    expect(result).toMatchObject({ ok: true, route: 'chat' });
    expect(runners.get('agent-1')?.directives).toEqual([]);
    expect(runners.get('agent-1')?.objectives).toEqual([]);
  });

  it('求助：有另一个待命队友时自动交接区域锁与支援任务', async () => {
    const { call, runners } = setup();
    await call('coop:start', 'agent-1');
    await call('coop:start', 'agent-2');
    const result = await call('coop:help-request', { agentId: 'agent-1', reason: '背包满了，农场箱子太远' }) as { ok: boolean; mode?: string; helperAgentId?: string };
    expect(result).toMatchObject({ ok: true, mode: 'handoff', helperAgentId: 'agent-2' });
    expect(runners.get('agent-2')?.objectives.some((item) => item.includes('支援'))).toBe(true);
    const board = await call('coop:blackboard-get') as { snapshot: { assignments: Array<{ agentId: string; status: string; task: string }> } };
    expect(board.snapshot.assignments.find((item) => item.agentId === 'agent-1')?.status).toBe('idle');
    expect(board.snapshot.assignments.find((item) => item.agentId === 'agent-2')?.task).toContain('支援');
  });
});
