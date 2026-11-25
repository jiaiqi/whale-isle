/**
 * V2-P2-01 攻略学习闭环增强门禁单测（REQ-GAME-03 / Blueprint 17 §7）：
 *   1. GuideProvenance 注释头 & YAML frontmatter & 章节版本/Mod 推断解析；
 *   2. evaluateGuideCompatibility 版本/Mod/未知版本兼容判据与警示；
 *   3. GuideLibrary.buildIndexForState 兼容排序/降权 & formatReadGuideReply 来源警示；
 *   4. StrategyNotebook v1 磁盘兼容、GameKnowledgeItem 契约导出、实玩成败置信度升降、反例积累与全本版本审计；
 *   5. reflection.ts & llm-prompt.ts V2 字段构建与宽松解析；
 *   6. LlmPlanner 端到端闭环：状态检测版本/Mod → 读旧版/缺Mod攻略拒盲从 → 用心得成功升置信度 / 失败降置信度记反例。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  detectRuntimeContextFromState,
  evaluateGuideCompatibility,
  formatReadGuideReply,
  GuideLibrary,
  LlmPlanner,
  parseAutonomousDecision,
  parseGuideProvenance,
  parseReflectionResult,
  buildNightlyReflectionMessages,
  StrategyNotebook,
  toGameKnowledgeItem,
  type InsightEmission,
} from './index';
import { parseGameState } from './planner';

const WIKI_GUIDE_WITH_HEADER = `<!-- guide-forager 归档
  topic: 钓鱼
  gameId: stardew
  sourceType: wiki
  source: Stardew Valley Wiki（https://stardewvalleywiki.com/wiki/Fishing）
  gameVersion: 1.6.15
  modContext: vanilla
  fetchedAt: 2026-11-26T00:00:00.000Z
-->

# Fishing

## 熏鱼机赚钱
Stardew 1.6 新增熏鱼机可让鱼类售价翻倍，前期高价值鱼建议保留熏制。
`;

const YAML_MOD_GUIDE = `---
gameId: stardew
sourceType: community
sourceTitle: SVE 与 Automate 联用攻略
sourceUri: https://example.com/sve-guide
gameVersion: 1.6
modContext: [Stardew Valley Expanded, Automate]
retrievedAt: 2026-11-25T10:00:00.000Z
---

## 自动化熏鱼流水线
在箱子旁放熏鱼机即可自动上鱼与取鱼，依赖 Mods: SVE, Automate。
`;

const OLD_GUIDE = `<!--
  sourceType: community
  sourceTitle: 1.5 老版本茶苗流
  gameVersion: 1.5.6
  modContext: 无
-->

## 茶苗赚钱（1.5 版）
仅限 v1.5：卡罗琳两心茶苗直接卖 500g，不需要任何前置。
`;

describe('V2-P2-01 GuideProvenance 解析与版本/Mod 兼容性评估', () => {
  it('解析 guide-forager 注释头与 YAML frontmatter 全部溯源字段', () => {
    const wikiProv = parseGuideProvenance(WIKI_GUIDE_WITH_HEADER, '钓鱼');
    expect(wikiProv).toMatchObject({
      gameId: 'stardew',
      sourceType: 'wiki',
      sourceTitle: 'Stardew Valley Wiki',
      sourceUri: 'https://stardewvalleywiki.com/wiki/Fishing',
      gameVersion: '1.6.15',
      modContext: [],
      retrievedAt: '2026-11-26T00:00:00.000Z',
    });

    const yamlProv = parseGuideProvenance(YAML_MOD_GUIDE, '自动化');
    expect(yamlProv).toMatchObject({
      gameId: 'stardew',
      sourceType: 'community',
      sourceTitle: 'SVE 与 Automate 联用攻略',
      sourceUri: 'https://example.com/sve-guide',
      gameVersion: '1.6',
      modContext: ['Stardew Valley Expanded', 'Automate'],
    });

    const fallbackProv = parseGuideProvenance('## 普通攻略\n无头部纯文本内容足够长。', '采矿');
    expect(fallbackProv.sourceType).toBe('wiki');
    expect(fallbackProv.sourceTitle).toBe('采矿');
    expect(fallbackProv.modContext).toEqual([]);
  });

  it('evaluateGuideCompatibility 区分 compatible / uncertain / outdated / mod-mismatch', () => {
    const ctx16Vanilla = { gameId: 'stardew', gameVersion: '1.6.8', installedMods: [] };

    const ok = evaluateGuideCompatibility({ gameVersion: '1.6.15', modContext: [] }, ctx16Vanilla);
    expect(ok).toMatchObject({ status: 'compatible', versionMatch: 'match', modMatch: 'match', missingMods: [] });

    const outdated = evaluateGuideCompatibility({ gameVersion: '1.5.6', modContext: [] }, ctx16Vanilla);
    expect(outdated.status).toBe('outdated');
    expect(outdated.versionMatch).toBe('mismatch');
    expect(outdated.warnings[0]).toContain('旧版本');

    const missingMod = evaluateGuideCompatibility({ gameVersion: '1.6', modContext: ['SVE', 'Automate'] }, {
      gameId: 'stardew',
      gameVersion: '1.6.8',
      installedMods: ['automate'],
    });
    expect(missingMod.status).toBe('mod-mismatch');
    expect(missingMod.modMatch).toBe('missing-mods');
    expect(missingMod.missingMods).toEqual(['SVE']);

    const unknownBoth = evaluateGuideCompatibility({ modContext: ['TractorMod'] });
    expect(unknownBoth.status).toBe('uncertain');
    expect(unknownBoth.modMatch).toBe('unknown');

    const unknownVerWithCtx = evaluateGuideCompatibility({ modContext: [] }, ctx16Vanilla);
    expect(unknownVerWithCtx.status).toBe('uncertain');
    expect(unknownVerWithCtx.warnings[0]).toContain('未标注游戏版本');
  });

  it('detectRuntimeContextFromState 提取状态中的游戏版本与已装 Mod，GuideLibrary 按兼容度排序并输出警告', () => {
    const detected = detectRuntimeContextFromState('时间：第1年春5日 09:00\n游戏版本：1.6.15\n已装Mod：Automate, LookupAnything');
    expect(detected).toEqual({ gameVersion: '1.6.15', installedMods: ['Automate', 'LookupAnything'] });

    const lib = new GuideLibrary({
      老版本茶苗: OLD_GUIDE,
      Mod联用: YAML_MOD_GUIDE,
      钓鱼: WIKI_GUIDE_WITH_HEADER,
    });
    const idx = lib.buildIndexForState({
      season: '春',
      location: 'Farm',
      runtimeContext: { gameId: 'stardew', gameVersion: '1.6.15', installedMods: [] },
    });
    expect(idx).toContain('仅供参考非命令');
    expect(idx).toContain('[⚠️旧版v1.5.6-适用性不确定]');
    expect(idx).toContain('[⚠️缺Mod:Stardew Valley Expanded/Automate]');
    expect(idx).toContain('[v1.6.15]');

    // 兼容条目排序靠前于 mod-mismatch 与 outdated
    expect(idx.indexOf('钓鱼#')).toBeLessThan(idx.indexOf('老版本茶苗#'));

    const oldRead = formatReadGuideReply(
      '老版本茶苗',
      '茶苗赚钱（1.5 版）',
      lib.readSection('老版本茶苗', '茶苗'),
      { gameId: 'stardew', gameVersion: '1.6.15', installedMods: [] },
    );
    expect(oldRead).toContain('兼容状态=outdated');
    expect(oldRead).toContain('兼容警示：');
    expect(oldRead).toContain('不是必须执行的命令');
  });
});

describe('V2-P2-01 StrategyNotebook 实玩置信度演进、反例更新、v1 兼容与版本审计', () => {
  it('向后兼容加载 v1 磁盘心得文件，并支持导出为 GameKnowledgeItem', () => {
    const dir = mkdtempSync(join(tmpdir(), 'whale-v1-compat-'));
    try {
      const legacyFile = {
        version: 1,
        saveName: '旧档',
        lastReflectedDay: '春4',
        tomorrowHint: '去海边钓鱼',
        insights: [
          {
            id: 'ins-7',
            source: '钓鱼#基础',
            claim: '晴天海滩钓鱼稳健',
            when: '晴天白天',
            verdict: 'adopt',
            why: '测试记录',
            evidence: ['春4 赚 320g'],
            createdDay: '春4',
            updatedDay: '春4',
            hits: 2,
          },
        ],
      };
      writeFileSync(join(dir, '旧档.json'), JSON.stringify(legacyFile), 'utf8');

      const nb = new StrategyNotebook({ notesDir: dir, saveName: '旧档' });
      expect(nb.size()).toBe(1);
      const loaded = nb.list()[0]!;
      expect(loaded.confidence).toBe(0.55);
      expect(loaded.status).toBe('unverified');
      expect(loaded.sourceType).toBe('experience');

      const knowledge = nb.listKnowledgeItems()[0]!;
      expect(knowledge.knowledgeId).toBe('ins-7');
      expect(knowledge.applicability).toEqual(['晴天白天']);
      expect(knowledge.evidenceSummary).toBe('春4 赚 320g');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('recordVerificationOutcome 两次实玩成功升级为 verified，连续失败加反例与限制后变为 rejected', () => {
    const nb = new StrategyNotebook();
    const created = nb.upsert('春1', {
      source: '钓鱼#熏鱼机',
      sourceType: 'wiki',
      gameVersion: '1.6',
      claim: '高价鱼优先熏制',
      when: '拥有煤炭与熏鱼机时',
      verdict: 'defer',
      confidence: 0.55,
      applicability: ['春季高价鱼'],
      why: '待实测煤炭供给是否充足',
    });

    // 第 1 次成功：confidence -> 0.70, status -> partially-verified, defer -> adopt
    const s1 = nb.recordVerificationOutcome({
      id: created.id,
      dayKey: '春2',
      succeeded: true,
      evidence: '春2 熏制鲶鱼净赚 +450g',
      runtimeContext: { gameId: 'stardew', gameVersion: '1.6.15', installedMods: [] },
    })!;
    expect(s1.confidence).toBe(0.7);
    expect(s1.status).toBe('partially-verified');
    expect(s1.verdict).toBe('adopt');

    // 第 2 次成功：confidence -> 0.85, status -> verified
    const s2 = nb.recordVerificationOutcome({
      id: created.id,
      dayKey: '春3',
      succeeded: true,
      evidence: '春3 熏制大比目鱼净赚 +380g',
      runtimeContext: { gameId: 'stardew', gameVersion: '1.6.15', installedMods: [] },
    })!;
    expect(s2.confidence).toBe(0.85);
    expect(s2.status).toBe('verified');
    expect(s2.verifiedCount).toBe(2);

    // 第 1 次失败反例：confidence 降为 0.60, 从 verified 退为 partially-verified
    const f1 = nb.recordVerificationOutcome({
      id: created.id,
      dayKey: '春4',
      succeeded: false,
      evidence: '春4 煤炭耗尽导致熏鱼机停机卡动作',
      failureCondition: '缺少煤炭库存',
    })!;
    expect(f1.confidence).toBe(0.6);
    expect(f1.status).toBe('partially-verified');
    expect(f1.contradictoryEvidence).toContain('春4 煤炭耗尽导致熏鱼机停机卡动作');
    expect(f1.knownLimitations).toContain('缺少煤炭库存');

    // 连续第 2 次失败：refutedCount >= 2 -> rejected + refuted
    const f2 = nb.recordVerificationOutcome({
      id: created.id,
      dayKey: '春5',
      succeeded: false,
      evidence: '春5 煤炭依然不足',
      failureCondition: '矿洞尚未稳定产出煤炭',
    })!;
    expect(f2.confidence).toBe(0.35);
    expect(f2.status).toBe('rejected');
    expect(f2.verdict).toBe('refuted');
    expect(nb.recordVerificationOutcome({ id: 'missing', dayKey: '春5', succeeded: true, evidence: 'x' })).toBeNull();
  });

  it('auditVersionCompatibility 批量将旧版本心得标为 outdated 并降权，formatForPrompt 暴露反例与警示', () => {
    const nb = new StrategyNotebook();
    const oldItem = nb.upsert('春1', {
      source: '老版本茶苗#1.5',
      sourceType: 'community',
      gameVersion: '1.5',
      claim: '卡罗琳茶苗无限卖 500g',
      verdict: 'adopt',
      confidence: 0.9,
      why: '旧版本视频教程',
    });
    const modItem = nb.upsert('春1', {
      source: 'SVE#Automate',
      sourceType: 'community',
      gameVersion: '1.6',
      modContext: ['Automate'],
      claim: '箱子自动喂机器',
      verdict: 'adopt',
      confidence: 0.85,
      why: '假设已装 Automate',
    });
    const goodItem = nb.upsert('春1', {
      source: '钓鱼#1.6',
      sourceType: 'wiki',
      gameVersion: '1.6',
      claim: '海滩海风渔点抛竿',
      verdict: 'adopt',
      confidence: 0.8,
      knownLimitations: ['雨天鱼种变化'],
      contradictoryEvidence: ['低钓鱼等级时绿藻偏多'],
      why: '原版有效',
    });

    const ctx = { gameId: 'stardew', gameVersion: '1.6.15', installedMods: [] };
    const affected = nb.auditVersionCompatibility(ctx, '春2');
    expect(affected.map((x) => x.id).sort()).toEqual([modItem.id, oldItem.id].sort());
    expect(nb.list().find((x) => x.id === oldItem.id)?.status).toBe('outdated');
    expect(nb.list().find((x) => x.id === oldItem.id)?.confidence).toBe(0.35);

    const ranked = nb.retrieve({ season: '春', location: 'Beach', runtimeContext: ctx, limit: 3 });
    expect(ranked[0]?.id).toBe(goodItem.id);

    const promptText = nb.formatForPrompt(ranked, ctx);
    expect(promptText).toContain('置信度80%');
    expect(promptText).toContain('反例：低钓鱼等级时绿藻偏多');
    expect(promptText).toContain('⚠️');

    // versionMismatch + recordVerificationOutcome 保持 outdated
    const stillOutdated = nb.recordVerificationOutcome({
      id: oldItem.id,
      dayKey: '春3',
      succeeded: false,
      evidence: '茶苗仅卖 250g',
      runtimeContext: ctx,
    })!;
    expect(stillOutdated.status).toBe('outdated');
  });
});

describe('V2-P2-01 reflection & llm-prompt 与 LlmPlanner 真实回执闭环', () => {
  it('parseAutonomousDecision、buildNightlyReflectionMessages 与 parseReflectionResult 保留并解析 V2 知识字段', () => {
    const parsedDecision = parseAutonomousDecision(JSON.stringify({
      tool: 'forage',
      args: {},
      intent: '先核实攻略限制',
      insight: {
        source: '四季作物收益#1.5',
        sourceType: 'community',
        gameVersion: '1.5',
        modContext: ['SVE'],
        claim: '旧版本收益推算',
        when: 'Stardew 1.5',
        verdict: 'reject',
        status: 'outdated',
        confidence: 0.15,
        applicability: ['Stardew 1.5 以前'],
        knownLimitations: ['1.6 已削弱售价'],
        contradictoryEvidence: ['实际出售只有半价'],
        why: '版本不符拒绝盲执行',
      },
    }));
    expect(parsedDecision?.insight).toMatchObject({
      sourceType: 'community',
      gameVersion: '1.5',
      modContext: ['SVE'],
      status: 'outdated',
      confidence: 0.15,
      knownLimitations: ['1.6 已削弱售价'],
      contradictoryEvidence: ['实际出售只有半价'],
    });

    const nb = new StrategyNotebook();
    const ins = nb.upsert('春5', {
      source: '矿洞',
      gameVersion: '1.6',
      claim: '带食物再下矿',
      verdict: 'adopt',
      confidence: 0.7,
      contradictoryEvidence: ['5层被史莱姆围攻'],
      why: '保证容错',
    });
    const msgs = buildNightlyReflectionMessages({
      summary: {
        dayKey: '春5',
        dayPlan: null,
        startMoney: 500,
        endMoney: 420,
        receiptTotal: 2,
        completedCount: 1,
        failedCount: 1,
        topFailures: [{ signature: 'explore_mine|血量过低|Mine', count: 1 }],
        relatedInsights: [ins],
      },
    });
    expect(msgs[1]?.content).toContain('置信度70%');
    expect(msgs[1]?.content).toContain('5层被史莱姆围攻');

    const refl = parseReflectionResult(JSON.stringify({
      updates: [
        {
          id: ins.id,
          source: '矿洞',
          sourceType: 'experience',
          gameVersion: '1.6',
          modContext: ['SMAPI'],
          claim: '带食物再下矿',
          verdict: 'refuted',
          status: 'rejected',
          confidence: 0.25,
          why: '体力耗尽来不及吃',
          knownLimitations: ['深层矿洞需带够补血料理'],
          contradictoryEvidence: ['春5 矿洞失败扣钱'],
        },
      ],
      tomorrowHint: '明天先卖矿石买沙拉',
    }));
    expect(refl?.updates[0]).toMatchObject({
      sourceType: 'experience',
      status: 'rejected',
      confidence: 0.25,
      knownLimitations: ['深层矿洞需带够补血料理'],
      contradictoryEvidence: ['春5 矿洞失败扣钱'],
    });
    expect(toGameKnowledgeItem(nb.list()[0]!).knowledgeId).toBe(ins.id);
  });

  it('LlmPlanner 闭环：状态识别版本/Mod → 读旧版攻略警示 → 引用心得实玩成功升置信度 → 失败降置信度记反例', async () => {
    const events: InsightEmission[] = [];
    const nb = new StrategyNotebook();
    const existing = nb.upsert('春1', {
      source: '钓鱼#熏鱼机',
      sourceType: 'wiki',
      gameVersion: '1.6',
      claim: '海边抛竿优先钓高星鱼',
      when: '晴天海滩',
      verdict: 'adopt',
      confidence: 0.65,
      why: '实测可观',
    });

    let step = 0;
    const userPrompts: string[] = [];
    const planner = new LlmPlanner({
      notebook: nb,
      guides: {
        老版本茶苗: OLD_GUIDE,
        钓鱼: WIKI_GUIDE_WITH_HEADER,
      },
      onInsight: (ev) => events.push(ev),
      chat: async (_slot, msgs) => {
        userPrompts.push(msgs.at(-1)?.content ?? '');
        step += 1;
        if (step === 1) return { content: '{"plan":[{"goal":"核对版本后海滩钓鱼","why":"安全游玩"}]}' };
        if (step === 2) return { content: '{"tool":"read_guide","args":{"topic":"老版本茶苗","section":"茶苗"}}' };
        if (step === 3) {
          return {
            content: JSON.stringify({
              tool: 'fish',
              args: { casts: 3 },
              intent: '看到老版本茶苗攻略仅适用 1.5，拒绝盲从，改按当前钓鱼心得去海边试钓',
              usedInsight: existing.id,
            }),
          };
        }
        return {
          content: JSON.stringify({
            tool: 'explore_mine',
            args: { targetFloor: 5 },
            intent: '再试一下这条心得或下矿',
            usedInsight: existing.id,
          }),
        };
      },
    });

    const state = parseGameState(`时间：第1年春6日 10:00（Sat），天气：晴
游戏版本：1.6.15
已装Mod：无
金钱：500g  体力：220/270  生命：100/100
## 当前界面
无（可以自由行动）
## 位置
地点：Beach，室外
## 背包（序号: 物品）
0: 训练用鱼竿
背包空位：10 个（共 12 格）`);

    const d1 = await planner.decide(state);
    expect(d1).toMatchObject({ kind: 'act', tool: 'fish' });
    expect(userPrompts.some((p) => p.includes('兼容状态=outdated') && p.includes('不是必须执行的命令'))).toBe(true);

    // 真实成功回执：confidence 0.65 -> 0.80
    planner.observeReceipt('fish', 'COMPLETED', '钓到 3 条大比目鱼');
    expect(nb.list()[0]?.confidence).toBe(0.8);
    expect(nb.list()[0]?.verifiedCount).toBe(1);

    // 下一轮继续引用同一心得但执行失败：confidence 0.80 -> 0.55，记录反例
    const d2 = await planner.decide(state);
    expect(d2).toMatchObject({ kind: 'act', tool: 'explore_mine' });
    planner.observeReceipt('explore_mine', 'FAILED', '体力不足且背包无空间');
    const afterFail = nb.list()[0]!;
    expect(afterFail.confidence).toBe(0.55);
    expect(afterFail.refutedCount).toBe(1);
    expect(afterFail.contradictoryEvidence[0]).toContain('explore_mine:FAILED');
    expect(afterFail.knownLimitations).toContain('体力不足且背包无空间');
    expect(events.filter((e) => e.action === 'reflected')).toHaveLength(2);
  });
});
