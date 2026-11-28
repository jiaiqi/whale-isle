/**
 * 星露谷伴随桌宠反应状态机（V2-P4-01，纯模块可单测）。
 *
 * 借鉴开源项目经验：
 * - dsh-pet（MIT）：安静/防打扰与单一节流阀，不连续刷语音锁；
 * - VPet（Apache-2.0）：体力/生命/时间阈值边缘触发提醒；
 * - Junimo-MCP（MIT）：卡死与 UNCERTAIN 诚实求助，不把未完成当喜报。
 */
import type { AutodriveEvent } from '@workbench/game-bridge-mcp';
import type { PetBubbleKind, PetBubbleMood } from '@workbench/shared-protocol';

export interface CompanionReaction {
  bubble?: {
    kind: Extract<PetBubbleKind, 'reaction' | 'notice' | 'dialog'>;
    text: string;
    mood?: PetBubbleMood;
    ttlMs?: number;
  };
  speech?: {
    text: string;
    scene: 'normal' | 'p0';
  };
}

export interface CompanionReactionContext {
  characterId?: string;
  shortName?: string;
  voiceEnabled: boolean;
}

const CHARACTER_SHORT_REPLIES: Record<string, { uncertain: string; fish: string }> = {
  'blue-whale-maid': { uncertain: '都、都怪这块石头突然长出来的！', fish: '钓到啦！本鱼的手感是天赋！' },
  'aboutme-dsh': { uncertain: '不是蓝蓝的错，是这块石头自己滚过来的。', fish: '鱼上钩啦，蓝蓝的手感也很好嘛！' },
  'aboutme-dsh1': { uncertain: '失误！活力装只是需要热个身。', fish: '钓到啦！活力全开！' },
  'aboutme-gpt': { uncertain: '这是环境变量异常，不是判断失误。', fish: '钓鱼成功，结果符合预期。' },
  'aboutme-claude': { uncertain: '先别急着下结论，这块石头的位置确实不合理。', fish: '鱼钓到了，过程很顺利。' },
  'aboutme-gemini': { uncertain: '哎呀，被石头抢先一步了。', fish: '钓到鱼啦，要不要看看它？' },
  'aboutme-qwen': { uncertain: '按计划不该撞上的，下一步我重新规划。', fish: '钓鱼完成，收益已记录。' },
  'aboutme-glm': { uncertain: '狐狸耳朵早听到石头在动了，只是没躲开。', fish: '鱼儿上钩，正事办成。' },
  'aboutme-grok': { uncertain: '石头先动的手，这锅我不接。', fish: '钓到了，别问我为什么这么强。' },
  'aboutme-kimi': { uncertain: '这次记录为环境干扰，不是操作失误。', fish: '钓到鱼了，我把过程记下来了。' },
};

const GENERIC_SHORT_REPLY = { uncertain: '这次没成功，我换个办法再来。', fish: '成功啦，继续！' };

function summarizeFailureForBubble(summary: string): string {
  const firstLine = summary.split(/\r?\n/)[0]?.replace(/^失败[:：]\s*/, '').trim() ?? '';
  if (/有界面打开|DialogueBox/i.test(summary)) return '有个弹窗挡住了';
  if (/还没开门/.test(firstLine)) return '还没开门呢';
  if (/找不到.*路|过不去/.test(firstLine)) return '那边暂时过不去';
  if (/空位|背包.*满/.test(firstLine)) return '背包没空位了';
  if (/超时/.test(firstLine)) return '这步走太久啦';
  const clean = firstLine.replace(/（[^）]{6,}）/g, '').replace(/\s+/g, ' ').trim();
  return clean.length > 22 ? `${clean.slice(0, 21)}…` : clean;
}

export function characterGameReply(characterId: string | undefined, kind: 'uncertain' | 'fish'): string {
  return (CHARACTER_SHORT_REPLIES[characterId ?? ''] ?? GENERIC_SHORT_REPLY)[kind];
}

function extractDayAndMinutes(clock: string): { dayKey: string; minutes: number | null } {
  const m = /第\d+年([春夏秋冬]\d+日)\s*(\d{2}):(\d{2})/.exec(clock);
  if (m === null) return { dayKey: clock.slice(0, 12), minutes: null };
  return {
    dayKey: m[1] ?? clock,
    minutes: Number(m[2]) * 60 + Number(m[3]),
  };
}

export interface StardewCompanionReactions {
  onEvent(event: AutodriveEvent, ctx: CompanionReactionContext): CompanionReaction[];
  onInsight(payload: { action: 'learned' | 'used' | 'reflected'; topic?: string; claim?: string }, ctx: CompanionReactionContext): CompanionReaction[];
  reset(): void;
}

