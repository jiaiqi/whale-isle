/**
 * V2-P1-06 — 星露谷 AI-First 自主游玩与控制权执行闭环（Blueprint 17 §5.1 & §12）
 * 覆盖：
 *   1. GameCharacterControlLease（人类接管/急停/安全暂停/TTL/stale sessionId & generation 拒绝）
 *   2. 13 项快捷控制语义解析（parseControlCommand）
 *   3. PausedBrainPlanner & LlmPlanner 默认安全暂停（RulePlanner.decide === 0）
 *   4. AutodriveRunner.emergencyStop（真实 cancel_action）/ pauseAi / resumeAi / inspectStatus
 *   5. Blueprint 17 §12 全部 12 项核心验收场景（确定性 [SIMULATION]）
 */
import { describe, expect, it, vi } from 'vitest';
import {
  AutodriveRunner,
  GameCharacterControlLease,
  LlmPlanner,
  PausedBrainPlanner,
  RulePlanner,
  StrategyNotebook,
  parseControlCommand,
  parseGameState,
  type AutodriveEvent,
  type GameAdapter,
} from './index';

const BASE_RAW = `时间：第1年春16日 09:00（Tue），天气：晴，明天天气：晴
金钱：1200g  体力：240/270  生命：100/100
## 当前界面
无（可以自由行动）
## 位置
地点：Farm（泡泡湾农场）
## 背包（序号: 物品）
0: 斧头
1: 竹鱼竿
2: 大海菊 x2 [可食用 +30体力]
背包空位：9 个（共 12 格）`;

function makeFakeAdapter(calls: Array<{ tool: string; args: Record<string, unknown> }>): {
  adapter: GameAdapter;
  failNext: boolean;
  setFailNext: (v: boolean) => void;
} {
  let failNext = false;
  const adapter: GameAdapter = {
    gameId: 'stardew',
    displayName: '星露谷物语（仿真）',
    unreachableMessage: 'not reachable',
    transport: {
      async callTool(tool, args) {
        calls.push({ tool, args: args ?? {} });
        if (tool === 'get_state') return { kind: 'ok', text: BASE_RAW, isError: false };
        if (tool === 'cancel_action') return { kind: 'ok', text: '成功：已取消在飞动作', isError: false };
        if (failNext) {
          failNext = false;
          return { kind: 'ok', text: '失败：工具执行受阻', isError: true };
        }
        return { kind: 'ok', text: `成功：${tool} 已完成`, isError: false };
      },
    },
    ping: async () => true,
    isLongAction: () => false,
    extractClock: () => '第1年春16日 09:00',
    classifyReceipt: ({ text, isError }) => ({
      status: isError ? 'FAILED' : 'COMPLETED',
      summary: text,
    }),
  };
  return {
    adapter,
    get failNext() {
      return failNext;
    },
    setFailNext: (v) => {
      failNext = v;
    },
  };
}

