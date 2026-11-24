#!/usr/bin/env node
/**
 * 本机 AI CLI 只读钩子（T-M6-49）。
 *
 * 用法（在 Claude Code / Codex / DeepSeek Harness / Gemini / Cursor / Qwen / Kimi / Grok
 * 的 hook 配置里调用；只传事件名/工具名/模型名，**绝不传对话正文与凭据**）：
 *
 *   WB_WORK_FOLLOW_SOURCE=claude WB_WORK_FOLLOW_SESSION=$SESSION_ID \
 *   WB_WORK_FOLLOW_KIND=tool WB_WORK_FOLLOW_TOOL=Bash \
 *     node tools/hooks/work-follow-hook.mjs
 *
 * 事件以单行 JSON 追加到 `userData/work-follow/events.jsonl`（Whale Isle 主进程按偏移增量消费）。
 * `WB_WORK_FOLLOW_DIR` 可覆盖目录（默认与桌面端 userData 一致）。
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SOURCES = new Set(['acp', 'claude', 'codex', 'deepseek', 'gemini', 'cursor', 'qwen', 'kimi', 'grok']);
const KINDS = new Set(['start', 'tool', 'stop']);

const source = (process.env.WB_WORK_FOLLOW_SOURCE ?? '').trim();
const kind = (process.env.WB_WORK_FOLLOW_KIND ?? 'tool').trim();
const sessionId = (process.env.WB_WORK_FOLLOW_SESSION ?? process.env.CLAUDE_SESSION_ID ?? '').trim();
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
  toolName: (process.env.WB_WORK_FOLLOW_TOOL ?? '').slice(0, 120),
  modelName: (process.env.WB_WORK_FOLLOW_MODEL ?? '').slice(0, 120),
  taskTitle: (process.env.WB_WORK_FOLLOW_TASK ?? '').slice(0, 120),
  ts: Date.now(),
};
appendFileSync(join(dir, 'events.jsonl'), `${JSON.stringify(event)}\n`, 'utf8');
