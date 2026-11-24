/**
 * 跨 AI 工作跟随（T-M6-49 / T-M6-64 / T-M6-65）。
 *
 * 只读事件：source（acp/claude/codex/deepseek/gemini/cursor/qwen/kimi/grok）、sessionId、
 * kind（start/tool/stop/asking/compact/error）、toolName/modelName/taskTitle/origin；
 * **绝不接收对话正文与凭据**。
 *
 * 策略：
 *   - single：同一只主桌宠随当前活跃 AI 自动换装（切角色，不新增窗口）；
 *   - multi：每个 AI 各来一只（按 source 映射 CrossPet 角色，最多 3 只同时展示）。
 * 并发忙碌：同角色 2 路 → busy、≥3 路 → swamped（由宿主覆写姿态）。
 * 在场策略：idle-leave（默认，60s 闲置退场）/ app-exit（仅 stop 或应用退出）/ always-with-app。
 * 来源去重：Hook 事件后 5s 内的同会话 log-watch 事件自动忽略，避免工具数双计。
 */
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ipcMain } from 'electron';
import { poseForWorkEvent } from './pose-resolver';
import {
  WorkFollowCardSchema,
  WorkFollowEventSchema,
  WorkFollowSessionSchema,
  WorkFollowStatusSchema,
  type WorkFollowCard,
  type WorkFollowEvent,
  type WorkFollowOrigin,
  type WorkFollowSession,
  type WorkFollowStatus,
} from '@workbench/shared-protocol';

export const CROWN_TOOL_THRESHOLD = 8;
const MAX_SESSIONS = 8;
const MAX_RECENT = 20;
const MAX_CARDS = 4;
const HOOK_DEDUPE_MS = 5_000;
const CARD_LINGER_MS = 120_000;

/** AI 来源 → CrossPet 角色（与 characters/crosspet 目录一一对应）。 */
export const SOURCE_CHARACTER: Record<WorkFollowEvent['source'], string> = {
  acp: '',
  claude: 'crosspet-claude',
  codex: 'crosspet-gpt',
  deepseek: 'crosspet-deepseek',
  gemini: 'crosspet-gemini',
  cursor: 'crosspet-glm',
  qwen: 'crosspet-qwen',
  kimi: 'crosspet-kimi',
  grok: 'crosspet-grok',
};

export type WorkPresencePolicy = WorkFollowStatus['presencePolicy'];

export interface WorkFollowHost {
  ingest(raw: unknown): { ok: boolean; error?: string };
  status(): WorkFollowStatus;
  setMode(mode: 'single' | 'multi'): WorkFollowStatus;
  mode(): 'single' | 'multi';
  setPresencePolicy(policy: WorkPresencePolicy): WorkFollowStatus;
  presencePolicy(): WorkPresencePolicy;
  setLogWatchEnabled(enabled: boolean): WorkFollowStatus;
  logWatchEnabled(): boolean;
  /** 某角色当前任务卡（最多 4 张；仅标题/状态，无正文） */
  cardsFor(characterId: string): WorkFollowCard[];
  /** 连通性自检（T-M6-58）：写一条受控事件，验证文件轮询消费在 1.5s 内闭合 */
  selfTest(): Promise<{ ok: boolean; elapsedMs: number; error?: string }>;
  /** 关闭文件轮询与闲置检查（测试/退出） */
  dispose(): void;
}

/** modelName 优先映射角色（Claude Code 也可能经 ACP 报 claude 模型）；未命中回退来源映射。 */
export function characterForWorkFollow(event: Pick<WorkFollowEvent, 'source' | 'modelName'>): string {
  const model = event.modelName.toLowerCase();
  const rules: Array<[RegExp, string]> = [
    [/claude/, 'crosspet-claude'],
    [/gpt|codex|openai/, 'crosspet-gpt'],
    [/gemini/, 'crosspet-gemini'],
    [/deepseek/, 'crosspet-deepseek'],
    [/qwen|tongyi|千问/, 'crosspet-qwen'],
    [/kimi|moonshot/, 'crosspet-kimi'],
    [/glm|chatglm|zhipu/, 'crosspet-glm'],
    [/grok|xai/, 'crosspet-grok'],
  ];
  return rules.find(([pattern]) => pattern.test(model))?.[1] ?? SOURCE_CHARACTER[event.source];
}

interface SettingsFile {
  mode?: unknown;
  presencePolicy?: unknown;
  logWatchEnabled?: unknown;
}

const PRESENCE_POLICIES: readonly WorkPresencePolicy[] = ['idle-leave', 'app-exit', 'always-with-app'];

