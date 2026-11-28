/**
 * T-M6-70 全权自主决策模式单测门禁：
 *   - LLM 在线可用期间 RulePlanner.decide 调用 0 次（spy 断言）；
 *   - 生存风险（5% 体力 / 01:40 深夜 / 低血量 / 0 空位）只写进 prompt 提醒，LLM 动作原样放行；
 *   - 失败签名与停滞时长注入下一轮 prompt，成功回执清空失败记忆；
 *   - 换日生成一次晨间计划、步中 planUpdate 修订、plan 事件发出；
 *   - 普通聊天建议（accept / modify / decline + reply，满 2 游戏小时未表态自动过期）；
 *   - `/自然语言` 强制命令（decline/modify/缺表态拒收重问，连续 2 次不合规进代驾；
 *     infeasible 必填 reason；execute 持续至 commandDone + COMPLETED 或 /cancel）；
 *   - BrainSwitch（缺 Key / 单次超时 / 连续 3 次乱码 → rule-standin 代驾 → 2 分钟恢复探测交回）；
 *   - T-M6-73 接管差异摘要单次注入；多游戏 adapter seam；`llm-planner.ts` 行数硬上限 ≤ 500 行。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { AutodriveRunner, type AutodriveEvent } from './autodrive';
import { StardewAdapter } from './adapter';
import { buildAutonomousDecisionMessages, buildRepeatedFailureSection, buildRepeatedNoProgressSection, buildStateContext } from './llm-prompt';
import {
  BrainSwitch,
  buildFailureMemorySection,
  buildPlannerMemoryQuery,
  buildSurvivalReminder,
  DayPlanStore,
  extractDecisionJson,
  extractJsonObject,
  festivalWindowOf,
  LlmPlanner,
  LLM_TOOL_WHITELIST,
  MAX_OBJECTIVE_ROUNDS,
  minutesUntil2am,
  normalizeToolArgs,
  parseAutonomousDecision,
  parseMorningPlanObject,
  parsePlanUpdate,
  pickGuideContext,
  pickPrematureReservedEdible,
  pickShippableItem,
  resolvePlannerContexts,
  StrategyNotebook,
  type BrainMode,
  type ChatStanceEmission,
  type PlanEmission,
} from './llm-planner';
import {
  countWood,
  findFreeTile,
  findNearestTree,
  hasChestItem,
  isRaining,
  listEdibleItems,
  listShippableItems,
  parseGameState,
  pickAnyNonEssential,
  pickChestSacrifice,
  pickEdible,
  pickFurnitureToPlace,
  pickRenewableReserved,
  pickTrash,
  pickTrashableFallback,
  RulePlanner,
  type GameStateSnapshot,
} from './planner';

const STATE_OK = `时间：第1年春16日 07:30（Tue），天气：晴
金钱：640g  体力：98/270  生命：100/100
## 当前界面
无（可以自由行动）
## 位置
地点：Farm（泡泡湾农场）
邮箱里有 7 封未读信件
## 背包（序号: 物品）
0: 斧头
背包空位：8 个（共 12 格）`;

const state = (raw = STATE_OK): GameStateSnapshot => parseGameState(raw);

describe('T-M6-70 文件预算硬门禁', () => {
  it('llm-planner.ts 单文件行数 ≤ 500 行', () => {
    const filePath = fileURLToPath(new URL('./llm-planner.ts', import.meta.url));
    const lineCount = readFileSync(filePath, 'utf8').split('\n').length;
    expect(lineCount).toBeLessThanOrEqual(500);
  });
});

describe('JSON 提取、参数归一化与辅助纯函数', () => {
  it('extractDecisionJson / extractJsonObject 支持纯 JSON、围栏、<think> 剥离与转义引号', () => {
    expect(extractDecisionJson('{"tool":"read_mail","args":{},"intent":"读信"}')).toMatchObject({ tool: 'read_mail' });
    expect(extractDecisionJson('```json\n{"tool":"fish","args":{"casts":5},"intent":"钓鱼"}\n```'))
      .toMatchObject({ tool: 'fish', args: { casts: 5 } });
    expect(extractDecisionJson('<think>我想想 {"fake":1}</think>{"tool":"sleep","args":{}}'))
      .toMatchObject({ tool: 'sleep' });
    expect(extractDecisionJson('{"tool":"say","args":{"text":"quote: \\"hi\\""},"intent":"escaped"}'))
      .toMatchObject({ tool: 'say', args: { text: 'quote: "hi"' } });
    expect(extractJsonObject('[1,2,3]')).toBeNull();
    expect(extractDecisionJson('没有 JSON')).toBeNull();
    expect(extractDecisionJson('{"args":{}}')).toBeNull();
    expect(extractDecisionJson('{"tool": bad }')).toBeNull();
  });

  it('normalizeToolArgs 压平数组/JSON 字符串/对象并对齐 BWF 参数键', () => {
    expect(normalizeToolArgs({ items: ['湿透的报纸'] }, 'ship_items')).toEqual({ item: '湿透的报纸' });
    expect(normalizeToolArgs({ item: '["湿透的报纸"]' }, 'ship_items')).toEqual({ item: '湿透的报纸' });
    expect(normalizeToolArgs({ item: { name: '湿透的报纸' } }, 'ship_items')).toEqual({ item: '湿透的报纸' });
    expect(normalizeToolArgs({ items: { 湿透的报纸: 1, 浮木: 1 } }, 'ship_items')).toEqual({ item: '湿透的报纸' });
    expect(normalizeToolArgs({ items: {} }, 'ship_items')).toEqual({});
    expect(normalizeToolArgs({ item: '[坏掉]' }, 'ship_items')).toEqual({ item: '[坏掉]' });
    expect(normalizeToolArgs({ items: ['铁锭', '煤炭'] }, 'take_items')).toEqual({ items: '铁锭,煤炭' });
    expect(normalizeToolArgs({ items: { 铁锭: 5 } }, 'take_items')).toEqual({ items: '铁锭' });
    expect(normalizeToolArgs({ item: '铁锭' }, 'take_items')).toEqual({ items: '铁锭' });
    expect(normalizeToolArgs({ item: 'Chest' }, 'craft')).toEqual({ recipe: 'Chest' });
    expect(normalizeToolArgs({ seeds: ['防风草种子'], x1: 1 }, 'plant_seeds')).toEqual({ seed: '防风草种子', x1: 1 });
  });

  it('parseAutonomousDecision 支持仅带 stance=infeasible 无 tool 的答复及 planUpdate', () => {
    const inf = parseAutonomousDecision('{"stance":"infeasible","reason":"周三皮埃尔关门","alternative":"明早再去","reply":"今天不开门呀"}');
    expect(inf).toMatchObject({ stance: 'infeasible', reason: '周三皮埃尔关门', alternative: '明早再去' });
    expect(inf?.tool).toBeUndefined();
    expect(parseAutonomousDecision('{"foo":1}')).toBeNull();
  });

  it('白名单、攻略节选与既有背包解析函数保持兼容', () => {
    for (const t of ['read_mail', 'fish', 'sleep', 'travel_to', 'get_state']) expect(LLM_TOOL_WHITELIST.has(t)).toBe(true);
    expect(LLM_TOOL_WHITELIST.has('exec')).toBe(false);
    const guides = { 钓鱼: '钓鱼攻略正文'.repeat(200) };
    expect(pickGuideContext({ ...state(), raw: `${STATE_OK}\n钓鱼 fish` }, guides)).toContain('钓鱼 专题节选');
    expect(pickGuideContext(state(), guides)).toBe('');
    expect(festivalWindowOf('今天是花舞节：建议参加 9:00-14:00 之间用 festival enter 入场')).toEqual({ start: 540, end: 840 });
    expect(festivalWindowOf('普通状态')).toBeNull();
    expect(pickShippableItem('0: 斧头\n7: 小嘴鲈鱼 金星 [可食用 +45 体力]')).toBe('小嘴鲈鱼');
    expect(countWood('8: 木材 x60')).toBe(60);
    expect(hasChestItem('10: 宝箱')).toBe(true);
    expect(pickFurnitureToPlace('6: 普通窗户')).toBe('普通窗户');
    expect(isRaining(parseGameState('时间：第1年春20日 16:00（Sat），天气：下雨'))).toBe(true);
    expect(pickPrematureReservedEdible(
      '5: 沙丁鱼 [可食用 +23体力]【留着：社区中心“海鱼”要交】\n7: 石头【留着：社区中心“建筑”要交】',
      '【工艺室】建筑 石头',
    )).toBe('沙丁鱼');
    // 保持 planner.ts 导出的背包/地图纯辅助函数覆盖率与契约稳定
    expect(listShippableItems('0: 斧头\n5: 沙丁鱼 [可食用 +23]')).toEqual(['沙丁鱼']);
    expect(listEdibleItems('5: 沙丁鱼 [可食用 +23]')).toEqual(['沙丁鱼']);
    expect(pickEdible('5: 沙丁鱼 [可食用 +23]')).toBe('沙丁鱼');
    expect(pickTrash('9: 破损的眼镜 [垃圾]')).toBe('破损的眼镜');
    expect(pickAnyNonEssential('6: 普通窗户', new Set())).toBe('普通窗户');
    expect(pickTrashableFallback('11: 鱼饵 x10', new Set())).toBe('鱼饵');
    expect(pickChestSacrifice('4: 木材 x60\n5: 石头 x20')).toBe('石头');
    expect(pickChestSacrifice('4: 木材 x60\n9: 沙丁鱼 [可食用 +23]【留着】')).toBeNull();
    expect(pickChestSacrifice('4: 木材 x60')).toBeNull();
    expect(pickRenewableReserved('9: 沙丁鱼 [可食用 +23]【留着】')).toEqual({ item: '沙丁鱼', mode: 'eat' });
    expect(pickRenewableReserved('6: 牡蛎【留着】')).toEqual({ item: '牡蛎', mode: 'trash' });
    expect(pickRenewableReserved('5: 木材 x22【留着】')).toBeNull();
    const mapRaw = `${STATE_OK}\n## 文字地图（以你为中心，左上角坐标=(10,10)，每个字符一格）\n  10  ##T##\n  11  #.@.T`;
    expect(findNearestTree(mapRaw, 12, 11)).toEqual({ x: 12, y: 10 });
  });

  it('minutesUntil2am 与 buildSurvivalReminder 准确计算深夜 01:40 剩余 20 分钟且只提醒', () => {
    expect(minutesUntil2am(7 * 60 + 30)).toBe(18 * 60 + 30);
    expect(minutesUntil2am(1 * 60 + 40)).toBe(20);
    expect(minutesUntil2am(3 * 60)).toBe(0);
    const extreme = parseGameState(`时间：第1年春16日 01:40（Tue），天气：晴
金钱：100g  体力：13/270  生命：20/100
## 位置
地点：Beach（沙滩）
## 背包
0: 斧头
背包空位：0 个（共 12 格）`);
    const text = buildSurvivalReminder(extreme, 0);
    expect(text).toContain('体力仅剩 5%');
    expect(text).toContain('只剩 20 分钟');
    expect(text).toContain('生命值危险（20%）');
    expect(text).toContain('背包空位为 0');
    expect(text).toContain('完全由你自主决定');
  });

  it('状态上下文按章节预算保留标题与省略说明，不静默截断半行', () => {
    const short = '时间：第1年春1日 06:00\n## 位置\n地点：Farm';
    expect(buildStateContext(short, 4000)).toBe(short);
    expect(buildStateContext('   ', 4000)).toBe('');

    const section = (name: string, n: number) => `## ${name}\n${Array.from({ length: n }, (_, i) => `${name}行${i}: ${'内容'.repeat(12)}`).join('\n')}\n`;
    const raw = `时间：第1年夏27日 06:20（Sat），天气：晴\n## 基本状态\n体力：270/270\n${section('背包', 90)}${section('箱子', 70)}${section('文字地图', 90)}${section('任务', 30)}`;
    expect(raw.length).toBeGreaterThan(6000);
    const out = buildStateContext(raw, 3000);
    expect(out.length).toBeLessThan(raw.length);
    for (const header of ['## 基本状态', '## 背包', '## 箱子', '## 文字地图', '## 任务']) {
      expect(out).toContain(header);
    }
    expect(out).toContain('因上下文预算省略约');
    expect(out).toContain('get_state full=true');
    // 不得出现半行截断：每行要么完整来自原文，要么是明确的省略说明
    for (const line of out.split('\n')) {
      if (line === '') continue;
      if (line.startsWith('（本节因上下文预算省略约')) continue;
      expect(raw).toContain(line);
    }
    expect(out).not.toContain('…');

    // 单节超长也要标注，且不出现整节静默消失
    const huge = `## 任务\n${'很长的任务描述'.repeat(800)}`;
    const truncated = buildStateContext(huge, 1200);
    expect(truncated).toContain('## 任务');
    expect(truncated).toContain('因上下文预算省略约');
  });

  it('状态上下文预算覆盖短原文、无章节、空章节与超长单行分支', () => {
    expect(buildStateContext('')).toBe('');
    expect(buildStateContext('   \n  ')).toBe('');
    expect(buildStateContext('时间：第1年春1日 06:00\n地点：Farm', 4000)).toContain('地点：Farm');
    const noSections = '很长的无章节状态'.repeat(400);
    const noSectionCtx = buildStateContext(noSections, 500);
    expect(noSectionCtx).toContain('因上下文预算省略约');
    expect(noSectionCtx.length).toBeLessThan(noSections.length + 120);
    // 保留前缀必须整行、来自原文
    const keptPrefix = noSectionCtx.split('\n（因上下文预算省略约')[0]!;
    expect(noSections.startsWith(keptPrefix)).toBe(true);
    const emptySection = `## 基本状态\n${'填充'.repeat(600)}\n## 任务\n## 作物\n`;
    const out = buildStateContext(emptySection, 900);
    expect(out).toContain('## 任务');
    expect(out).toContain('## 作物');
    const oneLine = `## 背包\n${'物品'.repeat(900)}`;
    const cut = buildStateContext(oneLine, 600);
    expect(cut).toContain('## 背包');
    expect(cut).toContain('因上下文预算省略约');
  });

  it('重复失败按原因归并提示，单次或不同原因不误报', () => {
    expect(buildRepeatedFailureSection([])).toBe('');
    expect(buildRepeatedFailureSection(['COMPLETED fish: 成功：钓到沙丁鱼'])).toBe('');

    const upgrade = 'FAILED upgrade_tool: 失败：升级 斧头 → 铜斧头 还不够：钱差 1554g（要 2000g，你身上 446g）；材料差 4 个铜锭';
    expect(buildRepeatedFailureSection([upgrade, upgrade])).toContain('同一失败原因出现2次');
    expect(buildRepeatedFailureSection([upgrade, upgrade])).toContain('upgrade_tool');
    expect(buildRepeatedFailureSection([upgrade, upgrade])).toContain('不要原样重试');

    // 不同工具的不同原因不应合并
    const other = 'FAILED interact: 失败：(69,15) 的熔炉还在加工铜锭，还要约 30 分钟';
    const mixed = buildRepeatedFailureSection([upgrade, other]);
    expect(mixed).toBe('');

    // 逐字差异但同因（前 24 字一致）应归并
    const drift = 'FAILED interact: 失败：(69,15) 的熔炉还在加工铜锭，还要约 20 分钟';
    const both = buildRepeatedFailureSection([
      'FAILED interact: 失败：(69,15) 的熔炉还在加工铜锭，还要约 30 分钟',
      drift,
    ]);
    expect(both).toContain('出现2次');

    // 窗口外的旧失败不计入
    const old = [...Array<string>(8).fill('COMPLETED travel_to: 成功：到达农场'), upgrade, upgrade];
    expect(buildRepeatedFailureSection(old)).toContain('出现2次');
  });

  it('同一工具多种原因反复失败也提示物理限制，换参数无益', () => {
    // 夏28 真机：take_items 在多个坐标各失败一次，原因不同但都是无进展试探
    const window = [
      'FAILED take_items: 失败：(69,16) 四周没有可以站的地方',
      'FAILED take_items: 失败：箱子里没有符合的东西，箱子是空的',
      'FAILED take_items: 失败：(69,16) 四周没有可以站的地方',
    ];
    const out = buildRepeatedFailureSection(window);
    expect(out).toContain('take_items 在最近8条里失败3次');
    expect(out).toContain('换参数也没有用');
    expect(out).toContain('不要继续换坐标试探');

    // 仅两次不触发工具级提示
    expect(buildRepeatedFailureSection(window.slice(0, 2))).toBe('');

    // 同因重复优先走同因提示，不重复输出工具级说明
    const same = ['FAILED upgrade_tool: 失败：钱差 1554g，缺 4 个铜锭', 'FAILED upgrade_tool: 失败：钱差 1554g，缺 4 个铜锭', 'FAILED upgrade_tool: 失败：钱差 1554g，缺 4 个铜锭'];
    const sameOut = buildRepeatedFailureSection(same);
    expect(sameOut).toContain('同一失败原因出现3次');
    expect(sameOut).toContain('前置条件没有变化');
    // 同一工具 3 次失败时，同因与工具级两层提示都会出现（不互斥）
    expect(sameOut).toContain('upgrade_tool 在最近8条里失败3次');
  });

  it('生命 39% 时提前点名偏低风险，不改写为指定行动', () => {
    const mid = parseGameState(`时间：第1年夏28日 14:00（Sun），天气：晴
金钱：771g  体力：170/270  生命：47/120
## 位置
地点：Farm（鲸屿两季农场），室外`);
    const text = buildSurvivalReminder(mid, 10);
    expect(text).toContain('生命过半偏低');
    expect(text).toContain('47/120');
    expect(text).not.toContain('生命值危险');
    // 只给风险与前置建议，不写死具体玩法
    expect(text).not.toMatch(/必须|只能|立刻前往/);

    // 30% 以下仍走原有危险提示
    const low = parseGameState(`时间：第1年夏28日 14:00（Sun），天气：晴
金钱：771g  体力：170/270  生命：30/120
## 位置
地点：Farm（鲸屿两季农场），室外`);
    const lowText = buildSurvivalReminder(low, 10);
    expect(lowText).toContain('生命值危险');
    expect(lowText).not.toContain('生命过半偏低');

    // 健康时既不危险也不偏低
    const healthy = parseGameState(`时间：第1年夏28日 14:00（Sun），天气：晴
金钱：771g  体力：170/270  生命：120/120
## 位置
地点：Farm（鲸屿两季农场），室外`);
    const healthyText = buildSurvivalReminder(healthy, 10);
    expect(healthyText).not.toContain('生命过半偏低');
    expect(healthyText).not.toContain('生命值危险');
  });

  it('重复空结果与反复开合界面都保留成功事实并提醒核对进展，不指定玩法', () => {
    const empty = 'COMPLETED clear_area: 成功：区域内没有可以清理的东西';
    expect(buildRepeatedNoProgressSection([empty])).toBe('');
    expect(buildRepeatedNoProgressSection([empty.replace('COMPLETED', 'FAILED'), empty])).toBe('');
    expect(buildRepeatedNoProgressSection(['COMPLETED fish: 成功：钓到沙丁鱼', 'COMPLETED fish: 成功：钓到沙丁鱼'])).toBe('');
    expect(buildRepeatedNoProgressSection([empty, empty, ...Array<string>(7).fill('COMPLETED travel_to: 成功：到达农场')])).toBe('');

    // 夏27真机反模式：书商摊反复 interact/dialogue/close_menu，界面开合不推进时间
    const bookShop = [
      'COMPLETED interact: 成功：交互后打开了界面：\n对话框：我是马尔赛罗，欢迎来到我的书摊！',
      'COMPLETED dialogue: 成功：对话已推进。当前界面：商店界面（Bookseller）。',
      'COMPLETED close_menu: 成功：已关闭。当前界面：无（可以自由行动）',
      'COMPLETED interact: 成功：交互后打开了界面：\n对话框：我是马尔赛罗，欢迎来到我的书摊！',
      'COMPLETED dialogue: 成功：对话已推进。当前界面：商店界面（Bookseller）。',
      'COMPLETED close_menu: 成功：已关闭。当前界面：无（可以自由行动）',
    ];
    const loop = buildRepeatedNoProgressSection(bookShop);
    expect(loop).toContain('反复开合同一交互界面');
    expect(loop).toContain('出现6次');
    expect(loop).toContain('仍保留 COMPLETED 状态');
    expect(loop).toContain('不推进游戏时间');
    expect(loop).not.toContain('最近失败签名');
    expect(loop).not.toContain('下矿');
    // 单次开合不应误报
    expect(buildRepeatedNoProgressSection(bookShop.slice(0, 2))).toBe('');
    const prompt = buildFailureMemorySection({ lastSignature: null, streak: 0, lastSummary: '', clockStallSec: 0 }, [empty, empty]);
    expect(prompt).toContain('空区域清理');
    expect(prompt).toContain('出现2次');
    expect(prompt).toContain('仍保留 COMPLETED 状态');
    expect(prompt).toContain('换一件能改变时间或资源的事');
    expect(prompt).not.toContain('最近失败签名');
    expect(prompt).not.toContain('下矿');
    const withFailure = buildFailureMemorySection({ lastSignature: 'eat|缺少食物', streak: 1, lastSummary: '缺少食物', clockStallSec: 61 }, [empty, empty]);
    expect(withFailure).toContain('出现2次');
    expect(withFailure).toContain('最近失败签名');
  });

  it('buildFailureMemorySection 支持直接记忆、recentReceipts 回退与时钟停滞提示', () => {
    expect(buildFailureMemorySection({ lastSignature: null, streak: 0, lastSummary: '', clockStallSec: 10 }, [])).toBe('');
    const fromReceipts = buildFailureMemorySection(
      { lastSignature: null, streak: 0, lastSummary: '', clockStallSec: 95 },
      ['FAILED fish: 失败：背包里没有鱼竿'],
    );
    expect(fromReceipts).toContain('fish|失败：背包里没有鱼竿');
    expect(fromReceipts).toContain('停滞现实 95 秒');
    expect(fromReceipts).toContain('换个做法');
  });
});

describe('DayPlanStore 与计划修订（§4.2）', () => {
  it('解析清晨计划并支持增删改/完成/整体替换与跨日清空', () => {
    expect(parseMorningPlanObject({ plan: 'bad' })).toBeNull();
    expect(parseMorningPlanObject({ plan: [] })).toBeNull();
    const parsed = parseMorningPlanObject({
      plan: [{ goal: '浇水收菜', why: '防风草熟了' }, '去海边钓鱼'],
      mood: '想赚钱买大背包',
    });
    expect(parsed?.items).toHaveLength(2);
    expect(parsed?.mood).toBe('想赚钱买大背包');

    const store = new DayPlanStore();
    expect(store.formatForPrompt()).toContain('尚未建立');
    const morning = store.setMorningPlan('春16', parsed!.items, parsed!.mood, '第1年春16日 06:00');
    expect(morning.items[0]?.status).toBe('in_progress');
    expect(morning.items[0]?.addedAt).toBe('第1年春16日 06:00');
    expect(morning.history).toHaveLength(1);
    expect(morning.history?.[0]?.kind).toBe('morning');
    expect(store.formatForPrompt()).toContain('[进行中] 浇水收菜');

    const upd = parsePlanUpdate({
      why: '下雨不用浇水',
      done: [0],
      inProgress: ['钓鱼'],
      add: [{ goal: '下矿挖铜', reason: '顺路' }],
    });
    expect(upd).not.toBeNull();
    const after = store.applyUpdate('春16', upd!, '第1年春16日 06:20');
    expect(after?.items[0]?.status).toBe('done');
    expect(after?.items[0]?.completedAt).toBe('第1年春16日 06:20');
    expect(after?.items[1]?.status).toBe('in_progress');
    expect(after?.items[2]?.goal).toBe('下矿挖铜');
    expect(after?.items[2]?.addedAt).toBe('第1年春16日 06:20');
    expect(after?.updateWhy).toBe('下雨不用浇水');
    expect(after?.history).toHaveLength(2);
    expect(after?.history?.[1]?.summary).toContain('完成「浇水收菜」');
    expect(after?.history?.[1]?.why).toBe('下雨不用浇水');

    const replaced = store.applyUpdate('春16', parsePlanUpdate([{ title: '早点睡觉', status: 'pending' }])!);
    expect(replaced?.items).toHaveLength(1);
    expect(parsePlanUpdate({})).toBeNull();
    expect(parsePlanUpdate([])).toBeNull();

    store.rollover('春17');
    expect(store.snapshot()).toBeNull();
    expect(store.hasAttemptedToday('春17')).toBe(false);

    // 重复目标去重：同名/同义标点不会重复推入 add 列表
    const dedup = new DayPlanStore();
    dedup.setMorningPlan('春1', [{ goal: '开礼物箱拿种子', why: '晨间', status: 'in_progress' }]);
    const res = dedup.applyUpdate('春1', parsePlanUpdate({
      add: [{ goal: '开礼物箱拿种子！', why: '补充理由' }, { goal: '走到礼物箱旁' }, { goal: '走到礼物箱旁' }],
    })!);
    expect(res?.items).toHaveLength(2);
    expect(res?.items[0]?.why).toBe('补充理由');
  });
});

describe('BrainSwitch 安全暂停与显式规则代驾状态机（V2-P1-06 / ADR-002 D-103）', () => {
  it('默认 allowRuleStandin=false：缺 Key → paused（安全暂停不调用规则）→ 配好 Key 后立即恢复 llm', () => {
    let keyReady = false;
    const events: Array<{ mode: BrainMode; reason: string }> = [];
    const sw = new BrainSwitch({
      isKeyAvailable: () => keyReady,
      onModeChange: (mode, reason) => events.push({ mode, reason }),
    });
    expect(sw.shouldTryLlm()).toBe(false);
    expect(sw.mode).toBe('paused');
    expect(sw.isPaused()).toBe(true);
    expect(sw.isUnavailable()).toBe(true);
    keyReady = true;
    expect(sw.shouldTryLlm()).toBe(true);
    sw.recordSuccess();
    expect(sw.mode).toBe('llm');
    expect(events.map((e) => e.mode)).toEqual(['paused', 'llm']);
  });

  it('显式 allowRuleStandin=true：连续 3 次解析失败 → rule-standin → 2 分钟后探测成功恢复', () => {
    let now = 1_000;
    const modes: BrainMode[] = [];
    const sw = new BrainSwitch({
      allowRuleStandin: true,
      now: () => now,
      probeIntervalMs: 120_000,
      onModeChange: (m) => modes.push(m),
    });
    expect(sw.recordParseFailure('坏1')).toBe(false);
    expect(sw.recordParseFailure('坏2')).toBe(false);
    expect(sw.recordParseFailure('坏3')).toBe(true);
    expect(sw.mode).toBe('rule-standin');

    now += 60_000;
    expect(sw.shouldTryLlm()).toBe(false);
    now += 60_000;
    expect(sw.shouldTryLlm()).toBe(true);
    expect(sw.recordParseFailure('探测仍坏')).toBe(true);
    now += 60_000;
    expect(sw.shouldTryLlm()).toBe(false);
    now += 60_000;
    expect(sw.shouldTryLlm()).toBe(true);
    sw.recordSuccess();
    expect(sw.mode).toBe('llm');
    expect(modes).toEqual(['rule-standin', 'llm']);
  });

  it('手动 setUserMode(rule ↔ llm) 与单次网关超时默认进入 paused（未启用代驾）', () => {
    const sw = new BrainSwitch();
    sw.setUserMode('rule');
    expect(sw.mode).toBe('rule');
    expect(sw.shouldTryLlm()).toBe(false);
    sw.recordGatewayFailure('ignored in rule');
    expect(sw.mode).toBe('rule');
    sw.setUserMode('llm');
    expect(sw.mode).toBe('llm');
    sw.recordGatewayFailure('ETIMEDOUT');
    expect(sw.mode).toBe('paused');
    expect(sw.isStandin()).toBe(false);
  });
});

describe('LlmPlanner 全权自主决策核心契约（§4.1–§4.9）', () => {
  it('LLM 可用期间 RulePlanner.decide 调用 0 次（spy 严格断言）', async () => {
    const rule = new RulePlanner();
    const decideSpy = vi.spyOn(rule, 'decide');
    const plans: PlanEmission[] = [];
    const script = [
      '{"plan":[{"goal":"读信浇水","why":"早上例行"}],"mood":"傲娇"}',
      '{"tool":"read_mail","args":{},"intent":"先看看谁寄信啦"}',
      '{"tool":"water_crops","args":{},"intent":"去把防风草浇了","planUpdate":{"why":"信读完啦","done":[0]}}',
    ];
    let idx = 0;
    const planner = new LlmPlanner({
      fallbackPlanner: rule,
      onPlan: (ev) => plans.push(ev),
      chat: async () => ({ content: script[idx++] ?? '{"tool":"wait","args":{}}' }),
    });
    const d1 = await planner.decide(state());
    expect(d1).toMatchObject({ kind: 'act', tool: 'read_mail' });
    const d2 = await planner.decide(state());
    expect(d2).toMatchObject({ kind: 'act', tool: 'water_crops' });
    expect(decideSpy).toHaveBeenCalledTimes(0);
    expect(plans.map((p) => p.reason)).toEqual(['morning', 'update']);
  });

  it('体力 5%、时钟 01:40、满包 0 空位、低血量时 LLM 选 fish 原样执行，prompt 含醒目生存提醒', async () => {
    const rule = new RulePlanner();
    const decideSpy = vi.spyOn(rule, 'decide');
    const capturedPrompts: string[] = [];
    const planner = new LlmPlanner({
      fallbackPlanner: rule,
      chat: async (_slot, messages) => {
        capturedPrompts.push(messages.at(-1)?.content ?? '');
        if (capturedPrompts.length === 1) {
          return { content: '{"plan":[{"goal":"夜钓冲刺","why":"想钓稀有鱼"}],"mood":"头铁"}' };
        }
        return { content: '{"tool":"fish","args":{"casts":1},"intent":"就算困死也要再甩最后一竿！"}' };
      },
    });
    const extreme = parseGameState(`时间：第1年春16日 01:40（Tue），天气：晴
金钱：500g  体力：13/270  生命：20/100
## 当前界面
无（可以自由行动）
## 位置
地点：Beach（沙滩）
## 背包（序号: 物品）
0: 竹鱼竿
5: 沙丁鱼 [可食用 +23 体力]
背包空位：0 个（共 12 格）`);

    const decision = await planner.decide(extreme);
    expect(decision).toMatchObject({ kind: 'act', tool: 'fish', args: { casts: 1 } });
    expect(decideSpy).toHaveBeenCalledTimes(0);
    const decisionPrompt = capturedPrompts[1] ?? '';
    expect(decisionPrompt).toContain('体力仅剩 5%');
    expect(decisionPrompt).toContain('只剩 20 分钟');
    expect(decisionPrompt).toContain('背包空位为 0');
  });

  it('失败一次后下一轮 prompt 含归一化失败签名与「换个做法」，成功回执解除失败记忆', async () => {
    const prompts: string[] = [];
    const planner = new LlmPlanner({
      chat: async (_slot, messages) => {
        prompts.push(messages.at(-1)?.content ?? '');
        return { content: '{"tool":"forage","args":{},"intent":"换去捡贝壳"}' };
      },
    });
    const beach = state(STATE_OK.replace('地点：Farm（泡泡湾农场）', '地点：Beach（沙滩）'));
    await planner.decide(beach); // 首轮建立地点
    planner.observeReceipt('fish', 'FAILED', '失败：背包里没有鱼竿（坐标 (12,34)）');
    await planner.decide(beach);
    expect(prompts.at(-1)).toContain('fish|失败：背包里没有鱼竿（坐标 (坐标)）|Beach');
    expect(prompts.at(-1)).toContain('换个做法');

    planner.observeReceipt('forage', 'COMPLETED', '采集到海草');
    await planner.decide(beach);
    expect(prompts.at(-1)).not.toContain('最近失败签名');
  });

  it('换日后重新生成一次当日计划；T-M6-73 接管差异摘要单次注入后自动清空', async () => {
    const plans: PlanEmission[] = [];
    const userPrompts: string[] = [];
    let day = 16;
    const planner = new LlmPlanner({
      onPlan: (ev) => plans.push(ev),
      chat: async (_slot, messages) => {
        const user = messages.at(-1)?.content ?? '';
        userPrompts.push(user);
        if (user.includes('请制定今日计划')) {
          return { content: `{"plan":[{"goal":"春${day}日目标","why":"新的一天"}],"mood":"精神饱满"}` };
        }
        return { content: '{"tool":"read_mail","args":{},"intent":"读信"}' };
      },
    });
    planner.setHandoverSummary('主人接管了 2 分钟：金币 640→500（-140），买了防风草种子');
    await planner.decide(state());
    expect(plans).toHaveLength(1);
    expect(plans[0]?.dayKey).toBe('春16');
    expect(userPrompts.at(-1)).toContain('主人接管了 2 分钟');

    // 同日第二次决策：不再重问计划，接管摘要也已消费清空
    await planner.decide(state());
    expect(plans).toHaveLength(1);
    expect(userPrompts.at(-1)).not.toContain('主人接管了 2 分钟');

    // 换日到春 17：重新生成一次计划
    day = 17;
    await planner.decide(state(STATE_OK.replace('第1年春16日', '第1年春17日')));
    expect(plans).toHaveLength(2);
    expect(plans[1]?.dayKey).toBe('春17');
  });

  it('普通聊天建议：decline 不执行且发出 reply；accept 下一步一致；2 个游戏小时未表态自动过期', async () => {
    const stances: ChatStanceEmission[] = [];
    const prompts: string[] = [];
    let step = 0;
    const responses = [
      '{"tool":"water_crops","args":{},"intent":"先把菜浇了","stance":"decline","reply":"哼，现在去矿洞？菜还没浇呢，明天再去！"}',
      '{"tool":"travel_to","args":{"location":"FishShop"},"intent":"去威利店里看看","stance":"accept","reply":"好吧好吧，听你的去买根鱼竿～"}',
      '{"tool":"forage","args":{},"intent":"没空理你先捡东西"}', // 故意不带 stance
      '{"tool":"forage","args":{},"intent":"两小时后继续捡"}',
    ];
    const planner = new LlmPlanner({
      onChatStance: (ev) => stances.push(ev),
      chat: async (_slot, messages) => {
        prompts.push(messages.at(-1)?.content ?? '');
        return { content: responses[step++] ?? '{"tool":"wait","args":{}}' };
      },
    });

    // 1) decline：拒绝去矿洞，按自己的想法浇水，同时发出傲娇 reply
    planner.submitSuggestion('现在去矿洞挖矿吧');
    const d1 = await planner.decide(state());
    expect(d1).toMatchObject({ kind: 'act', tool: 'water_crops' });
    expect(stances[0]).toMatchObject({ kind: 'suggestion', stance: 'decline', reply: '哼，现在去矿洞？菜还没浇呢，明天再去！' });

    // 2) accept：采纳买鱼竿建议
    planner.submitSuggestion('去鱼店买根鱼竿');
    const d2 = await planner.decide(state());
    expect(d2).toMatchObject({ kind: 'act', tool: 'travel_to', args: { location: 'FishShop' } });
    expect(stances[1]).toMatchObject({ kind: 'suggestion', stance: 'accept' });

    // 3) 过期机制：07:30 收到建议但本轮未表态 → 09:40（+130 分钟 ≥ 120）自动从上下文移除
    planner.submitSuggestion('快回家睡觉');
    await planner.decide(state()); // 07:30 打上时间戳，未表态
    expect(prompts.at(-1)).toContain('快回家睡觉');
    await planner.decide(state(STATE_OK.replace('07:30', '09:40')));
    expect(prompts.at(-1)).not.toContain('快回家睡觉');
  });

  it('强制命令 `/自然语言`：decline 被拒收重问；连续 2 次不合规进代驾', async () => {
    const brainModes: BrainMode[] = [];
    let call = 0;
    const script = [
      '{"stance":"decline","reply":"我不想去","tool":"fish","args":{}}',
      '{"stance":"execute","reply":"遵命！这就去皮埃尔店里～","tool":"travel_to","args":{"location":"SeedShop"},"intent":"执行命令去买种子"}',
    ];
    const planner = new LlmPlanner({
      onBrainChange: (m) => brainModes.push(m),
      chat: async () => ({ content: script[call++] ?? '{}' }),
    });
    planner.submitCommand('去皮埃尔买 10 包防风草种子');
    const d = await planner.decide(state());
    expect(call).toBe(2); // 第一次 decline 被拒收重问，第二次 execute 放行
    expect(d).toMatchObject({ kind: 'act', tool: 'travel_to', args: { location: 'SeedShop' } });
    expect(planner.isStandin()).toBe(false);

    // 连续 2 次不合规 → 默认安全暂停；显式 allowRuleStandin=true 时才进入 rule-standin 代驾
    const stubborn = new LlmPlanner({
      allowRuleStandin: true,
      onBrainChange: (m) => brainModes.push(m),
      chat: async () => ({ content: '{"stance":"decline","reply":"就不去","tool":"fish","args":{}}' }),
    });
    stubborn.submitCommand('立刻去矿洞');
    const fallbackDecision = await stubborn.decide(state());
    expect(stubborn.isStandin()).toBe(true);
    expect(brainModes).toContain('rule-standin');
    expect(fallbackDecision.kind).toBe('act');
  });

  it('强制命令 infeasible：缺 reason 被拒收；有具体 reason 合法结束命令并上报原因/替代方案', async () => {
    const stances: ChatStanceEmission[] = [];
    let idx = 0;
    const script = [
      '{"stance":"infeasible","reply":"做不到"}', // 缺 reason → 拒收重问
      '{"stance":"infeasible","reason":"今天周三，皮埃尔杂货店关门休息","alternative":"明天 9 点开门再去买","reply":"主人，周三皮埃尔不开门呀！明早第一个去～"}',
    ];
    const planner = new LlmPlanner({
      onChatStance: (ev) => stances.push(ev),
      chat: async () => ({ content: script[idx++] ?? '{}' }),
    });
    planner.submitCommand('去皮埃尔买种子');
    const d = await planner.decide(state());
    expect(idx).toBe(2);
    expect(d.kind).toBe('wait');
    expect(planner.hasCommand()).toBe(false);
    expect(stances[0]).toMatchObject({
      kind: 'command',
      stance: 'infeasible',
      reason: '今天周三，皮埃尔杂货店关门休息',
      alternative: '明天 9 点开门再去买',
    });
  });

  it('强制命令 execute 持续有效：直到 commandDone + COMPLETED 回执才结束；失败回执自动撤回；/cancel 可随时终止', async () => {
    let idx = 0;
    const script = [
      '{"stance":"execute","reply":"收到，先赶路去商店","tool":"travel_to","args":{"location":"SeedShop"},"intent":"去杂货店"}',
      '{"tool":"buy","args":{"item":"防风草种子","count":10},"intent":"买 10 包种子","commandDone":true}',
      '{"tool":"buy","args":{"item":"防风草种子","count":10},"intent":"重试买种子","commandDone":true}',
    ];
    const planner = new LlmPlanner({
      chat: async () => ({ content: script[idx++] ?? '{"tool":"wait","args":{}}' }),
    });
    planner.submitCommand('去买 10 包防风草种子');
    const step1 = await planner.decide(state());
    expect(step1).toMatchObject({ kind: 'act', tool: 'travel_to' });
    expect(planner.hasCommand()).toBe(true);
    expect(planner.consumeObjectiveDone()).toBeNull(); // 第一步未标 commandDone

    const step2 = await planner.decide(state());
    expect(step2).toMatchObject({ kind: 'act', tool: 'buy' });
    // 假设动作失败：restoreObjectiveDone 撤回完成声明，命令仍然持续有效！
    planner.restoreObjectiveDone();
    expect(planner.hasCommand()).toBe(true);

    // 重试并真实 COMPLETED：consumeObjectiveDone 正式结算结束命令
    await planner.decide(state());
    expect(planner.consumeObjectiveDone()).toBe('/去买 10 包防风草种子');
    expect(planner.hasCommand()).toBe(false);

    // /cancel 主动终止
    planner.submitCommand('今天别下矿');
    expect(planner.cancelCommand()).toBe('今天别下矿');
    expect(planner.hasCommand()).toBe(false);
  });

  it('LlmPlanner 集成恢复（显式 allowRuleStandin=true 兼容探测恢复；默认则安全暂停）', async () => {
    let now = 0;
    let healthy = false;
    const modes: BrainMode[] = [];
    const planner = new LlmPlanner({
      allowRuleStandin: true,
      now: () => now,
      probeIntervalMs: 120_000,
      onBrainChange: (m) => modes.push(m),
      chat: async () => {
        if (!healthy) return { content: '我胡言乱语不输出 JSON' };
        return { content: '{"tool":"forage","args":{},"intent":"大脑恢复啦，去采集！"}' };
      },
    });
    // 首轮：晨间计划乱码(#1) + 步决策乱码(#2, #3) → 显式代驾进入 rule-standin
    const standin1 = await planner.decide(state());
    expect(planner.isStandin()).toBe(true);
    expect(standin1.kind === 'act' ? standin1.intent : '').toContain('规则代驾：');

    healthy = true;
    now += 60_000;
    const standin2 = await planner.decide(state());
    expect(planner.isStandin()).toBe(true);
    expect(standin2.kind === 'act' ? standin2.intent : '').toContain('规则代驾：');

    now += 60_000;
    const recovered = await planner.decide(state());
    expect(planner.isStandin()).toBe(false);
    expect(recovered).toMatchObject({ kind: 'act', tool: 'forage', intent: '大脑恢复啦，去采集！' });
    expect(modes).toEqual(['rule-standin', 'llm']);
  });
});

describe('多游戏 adapter seam 与多步目标兼容（M7 & T-M6-54）', () => {
  it('systemPrompt 适配器路径使用游戏专属槽位、白名单、惰性求值与兜底', async () => {
    let who = '蓝蓝';
    const systems: string[] = [];
    const planner = new LlmPlanner({
      slot: 'TERRARIA_GAME_PLANNER',
      systemPrompt: () => `你是${who}，正在替主人游玩《泰拉瑞亚》。`,
      toolWhitelist: ['mine'],
      chat: async (_slot, messages) => {
        systems.push(messages[0]?.content ?? '');
        return { content: '{"tool":"mine","args":{"target":"tree"},"intent":"砍树"}' };
      },
    });
    expect(await planner.decide(state())).toMatchObject({ kind: 'act', tool: 'mine' });
    who = '小克';
    await planner.decide(state());
    expect(systems).toEqual(['你是蓝蓝，正在替主人游玩《泰拉瑞亚》。', '你是小克，正在替主人游玩《泰拉瑞亚》。']);

    const offlinePaused = new LlmPlanner({
      systemPrompt: 'DST 专属提示',
      toolWhitelist: ['gather'],
      fallbackPlanner: { name: 'dst-offline', decide: async () => ({ kind: 'act', tool: 'gather', args: {}, intent: '离线规则' }) },
      chat: async () => { throw new Error('gateway offline'); },
    });
    expect(await offlinePaused.decide(state())).toMatchObject({ kind: 'wait' });

    const offlineOptIn = new LlmPlanner({
      systemPrompt: 'DST 专属提示',
      toolWhitelist: ['gather'],
      allowRuleStandin: true,
      fallbackPlanner: { name: 'dst-offline', decide: async () => ({ kind: 'act', tool: 'gather', args: {}, intent: '离线规则' }) },
      chat: async () => { throw new Error('gateway offline'); },
    });
    expect(await offlineOptIn.decide(state())).toMatchObject({ kind: 'act', tool: 'gather', intent: '规则兜底：离线规则' });
  });

  it(`多步目标 objectiveDone 确认/恢复、超过 ${MAX_OBJECTIVE_ROUNDS} 轮清空与跨日清空`, async () => {
    const prompts: string[] = [];
    const planner = new LlmPlanner({
      contextProvider: () => '团队目标：修温室',
      chat: async (_slot, messages) => {
        prompts.push(messages.at(-1)?.content ?? '');
        return { content: '{"tool":"buy","args":{"item":"竹鱼竿"},"intent":"买鱼竿","objectiveDone":true}' };
      },
    });
    planner.setObjective('去买竹鱼竿');
    await planner.decide(state());
    expect(prompts.at(-1)).toContain('团队协作黑板');
    expect(prompts.at(-1)).toContain('主人当前目标：去买竹鱼竿');
    planner.restoreObjectiveDone();
    expect(planner.hasObjective()).toBe(true);
    await planner.decide(state());
    expect(planner.consumeObjectiveDone()).toBe('去买竹鱼竿');
    expect(planner.hasObjective()).toBe(false);

    const loopPlanner = new LlmPlanner({ chat: async () => ({ content: '{"tool":"fish","args":{}}' }) });
    loopPlanner.setObjective('钓 5 条鱼');
    for (let i = 0; i < MAX_OBJECTIVE_ROUNDS + 1; i++) await loopPlanner.decide(state());
    expect(loopPlanner.hasObjective()).toBe(false);

    loopPlanner.setObjective('跨日目标');
    await loopPlanner.decide(state());
    await loopPlanner.decide(state(STATE_OK.replace('第1年春16日', '第1年春17日')));
    expect(loopPlanner.hasObjective()).toBe(false);
  });

  it('边界分支全覆盖：remove/add 空库修订、网关中途抛错、越权纠错、infeasible 附带动作、黑板异常隔离', async () => {
    // 1) DayPlanStore 空库直接 applyUpdate + remove + 非法元素过滤
    const freshStore = new DayPlanStore();
    expect(parsePlanUpdate(null)).toBeNull();
    expect(freshStore.applyUpdate('春16', { remove: [0] })).toBeNull();
    const added = freshStore.applyUpdate('春16', parsePlanUpdate({
      reason: '临时加活',
      add: ['去砍树', { goal: '去钓鱼' }, 123 as unknown as string, { goal: '   ' }],
    })!);
    expect(added?.items).toHaveLength(2);
    const removed = freshStore.applyUpdate('春16', { remove: ['去砍树', 1] });
    expect(removed?.items).toEqual([]);
    expect(freshStore.snapshot()?.items).toEqual([]);
    const fromItemsKey = parsePlanUpdate({ items: [{ goal: '备选计划', status: 'invalid' as 'pending' }] });
    expect(fromItemsKey?.replace?.[0]?.status).toBe('pending');

    // 2) BrainSwitch initialMode=rule / 缺 Key 时手动切 llm 默认安全暂停 / 代驾期重复 command 不合规
    const ruleSw = new BrainSwitch({ initialMode: 'rule', isKeyAvailable: () => false });
    expect(ruleSw.userMode).toBe('rule');
    ruleSw.setUserMode('llm');
    expect(ruleSw.mode).toBe('paused');
    expect(ruleSw.reason).toContain('Key');
    expect(ruleSw.recordCommandNonCompliance('暂停中仍不合规')).toBe(true);

    // 3) normalizeToolArgs / pickPrematureReservedEdible / extractDecisionJson 细粒度分支
    expect(normalizeToolArgs({ items: [null, '石头'] }, 'ship_items')).toEqual({ item: '石头' });
    expect(normalizeToolArgs({ x: { id: 'copper' }, y: { raw: 1 } }, 'move_to')).toEqual({ x: 'copper', y: { raw: 1 } });
    expect(extractDecisionJson('{"tool":"sleep","args":{},"objectiveDone":true}')?.objectiveDone).toBe(true);
    expect(pickPrematureReservedEdible('7: 石头【留着：社区中心“未开包”要交】', '【工艺室】春季采集')).toBe('石头');
    expect(pickPrematureReservedEdible('7: 石头【留着：社区中心“建筑”要交】', '建筑')).toBeNull();

    // 4) 晨间计划抛错默认安全暂停（wait, RulePlanner 0 调用）；晨间计划同条携带 tool 直接复用；步决策越权纠错与网关抛错
    const ruleSpy = vi.fn(async () => ({ kind: 'act' as const, tool: 'wait', args: {}, intent: 'should not run' }));
    const errPlanner = new LlmPlanner({
      fallbackPlanner: { name: 'spy-rule', decide: ruleSpy },
      chat: async () => { throw new Error('morning timeout'); },
    });
    errPlanner.setSlot('STARDEW_GAME_PLANNER');
    errPlanner.setGuides({ 钓鱼: 'test' });
    errPlanner.setRecentReceipts(['FAILED fish: 没竿']);
    const errRes = await errPlanner.decide(state());
    expect(errRes.kind).toBe('wait');
    expect(errPlanner.isPaused()).toBe(true);
    expect(ruleSpy).toHaveBeenCalledTimes(0);

    let oneShotCalls = 0;
    const oneShot = new LlmPlanner({
      contextProvider: () => { throw new Error('blackboard boom'); },
      chat: async () => {
        oneShotCalls += 1;
        return { content: '{"plan":[{"goal":"顺手读信","why":"一举两得"}],"tool":"read_mail","args":{},"intent":"读信"}' };
      },
    });
    expect(await oneShot.decide(state())).toMatchObject({ kind: 'act', tool: 'read_mail' });
    expect(oneShotCalls).toBe(1);

    let stepCalls = 0;
    const stepRecover = new LlmPlanner({
      chat: async () => {
        stepCalls += 1;
        if (stepCalls === 1) return { content: '{"plan":[{"goal":"农活","why":"日常"}]}' };
        if (stepCalls === 2) return { content: '{"tool":"rm_rf","args":{}}' };
        return { content: '{"tool":"forage","args":{},"intent":"改采集"}' };
      },
    });
    expect(await stepRecover.decide(state())).toMatchObject({ kind: 'act', tool: 'forage' });

    let stepThrowCalls = 0;
    const stepThrow = new LlmPlanner({
      chat: async () => {
        stepThrowCalls += 1;
        if (stepThrowCalls === 1) return { content: '{"plan":[{"goal":"农活","why":"日常"}]}' };
        throw new Error('step socket hang up');
      },
    });
    await stepThrow.decide(state());
    expect(stepThrow.isPaused()).toBe(true);

    // 5) 强制命令：缺表态 / execute 缺合法 tool / infeasible 同时带合法替代 tool
    let cmdIdx = 0;
    const cmdResponses = [
      '{"tool":"fish","args":{}}', // 缺 stance → 拒收
      '{"stance":"infeasible","reason":"鱼店关门","tool":"forage","args":{},"intent":"顺路捡贝壳","reply":"关门啦先捡贝壳"}',
    ];
    const cmdPlanner = new LlmPlanner({ chat: async () => ({ content: cmdResponses[cmdIdx++] ?? '{}' }) });
    cmdPlanner.submitCommand('去鱼店买高级鱼竿');
    const infAct = await cmdPlanner.decide(state());
    expect(infAct).toMatchObject({ kind: 'act', tool: 'forage' });

    const badToolCmd = new LlmPlanner({
      chat: async () => ({ content: '{"stance":"execute","tool":"not_in_whitelist","args":{}}' }),
    });
    badToolCmd.submitCommand('乱来');
    await badToolCmd.decide(state());
    expect(badToolCmd.isPaused()).toBe(true);

    // 6) asks / 空输入过滤 / todayReceipts>60 裁剪 / 晨间计划返回纯动作或乱码 / 跨日建议过期 / decideForAdapter 重试与 objectiveDone
    badToolCmd.submitSuggestion('   ');
    badToolCmd.submitCommand('///   ');
    badToolCmd.setHandoverSummary('   ');
    expect(badToolCmd.hasCommand()).toBe(true);
    expect(badToolCmd.cancelCommand()).toBe('乱来');
    expect(badToolCmd.cancelCommand()).toBeNull();
    expect(badToolCmd.hasCommand()).toBe(false);
    expect(badToolCmd.asks).toBeGreaterThan(0);
    for (let i = 0; i < 65; i++) badToolCmd.observeReceipt('fish', 'FAILED', `失败${i}`);

    let reuseIdx = 0;
    const morningReuse = new LlmPlanner({
      personaPrompt: () => '活泼小鲸',
      onPlan: () => {},
      onChatStance: () => {},
      onBrainChange: () => {},
      fallbackPlanner: { name: 'wait-fb', decide: async () => ({ kind: 'wait', seconds: 2, reason: 'idle' }) },
      chat: async () => {
        reuseIdx += 1;
        if (reuseIdx === 1) return { content: '{"tool":"forage","args":{},"intent":"晨间直接返回动作"}' };
        return { content: '完全乱码' };
      },
    });
    morningReuse.submitSuggestion('跨日建议');
    expect(await morningReuse.decide(state())).toMatchObject({ kind: 'act', tool: 'forage' });
    // 跨日后建议满 2h 过期 + 无标准时间行兜底 + 晨间计划乱码降级等待型 fallback
    await morningReuse.decide(state(STATE_OK.replace('第1年春16日 07:30', '第1年春17日 08:00')));
    expect(morningReuse.debugSnapshot()['pendingSuggestion']).toBeNull();
    await morningReuse.decide({ ...state(), raw: '无标准时间头', gameClock: '' });

    let adpIdx = 0;
    const adpPlanner = new LlmPlanner({
      systemPrompt: 'Adapter prompt',
      toolWhitelist: ['mine'],
      allowRuleStandin: true,
      fallbackPlanner: { name: 'wait-fb', decide: async () => ({ kind: 'wait', seconds: 3, reason: 'rest' }) },
      chat: async () => {
        adpIdx += 1;
        if (adpIdx === 1) return { content: 'not json' };
        if (adpIdx === 2) return { content: '{"tool":"mine","args":{},"intent":"挖矿","objectiveDone":true}' };
        return { content: '{"tool":"forbidden","args":{}}' };
      },
    });
    adpPlanner.observeReceipt('mine', 'FAILED', '体力不足');
    adpPlanner.setObjective('挖一块矿');
    expect(await adpPlanner.decide(state())).toMatchObject({ kind: 'act', tool: 'mine' });
    expect(adpPlanner.consumeObjectiveDone()).toBe('挖一块矿');
    expect(await adpPlanner.decide(state())).toMatchObject({ kind: 'wait', seconds: 3 });
  });
});

describe('S01–S07 卡死回归剧本内存同构验证（免端口绑定验证真实 AutodriveRunner + LlmPlanner/RulePlanner）', () => {
  const scenarioDir = fileURLToPath(new URL('../../../tools/mock-harness/scenarios/stuck', import.meta.url));
  const files = readdirSync(scenarioDir).filter((f) => f.endsWith('.json')).sort();
  const readOnlyTools = new Set(['get_state', 'list_chests', 'map_info', 'bundle_info', 'gift_info', 'get_guide', 'quest_board', 'cancel_action']);

  for (const file of files) {
    it(`剧本回归通过：${file}`, async () => {
      const scenario = JSON.parse(readFileSync(join(scenarioDir, file), 'utf8')) as {
        id: string;
        initialState: string;
        freezeUntilMutation?: boolean;
        planner?: 'rule' | 'llm' | 'idle';
        llmScript?: string[];
        rules: Array<{ tool: string; receipt: { text: string; isError?: boolean }; advanceMinutes?: number }>;
        expect: {
          maxCycles: number;
          maxSameFailure: number;
          mustCallOneOf?: string[];
          mustCallWithArgs?: Array<{ tool: string; args: Record<string, unknown> }>;
          clockMustAdvance?: boolean;
        };
      };
      let frozen = scenario.freezeUntilMutation === true;
      let menuCleared = false;
      const clockRe = /时间：第(\d+)年([春夏秋冬])(\d+)日 (\d{2}):(\d{2})/;
      const m0 = clockRe.exec(scenario.initialState);
      let minutes = m0 ? Number(m0[4]) * 60 + Number(m0[5]) : 360;
      const startMinutes = minutes;
      const calls: Array<{ tool: string; args: Record<string, unknown>; isError: boolean }> = [];

      const fetchImpl: typeof fetch = async (_input, init) => {
        const rpc = JSON.parse(String(init?.body ?? '{}')) as { id?: unknown; params?: { name?: string; arguments?: Record<string, unknown> } };
        const tool = rpc.params?.name ?? 'get_state';
        const args = rpc.params?.arguments ?? {};
        let text = '';
        let isError = false;
        if (tool === 'get_state') {
          const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
          const mm = String(minutes % 60).padStart(2, '0');
          text = scenario.initialState.replace(clockRe, `时间：第${m0?.[1] ?? '1'}年${m0?.[2] ?? '春'}${m0?.[3] ?? '16'}日 ${hh}:${mm}`);
          if (menuCleared) text = text.replace(/(## 当前界面\n)[\s\S]*?(?=\n## |\s*$)/, '$1无（可以自由行动）\n');
          if (frozen) text += '\n## BWF 提示\n（MCP 客户端 120 秒没有动作，已暂停游戏）\n';
        } else {
          const menuNow = /## 当前界面\n([\s\S]*?)(?=\n## |\s*$)/.exec(menuCleared ? '' : scenario.initialState)?.[1] ?? '';
          const choiceGate = /选项|选择题/.test(menuNow) && tool === 'dialogue';
          if (choiceGate && typeof args['choice'] !== 'number') {
            text = '失败：这是选择题，需要用 dialogue 传 choice 序号（0 基）回答';
            isError = true;
          } else {
            if (frozen && !readOnlyTools.has(tool)) frozen = false;
            const rule = scenario.rules.find((r) => r.tool === tool) ?? scenario.rules.find((r) => r.tool === '*');
            if (!rule) {
              text = `失败：未覆盖工具 ${tool}`;
              isError = true;
            } else {
              if (!frozen && rule.advanceMinutes !== undefined) minutes += rule.advanceMinutes;
              if (choiceGate) menuCleared = true;
              text = rule.receipt.text;
              isError = rule.receipt.isError === true;
            }
          }
        }
        calls.push({ tool, args, isError });
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: rpc.id ?? 1, result: { content: [{ type: 'text', text }], isError } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };

      const receipts: string[] = [];
      let scriptIdx = 0;
      const mode = scenario.planner ?? 'rule';
      const allowStandin = (scenario as { allowRuleStandin?: boolean }).allowRuleStandin === true;
      const llm = mode === 'llm'
        ? new LlmPlanner({
          chat: async () => ({ content: scenario.llmScript?.[scriptIdx++] ?? '（无输出）' }),
          recentReceipts: [],
          allowRuleStandin: allowStandin,
          fallbackPlanner: new RulePlanner(),
        })
        : null;
      const decisions: string[] = [];
      const basePlanner = mode === 'idle'
        ? { name: 'idle', decide: async () => ({ kind: 'wait' as const, seconds: 5, reason: 'idle' }) }
        : (llm ?? new RulePlanner());
      const wrappedPlanner = {
        get name() { return basePlanner.name; },
        async decide(s: GameStateSnapshot) {
          const d = await basePlanner.decide(s);
          decisions.push(d.kind === 'act' ? d.tool : d.kind);
          return d;
        },
        observeReceipt: (t: string, st: 'COMPLETED' | 'FAILED' | 'UNCERTAIN' | 'TIMEOUT' | 'ERROR', sum: string) =>
          (basePlanner as RulePlanner).observeReceipt?.(t, st, sum),
      };

      let fakeNow = 0;
      const runner = new AutodriveRunner(
        (ev: AutodriveEvent) => {
          if (ev.type === 'receipt' && ev.tool !== 'autodrive') {
            receipts.push(`${ev.status} ${ev.tool}: ${ev.summary}`);
            llm?.setRecentReceipts([...receipts]);
          }
        },
        { maxCycles: scenario.expect.maxCycles, stepDelayMs: 0, errorDelayMs: 0, pollDelayMs: 0, now: () => fakeNow, sleep: async (ms) => { fakeNow += ms; } },
        new StardewAdapter('http://127.0.0.1:18088/mcp', fetchImpl),
      );
      runner.setPlanner(wrappedPlanner);
      await runner.start();
      while (runner.isRunning()) await new Promise((r) => setTimeout(r, 1));
      await runner.stopAndWait();

      const failCounts = new Map<string, number>();
      for (const c of calls) if (c.isError) failCounts.set(c.tool, (failCounts.get(c.tool) ?? 0) + 1);
      expect(Math.max(0, ...failCounts.values())).toBeLessThanOrEqual(scenario.expect.maxSameFailure);
      if (scenario.expect.mustCallOneOf) {
        const seen = new Set([...calls.map((c) => c.tool), ...decisions]);
        expect(scenario.expect.mustCallOneOf.some((t) => seen.has(t))).toBe(true);
      }
      if (scenario.expect.clockMustAdvance) {
        expect(minutes).toBeGreaterThan(startMinutes);
      }
      for (const req of scenario.expect.mustCallWithArgs ?? []) {
        expect(calls.some((c) => c.tool === req.tool && Object.entries(req.args).every(([k, v]) => c.args[k] === v))).toBe(true);
      }
    });
  }
});

describe('V2-P4-01：跨日失败动作账本注入 LlmPlanner（秋5 真机）', () => {
  it('同一签名跨日累计失败后，事实提示段进入自主决策 prompt', async () => {
    const prompts: string[] = [];
    let callIdx = 0;
    const planner = new LlmPlanner({
      chat: async (_slot, msgs) => {
        prompts.push(msgs.map((m) => m.content).join('\n'));
        callIdx += 1;
        if (callIdx === 1) return { content: '{"plan":[{"goal":"去海边钓鱼","why":"晴天"},{"goal":"整理背包","why":"省格"}],"mood":"干劲满满"}' };
        return { content: '{"tool":"forage","args":{},"intent":"先采集一圈"}' };
      },
    });

    // 夏28 踩过的坑：同一坐标取箱失败
    planner.observeReceipt('take_items', 'FAILED', '失败：(69,16) 四周没有可以站的地方');
    // 秋5 又踩一次：签名相同、跨日累计
    planner.observeReceipt('take_items', 'FAILED', '失败：(69,16) 四周没有可以站的地方');

    const decision = await planner.decide(state());
    expect(decision).toMatchObject({ kind: 'act', tool: 'forage' });
    expect(prompts.length).toBeGreaterThanOrEqual(2);
    const decisionPrompt = prompts[prompts.length - 1]!;
    expect(decisionPrompt).toContain('跨日累计失败动作');
    expect(decisionPrompt).toContain('(69,16)');
    expect(decisionPrompt).toContain('累计失败2次');
    // AI-first 红线：只陈述事实，不出现硬性措辞
    expect(decisionPrompt).not.toMatch(/必须去|只能换|立刻前往/);
    // 位置：紧挨「失败与停滞记忆」，排在长篇长期经验之前（秋5 真机：排在长文后被稀释）
    const failIdx = decisionPrompt.indexOf('失败与停滞记忆');
    const ledgerIdx = decisionPrompt.indexOf('跨日累计失败动作');
    const memoryIdx = decisionPrompt.indexOf('长期经验与主人记忆');
    expect(failIdx).toBeGreaterThanOrEqual(0);
    expect(ledgerIdx).toBeGreaterThan(failIdx);
    if (memoryIdx >= 0) expect(ledgerIdx).toBeLessThan(memoryIdx);
  });

  it('成功回执不进账本，不产生提示段', async () => {
    const prompts: string[] = [];
    let callIdx = 0;
    const planner = new LlmPlanner({
      chat: async (_slot, msgs) => {
        prompts.push(msgs.map((m) => m.content).join('\n'));
        callIdx += 1;
        if (callIdx === 1) return { content: '{"plan":[{"goal":"整理背包","why":"省格"}],"mood":"干劲满满"}' };
        return { content: '{"tool":"forage","args":{},"intent":"先采集一圈"}' };
      },
    });
    planner.observeReceipt('take_items', 'COMPLETED', '成功：从箱子取出：木材x10');
    await planner.decide(state());
    const decisionPrompt = prompts[prompts.length - 1]!;
    expect(decisionPrompt).not.toContain('跨日累计失败动作');
  });
});

describe('V2-P4-01：长期记忆与知识库检索注入 LlmPlanner', () => {
  it('buildPlannerMemoryQuery 与 resolvePlannerContexts 正常拼接查询并隔离异常', () => {
    const s = parseGameState(`${STATE_OK}\n今日：生日 阿比盖尔；节日 花舞节`);
    const q = buildPlannerMemoryQuery(s, {
      objective: '送礼',
      goalHint: '去皮埃尔买花',
      lastFailSignature: 'fish|无鱼竿|Beach',
      pendingSuggestion: '一起下矿',
    });
    expect(q).toContain('Farm');
    expect(q).toContain('生日 阿比盖尔');
    expect(q).toContain('节日 花舞节');
    expect(q).toContain('送礼');
    expect(q).toContain('fish 无鱼竿 Beach');

    const okCtx = resolvePlannerContexts(s, {
      memoryContextProvider: (query) => `记忆命中(${query.slice(0, 4)})`,
      knowledgeContextProvider: () => '知识条目：晴天浇水',
    });
    expect(okCtx.longTermMemoryText).toContain('记忆命中');
    expect(okCtx.verifiedKnowledgeText).toContain('知识条目');

    const safeFail = resolvePlannerContexts(s, {
      memoryContextProvider: () => { throw new Error('db locked'); },
      knowledgeContextProvider: () => { throw new Error('knowledge failed'); },
    });
    expect(safeFail).toEqual({ longTermMemoryText: '', verifiedKnowledgeText: '' });
  });

  it('晨间计划与每轮自主决策均注入记忆与知识上下文，并在 debugSnapshot 暴露配置状态', async () => {
    const prompts: string[] = [];
    let callIdx = 0;
    const planner = new LlmPlanner({
      chat: async (_slot, msgs) => {
        prompts.push(msgs.map((m) => m.content).join('\n'));
        callIdx += 1;
        if (callIdx === 1) {
          return { content: '{"plan":[{"goal":"去海边钓鱼","why":"晴天"},{"goal":"整理背包","why":"省格"}],"mood":"干劲满满"}' };
        }
        return { content: '{"tool":"forage","args":{},"intent":"先采集一圈"}' };
      },
      memoryContextProvider: (query) => `【相关经历】之前在 ${query.split(' ')[0]} 捡到过韭葱`,
      knowledgeContextProvider: () => '- [已晋升 90%] Farm：晴天优先批量浇水',
    });

    const decision = await planner.decide(state());
    expect(decision).toMatchObject({ kind: 'act', tool: 'forage' });
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain('已实测知识与避坑清单');
    expect(prompts[0]).toContain('长期经验与主人记忆');
    expect(prompts[1]).toContain('之前在 Farm 捡到过韭葱');
    expect(prompts[1]).toContain('[已晋升 90%] Farm');
    expect(planner.debugSnapshot()['retrieval']).toEqual({ memoryConfigured: true, knowledgeConfigured: true });
    expect(normalizeToolArgs({ target: 'Farm' }, 'travel_to')).toEqual({ location: 'Farm' });
    expect(normalizeToolArgs({ destination: ['Town'] }, 'travel_to')).toEqual({ location: 'Town' });
    expect(normalizeToolArgs({ x: 64, y: 15, radius: 3 }, 'clear_area')).toEqual({ radius: 3 });
    expect(normalizeToolArgs({ x: 64, y: 15, r: 4 }, 'clear_area')).toEqual({ radius: 4 });
    expect(normalizeToolArgs({ x: 64, y: 15 }, 'clear_area')).toEqual({ x1: 62, y1: 13, x2: 66, y2: 17 });
    expect(normalizeToolArgs({ x: 64, y: 16, count: 12 }, 'till_area')).toEqual({ count: 12 });
    expect(normalizeToolArgs({ shop: 'SeedShop' }, 'open_shop')).toEqual({ shop_id: 'SeedShop' });
    expect(normalizeToolArgs({ count: 8 }, 'fish')).toEqual({ casts: 8 });
    expect(normalizeToolArgs({ confirm: true }, 'sleep')).toEqual({ force: true });
    expect(normalizeToolArgs({ step: 'greet' }, 'festival')).toEqual({ action: 'greet' });
    expect(normalizeToolArgs({ choice: '右' }, 'choose_profession')).toEqual({ side: 'right' });
    expect(normalizeToolArgs({ petName: '蓝蓝' }, 'set_name')).toEqual({ name: '蓝蓝' });
    expect(normalizeToolArgs({ item: 'watering_can' }, 'upgrade_tool')).toEqual({ tool: 'watering_can' });
    expect(normalizeToolArgs({ gift: '黄水仙' }, 'give_gift')).toEqual({ item: '黄水仙' });
    expect(normalizeToolArgs({ count: 9 }, 'clear_area')).toEqual({ radius: 3 });
    expect(normalizeToolArgs({ chest_x: 68, chest_y: 17, items: ['石头'], count: 10 }, 'store_items')).toEqual({ x: 68, y: 17, items: '石头' });
    expect(normalizeToolArgs({ box_x: 68, box_y: 17, from_chest: true, chest: 'home', location: 'Farm', items: '喷壶' }, 'take_items')).toEqual({ x: 68, y: 17, items: '喷壶' });
    expect(normalizeToolArgs({ item: '昆虫头部', container: 'Farm (68,18)' }, 'store_items')).toEqual({ items: '昆虫头部', x: 68, y: 18 });

    const spMessages = buildAutonomousDecisionMessages({
      state: state(),
      recentReceipts: [],
      dayPlanText: '（暂无）',
      failureMemory: { lastSignature: null, streak: 0, lastSummary: '', clockStallSec: 0 },
      mandatoryCommand: null,
      pendingSuggestion: null,
      handoverSummary: null,
      teamAndObjectiveText: '',
      allowedTools: LLM_TOOL_WHITELIST,
      environmentHints: '',
      guidesHint: '',
      effectiveFreeSlots: 8,
    });
    expect(spMessages[0]?.content).not.toContain('say,');

    const mpMessages = buildAutonomousDecisionMessages({
      state: { ...state(), raw: `${state().raw}\n模式：联机` },
      recentReceipts: [],
      dayPlanText: '（暂无）',
      failureMemory: { lastSignature: null, streak: 0, lastSummary: '', clockStallSec: 0 },
      mandatoryCommand: null,
      pendingSuggestion: null,
      handoverSummary: null,
      teamAndObjectiveText: '',
      allowedTools: LLM_TOOL_WHITELIST,
      environmentHints: '',
      guidesHint: '',
      effectiveFreeSlots: 8,
    });
    expect(mpMessages[0]?.content).toContain(', say,');

    // StrategyNotebook 跨日近似表述去重合并，防止 56 天泛滥同义心得，同时不误合并不同作物策略
    const nb = new StrategyNotebook();
    nb.upsert('春1', { source: '每晚复盘', claim: '下雨天免浇水，适合去矿洞或河边钓鱼', verdict: 'adopt', why: '实测' });
    nb.upsert('春5', { source: '每晚复盘', claim: '下雨天不用浇水，适合去矿洞或河边钓鱼', verdict: 'adopt', why: '再验证' });
    expect(nb.size()).toBe(1);
    nb.upsert('春6', { source: '每晚复盘', claim: '春季第一周多种土豆收益稳定', verdict: 'adopt', why: '作物对比' });
    nb.upsert('春7', { source: '每晚复盘', claim: '春季第一周多种草莓收益更高', verdict: 'adopt', why: '作物对比' });
    expect(nb.size()).toBe(3);
  });
});
