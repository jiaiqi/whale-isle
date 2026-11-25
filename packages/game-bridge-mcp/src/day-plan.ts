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
}

export interface DayPlanSnapshot {
  dayKey: string;
  items: DayPlanItem[];
  mood?: string;
  updateWhy?: string;
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
      const item = normalizePlanItem(entry);
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
      .map((entry) => normalizePlanItem(entry))
      .filter((item): item is DayPlanItem => item !== null);
    if (parsedAdd.length > 0) add = parsedAdd;
  }

  let replace: Array<{ goal: string; why?: string; status?: DayPlanStatus }> | undefined;
  if (Array.isArray(rec['replace'] ?? rec['items'] ?? rec['plan'])) {
    const src = (rec['replace'] ?? rec['items'] ?? rec['plan']) as unknown[];
    const parsedReplace = src
      .map((entry) => normalizePlanItem(entry))
      .filter((item): item is DayPlanItem => item !== null);
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

function matchesRef(item: DayPlanItem, index: number, ref: string | number): boolean {
  if (typeof ref === 'number') return index === ref;
  const needle = ref.trim();
  return needle !== '' && (item.goal === needle || item.goal.includes(needle) || needle.includes(item.goal));
}

export class DayPlanStore {
  private current: DayPlanSnapshot | null = null;
  private attemptedDay = '';

  /** 跨日清空旧计划 */
  rollover(dayKey: string): boolean {
    if (dayKey === '' || (this.current !== null && this.current.dayKey === dayKey)) return false;
    const changed = this.attemptedDay !== dayKey;
    if (this.current !== null && this.current.dayKey !== dayKey) {
      this.current = null;
    }
    return changed;
  }

  hasAttemptedToday(dayKey: string): boolean {
    return dayKey !== '' && this.attemptedDay === dayKey;
  }

  markAttempted(dayKey: string): void {
    if (dayKey !== '') this.attemptedDay = dayKey;
  }

  setMorningPlan(dayKey: string, items: DayPlanItem[], mood?: string): DayPlanSnapshot {
    this.attemptedDay = dayKey;
    const normalized = items.slice(0, 8).map((item, idx) => ({
      ...item,
      status: idx === 0 && item.status === 'pending' ? ('in_progress' as const) : item.status,
    }));
    this.current = {
      dayKey,
      items: normalized,
      ...(mood === undefined ? {} : { mood }),
    };
    return this.snapshot()!;
  }

  applyUpdate(dayKey: string, update: DayPlanUpdate): DayPlanSnapshot | null {
    const baseItems: DayPlanItem[] = this.current?.dayKey === dayKey ? this.current.items.map((it) => ({ ...it })) : [];
    let nextItems = baseItems;

    if (update.replace !== undefined) {
      nextItems = update.replace
        .map((entry) => normalizePlanItem(entry))
        .filter((item): item is DayPlanItem => item !== null)
        .slice(0, 8);
    } else {
      if (update.done !== undefined) {
        nextItems = nextItems.map((item, idx) =>
          update.done!.some((ref) => matchesRef(item, idx, ref)) ? { ...item, status: 'done' } : item);
      }
      if (update.inProgress !== undefined) {
        nextItems = nextItems.map((item, idx) =>
          update.inProgress!.some((ref) => matchesRef(item, idx, ref)) ? { ...item, status: 'in_progress' } : item);
      }
      if (update.remove !== undefined) {
        nextItems = nextItems.filter((item, idx) => !update.remove!.some((ref) => matchesRef(item, idx, ref)));
      }
      if (update.add !== undefined) {
        for (const raw of update.add) {
          const item = normalizePlanItem(raw);
          if (item !== null && nextItems.length < 8) nextItems.push(item);
        }
      }
    }

    if (nextItems.length === 0) return null;
    this.attemptedDay = dayKey;
    this.current = {
      dayKey,
      items: nextItems,
      ...(this.current?.mood === undefined ? {} : { mood: this.current.mood }),
      ...(update.why === undefined ? {} : { updateWhy: update.why }),
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
      `${idx + 1}. ${badge[item.status]} ${item.goal}${item.why === '' ? '' : `（理由：${item.why}）`}`);
    const moodLine = this.current.mood === undefined ? '' : `今日心情：${this.current.mood}\n`;
    return `${moodLine}${lines.join('\n')}`;
  }
}
