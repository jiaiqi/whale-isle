/**
 * 双宠彩蛋小剧场驱动器（T-M6-65，纯状态机 + 可注入定时器）。
 *
 * 剧本五段：pop → pretend →（抓包 caught → bye ｜ 溜走 escape）→ 关闭。
 * 宿主匹配优先：主桌宠 characterId 与 egg 的 hostSkin 精确命中 > host 精确命中 > 通用随机。
 * 同一时刻最多 1 场；解散/应用退出/彩蛋窗关闭必须立即清理全部定时器，绝不留下僵尸窗口。
 */

export interface EggScriptLines {
  pop: string[];
  pretend: string[];
  caught: string[];
  bye: string[];
  escape: string[];
}

export interface EggScript {
  /** 彩蛋角色 id（如 crosspet-egg-deepseek-feed） */
  characterId: string;
  name: string;
  host: string;
  hostSkin: string;
  aura: string;
  lines: EggScriptLines;
}

export interface EggTheaterTimerApi {
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

export interface EggTheaterOptions {
  scripts: () => EggScript[];
  /** 打开彩蛋窗（不得抢焦点，由宿主 showInactive / manager.open 保证） */
  openEgg: (script: EggScript) => { ok: boolean; agentId?: string; error?: string } | Promise<{ ok: boolean; agentId?: string; error?: string }>;
  /** 彩蛋窗台词（pop/pretend/caught/bye/escape） */
  sayEgg: (agentId: string, text: string) => void;
  /** 主桌宠同步回应一句（抓包时） */
  sayHost: (text: string) => void;
  /** 阶段切换（宿主据此切换彩蛋姿态图） */
  onPhase?: (phase: EggTheaterState, agentId: string) => void;
  closeEgg: (agentId: string) => void;
  timers?: EggTheaterTimerApi;
  rng?: () => number;
  /** pop 停留多久进入 pretend（默认 1.2s） */
  popMs?: number;
  /** pretend 总时长（默认 5s）与轮播间隔（2.2s） */
  pretendMs?: number;
  pretendIntervalMs?: number;
  /** caught → bye 3s；bye → 关闭 2.5s；escape → 关闭 2.5s */
  caughtToByeMs?: number;
  byeToCloseMs?: number;
  escapeToCloseMs?: number;
}

export type EggTheaterState = 'idle' | 'pop' | 'pretend' | 'caught' | 'bye' | 'escape';

export interface EggTheaterStartResult {
  ok: boolean;
  agentId?: string;
  script?: EggScript;
  error?: string;
}

export interface EggTheater {
  start(mainCharacterId: string): Promise<EggTheaterStartResult>;
  /** 用户在 pop/pretend 期间点中彩蛋窗：进入抓包分支 */
  catch(): { ok: boolean; caught?: boolean; error?: string };
  /** 用户解散/应用退出：立即清理并关闭彩蛋窗 */
  dismiss(): void;
  state(): EggTheaterState;
  activeScript(): EggScript | null;
}

const DEFAULT_TIMERS: EggTheaterTimerApi = {
  setTimeout: (handler, ms) => globalThis.setTimeout(handler, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id as ReturnType<typeof setTimeout>),
};

function pickLine(pool: string[], rng: () => number): string | null {
  if (pool.length === 0) return null;
  const index = Math.min(pool.length - 1, Math.max(0, Math.floor(rng() * pool.length)));
  return pool[index] ?? null;
}

/** 主桌宠 id → 去掉 `crosspet-` 后的皮肤名（gpt-onesie / claude-saint…）。 */
export function skinNameOf(mainCharacterId: string): string {
  return mainCharacterId.replace(/^crosspet-/, '');
}

/**
 * 专属匹配打分：hostSkin 精确 2 分、host 精确 1 分；最高分唯一/并列时在最高分组内随机。
 * 没有任何专属命中 → 从全部彩蛋随机（通用彩蛋）。
 */
export function pickEggScript(scripts: readonly EggScript[], mainCharacterId: string, rng: () => number = Math.random): EggScript | null {
  if (scripts.length === 0) return null;
  const skin = skinNameOf(mainCharacterId);
  const scored = scripts.map((script) => {
    const score = script.hostSkin !== '' && script.hostSkin === skin ? 2 : script.host !== '' && script.host === skin ? 1 : 0;
    return { script, score };
  });
  const best = Math.max(...scored.map((entry) => entry.score));
  const candidates = best > 0 ? scored.filter((entry) => entry.score === best).map((entry) => entry.script) : [...scripts];
  const index = Math.min(candidates.length - 1, Math.max(0, Math.floor(rng() * candidates.length)));
  return candidates[index] ?? null;
}

export function createEggTheater(options: EggTheaterOptions): EggTheater {
  const timers = options.timers ?? DEFAULT_TIMERS;
  const rng = options.rng ?? Math.random;
  const popMs = options.popMs ?? 1_200;
  const pretendMs = options.pretendMs ?? 5_000;
  const pretendIntervalMs = options.pretendIntervalMs ?? 2_200;
  const caughtToByeMs = options.caughtToByeMs ?? 3_000;
  const byeToCloseMs = options.byeToCloseMs ?? 2_500;
  const escapeToCloseMs = options.escapeToCloseMs ?? 2_500;

  let phase: EggTheaterState = 'idle';
  let script: EggScript | null = null;
  let agentId: string | null = null;
  const pending = new Set<unknown>();

  const later = (handler: () => void, ms: number): void => {
    const id = timers.setTimeout(() => {
      pending.delete(id);
      handler();
    }, ms);
    pending.add(id);
  };
  const clearTimers = (): void => {
    for (const id of pending) timers.clearTimeout(id);
    pending.clear();
  };
  const say = (pool: string[]): void => {
    if (agentId === null) return;
    const line = pickLine(pool, rng);
    if (line !== null && line !== '') options.sayEgg(agentId, line);
  };
  const setPhase = (next: EggTheaterState): void => {
    phase = next;
    if (agentId !== null) options.onPhase?.(next, agentId);
  };
  const finish = (): void => {
    clearTimers();
    const openAgent = agentId;
    agentId = null;
    script = null;
    phase = 'idle';
    if (openAgent !== null) {
      try {
        options.closeEgg(openAgent);
      } catch { /* 已关闭 */ }
    }
  };
  const schedulePretendLine = (): void => {
    later(() => {
      if (phase !== 'pretend') return;
      say(script?.lines.pretend ?? []);
      schedulePretendLine();
    }, pretendIntervalMs);
  };
  const enterPretend = (): void => {
    if (phase !== 'pop') return;
    setPhase('pretend');
    say(script?.lines.pretend ?? []);
    schedulePretendLine();
    later(() => {
      if (phase !== 'pretend') return;
      setPhase('escape');
      say(script?.lines.escape ?? []);
      later(finish, escapeToCloseMs);
    }, pretendMs);
  };

  return {
    async start(mainCharacterId) {
      if (phase !== 'idle') return { ok: false, error: '已有一场彩蛋小剧场在运行' };
      const chosen = pickEggScript(options.scripts(), mainCharacterId, rng);
      if (chosen === null) return { ok: false, error: '未找到可用彩蛋素材' };
      let opened: { ok: boolean; agentId?: string; error?: string };
      try {
        opened = await options.openEgg(chosen);
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      if (!opened.ok || opened.agentId === undefined) return { ok: false, error: opened.error ?? '彩蛋窗打开失败' };
      script = chosen;
      agentId = opened.agentId;
      setPhase('pop');
      say(chosen.lines.pop);
      later(enterPretend, popMs);
      return { ok: true, agentId, script: chosen };
    },
    catch() {
      if (phase !== 'pop' && phase !== 'pretend') return { ok: false, error: '当前没有可抓包的彩蛋' };
      clearTimers();
      setPhase('caught');
      say(script?.lines.caught ?? []);
      options.sayHost('抓住你啦！');
      later(() => {
        setPhase('bye');
        say(script?.lines.bye ?? []);
        later(finish, byeToCloseMs);
      }, caughtToByeMs);
      return { ok: true, caught: true };
    },
    dismiss: finish,
    state: () => phase,
    activeScript: () => script,
  };
}