describe('GameCharacterControlLease 与 13 项控制语义（Blueprint 17 §5.1）', () => {
  it('强制校验 sessionId/generation、人类抢占、TTL 过期、暂停与急停锁定', () => {
    let now = 1_000;
    const lease = new GameCharacterControlLease({
      characterId: 'char_xiaojing',
      gameId: 'stardew',
      sessionId: 'sess-a1111111',
      generation: 3,
      now: () => now,
    });

    expect(lease.owner).toBe('ai');
    expect(lease.canAiAct()).toBe(true);
    expect(lease.snapshot()).toMatchObject({
      characterId: 'char_xiaojing',
      gameId: 'stardew',
      sessionId: 'sess-a1111111',
      generation: 3,
      owner: 'ai',
    });

    // 过期 session / 过期 generation 必须被拒绝
    expect(lease.validateDirective({ sessionId: 'sess-old' })).toMatchObject({
      ok: false,
      code: 'STALE_SESSION',
    });
    expect(lease.validateDirective({ generation: 2 })).toMatchObject({
      ok: false,
      code: 'STALE_GENERATION',
    });
    expect(lease.validateDirective({ sessionId: 'sess-a1111111', generation: 3 })).toEqual({ ok: true });

    // TTL 租约过期自动退回 paused
    expect(lease.acquireAi('定时任务', 500)).toEqual({ ok: true });
    now += 500;
    expect(lease.canAiAct()).toBe(false);
    expect(lease.owner).toBe('paused');
    expect(lease.resumeAi('手动恢复')).toBe(true);
    expect(lease.owner).toBe('ai');
    expect(lease.resumeAi('幂等空转')).toBe(false);

    // 人类接管抢占 AI，且不允许 AI 在接管期间重抢
    lease.takeOverByHuman('键盘移动');
    expect(lease.canAiAct()).toBe(false);
    expect(lease.acquireAi('尝试抢回').ok).toBe(false);
    expect(lease.validateDirective()).toMatchObject({ ok: false, code: 'CONTROL_BLOCKED' });
    lease.pauseAi('human 优先级更高');
    expect(lease.owner).toBe('human');
    expect(lease.releaseHumanControl()).toBe(true);
    expect(lease.releaseHumanControl()).toBe(false);
    expect(lease.canAiAct()).toBe(true);

    // pauseAi 与 emergencyStop
    lease.pauseAi('网关超时');
    expect(lease.owner).toBe('paused');
    lease.emergencyStop('Stop 键');
    expect(lease.owner).toBe('halted');
    expect(lease.acquireAi('急停期禁止').ok).toBe(false);
    expect(lease.validateDirective()).toMatchObject({ ok: false, code: 'CONTROL_BLOCKED' });
    expect(lease.resumeAi('解锁')).toBe(true);
    lease.bumpSession('sess-b2222222', 4);
    expect(lease.snapshot().generation).toBe(4);
  });

  it('精确解析全部 13 项快捷控制语义并拒绝空/无效输入', () => {
    expect(parseControlCommand('   ')).toBeNull();
    expect(parseControlCommand('今天天气真好')).toBeNull();
    expect(parseControlCommand('Stop')).toEqual({ kind: 'stop' });
    expect(parseControlCommand('/stop')).toEqual({ kind: 'stop' });
    expect(parseControlCommand('Pause AI')).toEqual({ kind: 'pause_ai' });
    expect(parseControlCommand('暂停 AI')).toEqual({ kind: 'pause_ai' });
    expect(parseControlCommand('Resume AI')).toEqual({ kind: 'resume_ai' });
    expect(parseControlCommand('Take Over')).toEqual({ kind: 'take_over' });
    expect(parseControlCommand('我来操作')).toEqual({ kind: 'take_over' });
    expect(parseControlCommand('Release Control')).toEqual({ kind: 'release_control' });
    expect(parseControlCommand('Follow Me')).toEqual({ kind: 'follow_me' });
    expect(parseControlCommand('Stay Here')).toEqual({ kind: 'stay_here' });
    expect(parseControlCommand('Do This 去矿洞找铜矿')).toEqual({ kind: 'do_this', argText: '去矿洞找铜矿' });
    expect(parseControlCommand('Go Fish')).toEqual({ kind: 'go_fish' });
    expect(parseControlCommand('Go Mine')).toEqual({ kind: 'go_mine' });
    expect(parseControlCommand('Cancel Task')).toEqual({ kind: 'cancel_task' });
    expect(parseControlCommand('What Are You Doing?')).toEqual({ kind: 'what_are_you_doing' });
    expect(parseControlCommand('Show Plan')).toEqual({ kind: 'show_plan' });
  });

  it('PausedBrainPlanner 与默认 LlmPlanner 在故障时 0 次调用 RulePlanner', async () => {
    const paused = new PausedBrainPlanner('无 Key 安全暂停');
    expect(await paused.decide(parseGameState(BASE_RAW))).toMatchObject({
      kind: 'wait',
      reason: '无 Key 安全暂停',
    });
    expect(paused.debugSnapshot()).toMatchObject({ planner: 'ai-paused', paused: true });
    paused.setReason('新暂停理由');
    expect(await paused.decide(parseGameState(BASE_RAW))).toMatchObject({ reason: '新暂停理由' });

    const rule = new RulePlanner();
    const ruleSpy = vi.spyOn(rule, 'decide');
    const llm = new LlmPlanner({
      isKeyAvailable: () => false,
      fallbackPlanner: rule,
      chat: async () => ({ content: '{}' }),
    });
    const decision = await llm.decide(parseGameState(BASE_RAW));
    expect(decision.kind).toBe('wait');
    expect(llm.isPaused()).toBe(true);
    expect(llm.isUnavailable()).toBe(true);
    expect(ruleSpy).toHaveBeenCalledTimes(0);
  });
});

