/**
 * 当日计划状态管理（T-M6-70 §4.2）：
 * 起床后由 LLM 自拟今日计划（目标列表 + 理由 + 心情），每轮决策注入上下文，
 * 并允许 LLM 在任意步输出 `planUpdate` 增删改或标记完成。不做玩法规则校验，只校验结构。
 */

export type DayPlanStatus = 'pending' | 'in_progress' | 'done';

export interface DayPlanItem {
  goal: string;
  why: string;
  status: DayPlanStatus;
  /** 加入或立项时的游戏时钟 */
  addedAt?: string;
  /** 标记为已完成时的游戏时钟 */
  completedAt?: string;
}

export interface DayPlanHistoryEntry {
  /** 触发记录时的游戏时钟 */
  atClock: string;
  /** 触发记录时的现实时间戳 */
  atTs: number;
  kind: 'morning' | 'update';
  summary: string;
  why?: string;
}

export interface DayPlanSnapshot {
  dayKey: string;
  items: DayPlanItem[];
  mood?: string;
  updateWhy?: string;
  history?: DayPlanHistoryEntry[];
}

export interface DayPlanUpdate {
  why?: string;
  /** 标记已完成的目标（支持目标文本子串匹配或 0 基序号） */
  done?: ReadonlyArray<string | number>;
  /** 标记进行中的目标（支持目标文本子串匹配或 0 基序号） */
  inProgress?: ReadonlyArray<string | number>;
  /** 移除不再适用的目标 */
  remove?: ReadonlyArray<string | number>;
  /** 新增目标项 */
  add?: ReadonlyArray<{ goal: string; why?: string; status?: DayPlanStatus } | string>;
  /** 直接替换完整列表（可选） */
  replace?: ReadonlyArray<{ goal: string; why?: string; status?: DayPlanStatus }>;
}

const VALID_STATUSES: ReadonlySet<string> = new Set(['pending', 'in_progress', 'done']);

function normalizeStatus(raw: unknown): DayPlanStatus {
  return typeof raw === 'string' && VALID_STATUSES.has(raw) ? (raw as DayPlanStatus) : 'pending';
}

