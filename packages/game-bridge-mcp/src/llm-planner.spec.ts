/**
 * T-M6-01 完整版门禁：LLM Planner 决策协议 / 坏输出回落 / 白名单越权拦截 / 攻略检索。
 * chat 全注入 mock（零网络）。
 */
import { describe, expect, it } from 'vitest';
import { extractDecisionJson, LlmPlanner, LLM_TOOL_WHITELIST, pickGuideContext } from './llm-planner';
import { parseGameState, type GameStateSnapshot } from './planner';

const STATE_OK = `时间：第1年春16日 07:30（Tue），天气：晴
金钱：640g  体力：98/270
## 当前界面
无（可以自由行动）
## 位置
地点：Farm（泡泡湾农场）
邮箱里有 7 封未读信件`;

const state = (): GameStateSnapshot => parseGameState(STATE_OK);

describe('extractDecisionJson', () => {
  it('纯 JSON / markdown 围栏 / 前后缀文本 三形态全解析', () => {
    expect(extractDecisionJson('{"tool":"read_mail","args":{},"intent":"读信"}')).toMatchObject({ tool: 'read_mail' });
    expect(extractDecisionJson('```json\n{"tool":"fish","args":{"casts":5},"intent":"钓鱼"}\n```')).toMatchObject({ tool: 'fish', args: { casts: 5 } });
    expect(extractDecisionJson('小鲸想了一下：{"tool":"sleep","args":{}} 就这么办！')).toMatchObject({ tool: 'sleep' });
  });

  it('坏输出返回 null：无 JSON / 缺 tool / 截断', () => {
    expect(extractDecisionJson('我就想睡觉不输出 JSON')).toBeNull();
    expect(extractDecisionJson('{"args":{},"intent":"x"}')).toBeNull();
    expect(extractDecisionJson('{"tool":"fish","args":{"casts":')).toBeNull();
  });
});

describe('白名单与攻略检索', () => {
  it('常用工具在白名单；危险/未知工具不在', () => {
    for (const t of ['read_mail', 'fish', 'sleep', 'travel_to', 'get_state']) expect(LLM_TOOL_WHITELIST.has(t)).toBe(true);
    expect(LLM_TOOL_WHITELIST.has('exec')).toBe(false);
    expect(LLM_TOOL_WHITELIST.has('rm_rf')).toBe(false);
  });

  it('状态含钓鱼线索 → 钓鱼攻略节选；无线索 → 空', () => {
    const guides = { 钓鱼: '钓鱼攻略正文'.repeat(200), 采矿: '采矿攻略' };
    const s = { ...state(), raw: state().raw + '去海边钓鱼（fish）' };
    const ctx = pickGuideContext(s, guides);
    expect(ctx).toContain('钓鱼 专题节选');
    expect(ctx.length).toBeLessThanOrEqual(1200 + 60);
    const noHint = pickGuideContext(state(), guides);
    expect(noHint).toBe('');
  });
});

describe('LlmPlanner 决策链', () => {
  it('正常链路：LLM 输出合法决策 → act 直出（含人设 intent）', async () => {
    const planner = new LlmPlanner({
      chat: async () => ({ content: '{"tool":"water_crops","args":{},"intent":"浇水中！才不是为了主人呢"}' }),
    });
    const d = await planner.decide(state());
    expect(d.kind === 'act' && d.tool).toBe('water_crops');
    expect(d.kind === 'act' && d.intent).toContain('才不是为了主人');
    expect(planner.asks).toBe(1);
  });

  it('越权工具名 → 拒绝重问 → 仍坏 → RulePlanner 兜底', async () => {
    let n = 0;
    const planner = new LlmPlanner({
      chat: async () => {
        n++;
        return { content: '{"tool":"exec_shell","args":{"cmd":"rm -rf"}}' }; // 越权两次
      },
    });
    const d = await planner.decide(state());
    expect(n).toBe(2); // 重问了一次
    // 兜底走 RulePlanner 日程：morning-mail 有未读 → read_mail
    expect(d.kind === 'act' && d.tool).toBe('read_mail');
    expect(planner.asks).toBe(1);
  });

  it('chat 抛错（网关/网络）→ 重试 → 兜底不卡死', async () => {
    const planner = new LlmPlanner({ chat: async () => { throw new Error('ECONNRESET'); } });
    const d = await planner.decide(state());
    expect(d.kind).toBe('act');
  });

  it('菜单打开时绕过 LLM（确定性处理不烧 token）', async () => {
    let asked = 0;
    const planner = new LlmPlanner({
      chat: async () => { asked++; return { content: '{"tool":"fish","args":{}}' }; },
    });
    const withMenu = { ...state(), menu: '正在播放剧情/节日事件' };
    await planner.decide(withMenu);
    expect(asked).toBe(0);
  });
});