describe('AutodriveRunner 急停取消在飞动作、暂停与作用域校验', () => {
  it('emergencyStop 真实发送 cancel_action；pauseAi/resumeAi 阻塞与恢复决策；过期指令被拒', async () => {
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const { adapter } = makeFakeAdapter(calls);
    const events: AutodriveEvent[] = [];
    const runner = new AutodriveRunner(
      (e) => events.push(e),
      { maxCycles: 2, stepDelayMs: 0, pollDelayMs: 0, errorDelayMs: 0, generation: 7, sleep: async () => {} },
      adapter,
    );

    expect(runner.submitScopedDirective('fish', {}, 'wrong gen', { generation: 6 }).ok).toBe(false);
    expect(runner.submitScopedDirective('fish', {}, 'wrong sess', { sessionId: 'other' }).ok).toBe(false);
    expect(runner.submitScopedDirective('fish', { casts: 1 }, 'valid', { sessionId: runner.sessionId, generation: 7 }).ok).toBe(true);

    await runner.pauseAi('等待主人');
    expect(runner.controlLease.owner).toBe('paused');
    expect(runner.resumeAi()).toBe(true);
    expect(runner.controlLease.owner).toBe('ai');

    // 通过 in-flight lock + emergencyStop 验证真实 cancel_action 下发且清空后续权限
    let releaseAction!: () => void;
    const blockingClientAdapter: GameAdapter = {
      ...adapter,
      transport: {
        async callTool(tool, args) {
          calls.push({ tool, args: args ?? {} });
          if (tool === 'fish') {
            await new Promise<void>((resolve) => {
              releaseAction = resolve;
            });
            return { kind: 'ok', text: '被中止', isError: false };
          }
          return { kind: 'ok', text: '成功', isError: false };
        },
      },
    };
    const r2 = new AutodriveRunner(() => {}, { generation: 9 }, blockingClientAdapter);
    const inFlight = r2.lock.execute('fish', { casts: 5 });
    const cancelled = await r2.emergencyStop('测试急停');
    expect(cancelled).toBe(true);
    expect(r2.controlLease.owner).toBe('halted');
    expect(calls.some((c) => c.tool === 'cancel_action')).toBe(true);
    expect(r2.inspectStatus()).toMatchObject({ generation: 9, running: false });
    releaseAction();
    await inFlight;
  });
});

