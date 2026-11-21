/**
 * Planner 接口与规则实现（T-M5-02）。
 * 三实现可切换（ARCHITECTURE 三轨计划）：
 *   - RulePlanner：确定性日程（无需 LLM，7×24 可跑——当前默认）
 *   - LlmPlanner：model-gateway 驱动（用户配 key 后启用）
 *   - 远程指令信箱：人工插队 P0（Shell 聊天/WebUI）
 * 行为须匹配桌宠人格：决策结果附 intent（用于台词/情绪联动，persona-brain 消费）。
 */

export interface GameStateSnapshot {
  raw: string;
  gameClock: string; // 「第1年春16日 06:00」
  clockMinutes: number; // 当日分钟
  stamina: number;
  staminaMax: number;
  money: number;
  location: string;
  menu: string; // 当前界面（空 = 自由行动）
  season: string;
  day: number;
}

export function parseGameState(raw: string): GameStateSnapshot {
  const clockM = /时间：(第\d+年[春夏秋冬]\d+日) (\d{2}):(\d{2})/.exec(raw);
  const staminaM = /体力：(\d+)\/(\d+)/.exec(raw);
  const moneyM = /金钱：(\d+)g/.exec(raw);
  const locM = /地点：([^\s（，。]+)/.exec(raw);
  const menuM = /## 当前界面\n(.+)/.exec(raw);
  const seasonM = /第\d+年(春|夏|秋冬|秋|冬)?/.exec(clockM?.[1] ?? '');
  const dayM = /年[春夏秋冬](\d+)日/.exec(clockM?.[1] ?? '');
  const hh = Number(clockM?.[2] ?? '6');
  const mm = Number(clockM?.[3] ?? '0');
  return {
    raw,
    gameClock: clockM?.[0]?.slice(3) ?? '未知',
    clockMinutes: hh * 60 + mm,
    stamina: Number(staminaM?.[1] ?? 100),
    staminaMax: Number(staminaM?.[2] ?? 270),
    money: Number(moneyM?.[1] ?? 0),
    location: locM?.[1] ?? '未知',
    menu: (menuM?.[1] ?? '').trim(),
    season: seasonM?.[1] ?? '春',
    day: Number(dayM?.[1] ?? 1),
  };
}

export type PlannerDecision =
  | { kind: 'act'; tool: string; args: Record<string, unknown>; intent: string }
  | { kind: 'wait'; seconds: number; reason: string }
  | { kind: 'stop'; reason: string };

export interface Planner {
  readonly name: string;
  decide(state: GameStateSnapshot): Promise<PlannerDecision>;
}

/** 对话框/菜单优先处理表（BWF 语义：有界面时其他动作会被拒绝） */
function handleMenu(state: GameStateSnapshot): PlannerDecision | null {
  const menu = state.menu;
  if (menu === '' || /无（可以自由行动）/.test(menu)) return null;
  if (/剧情|节日事件/.test(menu)) return { kind: 'act', tool: 'dialogue', args: {}, intent: '推进剧情对话' };
  if (/商店|Shop/.test(menu)) return { kind: 'act', tool: 'close_menu', args: {}, intent: '关掉误开的商店界面' };
  if (/选择题|选择/.test(menu)) return { kind: 'act', tool: 'dialogue', args: { choice: 1 }, intent: '做选择题' };
  return { kind: 'act', tool: 'dialogue', args: {}, intent: '推进当前界面' };
}

/**
 * RulePlanner：确定性日程（摸鱼/认真双态的规则化表达，人格化台词由 intent 承载）。
 * 日程（按游戏时钟）：
 *   06:00-07:00  读信（有未读）→ 出门
 *   07:00-11:00  农活：浇水（有作物）→ 收获 → 种植
 *   11:00-17:30  海边钓鱼（赚米）
 *   17:30-18:30  采集/翻垃圾桶（小鲸摸鱼时刻）
 *   >=18:30      回家 → 睡觉（防晕倒——历史教训：Joja 医疗费 50g）
 * 体力 <12% → 吃东西；体力 <8% 且无食物 → 直接睡觉。
 */
export class RulePlanner implements Planner {
  readonly name = 'rule-schedule';
  private phase: 'morning-mail' | 'farm-work' | 'fishing' | 'forage' | 'homeward' | 'sleeping' = 'farm-work';
  private lastPhaseDay = -1;

