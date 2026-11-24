/**
 * 免 Hook 零侵入本地 CLI 会话日志监听（T-M6-65，借鉴 agent-pet）。
 *
 * 严格只读：只按 `(path, inode, offset)` 增量读取新增字节，只提取
 * `sessionId / 事件类型 / toolName / modelName / timestamp`；
 * **绝不读取、持久化、上报或打印任何对话正文、用户提示、命令参数、代码或凭据**。
 *
 * 适配：
 *   - Claude Code：`<home>/.claude/projects/**\/*.jsonl`（message.content 只读 block.type/name）
 *   - Codex：`<home>/.codex/sessions/**\/*.jsonl`（payload.type/name/model）
 * 启动时把已有文件 offset 直接定位到末尾，绝不把历史当成正在干活；新文件从 0 读。
 */
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync, type Dirent } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { WorkFollowEvent } from '@workbench/shared-protocol';

const MAX_CHUNK_BYTES = 256 * 1024;
const DEFAULT_ACTIVE_WINDOW_MS = 10 * 60_000;

export interface CliLogWatcherOptions {
  /** 默认 os.homedir()；Windows 下同样是 %USERPROFILE% */
  homeDir?: string;
  /** 注入时钟（测试） */
  now?: () => number;
  /** 轮询间隔（默认 1500ms） */
  pollMs?: number;
  /** 只监听最近 N 分钟有更新的文件（默认 10 分钟） */
  activeWindowMs?: number;
  /** 开关（面板可关；关闭时 scan 直接跳过，不读盘） */
  enabled?: () => boolean;
  /** 只读事件（origin 固定 log-watch，由 work-follow 宿主做 Hook 5s 去重） */
  onEvent: (event: WorkFollowEvent) => void;
  /** 测试注入：只扫描指定根目录 */
  roots?: string[];
}

export interface CliLogWatcher {
  start(): void;
  stop(): void;
  /** 单次增量扫描；返回本次产生的事件数（测试/自检用） */
  scanOnce(): number;
  watchedFiles(): string[];
}

interface FileState {
  inode: number;
  offset: number;
  carry: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function timestampOf(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.trunc(value);
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return fallback;
}

function toolKind(name: string): 'tool' | 'asking' {
  return /ask|permission|confirm|request_user_input|approval/i.test(name) ? 'asking' : 'tool';
}

export interface ParsedLogLine {
  sessionId: string;
  events: Array<Pick<WorkFollowEvent, 'source' | 'sessionId' | 'kind' | 'toolName' | 'modelName' | 'ts' | 'origin'>>;
}

/** Claude Code JSONL 单行 → 只读事件（只碰 block.type/name，绝不读 text/input/arguments）。 */
export function parseClaudeJsonlLine(line: string, now: number): ParsedLogLine | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;
  const sessionId = asString(raw.sessionId);
  if (sessionId === '') return null;
  const events: ParsedLogLine['events'] = [];
  const ts = timestampOf(raw.timestamp, now);
  const message = isRecord(raw.message) ? raw.message : {};
  const modelName = asString(message.model) !== '' ? asString(message.model) : asString(raw.requestedModel);
  const type = asString(raw.type);
  const content = message.content;
  if (type === 'assistant' && Array.isArray(content)) {
    for (const block of content) {
      if (!isRecord(block) || asString(block.type) !== 'tool_use') continue;
      const name = asString(block.name);
      events.push({ source: 'claude', sessionId, kind: toolKind(name), toolName: name.slice(0, 120), modelName: modelName.slice(0, 120), ts, origin: 'log-watch' });
    }
    if (asString(message.stop_reason) === 'end_turn') {
      events.push({ source: 'claude', sessionId, kind: 'stop', toolName: '', modelName: modelName.slice(0, 120), ts, origin: 'log-watch' });
    }
  }
  // /compact 边界（有些版本写 system/subtype 或顶层 compact 标记）
  if ((type === 'system' && /compact/i.test(asString(raw.subtype))) || type === 'compact_boundary') {
    events.push({ source: 'claude', sessionId, kind: 'compact', toolName: '', modelName: modelName.slice(0, 120), ts, origin: 'log-watch' });
  }
  return { sessionId, events };
}

/** Codex rollout JSONL 单行 → 只读事件（只碰 payload.type/name/model）。 */
export function parseCodexJsonlLine(line: string, now: number, fallbackSessionId = ''): ParsedLogLine | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;
  const payload = isRecord(raw.payload) ? raw.payload : {};
  const sessionId = asString(payload.session_id) !== '' ? asString(payload.session_id) : asString(payload.id) !== '' ? asString(payload.id) : fallbackSessionId;
  if (sessionId === '') return null;
  const ts = timestampOf(raw.timestamp ?? payload.timestamp, now);
  const modelName = asString(payload.model);
  const type = asString(payload.type);
  const events: ParsedLogLine['events'] = [];
  const push = (kind: WorkFollowEvent['kind'], toolName = ''): void => {
    events.push({ source: 'codex', sessionId, kind, toolName: toolName.slice(0, 120), modelName: modelName.slice(0, 120), ts, origin: 'log-watch' });
  };
  if (type === 'task_started') push('start');
  else if (type === 'task_complete') push('stop');
  else if (type === 'function_call' || type === 'custom_tool_call') {
    const name = asString(payload.name);
    push(toolKind(name), name);
  }
  return { sessionId, events };
}