describe('Blueprint 17 §12 — 全部 12 项核心验收场景（AI-First · 0 次规则代驾）', () => {
  it('场景 1–3：满包多方案自主决策（非写死回家）、非下雨条件自主钓鱼、发现机会临时改计划并沟通', async () => {
    const rule = new RulePlanner();
    const ruleSpy = vi.spyOn(rule, 'decide');

    // 场景 1：背包空位 0（无硬编码规则接管，LLM 综合选择先吃或存箱）
    const fullBagRaw = BASE_RAW.replace('背包空位：9 个（共 12 格）', '背包空位：0 个（共 12 格）');
    const fullBagLlm = new LlmPlanner({
      fallbackPlanner: rule,
      chat: async (_slot, msgs) => {
        if ((msgs.at(-1)?.content ?? '').includes('请制定今日计划')) {
          return { content: '{"plan":[{"goal":"评估满包方案","why":"先腾格"}]}' };
        }
        return { content: '{"tool":"store_items","args":{"items":"大海菊"},"intent":"箱子在农场，先把大海菊存入箱子而不是直接弃丢或回家睡觉"}' };
      },
    });
    expect(await fullBagLlm.decide(parseGameState(fullBagRaw))).toMatchObject({ kind: 'act', tool: 'store_items' });

    // 场景 2：晴天（非雨天）自主钓鱼；场景 3：临时改变计划并发出 planUpdate
    const plans: string[] = [];
    let turn = 0;
    const weatherClearLlm = new LlmPlanner({
      fallbackPlanner: rule,
      onPlan: (p) => plans.push(`${p.reason}:${p.updateWhy ?? p.plan[0]?.goal}`),
      chat: async (_slot, msgs) => {
        if ((msgs.at(-1)?.content ?? '').includes('请制定今日计划')) {
          return { content: '{"plan":[{"goal":"上午浇水","why":"晴天常规"}]}' };
        }
        turn += 1;
        if (turn === 1) {
          return { content: '{"tool":"fish","args":{"casts":5},"intent":"今天海边咬口好，晴天也想去钓几条！"}' };
        }
        return {
          content: '{"tool":"travel_to","args":{"location":"Town"},"intent":"听说镇上广场有冒泡/任务机会，临时改去看看","planUpdate":{"why":"发现新机会并涉及下午共同逛镇约定，已告知主人","replace":[{"goal":"前往镇上查看新机会","why":"顺路看任务板"}]}}',
        };
      },
    });
    expect(await weatherClearLlm.decide(parseGameState(BASE_RAW))).toMatchObject({ kind: 'act', tool: 'fish' });
    expect(await weatherClearLlm.decide(parseGameState(BASE_RAW))).toMatchObject({ kind: 'act', tool: 'travel_to' });
    expect(plans.some((p) => p.startsWith('update:发现新机会'))).toBe(true);
    expect(ruleSpy).toHaveBeenCalledTimes(0);
  });

  it('场景 4, 5, 6, 12：多攻略检索、版本/存档不符拒绝盲从、失败更新经验避免重复', async () => {
    const guideMarkdown = [
      '## 旧版玩法（v1.5 以前）',
      '仅限 Stardew 1.5：无视社区中心直接靠漏洞无限刷新茶苗赚钱。',
      '## 矿洞（Mine v1.6）',
      '带够食物再进矿洞，15 层以后矿石更丰富。',
    ].join('\n');
    const notebook = new StrategyNotebook();
    const prompts: string[] = [];
    let step = 0;
    const planner = new LlmPlanner({
      notebook,
      guides: { 版本攻略: guideMarkdown },
      chat: async (_slot, msgs) => {
        const user = msgs.at(-1)?.content ?? '';
        prompts.push(user);
        if (user.includes('请制定今日计划')) {
          return { content: '{"plan":[{"goal":"核对攻略再去下矿","why":"不盲从旧版本"}]}' };
        }
        step += 1;
        if (step === 1) {
          return { content: '{"tool":"read_guide","args":{"topic":"版本攻略","section":"旧版"}}' };
        }
        if (step === 2) {
          return {
            content: '{"tool":"forage","args":{},"intent":"攻略属于 1.5 旧版本且与当前 1.6 不符，拒绝盲从改选安全采集","insight":{"source":"版本攻略#1.5","claim":"1.5 茶苗漏洞在新版本收益大降且适用性不确定","when":"Stardew >= 1.6","verdict":"defer","why":"版本变化需谨慎"}}',
          };
        }
        if (step === 3) {
          return { content: '{"tool":"explore_mine","args":{"targetFloor":15},"intent":"尝试直接冲 15 层"}' };
        }
        return {
          content: '{"tool":"eat","args":{"item":"大海菊"},"intent":"上次下矿血线危险失败，补充负经验并先吃食物","insight":{"source":"实玩","claim":"体力或食物不足时不得强冲深层矿洞","when":"hp<40 或缺食物","verdict":"refuted","why":"矿洞受阻失败"}}',
        };
      },
    });

    const d1 = await planner.decide(parseGameState(`${BASE_RAW}\n矿洞`));
    expect(d1).toMatchObject({ kind: 'act', tool: 'forage' });
    expect(prompts.some((p) => p.includes('仅限 Stardew 1.5'))).toBe(true);
    expect(notebook.list().some((i) => i.verdict === 'defer' && i.when.includes('1.6'))).toBe(true);

    const d2 = await planner.decide(parseGameState(BASE_RAW));
    expect(d2).toMatchObject({ kind: 'act', tool: 'explore_mine' });
    planner.observeReceipt('explore_mine', 'FAILED', '失败：矿梯未解锁或血量过低');
    const d3 = await planner.decide(parseGameState(BASE_RAW));
    expect(d3).toMatchObject({ kind: 'act', tool: 'eat' });
    expect(notebook.list().some((i) => i.verdict === 'refuted')).toBe(true);
  });

  it('场景 7–11：建议协商、强制指令、Stop 急停、人类接管不抢控与过期指令隔离', async () => {
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const { adapter } = makeFakeAdapter(calls);
    const events: AutodriveEvent[] = [];

    let turn = 0;
    const stances: string[] = [];
    const planner = new LlmPlanner({
      onChatStance: (s) => stances.push(`${s.kind}:${s.stance}`),
      chat: async (_slot, msgs) => {
        if ((msgs.at(-1)?.content ?? '').includes('请制定今日计划')) {
          return { content: '{"plan":[{"goal":"日常探索","why":"按主线推进"}]}' };
        }
        turn += 1;
        if (turn === 1) {
          return { content: '{"tool":"water_crops","args":{},"intent":"先浇地再说","stance":"modify","reply":"先浇完眼前的地我就去海边钓两竿～"}' };
        }
        return { content: '{"stance":"execute","tool":"travel_to","args":{"location":"Mine"},"intent":"收到强制命令前往矿洞","commandDone":true,"reply":"好嘞，这就动身去矿洞！"}' };
      },
    });

    const runner = new AutodriveRunner(
      (e) => events.push(e),
      { maxCycles: 2, stepDelayMs: 0, pollDelayMs: 0, errorDelayMs: 0, generation: 1, sleep: async () => {} },
      adapter,
    );
    runner.setPlanner(planner);

    // 场景 7：普通建议协商（modify）— runner.setPlanner 会接管 onChatStance 到 events 流
    runner.submitSuggestion('去钓鱼好不好');
    await runner.start();
    while (runner.isRunning()) await new Promise((r) => setTimeout(r, 1));
    await runner.stopAndWait();
    expect(events.some((e) => e.type === 'chat-stance' && e.kind === 'suggestion' && e.stance === 'modify')).toBe(true);

    // 场景 8：强制指令执行与任务收尾交还
    const runner2 = new AutodriveRunner(
      (e) => events.push(e),
      { maxCycles: 1, stepDelayMs: 0, pollDelayMs: 0, errorDelayMs: 0, generation: 2, sleep: async () => {} },
      adapter,
    );
    runner2.setPlanner(planner);
    runner2.submitCommand('去矿洞');
    await runner.stopAndWait();
    await runner2.start();
    while (runner2.isRunning()) await new Promise((r) => setTimeout(r, 1));
    await runner2.stopAndWait();
    expect(events.some((e) => e.type === 'chat-stance' && e.kind === 'command' && e.stance === 'execute')).toBe(true);
    expect(events.some((e) => e.type === 'objective' && e.reason === 'done')).toBe(true);

    // 场景 9 & 10 & 11：Stop 急停后不再写入 + 人类接管绝不抢控 + 旧 generation 指令被拒
    const beforeTakeoverCalls = calls.length;
    await runner2.setHumanControl(true, 'in-game');
    expect(runner2.submitScopedDirective('fish', {}, 'blocked while human').ok).toBe(false);
    expect(runner2.submitScopedDirective('fish', {}, 'stale gen', { generation: 1 }).ok).toBe(false);
    await runner2.emergencyStop('场景 9 急停');
    expect(runner2.controlLease.owner).toBe('halted');
    expect(calls.slice(beforeTakeoverCalls).every((c) => c.tool === 'cancel_action')).toBe(true);
  });
});