export function createWorkFollowHost(options: {
  userDataDir: string;
  /** multi 模式：为某来源召唤桌宠（返回是否成功）；single 模式：切换主宠角色 */
  summon?: (characterId: string, source: WorkFollowEvent['source']) => void;
  switchCharacter?: (characterId: string) => void;
  onCrown?: (session: WorkFollowSession) => void;
  /** 自定义角色 reactTo 代演：返回角色 id 时优先于来源/modelName 映射 */
  resolveCharacter?: (event: WorkFollowEvent) => string | null;
  /** 每个事件尝试驱动代理角色演出的姿态（缺失回退由渲染层处理） */
  onAgentPose?: (session: WorkFollowSession, pose: string) => void;
  /** T-M6-64：每次真实工作活动（start/tool/asking/compact/error/stop）回调，供贴边探出/收回 */
  onWorkActivity?: (session: WorkFollowSession, kind: WorkFollowEvent['kind'], origin: WorkFollowOrigin) => void;
  /** T-M6-64：某角色的任务卡变化（含空数组=全部收工） */
  onCards?: (characterId: string, cards: WorkFollowCard[]) => void;
  onUpdate?: (status: WorkFollowStatus) => void;
  /** multi 模式闲置多久自动告别退场（默认 60s；0 关闭） */
  idleTimeoutMs?: number;
  /** 闲置退场回调（main 据此关闭对应跨 AI 窗口；同一角色还有活跃会话时由 main 自行判断） */
  onSessionIdle?: (session: WorkFollowSession) => void;
  now?: () => number;
  /** 轮询间隔（默认 500ms；测试传 0 关闭） */
  pollMs?: number;
}): WorkFollowHost {
  const now = options.now ?? Date.now;
  const settingsPath = join(options.userDataDir, 'work-follow.json');
  const inboxDir = join(options.userDataDir, 'work-follow');
  const inboxPath = join(inboxDir, 'events.jsonl');
  const sessions = new Map<string, WorkFollowSession>();
  /** `${source}:${sessionId}` → 最近一次事件来源 */
  const origins = new Map<string, WorkFollowOrigin>();
  /** `${source}:${sessionId}` → 最近一次 Hook 事件时间（log-watch 去重） */
  const lastHookAt = new Map<string, number>();
  const recent: WorkFollowStatus['recent'] = [];
  const updateListeners = new Set<(status: WorkFollowStatus) => void>();
  let mode: 'single' | 'multi' = 'multi';
  let presencePolicy: WorkPresencePolicy = 'idle-leave';
  let logWatchEnabled = true;

  try {
    if (existsSync(settingsPath)) {
      const parsed = JSON.parse(readFileSync(settingsPath, 'utf8')) as SettingsFile;
      if (parsed.mode === 'single' || parsed.mode === 'multi') mode = parsed.mode;
      if (PRESENCE_POLICIES.includes(parsed.presencePolicy as WorkPresencePolicy)) {
        presencePolicy = parsed.presencePolicy as WorkPresencePolicy;
      }
      if (typeof parsed.logWatchEnabled === 'boolean') logWatchEnabled = parsed.logWatchEnabled;
    }
  } catch { /* 坏配置 → 默认值 */ }

  const persistSettings = (): void => {
    try {
      mkdirSync(dirname(settingsPath), { recursive: true });
      writeFileSync(settingsPath, `${JSON.stringify({ mode, presencePolicy, logWatchEnabled }, null, 2)}\n`, 'utf8');
    } catch { /* 只影响下次启动的默认值 */ }
  };

  const activeOrigins = (): Record<string, WorkFollowOrigin> => {
    const out: Record<string, WorkFollowOrigin> = {};
    for (const [key, session] of sessions) {
      if (session.active) out[key] = origins.get(key) ?? 'hook';
    }
    return out;
  };

  const status = (): WorkFollowStatus => WorkFollowStatusSchema.parse({
    mode,
    sessions: [...sessions.values()].sort((a, b) => b.lastEventAt - a.lastEventAt).slice(0, MAX_SESSIONS),
    recent,
    presencePolicy,
    logWatchEnabled,
    activeOrigins: activeOrigins(),
  });

  const cardsFor = (characterId: string): WorkFollowCard[] => {
    const at = now();
    return [...sessions.entries()]
      .filter(([key, session]) => {
        if (session.characterId !== characterId) return false;
        if (session.active) return true;
        const state = lastKindOf(key);
        return (state === 'stop' || state === 'error') && at - session.lastEventAt <= CARD_LINGER_MS;
      })
      .sort(([, a], [, b]) => b.lastEventAt - a.lastEventAt)
      .slice(0, MAX_CARDS)
      .map(([key, session]) => WorkFollowCardSchema.parse({
        sessionId: session.sessionId,
        title: session.taskTitle,
        state: cardStateOf(key),
      }));
  };

  /** 最近一次事件 kind；无记录时按 active 兜底 running。 */
  const lastKindMap = new Map<string, WorkFollowEvent['kind']>();
  const lastKindOf = (key: string): WorkFollowEvent['kind'] | null => lastKindMap.get(key) ?? null;
  const cardStateOf = (key: string): WorkFollowCard['state'] => {
    const kind = lastKindMap.get(key);
    if (kind === 'error') return 'error';
    if (kind === 'asking') return 'asking';
    if (kind === 'stop') return 'done';
    return 'running';
  };

  const emitCards = (): void => {
    if (options.onCards === undefined) return;
    const characterIds = new Set([...sessions.values()].map((session) => session.characterId).filter((id) => id !== ''));
    for (const characterId of characterIds) {
      try {
        options.onCards(characterId, cardsFor(characterId));
      } catch { /* 单个角色异常不影响宿主 */ }
    }
  };

  const emitUpdate = (): void => {
    const next = status();
    options.onUpdate?.(next);
    emitCards();
    for (const listener of updateListeners) {
      try {
        listener(next);
      } catch {
        /* 单个订阅者异常不影响宿主 */
      }
    }
  };

  const keyOf = (event: WorkFollowEvent): string => `${event.source}:${event.sessionId}`;

  const ingest = (raw: unknown): { ok: boolean; error?: string } => {
    const parsed = WorkFollowEventSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? '非法事件' };
    const event = parsed.data;
    const at = event.ts > 0 ? event.ts : now();
    const key = keyOf(event);

    // T-M6-65：Hook 已覆盖的会话，5s 内 log-watch 重复事件直接忽略（不重复计工具数）
    if (event.origin === 'log-watch') {
      const lastHook = lastHookAt.get(event.sessionId) ?? 0;
      if (lastHook > 0 && at - lastHook < HOOK_DEDUPE_MS) return { ok: true };
    } else if (event.origin === 'hook') {
      lastHookAt.set(event.sessionId, at);
    }

    const proxy = options.resolveCharacter?.(event) ?? null;
    const characterId = proxy !== null && proxy !== '' ? proxy : characterForWorkFollow(event);
    origins.set(key, event.origin);
    lastKindMap.set(key, event.kind);

    if (event.kind === 'stop') {
      const existing = sessions.get(key);
      if (existing !== undefined) {
        existing.active = false;
        existing.lastEventAt = at;
        options.onAgentPose?.(existing, poseForWorkEvent({ kind: 'stop' }));
        options.onWorkActivity?.(existing, 'stop', event.origin);
      }
      recent.unshift({ source: event.source, kind: event.kind, toolName: event.toolName, at });
      recent.splice(MAX_RECENT);
      emitUpdate();
      return { ok: true };
    }

    let session = sessions.get(key);
    const isNewSession = session === undefined;
    if (session === undefined) {
      const created = WorkFollowSessionSchema.parse({
        source: event.source,
        sessionId: event.sessionId,
        characterId,
        startedAt: at,
        lastEventAt: at,
        taskTitle: event.taskTitle,
        modelName: event.modelName,
        active: true,
      });
      sessions.set(key, created);
      session = created;
      if (mode === 'multi' && characterId !== '') options.summon?.(characterId, event.source);
    }
    session.lastEventAt = at;
    session.active = true;
    if (event.taskTitle !== '') session.taskTitle = event.taskTitle;
    if (event.modelName !== '') session.modelName = event.modelName;

    if (mode === 'single' && characterId !== '' && (isNewSession || session.characterId !== characterId)) {
      // 单宠模式：start 与后续 tool 事件命中新角色都要换装（同一时间只显示一只）
      session.characterId = characterId;
      options.switchCharacter?.(characterId);
    }
    if (event.kind === 'tool') {
      session.toolCalls += 1;
      if (!session.crowned && session.toolCalls >= CROWN_TOOL_THRESHOLD) {
        session.crowned = true;
        options.onCrown?.(session);
      }
    }
    options.onAgentPose?.(session, poseForWorkEvent({ kind: event.kind, ...(event.toolName === '' ? {} : { toolName: event.toolName }) }));
    options.onWorkActivity?.(session, event.kind, event.origin);
    recent.unshift({ source: event.source, kind: event.kind, toolName: event.toolName, at });
    recent.splice(MAX_RECENT);
    emitUpdate();
    return { ok: true };
  };

  // ── 本机 CLI 钩子 JSONL 轮询（只读；坏行跳过；偏移量仅内存） ──
  let offset = 0;
  let carry = '';
  const pollMs = options.pollMs ?? 500;
  let timer: ReturnType<typeof setInterval> | null = null;
  const drain = (): void => {
    if (!existsSync(inboxPath)) return;
    const fd = openSync(inboxPath, 'r');
    try {
      const size = statSync(inboxPath).size;
      if (size < offset) { offset = 0; carry = ''; }
      if (size === offset) return;
      const buffer = Buffer.alloc(size - offset);
      readSync(fd, buffer, 0, buffer.length, offset);
      offset = size;
      const text = carry + buffer.toString('utf8');
      const lines = text.split('\n');
      carry = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed === '') continue;
        try {
          ingest(JSON.parse(trimmed) as unknown);
        } catch { /* 非 JSON 行忽略 */ }
      }
    } finally {
      closeSync(fd);
    }
  };
  if (pollMs > 0) timer = setInterval(drain, pollMs);
  mkdirSync(inboxDir, { recursive: true });

  // 闲置退场只对 idle-leave 生效：app-exit 必须等 stop；always-with-app 跟随前台应用
  const idleTimeoutMs = options.idleTimeoutMs ?? 60_000;
  const idleTimer = idleTimeoutMs > 0
    ? setInterval(() => {
      if (presencePolicy !== 'idle-leave') return;
      const at = now();
      let changed = false;
      for (const [key, session] of sessions) {
        if (!session.active) continue;
        if (at - session.lastEventAt < idleTimeoutMs) continue;
        session.active = false;
        lastKindMap.set(key, 'stop');
        changed = true;
        if (mode === 'multi') options.onSessionIdle?.(session);
      }
      if (changed) emitUpdate();
    }, 5_000)
    : null;

  const host: WorkFollowHost = {
    ingest,
    status,
    setMode(next) {
      mode = next;
      persistSettings();
      emitUpdate();
      return status();
    },
    mode: () => mode,
    setPresencePolicy(next) {
      presencePolicy = next;
      persistSettings();
      emitUpdate();
      return status();
    },
    presencePolicy: () => presencePolicy,
    setLogWatchEnabled(next) {
      logWatchEnabled = next;
      persistSettings();
      emitUpdate();
      return status();
    },
    logWatchEnabled: () => logWatchEnabled,
    cardsFor,
    selfTest() {
      const sessionId = `self-test-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const started = Date.now();
      mkdirSync(inboxDir, { recursive: true });
      return new Promise((resolve) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const finish = (ok: boolean, error?: string): void => {
          if (settled) return;
          settled = true;
          if (timer !== null) clearTimeout(timer);
          updateListeners.delete(listener);
          resolve({ ok, elapsedMs: Date.now() - started, ...(error === undefined ? {} : { error }) });
        };
        const listener = (next: WorkFollowStatus): void => {
          if (next.sessions.some((session) => session.sessionId === sessionId)) finish(true);
        };
        updateListeners.add(listener);
        timer = setTimeout(() => {
          finish(false, '1.5s 内未消费到测试事件（文件轮询或主进程未就绪）');
        }, 1_500);
        try {
          const event: WorkFollowEvent = {
            source: 'acp',
            sessionId,
            kind: 'start',
            toolName: 'self-test',
            modelName: '',
            taskTitle: '鲸屿连通性自检',
            ts: now(),
            origin: 'manual',
          };
          appendFileSync(inboxPath, `${JSON.stringify(event)}\n`, 'utf8');
        } catch (error) {
          finish(false, `写入测试事件失败：${error instanceof Error ? error.message : String(error)}`);
        }
      });
    },
    dispose() {
      if (timer !== null) clearInterval(timer);
      if (idleTimer !== null) clearInterval(idleTimer);
      timer = null;
    },
  };

  ipcMain.handle('work-follow:status', () => host.status());
  ipcMain.handle('work-follow:ingest', (_event, raw: unknown) => host.ingest(raw));
  ipcMain.handle('work-follow:mode', (_event, next: 'single' | 'multi') => host.setMode(next));
  ipcMain.handle('work-follow:presence-policy', (_event, next: WorkPresencePolicy) => host.setPresencePolicy(next));
  ipcMain.handle('work-follow:log-watch', (_event, enabled: boolean) => host.setLogWatchEnabled(Boolean(enabled)));
  ipcMain.handle('work-follow:self-test', () => host.selfTest());
  return host;
}