export function createStardewCompanionReactions(options: {
  now?: () => number;
  milestoneCooldownMs?: number;
  stuckCooldownMs?: number;
} = {}): StardewCompanionReactions {
  const now = options.now ?? Date.now;
  const milestoneCooldownMs = options.milestoneCooldownMs ?? 30_000;
  const stuckCooldownMs = options.stuckCooldownMs ?? 45_000;

  let currentDayKey = '';
  const firedWarningsToday = new Set<string>();
  let lastMilestoneAt = -milestoneCooldownMs;
  let lastStuckAt = -stuckCooldownMs;

  const reset = (): void => {
    currentDayKey = '';
    firedWarningsToday.clear();
    lastMilestoneAt = -milestoneCooldownMs;
    lastStuckAt = -stuckCooldownMs;
  };

  const onEvent = (event: AutodriveEvent, ctx: CompanionReactionContext): CompanionReaction[] => {
    const t = now();
    const out: CompanionReaction[] = [];
    const speakIfEnabled = (text: string, scene: 'normal' | 'p0' = 'normal') =>
      ctx.voiceEnabled ? { text, scene } : undefined;

    if (event.type === 'state') {
      const { dayKey, minutes } = extractDayAndMinutes(event.clock);
      if (dayKey !== '' && dayKey !== currentDayKey) {
        currentDayKey = dayKey;
        firedWarningsToday.clear();
      }
      const staminaPct = event.staminaMax > 0 ? (event.stamina / event.staminaMax) * 100 : 100;
      if (staminaPct <= 15) {
        if (!firedWarningsToday.has('low-stamina')) {
          firedWarningsToday.add('low-stamina');
          const line = `体力只剩 ${Math.round(staminaPct)}% 了，小心别累晕掉呀！`;
          const speech = speakIfEnabled(line, 'normal');
          out.push({
            bubble: { kind: 'notice', text: line, mood: 'sleepy', ttlMs: 8_000 },
            ...(speech === undefined ? {} : { speech }),
          });
        }
      } else if (staminaPct >= 30) {
        firedWarningsToday.delete('low-stamina');
      }

      const healthPct = event.health !== undefined && event.healthMax !== undefined && event.healthMax > 0
        ? (event.health / event.healthMax) * 100
        : 100;
      if (healthPct <= 30) {
        if (!firedWarningsToday.has('low-health')) {
          firedWarningsToday.add('low-health');
          const line = `生命值告急（${Math.round(healthPct)}%），快补血或撤退！`;
          const speech = speakIfEnabled(line, 'p0');
          out.push({
            bubble: { kind: 'reaction', text: line, mood: 'surprised', ttlMs: 8_000 },
            ...(speech === undefined ? {} : { speech }),
          });
        }
      } else if (healthPct >= 50) {
        firedWarningsToday.delete('low-health');
      }

      if (minutes !== null && (minutes >= 23 * 60 + 30 || minutes < 2 * 60) && !firedWarningsToday.has('curfew')) {
        firedWarningsToday.add('curfew');
        const line = '快凌晨两点啦，该回农场睡觉存档咯～';
        const speech = speakIfEnabled(line, 'normal');
        out.push({
          bubble: { kind: 'notice', text: line, mood: 'sleepy', ttlMs: 9_000 },
          ...(speech === undefined ? {} : { speech }),
        });
      }

      if (event.freeSlots === 0 && !firedWarningsToday.has('bag-full')) {
        firedWarningsToday.add('bag-full');
        out.push({
          bubble: { kind: 'notice', text: '背包满啦，得想想怎么腾格子～', mood: 'thinking', ttlMs: 7_000 },
        });
      } else if (event.freeSlots !== undefined && event.freeSlots >= 2) {
        firedWarningsToday.delete('bag-full');
      }
      return out;
    }

    if (event.type === 'watchdog' && event.kind === 'stuck') {
      if (t - lastStuckAt >= stuckCooldownMs) {
        lastStuckAt = t;
        const shortDetail = event.detail.replace(/\s+/g, ' ').slice(0, 48);
        const line = `好像卡住啦：${shortDetail}`;
        const speech = speakIfEnabled('唔，这边好像卡住了，主人帮我看一眼嘛～', 'normal');
        out.push({
          bubble: { kind: 'reaction', text: line, mood: 'angry', ttlMs: 8_000 },
          ...(speech === undefined ? {} : { speech }),
        });
      }
      return out;
    }

    if (event.type === 'human-control' && !event.active && event.summary) {
      const hasChange = !event.summary.includes('没有可见变化');
      if (hasChange) {
        const speech = speakIfEnabled('欢迎回来！刚才的变化我记住啦，继续交给我吧～', 'normal');
        out.push({
          bubble: { kind: 'reaction', text: event.summary.slice(0, 70), mood: 'happy', ttlMs: 7_000 },
          ...(speech === undefined ? {} : { speech }),
        });
      }
      return out;
    }

    if (event.type !== 'receipt' || event.tool === 'autodrive' || event.tool.startsWith('chat_') || event.tool.startsWith('reflex_')) {
      return out;
    }

    if (event.status === 'UNCERTAIN') {
      const line = characterGameReply(ctx.characterId, 'uncertain');
      const speech = speakIfEnabled(line, 'normal');
      if (t - lastMilestoneAt >= 8_000) {
        lastMilestoneAt = t;
        out.push({
          bubble: { kind: 'reaction', text: line, mood: 'shy', ttlMs: 6_000 },
          ...(speech === undefined ? {} : { speech }),
        });
      } else if (speech !== undefined) {
        out.push({ speech });
      }
      return out;
    }

    if (event.status === 'COMPLETED' && /fish|钓/.test(event.tool) && /成功|完美/.test(event.summary)) {
      const line = characterGameReply(ctx.characterId, 'fish');
      const speech = speakIfEnabled(line, 'normal');
      if (t - lastMilestoneAt >= 8_000) {
        lastMilestoneAt = t;
        out.push({
          bubble: { kind: 'reaction', text: line, mood: 'happy', ttlMs: 6_000 },
          ...(speech === undefined ? {} : { speech }),
        });
      } else if (speech !== undefined) {
        out.push({ speech });
      }
      return out;
    }

    if (t - lastMilestoneAt < milestoneCooldownMs) return out;

    if (event.status === 'COMPLETED') {
      const milestoneMap: Array<[RegExp, { text: string; mood: PetBubbleMood; speak?: string }]> = [
        [/^harvest_crops$/, { text: '庄稼收获好啦！钱包又要鼓起来了～', mood: 'happy', speak: '丰收啦！这些作物看起来好精神～' }],
        [/^donate_bundles$/, { text: '收集包又推进一格！祝尼魔肯定开心～', mood: 'happy', speak: '收集包献祭成功！离修好社区中心又近一步啦～' }],
        [/^(?:upgrade_tool|build|upgrade_house)$/, { text: '大工程办妥啦，干得漂亮！', mood: 'happy', speak: '升级完工啦！效率肯定更高了～' }],
        [/^(?:explore_mine|fight)$/, { text: '矿洞探险顺利！', mood: 'coquettish' }],
        [/^sleep$/, { text: '准备睡觉结算今天啦，晚安～', mood: 'sleepy' }],
      ];
      const hit = milestoneMap.find(([re]) => re.test(event.tool));
      if (hit !== undefined) {
        lastMilestoneAt = t;
        const spec = hit[1];
        const speech = spec.speak === undefined ? undefined : speakIfEnabled(spec.speak, 'normal');
        out.push({
          bubble: { kind: 'reaction', text: spec.text, mood: spec.mood, ttlMs: 6_500 },
          ...(speech === undefined ? {} : { speech }),
        });
      }
    } else if (event.status === 'FAILED') {
      lastMilestoneAt = t;
      out.push({
        bubble: { kind: 'reaction', text: `没做顺：${summarizeFailureForBubble(event.summary)}`, mood: 'angry', ttlMs: 6_000 },
      });
    }
    return out;
  };

  const onInsight = (
    payload: { action: 'learned' | 'used' | 'reflected'; topic?: string; claim?: string },
    ctx: CompanionReactionContext,
  ): CompanionReaction[] => {
    if (payload.action === 'used') return [];
    const t = now();
    if (t - lastMilestoneAt < milestoneCooldownMs) return [];
    lastMilestoneAt = t;
    const summary = (payload.claim ?? payload.topic ?? '一条新经验').slice(0, 44);
    const text = payload.action === 'learned' ? `记下新攻略心得：${summary}` : `复盘更新经验：${summary}`;
    return [{
      bubble: { kind: 'reaction', text, mood: 'thinking', ttlMs: 7_000 },
      ...(payload.action === 'learned' && ctx.voiceEnabled ? { speech: { text: '记下来了！下次就知道怎么处理啦～', scene: 'normal' as const } } : {}),
    }];
  };

  return { onEvent, onInsight, reset };
}
