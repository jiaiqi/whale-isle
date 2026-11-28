/**
 * 「今日安排事实」（V2-P4-01，2026-11-28）：
 *
 * 参考 ValleyServer/ValleyWhale 的 `Knowledge.TodaysFestival()` 与
 * `GameActions.Town.DailyQuestHint()`：把「今天是什么日子」作为**结构化事实**喂给晨间计划，
 * 让一天像人那样按「几点做什么」编排，而不是让模型自由发挥。
 *
 * 只陈述游戏已给出的事实（节日名与时间窗、生日、天气、季末、任务及其交付方式），
 * 不替模型决定做什么、也不校验玩法（AI-first 红线）。
 */

/** 从「今日：生日 无；节日 月光水母之舞（Beach，22:00-00:00(次日)）」提取节日与地点时间窗 */
export interface TodayFestivalFact {
  name: string;
  /** 地点（如 Beach）；无地点时为 null */
  location: string | null;
  /** 时间窗原文（如 22:00-00:00(次日)）；无则 null */
  window: string | null;
}

export function parseTodayFestival(raw: string): TodayFestivalFact | null {
  const todayLine = /^.*今日：.*$/m.exec(raw)?.[0] ?? '';
  // 必须保留括号内的地点与时段，因此不能按『（』截断
  const festivalRaw = /节日\s*(无|.+?)\s*$/.exec(todayLine)?.[1]?.trim() ?? '无';
  if (festivalRaw === '' || festivalRaw === '无') return null;
  // 「月光水母之舞（Beach，22:00-00:00(次日)）」→ 名称 / 地点 / 时间窗
  // 时间窗自身可能含括号（如 22:00-00:00(次日)），因此取到最外层右括号前为止
  const m = /^([^（(]+?)\s*[（(]\s*([^，,]*?)\s*[，,]\s*(.+?)\s*[）)]\s*$/.exec(festivalRaw);
  if (m === null) return { name: festivalRaw.slice(0, 40), location: null, window: null };
  const name = (m[1] ?? '').trim();
  const where = (m[2] ?? '').trim();
  const window = (m[3] ?? '').trim();
  return {
    name: name === '' ? festivalRaw.slice(0, 40) : name.slice(0, 40),
    location: where === '' ? null : where.slice(0, 24),
    window: window === '' ? null : window.slice(0, 32),
  };
}

export function parseTodayBirthday(raw: string): string | null {
  const todayLine = /^.*今日：.*$/m.exec(raw)?.[0] ?? '';
  const value = /生日\s*(无|[^；;\n]+)/.exec(todayLine)?.[1]?.trim() ?? '无';
  return value === '' || value === '无' ? null : value.slice(0, 24);
}

/**
 * 从「## 任务」段挑出**带交付方式**的任务（游戏已说明怎么交），最多 5 条。
 * 只取 `- xxx。怎么交：yyy` 形态，避免把纯目标类任务当成今日必做。
 */
export function parseActionableQuests(raw: string, limit = 5): Array<{ title: string; how: string }> {
  const section = /## 任务([\s\S]*?)(?=\n## |\n*$)/.exec(raw)?.[1] ?? '';
  const out: Array<{ title: string; how: string }> = [];
  for (const line of section.split('\n')) {
    // 游戏原文常见「……花椰菜。。怎么交：」，因此允许交付说明前有 1~2 个句号
    const m = /^-\s*(.+?)。+?怎么交：(.+)$/.exec(line.trim());
    if (m === null) continue;
    const title = (m[1] ?? '').trim();
    const how = (m[2] ?? '').trim();
    if (title === '' || how === '') continue;
    out.push({ title: title.slice(0, 40), how: how.slice(0, 160) });
    if (out.length >= limit) break;
  }
  return out;
}

/** 季末提示：每月 28 日是季节最后一天（ Stardew 每季 28 天）。 */
export function isSeasonEndDay(season: string, day: number): boolean {
  return day >= 28;
}

/**
 * 汇总「今日安排事实」段落；无任何事实时返回空串（不塞空标题）。
 */
export function buildTodayScheduleFacts(input: {
  raw: string;
  season: string;
  day: number;
  weather: string;
}): string {
  const lines: string[] = [];
  const festival = parseTodayFestival(input.raw);
  if (festival !== null) {
    const when = festival.window !== null ? `，时段 ${festival.window}` : '';
    const where = festival.location !== null ? `，地点 ${festival.location}` : '';
    lines.push(`- 今日节日：${festival.name}${where}${when}（节日当天镇上商店关门）`);
  }
  const birthday = parseTodayBirthday(input.raw);
  if (birthday !== null) lines.push(`- 今日生日：${birthday}（可送礼提升好感）`);

  const quests = parseActionableQuests(input.raw);
  if (quests.length > 0) {
    lines.push('- 今日可执行任务（游戏已给出交付方式）：');
    for (const q of quests) lines.push(`  · ${q.title} → ${q.how}`);
  }
  if (isSeasonEndDay(input.season, input.day)) {
    lines.push(`- 今天是${input.season}季最后一天：来不及成熟的作物不要再种，长期目标（升级工具/设施/深层矿洞）更适合这几天推进。`);
  }
  if (input.weather !== '') lines.push(`- 今日天气：${input.weather}（雨天/绿雨户外作物自动浇水，不用花时间浇水）`);

  if (lines.length === 0) return '';
  return '## 今日安排事实（游戏已给出的客观信息，据此编排一天，不强制）\n' + lines.join('\n');
}
