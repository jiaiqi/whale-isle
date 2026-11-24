/**
 * 冷启动只读历史补录（T-M6-65）。
 *
 * 扫描本机 `~/.claude/projects/**\/*.jsonl` 与 `~/.codex/sessions/**\/*.jsonl`，
 * **严格只读统计**：只抽取 timestamp、model、`tool_use` / `function_call` 计数，
 * 绝不读取、存储或打印任何对话正文、用户提示、命令参数、代码或凭据。
 *
 * 幂等：结果写 `userData/friendship/backfill-marker.json`；再次调用直接返回已补录结果。
 */
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync, type Dirent } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';

export interface BackfillMarker {
  version: 1;
  scannedFiles: number;
  rounds: number;
  busiestDate: string;
  byFamily: Record<string, number>;
  completedAt: string;
}

export interface BackfillResult {
  ok: true;
  already: boolean;
  scannedFiles: number;
  rounds: number;
  busiestDate: string;
  byFamily: Record<string, number>;
  markerPath: string;
}

export interface BackfillOptions {
  userDataDir: string;
  homeDir?: string;
  roots?: string[];
  now?: () => number;
  /** 单文件超过该大小跳过（默认 64MB），避免误读超大日志 */
  maxFileBytes?: number;
  /** 扫描文件上限（默认 500） */
  maxFiles?: number;
}

const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 500;

/** 模型名 → CrossPet 家族（与工作跟随映射一致；无法识别归 unknown）。 */
export function familyOfModel(model: string): string {
  const value = model.toLowerCase();
  if (/claude/.test(value)) return 'claude';
  if (/gpt|codex|openai/.test(value)) return 'gpt';
  if (/gemini/.test(value)) return 'gemini';
  if (/deepseek/.test(value)) return 'deepseek';
  if (/qwen|tongyi|千问/.test(value)) return 'qwen';
  if (/kimi|moonshot/.test(value)) return 'kimi';
  if (/glm|chatglm|zhipu/.test(value)) return 'glm';
  if (/grok|xai/.test(value)) return 'grok';
  return 'unknown';
}

export function backfillMarkerPath(userDataDir: string): string {
  return join(userDataDir, 'friendship', 'backfill-marker.json');
}

function readMarker(path: string): BackfillMarker | null {
  try {
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<BackfillMarker>;
    if (parsed.version !== 1 || typeof parsed.scannedFiles !== 'number' || typeof parsed.rounds !== 'number') return null;
    return {
      version: 1,
      scannedFiles: parsed.scannedFiles,
      rounds: parsed.rounds,
      busiestDate: typeof parsed.busiestDate === 'string' ? parsed.busiestDate : '',
      byFamily: typeof parsed.byFamily === 'object' && parsed.byFamily !== null ? parsed.byFamily : {},
      completedAt: typeof parsed.completedAt === 'string' ? parsed.completedAt : '',
    };
  } catch {
    return null;
  }
}

function listJsonl(root: string, out: string[], maxFiles: number): void {
  if (out.length >= maxFiles || !existsSync(root)) return;
  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= maxFiles) return;
    const absolute = join(root, entry.name);
    if (entry.isDirectory()) listJsonl(absolute, out, maxFiles);
    else if (entry.name.endsWith('.jsonl')) out.push(absolute);
  }
}

function localYmd(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function modelOf(record: Record<string, unknown>): string {
  const message = typeof record.message === 'object' && record.message !== null ? record.message as Record<string, unknown> : {};
  if (typeof message.model === 'string') return message.model;
  if (typeof record.requestedModel === 'string') return record.requestedModel;
  const payload = typeof record.payload === 'object' && record.payload !== null ? record.payload as Record<string, unknown> : {};
  if (typeof payload.model === 'string') return payload.model;
  return '';
}

/**
 * 统计单行：返回 {model, tools, ts}。只读 type/name/model/timestamp，绝不读取正文。
 * Claude：message.content[].type==='tool_use'；Codex：payload.type==='function_call'|'custom_tool_call'。
 */
export function countToolsInLine(line: string): { model: string; tools: number; ts: number | null } | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const model = modelOf(record);
  const payload = typeof record.payload === 'object' && record.payload !== null ? record.payload as Record<string, unknown> : {};
  const rawTs = record.timestamp ?? payload.timestamp;
  const ts = typeof rawTs === 'number' && Number.isFinite(rawTs)
    ? rawTs
    : typeof rawTs === 'string' && !Number.isNaN(Date.parse(rawTs))
      ? Date.parse(rawTs)
      : null;
  let tools = 0;
  const message = typeof record.message === 'object' && record.message !== null ? record.message as Record<string, unknown> : {};
  if (Array.isArray(message.content)) {
    for (const block of message.content) {
      if (typeof block !== 'object' || block === null) continue;
      if ((block as Record<string, unknown>).type === 'tool_use') tools += 1;
    }
  }
  if (payload.type === 'function_call' || payload.type === 'custom_tool_call') tools += 1;
  return { model, tools, ts };
}

