/**
 * T-M6-72 门禁测试：攻略库切块与索引、`read_guide` 宿主直读、心得本 Zod/持久化/200 上限淘汰、
 * 每晚复盘幂等与容错、以及回放级完整端到端学习闭环（读攻略 → defer → 条件满足引用 → 复盘 adopt）。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AutodriveRunner,
  buildAutonomousDecisionMessages,
  extractSaveNameFromState,
  formatReadGuideReply,
  GuideLibrary,
  LlmPlanner,
  MAX_GUIDE_INDEX_CHARS,
  MAX_GUIDE_SECTION_CHARS,
  MAX_GUIDE_SUMMARY_CHARS,
  parseAutonomousDecision,
  parseReflectionResult,
  runNightlyReflection,
  sanitizeSaveFileName,
  splitGuideMarkdown,
  StardewAdapter,
  StrategyNotebook,
  summarizeReceiptsForReflection,
  type AutodriveEvent,
  type GameStateSnapshot,
  type InsightEmission,
} from './index';
import { parseGameState } from './planner';

const SAMPLE_CROPS_GUIDE = `<!-- guide-forager 归档
  topic: 四季作物收益
  source: Stardew Valley Wiki
-->

# Crops

## Basics
### Trellis Crops
Green Bean and Hops grow on trellises and cannot be walked through. Plan farm paths carefully.

## Spring
### Strawberry
草莓春季收益极高，只能在春 13 复活节花展广场以 100g 购买种子，建议至少预留 1000g 预算购买。

## Summer
### Blueberry
蓝莓夏季一次播种多次收获，初期稳定现金流推荐。

## History
历史版本变更。
`;

const makeState = (overrides: { day?: string; clock?: string; money?: number; location?: string; extra?: string } = {}): GameStateSnapshot => {
  const day = overrides.day ?? '第1年春5日';
  const clock = overrides.clock ?? '09:00';
  const money = overrides.money ?? 450;
  const location = overrides.location ?? 'Farm（泡泡湾农场）';
  const raw = `## 基本状态
时间：${day} ${clock}（Thu），天气：晴，明天天气：晴
金钱：${money}g  体力：220/270  生命：100/100
## 当前界面
无（可以自由行动）
## 位置
地点：${location}，室外
## 背包（序号: 物品）
0: 斧头
背包空位：10 个（共 12 格）
${overrides.extra ?? ''}`;
  return parseGameState(raw);
};

describe('GuideLibrary 切块、索引与宿主侧 read_guide（T-M6-72 §4B.3 #1）', () => {
  it('按 ## / ### 确定性切块，跳过 History 样板节并限制 summary ≤80 字、全文 ≤2000 字', () => {
    const longBody = '作物收益详解。'.repeat(500);
    const md = `${SAMPLE_CROPS_GUIDE}\n## 超长专题\n${longBody}\n## 同名节\n第一段内容足够长用于校验同名序号。\n## 同名节\n第二段内容足够长用于校验同名序号。`;
    const run1 = splitGuideMarkdown('四季作物收益', md);
    const run2 = splitGuideMarkdown('四季作物收益', md);
    expect(run1).toEqual(run2);
    expect(run1.some((s) => s.title === 'History')).toBe(false);
    expect(run1.find((s) => s.title === 'Strawberry')?.headingPath).toBe('Spring / Strawberry');
    expect(run1.some((s) => s.sectionId === '同名节 (2)')).toBe(true);
    for (const sec of run1) {
      expect(sec.summary.length).toBeLessThanOrEqual(MAX_GUIDE_SUMMARY_CHARS);
      expect(sec.text.length).toBeLessThanOrEqual(MAX_GUIDE_SECTION_CHARS);
    }

    // 无标题纯正文回退总览；纯空白返回空
    expect(splitGuideMarkdown('空白', '<!-- 仅注释 -->')).toEqual([]);
    const fallback = splitGuideMarkdown('随手记', '纯文本开局建议：前五天先种防风草并留木材造箱子。');
    expect(fallback).toHaveLength(1);
    expect(fallback[0]?.sectionId).toBe('总览');
  });

  it('每轮生成 ≤800 字相关索引，readSection 精准命中或友好报错且可格式化回喂', () => {
    const lib = new GuideLibrary({
      四季作物收益: SAMPLE_CROPS_GUIDE,
      钓鱼: '## 钓鱼基础\n在海滩 Beach 抛竿最远收益越高，鱼竿在威利处领取。\n## 进阶技巧\n泡泡点会提高上钩率与宝箱概率。',
      姜岛: '## 解锁条件\n完成社区中心全部献祭后修好威利的船即可前往姜岛。',
    });
    expect(lib.topics().sort()).toEqual(['姜岛', '四季作物收益', '钓鱼'].sort());

    const springIdx = lib.buildIndexForState({ season: '春', location: 'Farm', dayPlanText: 'Spring 作物收益 Strawberry' });
    expect(springIdx.length).toBeLessThanOrEqual(MAX_GUIDE_INDEX_CHARS);
    expect(springIdx).toContain('四季作物收益');
    expect(springIdx).toContain('Strawberry');

    const hitExact = lib.readSection('四季作物收益', 'Strawberry');
    expect(hitExact.ok).toBe(true);
    if (hitExact.ok) {
      expect(formatReadGuideReply('四季作物收益', 'Strawberry', hitExact)).toContain('春 13 复活节');
    }

    const hitDefault = lib.readSection('钓鱼');
    expect(hitDefault.ok).toBe(true);

    const missSection = lib.readSection('钓鱼', '不存在的小节');
    expect(missSection.ok).toBe(false);
    expect(formatReadGuideReply('钓鱼', '不存在的小节', missSection)).toContain('可选：');

    const missTopic = lib.readSection('未知专题');
    expect(missTopic.ok).toBe(false);
    expect(new GuideLibrary({}).buildIndexForState({ season: '春', location: 'Farm' })).toBe('');
  });
});

describe('StrategyNotebook Zod、按存档持久化、200 上限淘汰与检索引用（§4B.3 #5）', () => {
  it('按存档名写盘/重开读回，坏文件不崩溃且防路径穿越', () => {
    const dir = mkdtempSync(join(tmpdir(), 'whale-notes-'));
    try {
      expect(sanitizeSaveFileName('../evil\\save:1')).toBe('evil_save_1');
      expect(sanitizeSaveFileName('   ')).toBe('default');
      expect(extractSaveNameFromState('地点：Farm（泡泡湾农场）')).toBe('泡泡湾农场');
      expect(extractSaveNameFromState('【你的长期笔记】海滩农场（沙地）')).toBe('海滩农场');

      const nb = new StrategyNotebook({ notesDir: dir });
      nb.bindSave('泡泡湾农场');
      const created = nb.upsert('春5', {
        source: '四季作物收益#Strawberry',
        claim: '草莓春季收益最高，春 13 蛋节集中买种',
        when: '春 13 之前预留 ≥ 1000g',
        verdict: 'defer',
        why: '当前春 5 只有 450g，先买防风草周转',
      });
      expect(created.id).toBe('ins-1');
      expect(existsSync(join(dir, '泡泡湾农场.json'))).toBe(true);

      // 引用 hits + 1 与相同出处/结论合并修订
      expect(nb.recordHit('ins-1', '春13')?.hits).toBe(1);
      expect(nb.recordHit('not-exist', '春13')).toBeNull();
      nb.upsert('春13', {
        source: '四季作物收益#Strawberry',
        claim: '草莓春季收益最高，春 13 蛋节集中买种',
        verdict: 'adopt',
        why: '蛋节已买到 12 颗草莓并成功种下',
        evidence: '春13 买 12 颗花费 1200g',
      });
      nb.setTomorrowHint('明早先给草莓浇水');

      const reopened = new StrategyNotebook({ notesDir: dir, saveName: '泡泡湾农场' });
      expect(reopened.size()).toBe(1);
      expect(reopened.list()[0]?.verdict).toBe('adopt');
      expect(reopened.list()[0]?.hits).toBe(1);
      expect(reopened.list()[0]?.evidence).toEqual(['春13 买 12 颗花费 1200g']);
      expect(reopened.getTomorrowHint()).toBe('明早先给草莓浇水');

      // 损坏文件或 Schema 非法安全退回空本
      writeFileSync(join(dir, 'corrupt.json'), '{bad json', 'utf8');
      const broken = new StrategyNotebook({ notesDir: dir, saveName: 'corrupt' });
      expect(broken.size()).toBe(0);
      writeFileSync(join(dir, 'bad_schema.json'), JSON.stringify({ version: 99, insights: 'oops' }), 'utf8');
      expect(new StrategyNotebook({ notesDir: dir, saveName: 'bad_schema' }).size()).toBe(0);
      // 切换存档会清空并隔离
      reopened.bindSave('另一存档');
      expect(reopened.size()).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('上限淘汰顺序：优先淘汰久未引用的 refuted，其次淘汰 hits 最低；检索按条件排序', () => {
    const nb = new StrategyNotebook({ maxInsights: 3 });
    const a = nb.upsert('春1', { source: 'A', claim: '被推翻且最早的旧结论', when: '春季', verdict: 'refuted', why: '实测亏钱' });
    const b = nb.upsert('春2', { source: 'B', claim: '低命中待定结论', when: '冬季', verdict: 'defer', why: '未到季节' });
    const c = nb.upsert('春3', { source: 'C', claim: '高命中海滩钓鱼策略', when: 'Beach 钓鱼', verdict: 'adopt', why: '海滩好赚' });
    nb.recordHit(c.id, '春4');
    nb.recordHit(c.id, '春5');
    nb.recordHit(b.id, '春5');

    // 第 4 条触发淘汰：必须先淘汰 refuted 的 a
    nb.upsert('春6', { source: 'D', claim: '春季海滩抛竿最远', when: '春 Beach', verdict: 'adopt', why: '高收益' });
    expect(nb.list().some((x) => x.id === a.id)).toBe(false);

    // 第 5 条触发淘汰：b(hits=1, defer) 应先于 c(hits=2) 与新 adopt 被淘汰？Wait: 新插入 hits=0 < b(hits=1)，所以若插入后命中 b 会胜出；先给第4条记3次hit再插第5条验证 hits 最低者淘汰
    const dItem = nb.list().find((x) => x.source === 'D')!;
    nb.recordHit(dItem.id, '春6');
    nb.recordHit(dItem.id, '春6');
    nb.upsert('春7', { source: 'E', claim: '第五条采纳', when: 'Farm', verdict: 'adopt', why: '常用' });
    // 第5条插完本身 hits=0 是最低的（b=1, c=2, d=2），验证按 hits 排序且 size=3
    expect(nb.size()).toBe(3);

    const beachTop = nb.retrieve({ season: '春', location: 'Beach', dayPlanText: '去海滩钓鱼', limit: 2 });
    expect(beachTop[0]?.claim).toContain('海滩');
    expect(nb.formatForPrompt(beachTop)).toContain('你的经验心得本');
    expect(nb.formatForPrompt([])).toBe('');
  });
});

describe('Reflection 夜间复盘、幂等性与乱码跳过（§4B.3 #4）', () => {
  it('汇总 Top 3 失败签名，每日只复盘一次，乱码或异常不阻塞睡觉', async () => {
    const agg = summarizeReceiptsForReflection([
      { tool: 'fish', status: 'COMPLETED', summary: '钓到沙丁鱼' },
      { tool: 'water_crops', status: 'FAILED', summary: 'FAILED water_crops: 没有水壶' },
      { tool: 'water_crops', status: 'FAILED', summary: 'FAILED water_crops: 没有水壶' },
      { tool: 'buy', status: 'FAILED', summary: '今天周三皮埃尔关门' },
    ], 'Farm');
    expect(agg.completedCount).toBe(1);
    expect(agg.failedCount).toBe(3);
    expect(agg.topFailures[0]).toMatchObject({ signature: 'water_crops|没有水壶|Farm', count: 2 });

    expect(parseReflectionResult('not json')).toBeNull();
    expect(parseReflectionResult('{"other":1}')).toBeNull();
    const parsedOk = parseReflectionResult('{"updates":[{"claim":"周三商店关门","verdict":"adopt","why":"实测吃闭门羹","evidence":"周三 buy 失败"}],"tomorrowHint":"明早先买种"}');
    expect(parsedOk?.updates).toHaveLength(1);
    expect(parsedOk?.tomorrowHint).toBe('明早先买种');

    const nb = new StrategyNotebook();
    let calls = 0;
    const r1 = await runNightlyReflection({
      dayKey: '春5',
      notebook: nb,
      summary: { dayKey: '春5', dayPlan: null, startMoney: 500, endMoney: 720, ...agg, relatedInsights: [] },
      slot: 'STARDEW_GAME_PLANNER',
      chat: async () => {
        calls += 1;
        return { content: '{"updates":[{"claim":"海滩钓鱼更稳","verdict":"adopt","why":"收益+220g"}],"tomorrowHint":"去矿洞看看"}' };
      },
    });
    expect(r1.ran).toBe(true);
    expect(r1.updated).toHaveLength(1);
    expect(nb.getTomorrowHint()).toBe('去矿洞看看');

    // 同日二次调用直接幂等跳过
    const r2 = await runNightlyReflection({
      dayKey: '春5',
      notebook: nb,
      summary: { dayKey: '春5', dayPlan: null, startMoney: 500, endMoney: 720, ...agg, relatedInsights: [] },
      slot: 'STARDEW_GAME_PLANNER',
      chat: async () => { calls += 1; return { content: '{}' }; },
    });
    expect(r2.ran).toBe(false);
    expect(calls).toBe(1);

    // 乱码 / 网关异常跳过不抛
    const nb2 = new StrategyNotebook();
    const bad = await runNightlyReflection({
      dayKey: '春6', notebook: nb2,
      summary: { dayKey: '春6', dayPlan: null, startMoney: 0, endMoney: 0, receiptTotal: 0, completedCount: 0, failedCount: 0, topFailures: [], relatedInsights: [] },
      slot: 'S', chat: async () => { throw new Error('network error'); },
    });
    expect(bad.ran).toBe(true);
    expect(bad.updated).toEqual([]);
    expect(nb2.hasReflectedDay('春6')).toBe(true);
  });
});

describe('LlmPlanner + AutodriveRunner 端到端学习闭环（read_guide → defer → 2 天后 usedInsight → 复盘 adopt）', () => {
  it('parseAutonomousDecision 解析 read_guide / insight / usedInsight，read_guide 不发往游戏且同轮上限 2 节', async () => {
    const parsed = parseAutonomousDecision('{"tool":"forage","args":{},"intent":"采集","insight":{"source":"四季作物收益#Spring","claim":"草莓划算","when":"春13蛋节","verdict":"defer","why":"现在钱不够"},"usedInsight":"ins-1"}');
    expect(parsed?.insight?.verdict).toBe('defer');
    expect(parsed?.usedInsight).toBe('ins-1');

    const promptCheck = buildAutonomousDecisionMessages({
      guidesHint: '## 攻略索引\n- 四季作物收益#Strawberry：春13蛋节买',
      insightsText: '## 你的经验心得本\n- [ins-1 | defer | 引用0次] 草莓春季收益最高',
      state: makeState(),
      effectiveFreeSlots: 10,
      environmentHints: '',
      recentReceipts: [],
      dayPlanText: '1. 去采集',
      failureMemory: { lastSignature: null, streak: 0, lastSummary: '', clockStallSec: 0 },
      mandatoryCommand: null,
      pendingSuggestion: null,
      handoverSummary: null,
      teamAndObjectiveText: '',
      allowedTools: new Set(['forage', 'sleep']),
    });
    expect(promptCheck[0]?.content).toContain('read_guide');
    expect(promptCheck[1]?.content).toContain('ins-1');

    // 同轮调用 3 次 read_guide → 第 3 次被拒绝要求输出白名单动作
    let step = 0;
    const userMsgs: string[] = [];
    const planner = new LlmPlanner({
      guides: { 钓鱼: '## 入门\n威利海滩给鱼竿，甩竿最远出高星鱼。\n## 泡泡\n看到水面泡泡可以加速咬钩。' },
      chat: async (_slot, messages) => {
        userMsgs.push(messages.at(-1)?.content ?? '');
        step += 1;
        if (step === 1) return { content: '{"plan":[{"goal":"学钓鱼","why":"新存档"}]}' };
        if (step === 2) return { content: '{"tool":"read_guide","args":{"topic":"钓鱼","section":"入门"}}' };
        if (step === 3) return { content: '{"tool":"read_guide","args":{"topic":"钓鱼","section":"泡泡"}}' };
        if (step === 4) return { content: '{"tool":"read_guide","args":{"topic":"钓鱼","section":"入门"}}' };
        return { content: '{"tool":"forage","args":{},"intent":"看完攻略先去采集"}' };
      },
    });
    const d = await planner.decide(makeState());
    expect(d).toMatchObject({ kind: 'act', tool: 'forage' });
    expect(userMsgs.some((m) => m.includes('威利海滩给鱼竿'))).toBe(true);
    expect(userMsgs.some((m) => m.includes('已读满 2 节攻略'))).toBe(true);
  });

  it('同构回放闭环：春5读攻略产 defer 心得 → 春13 1200g 引用 usedInsight → sleep 前复盘改 adopt 并驱动春14计划', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'whale-e2e-learn-'));
    try {
      const mcpCalls: string[] = [];
      let simPhase = 0;
      const states = [
        // Cycle 1: 春5，钱 450g（不够 1000g），读攻略写 defer 心得并采集
        makeState({ day: '第1年春5日', clock: '10:00', money: 450, location: 'Farm（泡泡湾农场）' }).raw,
        // Cycle 2: 春13，钱 1200g（条件满足），引用 ins-1 决定买种并前往睡觉
        makeState({ day: '第1年春13日', clock: '22:10', money: 1200, location: 'Farm（泡泡湾农场）' }).raw,
        // Cycle 3: 春14 清晨，验证昨日复盘 tomorrowHint 注入晨间计划
        makeState({ day: '第1年春14日', clock: '06:00', money: 800, location: 'Farm（泡泡湾农场）' }).raw,
      ];

      const fetchImpl: typeof fetch = async (_input, init) => {
        const rpc = JSON.parse(String(init?.body ?? '{}')) as { id?: unknown; params?: { name?: string } };
        const tool = rpc.params?.name ?? 'get_state';
        mcpCalls.push(tool);
        let text = `${tool} 成功`;
        if (tool === 'get_state') {
          text = states[Math.min(simPhase, states.length - 1)]!;
        } else if (tool === 'forage' || tool === 'sleep') {
          simPhase += 1;
        }
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: rpc.id ?? 1, result: { content: [{ type: 'text', text }], isError: false } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };

      const insightEvents: InsightEmission[] = [];
      const promptsSeen: string[] = [];
      const morningPromptsSeen: string[] = [];

      let chatIdx = 0;
      const planner = new LlmPlanner({
        notesDir: dir,
        guides: { 四季作物收益: SAMPLE_CROPS_GUIDE },
        onInsight: (ev) => insightEvents.push(ev),
        chat: async (_slot, messages) => {
          chatIdx += 1;
          const sys = messages[0]?.content ?? '';
          const user = messages.at(-1)?.content ?? '';
          if (sys.includes('新的一天刚起床')) morningPromptsSeen.push(sys);
          else promptsSeen.push(user);

          switch (chatIdx) {
            case 1: return { content: '{"plan":[{"goal":"先采集赚钱","why":"起步期"}],"mood":"元气"}' }; // 春5 morning
            case 2: return { content: '{"tool":"read_guide","args":{"topic":"四季作物收益","section":"Strawberry"}}' }; // 春5 read_guide
            case 3: return { content: '{"tool":"forage","args":{},"intent":"钱还不够买草莓，先去采集","insight":{"source":"四季作物收益#Strawberry","claim":"春13蛋节买草莓收益最高","when":"春13且金币>=1000","verdict":"defer","why":"现在春5只有450g，先攒钱"}}' }; // 春5 decide
            case 4: return { content: '{"plan":[{"goal":"蛋节买草莓然后早睡","why":"条件满足"}],"mood":"期待"}' }; // 春13 morning
            case 5: return { content: '{"tool":"sleep","args":{},"intent":"已经买好草莓啦，遵循心得去睡觉","usedInsight":"ins-1"}' }; // 春13 decide -> usedInsight + triggers reflection!
            case 6: return { content: '{"updates":[{"id":"ins-1","source":"四季作物收益#Strawberry","claim":"春13蛋节买草莓收益最高","when":"春13且金币>=1000","verdict":"adopt","why":"实测买完草莓只花400g余800g可行","evidence":"春13 买草莓投入400g"}],"tomorrowHint":"明早先浇灌刚种下的草莓"}' }; // 春13 reflection
            case 7: return { content: '{"plan":[{"goal":"浇灌草莓","why":"昨日复盘提醒"}],"mood":"开心"}' }; // 春14 morning
            default: return { content: '{"tool":"water_crops","args":{},"intent":"按昨日复盘先浇草莓"}' }; // 春14 decide
          }
        },
      });

      const events: AutodriveEvent[] = [];
      const runner = new AutodriveRunner(
        (ev) => events.push(ev),
        { maxCycles: 3, stepDelayMs: 0, errorDelayMs: 0, pollDelayMs: 0, sleep: async () => {} },
        new StardewAdapter('http://127.0.0.1:18088/mcp', fetchImpl),
      );
      runner.setPlanner(planner);
      await runner.start();
      while (runner.isRunning()) await new Promise((r) => setTimeout(r, 1));
      await runner.stopAndWait();

      // 验证：read_guide 绝不出现在游戏 MCP 调用中（首个 get_state 来自 ping 探活）
      expect(mcpCalls).not.toContain('read_guide');
      expect(mcpCalls).toEqual(['get_state', 'get_state', 'forage', 'get_state', 'sleep', 'get_state', 'water_crops']);

      // 补充：≥24:00 且当日已有回执时触发夜间复盘分支
      const lateNightInsights: InsightEmission[] = [];
      let lateIdx = 0;
      const latePlanner = new LlmPlanner({
        onInsight: (ev) => lateNightInsights.push(ev),
        chat: async () => {
          lateIdx += 1;
          if (lateIdx === 1) return { content: '{"plan":[{"goal":"夜钓","why":"补收入"}]}' };
          if (lateIdx === 2) return { content: '{"tool":"forage","args":{},"intent":"傍晚采集"}' };
          if (lateIdx === 3) return { content: '{"updates":[{"claim":"深夜继续钓鱼","verdict":"adopt","why":"实测收益可观"}],"tomorrowHint":"明日休息"}' };
          return { content: '{"tool":"fish","args":{},"intent":"再钓一杆"}' };
        },
      });
      await latePlanner.decide(makeState({ day: '第1年春15日', clock: '18:00' })); // 初始化晨间计划并跳过
      latePlanner.observeReceipt('forage', 'COMPLETED', '采集完成');
      await latePlanner.decide(makeState({ day: '第1年春15日', clock: '00:20' }));
      expect(lateNightInsights.some((e) => e.action === 'reflected')).toBe(true);

      // 补充：GuideLibrary 四季/大小写/窄字符索引、StrategyNotebook 初始化与平局淘汰、Reflection 乱码跳过、LlmPlanner bindCallbacks
      const libExtra = new GuideLibrary({
        四季作物收益: `${SAMPLE_CROPS_GUIDE}\n## Fall\nPumpkin 南瓜秋季收益高。\n## Winter\n冬季可去矿洞或钓鱼。`,
        空白专题: '   ',
      });
      expect(libExtra.sectionsOf('四季作物收益').length).toBeGreaterThan(0);
      expect(libExtra.readSection('crops').ok).toBe(false);
      expect(libExtra.readSection('四季').ok).toBe(true);
      expect(libExtra.readSection('四季作物收益', 'fall').ok).toBe(true);
      expect(libExtra.readSection('').ok).toBe(false);
      expect(libExtra.buildIndexForState({ season: '夏', location: 'Farm', maxChars: 130 }).length).toBeLessThanOrEqual(130);
      expect(libExtra.buildIndexForState({ season: '秋', location: 'Farm' })).toContain('四季作物收益');
      expect(libExtra.buildIndexForState({ season: '冬', location: 'Mine' })).toContain('四季作物收益');

      const nbInit = new StrategyNotebook({
        saveName: 'custom',
        maxInsights: 2,
        initialInsights: [
          { id: 'ins-4', source: 'S', claim: '推翻一', when: '春', verdict: 'refuted', why: '亏', evidence: [], createdDay: '春1', updatedDay: '春1', hits: 0 },
          { id: 'ins-2', source: 'S', claim: '推翻二', when: '春', verdict: 'refuted', why: '也亏', evidence: [], createdDay: '春2', updatedDay: '春2', hits: 1, lastHitDay: '春3' },
        ],
      });
      nbInit.upsert('春4', { source: 'S', claim: '新结论', verdict: 'reject', why: '不适用', evidence: '实测负收益' });
      expect(nbInit.list().some((x) => x.id === 'ins-4')).toBe(false);
      expect(nbInit.retrieve({ season: '未知', location: '未知', limit: 2 }).length).toBeGreaterThan(0);

      // parseReflectionResult 忽略无效项 + runNightlyReflection LLM 乱码跳过 + 负数金币差格式化
      const prPartial = parseReflectionResult('{"updates":[123,{"claim":"","verdict":"bad","why":""},{"claim":"周三休息","verdict":"reject","why":"商店不开","when":"周三"}]}');
      expect(prPartial?.updates).toHaveLength(1);
      const nbBadReply = new StrategyNotebook();
      const badReflect = await runNightlyReflection({
        dayKey: '冬1', notebook: nbBadReply,
        summary: { dayKey: '冬1', dayPlan: null, startMoney: 1000, endMoney: 800, receiptTotal: 0, completedCount: 0, failedCount: 0, topFailures: [], relatedInsights: [] },
        slot: 'S', chat: async () => ({ content: '完全不是 JSON' }),
      });
      expect(badReflect).toEqual({ ran: true, updated: [] });

      // 补充：seasonEnglish 未知季节 + StrategyNotebook bindSave 非空切换与平局淘汰（338/343）
      expect(libExtra.buildIndexForState({ season: '未知季节', location: '未知地点' })).toContain('四季作物收益');
      const nbTie = new StrategyNotebook({ maxInsights: 2 });
      nbTie.upsert('春1', { source: 'S', claim: 'r1', verdict: 'refuted', why: 'w1' });
      nbTie.upsert('春1', { source: 'S', claim: 'r2', verdict: 'refuted', why: 'w2' });
      nbTie.recordHit('ins-2', '春1');
      nbTie.upsert('春2', { source: 'S', claim: 'a1', verdict: 'adopt', why: 'w3' });
      nbTie.upsert('春3', { source: 'S', claim: 'a2', verdict: 'adopt', why: 'w4' });
      nbTie.upsert('春4', { source: 'S', claim: 'a3', verdict: 'adopt', why: 'w5' });
      expect(new GuideLibrary({ StardewGuide: '## Tip\nFirst tip content.' }).readSection('stardewguide').ok).toBe(true);
      const tinyIdx = new GuideLibrary({ 开局前几周: '## 首周\n开局前几周多攒木头造箱子并种防风草，建议每天先把体力花在性价比最高的作物上。' }).buildIndexForState({ season: '春', location: 'Farm', maxChars: 130 });
      expect(tinyIdx.length).toBeLessThanOrEqual(130);
      expect(formatReadGuideReply('a', 'b', { ok: false, error: '缺失', availableSections: [] })).not.toContain('可选：');

      const dirTie = mkdtempSync(join(tmpdir(), 'whale-bind-'));
      try {
        const nbDir = new StrategyNotebook({ notesDir: dirTie, saveName: 's1' });
        nbDir.upsert('春1', { source: 'S', claim: 'c1', verdict: 'adopt', why: 'w' });
        nbDir.bindSave('s2');
        expect(nbDir.size()).toBe(0);
        nbDir.bindSave('s1');
        expect(nbDir.size()).toBe(1);
      } finally {
        rmSync(dirTie, { recursive: true, force: true });
      }

      // LlmPlanner bindCallbacks / setSaveName / parseAutonomousDecision 坏 insight 忽略
      const parsedBadInsight = parseAutonomousDecision('{"tool":"forage","args":{},"insight":{"claim":"","verdict":"nope"}}');
      expect(parsedBadInsight?.insight).toBeUndefined();
      const bound = new LlmPlanner({ notebook: nbInit, chat: async () => ({ content: '{"tool":"forage","args":{},"intent":"采集"}' }) });
      const boundEvents: InsightEmission[] = [];
      bound.bindCallbacks({ onInsight: (ev) => boundEvents.push(ev) });
      bound.setSaveName('另一名字');
      expect(bound.debugSnapshot()['guideTopics']).toEqual([]);
      expect(boundEvents).toEqual([]);

      // 验证：春5 learned(defer) → 春13 used(ins-1, hits=1) → sleep 前 reflected(adopt) → 春14 晨间收到 tomorrowHint
      expect(insightEvents.map((e) => `${e.action}:${e.insight.verdict}:${e.insight.hits}`)).toEqual([
        'learned:defer:0',
        'used:defer:1',
        'reflected:adopt:1',
      ]);
      expect(morningPromptsSeen.some((s) => s.includes('明早先浇灌刚种下的草莓'))).toBe(true);
      expect(promptsSeen.some((p) => p.includes('ins-1'))).toBe(true);

      // 验证：心得本按识别出的存档名「泡泡湾农场.json」落盘，且 sleep 未被复盘阻塞
      const savedPath = join(dir, '泡泡湾农场.json');
      expect(existsSync(savedPath)).toBe(true);
      const savedRaw = JSON.parse(readFileSync(savedPath, 'utf8')) as { insights: Array<{ verdict: string; hits: number }> };
      expect(savedRaw.insights[0]?.verdict).toBe('adopt');
      expect(savedRaw.insights[0]?.hits).toBe(1);
      expect(events.filter((e) => e.type === 'receipt' && e.status === 'COMPLETED').length).toBeGreaterThanOrEqual(3);
      expect(extractSaveNameFromState('## 位置\n地点：FarmHouse（鲸屿真机农场）')).toBe('鲸屿真机农场');
      expect(extractSaveNameFromState('## 位置\n地点：Greenhouse（海风农场）')).toBe('海风农场');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