export function normalizePlanItem(raw: unknown): DayPlanItem | null {
  if (typeof raw === 'string') {
    const goal = raw.trim().slice(0, 120);
    return goal === '' ? null : { goal, why: '', status: 'pending' };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const goalRaw = typeof rec['goal'] === 'string' ? rec['goal'] : typeof rec['title'] === 'string' ? rec['title'] : '';
  const goal = goalRaw.trim().slice(0, 120);
  if (goal === '') return null;
  const why = typeof rec['why'] === 'string'
    ? rec['why'].trim().slice(0, 160)
    : typeof rec['reason'] === 'string'
      ? rec['reason'].trim().slice(0, 160)
      : '';
  return {
    goal,
    why,
    status: normalizeStatus(rec['status']),
  };
}

/** 更新中省略状态表示保留旧状态，不能在解析时提前变成 pending。 */
function normalizePlanUpdateItem(raw: unknown): { goal: string; why: string; status?: DayPlanStatus } | null {
  const item = normalizePlanItem(raw);
  if (item === null) return null;
  const hasStatus = typeof raw === 'object' && raw !== null && 'status' in raw && raw.status !== undefined;
  return { goal: item.goal, why: item.why, ...(hasStatus ? { status: item.status } : {}) };
}

/** 解析清晨计划 JSON：`{"plan":[{"goal":"...","why":"..."}],"mood":"..."}` */
export function parseMorningPlanObject(obj: Record<string, unknown>): { items: DayPlanItem[]; mood?: string } | null {
  const rawList = obj['plan'];
  if (!Array.isArray(rawList)) return null;
  const items: DayPlanItem[] = [];
  for (const entry of rawList) {
    const item = normalizePlanItem(entry);
    if (item !== null) items.push(item);
    if (items.length >= 8) break;
  }
  if (items.length === 0) return null;
  const mood = typeof obj['mood'] === 'string' && obj['mood'].trim() !== ''
    ? obj['mood'].trim().slice(0, 80)
    : undefined;
  return { items, ...(mood === undefined ? {} : { mood }) };
}

/** 解析任一步附带的 `planUpdate` 字段（兼容对象与直接数组两种常见模型写法） */
export function parsePlanUpdate(raw: unknown): DayPlanUpdate | null {
  if (Array.isArray(raw)) {
    const replace: Array<{ goal: string; why?: string; status?: DayPlanStatus }> = [];
    for (const entry of raw) {
      const item = normalizePlanUpdateItem(entry);
      if (item !== null) replace.push(item);
    }
    return replace.length > 0 ? { replace } : null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const rec = raw as Record<string, unknown>;
  const why = typeof rec['why'] === 'string' && rec['why'].trim() !== ''
    ? rec['why'].trim().slice(0, 160)
    : typeof rec['reason'] === 'string' && rec['reason'].trim() !== ''
      ? rec['reason'].trim().slice(0, 160)
      : undefined;

  const parseRefList = (val: unknown): Array<string | number> | undefined => {
    if (!Array.isArray(val)) return undefined;
    const refs = val.filter((v): v is string | number =>
      (typeof v === 'string' && v.trim() !== '') || (typeof v === 'number' && Number.isInteger(v) && v >= 0));
    return refs.length > 0 ? refs : undefined;
  };

  const done = parseRefList(rec['done']);
  const inProgress = parseRefList(rec['inProgress'] ?? rec['in_progress']);
  const remove = parseRefList(rec['remove']);

  let add: Array<{ goal: string; why?: string; status?: DayPlanStatus } | string> | undefined;
  if (Array.isArray(rec['add'])) {
    const parsedAdd = rec['add']
      .map((entry) => normalizePlanUpdateItem(entry))
      .filter((item): item is NonNullable<ReturnType<typeof normalizePlanUpdateItem>> => item !== null);
    if (parsedAdd.length > 0) add = parsedAdd;
  }

  let replace: Array<{ goal: string; why?: string; status?: DayPlanStatus }> | undefined;
  if (Array.isArray(rec['replace'] ?? rec['items'] ?? rec['plan'])) {
    const src = (rec['replace'] ?? rec['items'] ?? rec['plan']) as unknown[];
    const parsedReplace = src
      .map((entry) => normalizePlanUpdateItem(entry))
      .filter((item): item is NonNullable<ReturnType<typeof normalizePlanUpdateItem>> => item !== null);
    if (parsedReplace.length > 0) replace = parsedReplace;
  }

  if (done === undefined && inProgress === undefined && remove === undefined && add === undefined && replace === undefined) {
    return null;
  }
  return {
    ...(why === undefined ? {} : { why }),
    ...(done === undefined ? {} : { done }),
    ...(inProgress === undefined ? {} : { inProgress }),
    ...(remove === undefined ? {} : { remove }),
    ...(add === undefined ? {} : { add }),
    ...(replace === undefined ? {} : { replace }),
  };
}

function normalizeGoalKey(goal: string): string {
  return goal.replace(/[\s，。、：:！!？?（）()【】[\]「」"'`]+/g, '').trim().toLowerCase();
}

function matchesRef(item: DayPlanItem, index: number, ref: string | number): boolean {
  if (typeof ref === 'number') return index === ref;
  const needle = ref.trim();
  return needle !== '' && (item.goal === needle || item.goal.includes(needle) || needle.includes(item.goal));
}

function shortGoalLabel(goal: string): string {
  const s = goal.trim();
  return s.length > 24 ? `${s.slice(0, 23)}…` : s;
}

export class DayPlanStore {
  private current: DayPlanSnapshot | null = null;
  private attemptedDay = '';
  private history: DayPlanHistoryEntry[] = [];

  /** 跨日清空旧计划 */
  rollover(dayKey: string): boolean {
    if (dayKey === '' || (this.current !== null && this.current.dayKey === dayKey)) return false;
    const changed = this.attemptedDay !== dayKey;
    if (this.current !== null && this.current.dayKey !== dayKey) {
      this.current = null;
      this.history = [];
    }
    return changed;
  }

  hasAttemptedToday(dayKey: string): boolean {
    return dayKey !== '' && this.attemptedDay === dayKey;
  }

  markAttempted(dayKey: string): void {
    if (dayKey !== '') this.attemptedDay = dayKey;
  }

  setMorningPlan(dayKey: string, items: DayPlanItem[], mood?: string, atClock = ''): DayPlanSnapshot {
    this.attemptedDay = dayKey;
    const stamp = atClock.trim() !== '' ? atClock.trim() : dayKey;
    const normalized = items.slice(0, 8).map((item, idx) => {
      const status = idx === 0 && item.status === 'pending' ? ('in_progress' as const) : item.status;
      return {
        ...item,
        status,
        addedAt: item.addedAt ?? stamp,
        ...(status === 'done' ? { completedAt: item.completedAt ?? stamp } : {}),
      };
    });
    this.history = [{
      atClock: stamp,
      atTs: Date.now(),
      kind: 'morning',
      summary: `晨间拟定 ${normalized.length} 项待办`,
      ...(mood === undefined ? {} : { why: mood }),
    }];
    this.current = {
      dayKey,
      items: normalized,
      ...(mood === undefined ? {} : { mood }),
      history: this.history.map((entry) => ({ ...entry })),
    };
    return this.snapshot()!;
  }

  applyUpdate(dayKey: string, update: DayPlanUpdate, atClock = ''): DayPlanSnapshot | null {
    const baseItems: DayPlanItem[] = this.current?.dayKey === dayKey ? this.current.items.map((it) => ({ ...it })) : [];
    const stamp = atClock.trim() !== '' ? atClock.trim() : dayKey;
    let nextItems = baseItems;
    const doneGoals: string[] = [];
    const progressGoals: string[] = [];
    const addedGoals: string[] = [];
    const removedGoals: string[] = [];
    let replacedCount: number | null = null;

    if (update.replace !== undefined) {
      nextItems = update.replace
        .map((entry) => normalizePlanItem(entry))
        .filter((item): item is DayPlanItem => item !== null)
        .slice(0, 8)
        .map((item) => {
          const existing = baseItems.find((old) => normalizeGoalKey(old.goal) === normalizeGoalKey(item.goal));
          const requested = update.replace!.find((entry) => normalizePlanItem(entry)?.goal === item.goal)?.status;
          const status = existing?.status === 'done' ? 'done' : requested ?? existing?.status ?? 'pending';
          if (status === 'done' && existing?.status !== 'done') doneGoals.push(item.goal);
          return {
            ...item,
            status,
            addedAt: existing?.addedAt ?? stamp,
            ...(status === 'done' ? { completedAt: existing?.completedAt ?? stamp } : {}),
          };
        });
      replacedCount = nextItems.length;
    } else {
      if (update.done !== undefined) {
        nextItems = nextItems.map((item, idx) => {
          if (!update.done!.some((ref) => matchesRef(item, idx, ref))) return item;
          if (item.status !== 'done') doneGoals.push(item.goal);
          return { ...item, status: 'done', completedAt: item.completedAt ?? stamp };
        });
      }
      if (update.inProgress !== undefined) {
        nextItems = nextItems.map((item, idx) => {
          if (item.status === 'done' || !update.inProgress!.some((ref) => matchesRef(item, idx, ref))) return item;
          if (item.status !== 'in_progress') progressGoals.push(item.goal);
          return { ...item, status: 'in_progress' };
        });
      }
      if (update.remove !== undefined) {
        nextItems = nextItems.filter((item, idx) => {
          const hit = update.remove!.some((ref) => matchesRef(item, idx, ref));
          if (hit) removedGoals.push(item.goal);
          return !hit;
        });
      }
      if (update.add !== undefined) {
        for (const raw of update.add) {
          const item = normalizePlanItem(raw);
          if (item === null) continue;
          const key = normalizeGoalKey(item.goal);
          const dupIdx = nextItems.findIndex((existing) => normalizeGoalKey(existing.goal) === key);
          if (dupIdx >= 0) {
            const existing = nextItems[dupIdx]!;
            const explicitStatus = typeof raw === 'object' ? raw.status : undefined;
            const nextStatus = existing.status === 'done' ? 'done' : explicitStatus ?? existing.status;
            if (nextStatus === 'done' && existing.status !== 'done') doneGoals.push(existing.goal);
            nextItems[dupIdx] = {
              goal: existing.goal,
              why: item.why !== '' ? item.why : existing.why,
              status: nextStatus,
              ...(existing.addedAt === undefined ? { addedAt: stamp } : { addedAt: existing.addedAt }),
              ...(nextStatus === 'done' ? { completedAt: existing.completedAt ?? stamp } : {}),
            };
          } else if (nextItems.length < 8) {
            addedGoals.push(item.goal);
            nextItems.push({
              ...item,
              addedAt: stamp,
              ...(item.status === 'done' ? { completedAt: stamp } : {}),
            });
          }
        }
      }
    }

    if (nextItems.length === 0 && baseItems.length === 0) return null;
    this.attemptedDay = dayKey;
    const changeParts: string[] = [];
    if (replacedCount !== null) changeParts.push(`重排为 ${replacedCount} 项`);
    if (doneGoals.length > 0) changeParts.push(`完成「${doneGoals.map(shortGoalLabel).join('、')}」`);
    if (progressGoals.length > 0) changeParts.push(`推进「${progressGoals.map(shortGoalLabel).join('、')}」`);
    if (addedGoals.length > 0) changeParts.push(`新增「${addedGoals.map(shortGoalLabel).join('、')}」`);
    if (removedGoals.length > 0) changeParts.push(`移除「${removedGoals.map(shortGoalLabel).join('、')}」`);
    if (changeParts.length > 0 || update.why !== undefined) {
      if (this.current?.dayKey !== dayKey) this.history = [];
      this.history = [
        ...this.history.slice(-39),
        {
          atClock: stamp,
          atTs: Date.now(),
          kind: 'update',
          summary: changeParts.join(' · ') || `记录计划说明（共 ${nextItems.length} 项，目标状态未变）`,
          ...(update.why === undefined ? {} : { why: update.why }),
        },
      ];
    }
    this.current = {
      dayKey,
      items: nextItems,
      ...(this.current?.mood === undefined ? {} : { mood: this.current.mood }),
      ...(update.why === undefined ? {} : { updateWhy: update.why }),
      ...(this.history.length > 0 ? { history: this.history.map((entry) => ({ ...entry })) } : {}),
    };
    return this.snapshot();
  }

  snapshot(): DayPlanSnapshot | null {
    if (this.current === null) return null;
    return {
      dayKey: this.current.dayKey,
      items: this.current.items.map((item) => ({ ...item })),
      ...(this.current.mood === undefined ? {} : { mood: this.current.mood }),
      ...(this.current.updateWhy === undefined ? {} : { updateWhy: this.current.updateWhy }),
      ...(this.history.length > 0 ? { history: this.history.map((entry) => ({ ...entry })) } : {}),
    };
  }

  formatForPrompt(): string {
    if (this.current === null || this.current.items.length === 0) {
      return '（今日计划尚未建立，可根据当前状态在输出中附带 planUpdate 建立）';
    }
    const badge: Record<DayPlanStatus, string> = {
      done: '[已完成]',
      in_progress: '[进行中]',
      pending: '[待办]',
    };
    const lines = this.current.items.map((item, idx) =>
      `[ref=${idx}] ${badge[item.status]} ${item.goal}${item.why === '' ? '' : `（理由：${item.why}）`}`);
    const moodLine = this.current.mood === undefined ? '' : `今日心情：${this.current.mood}\n`;
    return `${moodLine}${lines.join('\n')}`;
  }
}