async function scanFile(path: string, now: number): Promise<{ rounds: number; byFamily: Record<string, number>; byDate: Record<string, number> }> {
  const result = { rounds: 0, byFamily: {} as Record<string, number>, byDate: {} as Record<string, number> };
  let fallbackDate = now;
  try {
    fallbackDate = statSync(path).mtimeMs;
  } catch {
    return result;
  }
  const stream = createReadStream(path, { encoding: 'utf8' });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of reader) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      const counted = countToolsInLine(trimmed);
      if (counted === null || counted.tools === 0) continue;
      result.rounds += counted.tools;
      const family = familyOfModel(counted.model);
      result.byFamily[family] = (result.byFamily[family] ?? 0) + counted.tools;
      const day = localYmd(counted.ts ?? fallbackDate);
      result.byDate[day] = (result.byDate[day] ?? 0) + counted.tools;
    }
  } finally {
    reader.close();
    stream.close();
  }
  return result;
}

/**
 * 执行（或读取已完成的）历史补录。幂等：标记存在时不重新扫描。
 * 返回真实扫描文件数与补录轮数，绝不伪造。
 */
export async function backfillCliHistory(options: BackfillOptions): Promise<BackfillResult> {
  const home = options.homeDir ?? homedir();
  const markerPath = backfillMarkerPath(options.userDataDir);
  const existing = readMarker(markerPath);
  if (existing !== null) {
    return {
      ok: true,
      already: true,
      scannedFiles: existing.scannedFiles,
      rounds: existing.rounds,
      busiestDate: existing.busiestDate,
      byFamily: existing.byFamily,
      markerPath,
    };
  }
  const now = (options.now ?? Date.now)();
  const roots = options.roots ?? [join(home, '.claude', 'projects'), join(home, '.codex', 'sessions')];
  const maxFiles = options.maxFiles ?? MAX_FILES;
  const maxFileBytes = options.maxFileBytes ?? MAX_FILE_BYTES;
  const files: string[] = [];
  for (const root of roots) listJsonl(root, files, maxFiles);

  let scannedFiles = 0;
  let rounds = 0;
  const byFamily: Record<string, number> = {};
  const byDate: Record<string, number> = {};
  for (const path of files) {
    try {
      if (statSync(path).size > maxFileBytes) continue;
    } catch {
      continue;
    }
    try {
      const scanned = await scanFile(path, now);
      scannedFiles += 1;
      rounds += scanned.rounds;
      for (const [family, count] of Object.entries(scanned.byFamily)) byFamily[family] = (byFamily[family] ?? 0) + count;
      for (const [day, count] of Object.entries(scanned.byDate)) byDate[day] = (byDate[day] ?? 0) + count;
    } catch {
      /* 单文件坏/权限问题跳过，不影响其他 */
    }
  }
  const busiestDate = Object.entries(byDate).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? '';
  const marker: BackfillMarker = {
    version: 1,
    scannedFiles,
    rounds,
    busiestDate,
    byFamily,
    completedAt: new Date(now).toISOString(),
  };
  mkdirSync(dirname(markerPath), { recursive: true });
  const temp = `${markerPath}.tmp`;
  writeFileSync(temp, `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
  renameSync(temp, markerPath);
  return { ok: true, already: false, scannedFiles, rounds, busiestDate, byFamily, markerPath };
}
