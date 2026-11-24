#!/usr/bin/env node
/**
 * 本机 AI CLI 只读钩子（T-M6-49 / T-M6-58）。
 *
 * 双输入模式：
 *   ① 环境变量（手动模式）：WB_WORK_FOLLOW_SOURCE / _SESSION / _KIND / _TOOL / _MODEL；
 *   ② 标准 JSON 钩子（Claude Code / Gemini / Cursor 等把事件 JSON 从 stdin 传入）：
 *      自动识别 session_id、tool_name、hook_event_name、model，映射为 start/tool/stop。
 * 只传事件名/工具名/模型名，**绝不传对话正文与凭据**。
 *
 * 事件以单行 JSON 追加到 `userData/work-follow/events.jsonl`（Whale Isle 主进程按偏移增量消费）。
 * `WB_WORK_FOLLOW_DIR` 可覆盖目录（默认与桌面端 userData 一致）。
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SOURCES = new Set(['acp', 'claude', 'codex', 'deepseek', 'gemini', 'cursor', 'qwen', 'kimi', 'grok']);
const KINDS = new Set(['start', 'tool', 'stop', 'asking', 'compact', 'error']);

/** 非交互 stdin 读取（CLI 钩子会写一行 JSON；TTY 手动执行时跳过，避免卡住）。 */
function readStdinJson() {
  if (process.stdin.isTTY) return {};
  try {
    const raw = readFileSync(0, 'utf8').trim();
    if (raw === '') return {};
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

const stdin = readStdinJson();
const hookEvent = String(stdin.hook_event_name ?? stdin.hookEventName ?? stdin.event ?? '').toLowerCase();
// T-M6-64：PreCompact → compact；Notification/PermissionRequest → asking（只取事件名，绝不读正文）
const kindFromEvent = hookEvent.includes('precompact')
  ? 'compact'
  : hookEvent.includes('permission') || hookEvent.includes('notification')
    ? 'asking'
    : hookEvent.includes('pretool') || hookEvent.includes('beforetool') || hookEvent.includes('afterfileedit')
      ? 'tool'
      : hookEvent.includes('stop') || hookEvent.includes('afteragent')
        ? 'stop'
        : hookEvent.includes('error') || hookEvent.includes('failed')
          ? 'error'
          : hookEvent.includes('prompt') || hookEvent.includes('beforeagent') || hookEvent.includes('start')
            ? 'start'
            : '';

const source = (process.env.WB_WORK_FOLLOW_SOURCE ?? '').trim();
const kind = (process.env.WB_WORK_FOLLOW_KIND ?? kindFromEvent ?? 'tool').trim();
const sessionId = (
  process.env.WB_WORK_FOLLOW_SESSION
  ?? process.env.CLAUDE_SESSION_ID
  ?? String(stdin.session_id ?? stdin.sessionId ?? '')
).trim();
if (!SOURCES.has(source)) { console.error(`[work-follow-hook] 未知来源：${source || '(空)'}`); process.exit(2); }
if (!KINDS.has(kind)) { console.error(`[work-follow-hook] 未知 kind：${kind}`); process.exit(2); }
if (sessionId === '') { console.error('[work-follow-hook] 缺少会话 id（WB_WORK_FOLLOW_SESSION）'); process.exit(2); }

const defaultDir = process.platform === 'darwin'
  ? join(homedir(), 'Library', 'Application Support', 'Whale Isle', 'work-follow')
  : process.platform === 'win32'
    ? join(process.env.APPDATA ?? homedir(), 'Whale Isle', 'work-follow')
    : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'Whale Isle', 'work-follow');
const dir = process.env.WB_WORK_FOLLOW_DIR ?? defaultDir;
mkdirSync(dir, { recursive: true });

const event = {
  source,
  sessionId: sessionId.slice(0, 128),
  kind,
  toolName: (process.env.WB_WORK_FOLLOW_TOOL ?? String(stdin.tool_name ?? stdin.toolName ?? '')).slice(0, 120),
  modelName: (process.env.WB_WORK_FOLLOW_MODEL ?? String(stdin.model ?? stdin.model_name ?? '')).slice(0, 120),
  taskTitle: (process.env.WB_WORK_FOLLOW_TASK ?? '').slice(0, 120),
  ts: Date.now(),
};
appendFileSync(join(dir, 'events.jsonl'), `${JSON.stringify(event)}\n`, 'utf8');