function listJsonl(root: string, activeSince: number, out: string[]): void {
  if (!existsSync(root)) return;
  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const absolute = join(root, entry.name);
    if (entry.isDirectory()) {
      listJsonl(absolute, activeSince, out);
      continue;
    }
    if (!entry.name.endsWith('.jsonl')) continue;
    try {
      if (statSync(absolute).mtimeMs >= activeSince) out.push(absolute);
    } catch { /* 竞态删除 */ }
  }
}

function sessionIdFromCodexPath(path: string): string {
  const match = /rollout-[^.]+-([0-9a-f-]{36})\.jsonl$/i.exec(path);
  return match?.[1] ?? '';
}

export function createCliLogWatcher(options: CliLogWatcherOptions): CliLogWatcher {
  const home = options.homeDir ?? homedir();
  const now = options.now ?? Date.now;
  const pollMs = options.pollMs ?? 1_500;
  const activeWindowMs = options.activeWindowMs ?? DEFAULT_ACTIVE_WINDOW_MS;
  const roots = options.roots ?? [join(home, '.claude', 'projects'), join(home, '.codex', 'sessions')];
  const files = new Map<string, FileState>();
  const startedSessions = new Set<string>();
  let primed = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const emit = (source: 'claude' | 'codex', parsed: ParsedLogLine): number => {
    let count = 0;
    if (!startedSessions.has(parsed.sessionId)) {
      startedSessions.add(parsed.sessionId);
      const first = parsed.events[0];
      options.onEvent({
        source,
        sessionId: parsed.sessionId,
        kind: 'start',
        toolName: '',
        modelName: first?.modelName ?? '',
        taskTitle: '',
        ts: first?.ts ?? now(),
        origin: 'log-watch',
      });
      count += 1;
    }
    for (const event of parsed.events) {
      options.onEvent(event as WorkFollowEvent);
      count += 1;
    }
    return count;
  };

  const readFile = (path: string, source: 'claude' | 'codex'): number => {
    let state = files.get(path);
    let stat;
    try {
      stat = statSync(path);
    } catch {
      files.delete(path);
      return 0;
    }
    if (state === undefined) {
      // 新出现的文件：从 0 读
      state = { inode: Number(stat.ino), offset: 0, carry: '' };
      files.set(path, state);
    } else if (state.inode !== Number(stat.ino) || stat.size < state.offset) {
      // 文件被轮转/截断：重置偏移，绝不重读历史之外的旧内容
      state.inode = Number(stat.ino);
      state.offset = 0;
      state.carry = '';
    }
    if (stat.size === state.offset) return 0;
    const length = Math.min(MAX_CHUNK_BYTES, stat.size - state.offset);
    const buffer = Buffer.alloc(length);
    const fd = openSync(path, 'r');
    try {
      readSync(fd, buffer, 0, length, state.offset);
    } finally {
      closeSync(fd);
    }
    state.offset += length;
    const text = state.carry + buffer.toString('utf8');
    const lines = text.split('\n');
    state.carry = lines.pop() ?? '';
    const fallbackSession = source === 'codex' ? sessionIdFromCodexPath(path) : '';
    let count = 0;
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      const parsed = source === 'claude' ? parseClaudeJsonlLine(trimmed, now()) : parseCodexJsonlLine(trimmed, now(), fallbackSession);
      if (parsed === null) continue;
      if (parsed.events.length === 0 && startedSessions.has(parsed.sessionId)) continue;
      count += emit(source, parsed);
    }
    return count;
  };

  const prime = (): void => {
    const activeSince = now() - activeWindowMs;
    const paths: string[] = [];
    for (const root of roots) listJsonl(root, activeSince, paths);
    for (const path of paths) {
      try {
        const stat = statSync(path);
        files.set(path, { inode: Number(stat.ino), offset: stat.size, carry: '' });
      } catch { /* 竞态删除 */ }
    }
    primed = true;
  };

  return {
    start() {
      if (!primed) prime();
      if (timer !== null) return;
      timer = setInterval(() => this.scanOnce(), pollMs);
      timer.unref?.();
    },
    stop() {
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
    scanOnce() {
      if (options.enabled !== undefined && !options.enabled()) return 0;
      if (!primed) prime();
      const activeSince = now() - activeWindowMs;
      const paths: string[] = [];
      for (const root of roots) listJsonl(root, activeSince, paths);
      let count = 0;
      for (const path of paths.slice(0, 40)) {
        const source = path.includes(`${join('.codex', 'sessions')}`) ? 'codex' : 'claude';
        count += readFile(path, source);
      }
      return count;
    },
    watchedFiles: () => [...files.keys()],
  };
}