  async decide(state: GameStateSnapshot): Promise<PlannerDecision> {
    const menu = handleMenu(state);
    if (menu) return menu;

    // 跨日重置日程
    const dayKey = `${state.season}${state.day}`;
    if (this.lastPhaseDay !== state.day) {
      this.lastPhaseDay = state.day;
      this.phase = 'morning-mail';
    }
    void dayKey;

    const staminaRatio = state.stamina / state.staminaMax;
    if (staminaRatio < 0.08) {
      return { kind: 'act', tool: 'sleep', args: {}, intent: '体力见底，回家睡觉（再也不收 50g 医疗费！）' };
    }
    if (staminaRatio < 0.12 && state.clockMinutes < 18 * 60) {
      return { kind: 'act', tool: 'eat', args: {}, intent: '体力不足先吃点东西垫垫' };
    }
    if (state.clockMinutes >= 18 * 60 + 30) {
      return this.goSleep(state);
    }

    switch (this.phase) {
      case 'morning-mail': {
        if (/(\d+) 封未读信件/.test(state.raw)) {
          const tool = { kind: 'act' as const, tool: 'read_mail', args: {}, intent: '读信啦——说不定有鱼竿！（7 封未读）' };
          this.phase = 'farm-work';
          return tool;
        }
        this.phase = 'farm-work';
        return this.farmWork(state);
      }
      case 'farm-work':
        return this.farmWork(state);
      case 'fishing':
        if (state.clockMinutes >= 17 * 60 + 30) {
          this.phase = 'forage';
          return this.forage(state);
        }
        return { kind: 'act', tool: 'fish', args: { casts: 5 }, intent: '钓鱼赚米！这可是正经的生产活动（傲娇）' };
      case 'forage':
        if (state.clockMinutes >= 18 * 60 + 30) return this.goSleep(state);
        return this.forage(state);
      case 'homeward':
        return this.goSleep(state);
      case 'sleeping':
        return { kind: 'wait', seconds: 60, reason: '睡觉结算中……' };
    }
  }

  private farmWork(state: GameStateSnapshot): PlannerDecision {
    if (state.clockMinutes >= 11 * 60) {
      this.phase = 'fishing';
      return { kind: 'act', tool: 'travel_to', args: { location: 'Beach' }, intent: '上午农活干完，去海滩钓鱼！' };
    }
    if (/剩 \d+ 株没浇|需要浇水/.test(state.raw)) {
      return { kind: 'act', tool: 'water_crops', args: {}, intent: '给作物浇水——今天浇了才算长一天' };
    }
    if (/成熟的作物/.test(state.raw)) {
      return { kind: 'act', tool: 'harvest_crops', args: {}, intent: '收获成熟的作物！' };
    }
    if (/防风草种子|种子 x\d+/.test(state.raw)) {
      return { kind: 'act', tool: 'plant_seeds', args: { seed: '防风草种子' }, intent: '播种防风草（海滩农场沙地注意洒水器无效）' };
    }
    if (state.location !== 'Farm' && state.location !== 'FarmHouse') {
      return { kind: 'act', tool: 'travel_to', args: { location: 'Farm' }, intent: '回农场继续干活' };
    }
    // 没有明确农活 → 直接进入钓鱼阶段
    this.phase = 'fishing';
    return { kind: 'act', tool: 'travel_to', args: { location: 'Beach' }, intent: '农活告一段落，海滩钓鱼去～' };
  }

  private forage(state: GameStateSnapshot): PlannerDecision {
    if (state.location !== 'Town') {
      return { kind: 'act', tool: 'travel_to', args: { location: 'Town' }, intent: '傍晚去镇上翻垃圾桶（侦察！才不是摸鱼）' };
    }
    return { kind: 'act', tool: 'forage', args: {}, intent: '采集时间～顺便翻翻垃圾桶（小鲸的侦察行动）' };
  }

  private goSleep(_state: GameStateSnapshot): PlannerDecision {
    this.phase = 'sleeping';
    if (_state.location !== 'FarmHouse') {
      return { kind: 'act', tool: 'travel_to', args: { location: 'FarmHouse' }, intent: '回家！绝不晕倒（Joja 医疗费 50g 的教训）' };
    }
    return { kind: 'act', tool: 'sleep', args: {}, intent: '睡觉～晚安主人（自动结算）' };
  }
}
