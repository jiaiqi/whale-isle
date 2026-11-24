/**
 * 跨 AI 工作跟随（T-M6-49，对齐 CrossPet follow-policy + T-M5-07）。
 *
 * 只读事件：source（acp/claude/codex/deepseek/gemini/cursor/qwen/kimi/grok）、sessionId、
 * kind（start/tool/stop）、toolName/modelName/taskTitle；**绝不接收对话正文与凭据**。
 *
 * 两种策略：
 *   - single：同一只主桌宠随当前活跃 AI 自动换装（切角色，不新增窗口）；
 *   - multi：每个 AI 各来一只（按 source 映射 CrossPet 角色，最多 3 只同时展示）；
 * 大活判定：单会话工具调用 ≥ 8 → 自动戴小皇冠（`pet:crown` 叠加）。
 *
 * 事件来源两条腿：
 *   ① agent-harness（ACP）事件在 main 侧直接 ingest；
 *   ② 本机 CLI 钩子把 JSONL 追加到 `userData/work-follow/events.jsonl`（tools/hooks/work-follow-hook.mjs），
 *      本宿主按文件偏移轮询消费，解析失败的行跳过，不阻塞。
 */
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ipcMain } from 'electron';
import { poseForWorkEvent } from './pose-resolver';
import {
  WorkFollowEventSchema,
  WorkFollowSessionSchema,
  WorkFollowStatusSchema,
  type WorkFollowEvent,
  type WorkFollowSession,
  type WorkFollowStatus,
} from '@workbench/shared-protocol';

export const CROWN_TOOL_THRESHOLD = 8;
const MAX_SESSIONS = 8;
const MAX_RECENT = 20;

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

export interface WorkFollowHost {
  ingest(raw: unknown): { ok: boolean; error?: string };
  status(): WorkFollowStatus;
  setMode(mode: 'single' | 'multi'): WorkFollowStatus;
  mode(): 'single' | 'multi';
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
  const recent: WorkFollowStatus['recent'] = [];
  const updateListeners = new Set<(status: WorkFollowStatus) => void>();
  let mode: 'single' | 'multi' = 'multi';

  try {
    if (existsSync(settingsPath)) {
      const parsed = JSON.parse(readFileSync(settingsPath, 'utf8')) as { mode?: unknown };
      if (parsed.mode === 'single' || parsed.mode === 'multi') mode = parsed.mode;
    }
  } catch { /* 坏配置 → 默认 multi */ }

  const persistMode = (): void => {
    try {
      mkdirSync(dirname(settingsPath), { recursive: true });
      writeFileSync(settingsPath, `${JSON.stringify({ mode }, null, 2)}\n`, 'utf8');
    } catch { /* 只影响下次启动的默认值 */ }
  };

  const status = (): WorkFollowStatus => WorkFollowStatusSchema.parse({
    mode,
    sessions: [...sessions.values()].sort((a, b) => b.lastEventAt - a.lastEventAt).slice(0, MAX_SESSIONS),
    recent,
  });

  const emitUpdate = (): void => {
    const next = status();
    options.onUpdate?.(next);
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
    const proxy = options.resolveCharacter?.(event) ?? null;
    const characterId = proxy !== null && proxy !== '' ? proxy : characterForWorkFollow(event);

    if (event.kind === 'stop') {
      const existing = sessions.get(key);
      if (existing !== undefined) {
        existing.active = false;
        existing.lastEventAt = at;
        options.onAgentPose?.(existing, poseForWorkEvent({ kind: 'stop' }));
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

  // multi 模式闲置退场：60s 没有新事件 → active=false 并回调（main 关闭对应窗口）
  const idleTimeoutMs = options.idleTimeoutMs ?? 60_000;
  const idleTimer = idleTimeoutMs > 0
    ? setInterval(() => {
      const at = now();
      let changed = false;
      for (const session of sessions.values()) {
        if (!session.active) continue;
        if (at - session.lastEventAt < idleTimeoutMs) continue;
        session.active = false;
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
      persistMode();
      emitUpdate();
      return status();
    },
    mode: () => mode,
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
  ipcMain.handle('work-follow:self-test', () => host.selfTest());
  return host;
}
