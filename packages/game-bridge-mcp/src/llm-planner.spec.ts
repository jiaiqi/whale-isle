/**
 * T-M6-01 完整版门禁：LLM Planner 决策协议 / 坏输出回落 / 白名单越权拦截 / 攻略检索。
 * chat 全注入 mock（零网络）。
 */
import { describe, expect, it } from 'vitest';
import { extractDecisionJson, LlmPlanner, LLM_TOOL_WHITELIST, pickGuideContext, pickShippableItem } from './llm-planner';
import { parseGameState, type GameStateSnapshot } from './planner';

const STATE_OK = `时间：第1年春16日 07:30（Tue），天气：晴
金钱：640g  体力：98/270
## 当前界面
无（可以自由行动）
## 位置
地点：Farm（泡泡湾农场）
邮箱里有 7 封未读信件`;

/** 真机 2026-11-22 现场原样：背包空位 0，钓鱼连续 FAILED */
const STATE_FULL = `${STATE_OK.replace('地点：Farm（泡泡湾农场）', '地点：Town（鹈鹕镇）')}
## 背包（序号: 物品）
0: 斧头
11: 小嘴鲈鱼 [可食用 +25 体力]
背包空位：0 个（共 12 格）`;

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
    expect(extractDecisionJson('{"tool": bad json }')).toBeNull(); // JSON.parse 抛错也须吞掉
  });
});

describe('白名单与攻略检索', () => {
  it('常用工具在白名单；危险/未知工具不在', () => {
    for (const t of ['read_mail', 'fish', 'sleep', 'travel_to', 'get_state']) expect(LLM_TOOL_WHITELIST.has(t)).toBe(true);
    expect(LLM_TOOL_WHITELIST.has('exec')).toBe(false);
    expect(LLM_TOOL_WHITELIST.has('rm_rf')).toBe(false);
  });

  it('状态含钓鱼线索 → 钓鱼攻略节选；无线索 → 空', () => {    const guides = { 钓鱼: '钓鱼攻略正文'.repeat(200), 采矿: '采矿攻略' };
    const s = { ...state(), raw: state().raw + '去海边钓鱼（fish）' };
    const ctx = pickGuideContext(s, guides);
    expect(ctx).toContain('钓鱼 专题节选');
    expect(ctx.length).toBeLessThanOrEqual(1200 + 60);
    const noHint = pickGuideContext(state(), guides);
    expect(noHint).toBe('');
  });
});

describe('pickShippableItem（出货目标挑选）', () => {
  it('跳过工具与「留着」任务物品；取最后一条并剥离标签', () => {
    const raw = `## 背包（序号: 物品）
0: 斧头
1: 黄水仙【留着：社区中心"春季采集"要交】
4: 绿藻 [可食用 +13 体力]
7: 小嘴鲈鱼 金星 [可食用 +45 体力]
背包空位：0 个（共 12 格）`;
    expect(pickShippableItem(raw)).toBe('小嘴鲈鱼');
  });
  it('只有工具/任务物品 → null（升级路径改走 store_items）', () => {
    expect(pickShippableItem('0: 斧头\n1: 锄头\n2: 黄水仙【留着】')).toBeNull();
    expect(pickShippableItem('没有背包段')).toBeNull();
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

  it('背包空位 0 → 确定性 tidy_backpack，不烧 token（真机连续 FAILED fish 修复）', async () => {
    let asked = 0;
    const planner = new LlmPlanner({
      chat: async () => { asked++; return { content: '{"tool":"fish","args":{}}' }; },
    });
    const full = parseGameState(STATE_FULL);
    expect(full.freeSlots).toBe(0);
    const d = await planner.decide(full);
    expect(d.kind === 'act' && d.tool).toBe('tidy_backpack');
    expect(d.kind === 'act' && d.intent).toContain('背包');
    expect(asked).toBe(0);
    expect(planner.asks).toBe(1); // 只计数，未走 LLM
  });

  it('回执显示背包满（状态未解析出空位）→ 同样整理', async () => {
    const planner = new LlmPlanner({
      chat: async () => ({ content: '{"tool":"fish","args":{}}' }),
      recentReceipts: ['FAILED fish: 失败：背包满了，再钓拿不下的会掉在地上'],
    });
    const d = await planner.decide(state());
    expect(d.kind === 'act' && d.tool).toBe('tidy_backpack');
  });

  it('农场没有箱子（tidy 必失败）→ 直接出货，不再浪费一轮 tidy', async () => {
    const planner = new LlmPlanner({
      chat: async () => ({ content: '{"tool":"fish","args":{}}' }),
      recentReceipts: ['FAILED tidy_backpack: 失败：农场上没有箱子。先 craft Chest（50 木材），再 place_item 放在农场上'],
    });
    const d = await planner.decide(parseGameState(STATE_FULL));
    expect(d.kind === 'act' && d.tool).toBe('ship_items');
    expect(d.kind === 'act' && d.args).toEqual({ item: '小嘴鲈鱼' });
  });

  it('出货也失败 → 吃一个腾位 → 再失败 → 扔垃圾（阶梯降级）', async () => {
    const raw = `${STATE_FULL}
9: 破损的眼镜 [垃圾]`;
    const shipFail = new LlmPlanner({
      chat: async () => ({ content: '{"tool":"fish","args":{}}' }),
      recentReceipts: [
        'FAILED tidy_backpack: 失败：农场上没有箱子',
        'FAILED ship_items: 失败：出货箱满了',
      ],
    });
    const eat = await shipFail.decide(parseGameState(raw));
    expect(eat.kind === 'act' && eat.tool).toBe('eat');
    expect(eat.kind === 'act' && eat.args).toEqual({ item: '小嘴鲈鱼' });

    const eatFail = new LlmPlanner({
      chat: async () => ({ content: '{"tool":"fish","args":{}}' }),
      recentReceipts: [
        'FAILED ship_items: 失败：出货箱满了',
        'FAILED eat: 失败：吃不下了',
      ],
    });
    const trash = await eatFail.decide(parseGameState(raw));
    expect(trash.kind === 'act' && trash.tool).toBe('trash_item');
    expect(trash.kind === 'act' && trash.args).toEqual({ item: '破损的眼镜' });
  });

  it('腾出空位后救援阶段归零：恢复 LLM 正常决策', async () => {
    let asked = 0;
    const planner = new LlmPlanner({
      chat: async () => { asked++; return { content: '{"tool":"water_crops","args":{},"intent":"浇水"}' }; },
      recentReceipts: ['FAILED tidy_backpack: 失败：农场上没有箱子'],
    });
    const rescue = await planner.decide(parseGameState(STATE_FULL));
    expect(rescue.kind === 'act' && rescue.tool).toBe('ship_items');
    const freed = parseGameState(STATE_FULL.replace('背包空位：0 个', '背包空位：2 个'));
    const normal = await planner.decide(freed);
    expect(normal.kind === 'act' && normal.tool).toBe('water_crops');
    expect(asked).toBe(1);
  });

  it('出货候选排序：鱼/采集优先于家具（真机「普通窗户不能出货」教训）', () => {
    const raw = `${STATE_OK}
## 背包（序号: 物品）
5: 沙丁鱼 x3 金星 [可食用 +23体力]
6: 普通窗户
背包空位：0 个（共 12 格）`;
    expect(pickShippableItem(raw)).toBe('沙丁鱼');
  });

  it('被 BWF 拒绝的单品会被记住并换下一个，不降级策略', async () => {
    const raw = `${STATE_FULL}
6: 普通窗户`;
    const planner = new LlmPlanner({
      chat: async () => ({ content: '{"tool":"fish","args":{}}' }),
      recentReceipts: [
        'FAILED tidy_backpack: 失败：农场上没有箱子',
        'FAILED ship_items: 失败：普通窗户 不能出货',
      ],
    });
    const d = await planner.decide(parseGameState(raw));
    expect(d.kind === 'act' && d.tool).toBe('ship_items');
    expect(d.kind === 'act' && d.args).toEqual({ item: '小嘴鲈鱼' });
  });

  it('整理连续两次失败 + 背包满 → 升级为出货 ship_items（带具体物品名）', async () => {
    const planner = new LlmPlanner({
      chat: async () => ({ content: '{"tool":"fish","args":{}}' }),
      recentReceipts: ['FAILED tidy_backpack: 失败：箱子也满了', 'FAILED tidy_backpack: 失败：真的塞不下'],
    });
    const d = await planner.decide(parseGameState(STATE_FULL));
    expect(d.kind === 'act' && d.tool).toBe('ship_items');
    // ship_items 契约要求 item 必填：从背包挑最近捡的鱼（跳过工具）
    expect(d.kind === 'act' && d.args).toEqual({ item: '小嘴鲈鱼' });
  });

  it('整理连续失败但没有可出货物品 → store_items（无参也安全）', async () => {
    const toolsOnly = `${STATE_OK}
## 背包（序号: 物品）
0: 斧头
1: 锄头
2: 喷壶（水 39/40）
3: 黄水仙【留着：社区中心"春季采集"要交】
背包空位：0 个（共 12 格）`;
    const planner = new LlmPlanner({
      chat: async () => ({ content: '{"tool":"fish","args":{}}' }),
      recentReceipts: ['FAILED tidy_backpack: 失败：箱子也满了', 'FAILED tidy_backpack: 失败：真的塞不下'],
    });
    const d = await planner.decide(parseGameState(toolsOnly));
    expect(d.kind === 'act' && d.tool).toBe('store_items');
  });

  it('同一工具连续两次失败（非背包）→ 换规则日程，不重复死磕', async () => {
    let asked = 0;
    const planner = new LlmPlanner({
      chat: async () => { asked++; return { content: '{"tool":"fish","args":{}}' }; },
      recentReceipts: ['FAILED fish: 失败：这里没有水', 'FAILED fish: 失败：没有水钓不了'],
    });
    const d = await planner.decide(state());
    expect(d.kind === 'act' && d.tool).not.toBe('fish');
    expect(asked).toBe(0);
  });
});
