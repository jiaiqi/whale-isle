/**
 * 外部服务商配置只读导入器（T-M6-09，Magpie / CC Switch 思想重写）：
 * - 只读扫描 Magpie `providers.json`、CC Switch `cc-switch.db` / JSON 导出 / 旧版 config.json；
 * - 统一归一为「主进程内部候选」（含明文 Key），对外只允许 `toPreview` 的无 Key 预览；
 * - SQLite 一律走系统 `sqlite3 -readonly`（8s 超时），任何情况下都不写原文件；
 * - 所有失败路径只返回 `ok:false + 中文 error`，绝不抛出异常。
 *
 * 安全铁律：`ImportPreviewItem` 不含 apiKey；`JSON.stringify(items)` 不得出现明文 Key。
 * 本文件不 import electron / better-sqlite3，确保可在纯 Node（vitest）下单测。
 */

import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export type ImportProtocol = 'openai' | 'anthropic';
export type ImportSource = 'magpie' | 'ccswitch' | 'file';

/** 主进程内部候选（含明文 Key —— 绝不可直接下发渲染进程） */
export interface ImportCandidate {
  /** 稳定 id：命中内置时用内置 id；否则 `imported-<slug>-<n>` */
  id: string;
  name: string;
  protocol: ImportProtocol;
  baseUrl: string;
  /** 用户文件里显式给了完整端点时为 true */
  isFullUrl: boolean;
  models: string[];
  apiKey: string;
  source: ImportSource;
  /** 命中内置 id（deepseek-official / openai / anthropic / openrouter / siliconflow / volcano-ark / minimax / opencode-go / local-ollama） */
  matchedBuiltin: boolean;
}

/** 可安全下发渲染进程的预览项（无任何明文 Key） */
export interface ImportPreviewItem {
  id: string;
  name: string;
  protocol: ImportProtocol;
  baseUrl: string;
  models: string[];
  hasKey: boolean;
  keyMask: string;
  matchedBuiltin: boolean;
}

export interface ImportScanResult {
  ok: boolean;
  error?: string;
  source: ImportSource;
  /** 实际读取路径（找不到时为空串） */
  detectedPath: string;
  items: ImportPreviewItem[];
}

/** 内置 id 到展示名（导入项没写 name 时的兜底） */
const BUILTIN_DISPLAY_NAMES: Record<string, string> = {
  'deepseek-official': 'DeepSeek 官方',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  openrouter: 'OpenRouter',
  siliconflow: 'SiliconFlow 硅基流动',
  'volcano-ark': '火山方舟',
  minimax: 'MiniMax',
  'opencode-go': 'OpenCode Go',
  'local-ollama': '本地 Ollama',
};

const MAGPIE_DEFAULT_SUBPATH = ['.config', 'magpie', 'providers.json'];
const CCSWITCH_DIR = '.cc-switch';
const CCSWITCH_DB = 'cc-switch.db';
const SQLITE_TIMEOUT_MS = 8_000;

type JsonRecord = Record<string, unknown>;

interface ParsedOutcome {
  /** 根结构是否被识别为该格式（即使 0 行/0 候选） */
  recognized: boolean;
  rowCount: number;
  candidates: ImportCandidate[];
}

interface RawCandidate {
  idHint: string;
  name: string;
  protocol: ImportProtocol;
  baseUrl: string;
  isFullUrl: boolean;
  models: string[];
  apiKey: string;
  source: ImportSource;
}

// ============================================================================
// 通用小工具
// ============================================================================

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** 大小写不敏感地读取自有字段（容错 camelCase / snake_case / PascalCase） */
function ownValue(record: JsonRecord, key: string): unknown {
  if (Object.prototype.hasOwnProperty.call(record, key)) return record[key];
  const lowered = key.toLowerCase();
  for (const [candidateKey, value] of Object.entries(record)) {
    if (candidateKey.toLowerCase() === lowered) return value;
  }
  return undefined;
}

function pickValue(record: JsonRecord, aliases: string[]): unknown {
  for (const alias of aliases) {
    const value = ownValue(record, alias);
    if (value !== undefined) return value;
  }
  return undefined;
}

function pickString(record: JsonRecord, aliases: string[]): string {
  for (const alias of aliases) {
    const value = ownValue(record, alias);
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed !== '') return trimmed;
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value);
    }
  }
  return '';
}

function envString(value: unknown): string {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    // 未展开的模板（如 ${OPENAI_API_KEY}）不是真实凭据
    if (/^\$\{[^}]*\}$/.test(trimmed)) return '';
    return trimmed;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return String(value);
  return '';
}

/** JSON 字符串可能被双重编码：最多解两层 */
function decodeJson(value: unknown, rounds = 3): unknown {
  let current = value;
  for (let index = 0; index < rounds; index += 1) {
    if (typeof current !== 'string') break;
    const trimmed = current.trim();
    if (trimmed === '') return undefined;
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[') && !trimmed.startsWith('"')) break;
    try {
      current = JSON.parse(trimmed) as unknown;
    } catch {
      break;
    }
  }
  return current;
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (value === '' || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

/** string / comma-separated / string[] / {id}[] / id→配置 映射 都归一为 string[] */
function toStringList(value: unknown): string[] {
  const out: string[] = [];
  const push = (item: unknown): void => {
    if (typeof item === 'string') {
      for (const part of item.split(',')) {
        const trimmed = part.trim();
        if (trimmed !== '') out.push(trimmed);
      }
      return;
    }
    if (typeof item === 'number' && Number.isFinite(item)) {
      out.push(String(item));
      return;
    }
    if (isRecord(item)) {
      const id = pickString(item, ['id', 'model', 'name', 'value']);
      if (id !== '') out.push(id);
    }
  };

  if (Array.isArray(value)) {
    for (const item of value) push(item);
  } else if (isRecord(value)) {
    // 单个模型对象 { id }  vs 映射 { "model-id": {...} }
    if (pickString(value, ['id', 'model', 'name']) !== '') {
      push(value);
    } else {
      for (const key of Object.keys(value)) {
        const trimmed = key.trim();
        if (trimmed !== '') out.push(trimmed);
      }
    }
  } else {
    push(value);
  }
  return uniqueStrings(out);
}

function pickModels(record: JsonRecord, aliases: string[]): string[] {
  const out: string[] = [];
  for (const alias of aliases) {
    const value = ownValue(record, alias);
    if (value !== undefined) out.push(...toStringList(value));
  }
  return uniqueStrings(out);
}

function isTruthyFlag(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (typeof value === 'string') {
    const lowered = value.trim().toLowerCase();
    return lowered === 'true' || lowered === '1' || lowered === 'yes' || lowered === 'on';
  }
  return false;
}

function slugify(text: string): string {
  return text
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function slugFor(name: string, baseUrl: string): string {
  return slugify(name) || slugify(hostOf(baseUrl)) || 'provider';
}

function isMessagesEndpoint(rawUrl: string): boolean {
  return /\/messages\/?$/i.test(rawUrl.trim());
}

/** 完整端点 → 根地址；`.../chat/completions` 与 `.../messages` 视为完整端点 */
function stripEndpointSuffix(rawUrl: string): { baseUrl: string; isFullUrl: boolean } {
  const trimmed = rawUrl.trim().replace(/\/+$/, '');
  const lowered = trimmed.toLowerCase();
  for (const suffix of ['/chat/completions', '/messages']) {
    if (lowered.endsWith(suffix)) {
      const base = trimmed.slice(0, -suffix.length).replace(/\/+$/, '');
      return { baseUrl: base === '' ? trimmed : base, isFullUrl: true };
    }
  }
  return { baseUrl: trimmed, isFullUrl: false };
}

/** 掩码：≥12 显头尾 4 位，否则全掩；预览绝不携带明文 */
function maskKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed === '') return '';
  if (trimmed.length < 12) return '••••••••';
  return `${trimmed.slice(0, 4)}••••••••${trimmed.slice(-4)}`;
}

/**
 * 内置供应商匹配（保守）：
 *   ① baseUrl 主机等于内置官方域 → 命中（异地中转/自建域名绝不误判）；
 *   ② 名称或 id 与内置 id/展示名**完全相同**（归一化后）→ 命中（对应「同名服务商冲突策略」）。
 * 刻意不做关键字包含匹配：自定义「Fixture Anthropic」不能被误认成官方 Anthropic 而覆盖其 URL。
 */
const BUILTIN_HOSTS: Array<{ id: string; hosts: string[]; ports?: string[] }> = [
  { id: 'opencode-go', hosts: ['opencode.ai'] },
  { id: 'openrouter', hosts: ['openrouter.ai'] },
  { id: 'siliconflow', hosts: ['api.siliconflow.cn', 'siliconflow.cn'] },
  { id: 'deepseek-official', hosts: ['api.deepseek.com', 'deepseek.com'] },
  { id: 'minimax', hosts: ['api.minimaxi.com', 'api.minimax.chat', 'minimaxi.com'] },
  { id: 'volcano-ark', hosts: ['ark.cn-beijing.volces.com', 'volces.com', 'volcengine.com'] },
  { id: 'anthropic', hosts: ['api.anthropic.com'] },
  { id: 'openai', hosts: ['api.openai.com'] },
  { id: 'local-ollama', hosts: ['127.0.0.1', 'localhost'], ports: ['11434'] },
];

function normalizeToken(text: string): string {
  return text
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '')
    .trim();
}

function matchBuiltin(idRaw: string, nameRaw: string, baseUrl: string): string | null {
  let host = '';
  let port = '';
  try {
    const parsed = new URL(baseUrl);
    host = parsed.hostname.toLowerCase();
    port = parsed.port;
  } catch {
    /* 非法 URL 交给上层兜底 */
  }
  for (const entry of BUILTIN_HOSTS) {
    if (entry.hosts.some((h) => host === h || host.endsWith(`.${h}`))) {
      if (entry.ports === undefined || entry.ports.includes(port) || entry.ports.includes('')) return entry.id;
    }
  }
  const id = normalizeToken(idRaw);
  const name = normalizeToken(nameRaw);
  for (const [builtinId, display] of Object.entries(BUILTIN_DISPLAY_NAMES)) {
    if (id === normalizeToken(builtinId) || name === normalizeToken(display) || id === normalizeToken(display)) return builtinId;
  }
  return null;
}

/** 统一生成稳定 id / 兜底名称 / matchedBuiltin 标记 */
function finalizeCandidate(raw: RawCandidate, nextImportedSeq: () => number): ImportCandidate {
  const matched = matchBuiltin(raw.idHint, raw.name, raw.baseUrl);
  const matchedBuiltin = matched !== null;
  const id = matched ?? `imported-${slugFor(raw.name, raw.baseUrl)}-${nextImportedSeq()}`;
  const builtinName = matched === null ? '' : BUILTIN_DISPLAY_NAMES[matched] ?? matched;
  return {
    id,
    name: raw.name || builtinName || raw.idHint || id,
    protocol: raw.protocol,
    baseUrl: raw.baseUrl,
    isFullUrl: raw.isFullUrl,
    models: raw.models,
    apiKey: raw.apiKey,
    source: raw.source,
    matchedBuiltin,
  };
}

// ============================================================================
// Magpie：providers.json
// ============================================================================

function withFallbackId(record: JsonRecord, fallbackId: string): JsonRecord {
  if (pickString(record, ['id', 'providerId', 'provider_id', 'slug']) !== '') return record;
  return { ...record, id: fallbackId };
}

function magpieRows(raw: unknown): { recognized: boolean; rows: JsonRecord[] } {
  if (Array.isArray(raw)) {
    return { recognized: true, rows: raw.filter(isRecord) };
  }
  const root = isRecord(raw) ? raw : null;
  if (root === null) return { recognized: false, rows: [] };

  const providers = ownValue(root, 'providers');
  if (Array.isArray(providers)) {
    return { recognized: true, rows: providers.filter(isRecord) };
  }
  if (isRecord(providers)) {
    const rows: JsonRecord[] = [];
    for (const [key, value] of Object.entries(providers)) {
      if (isRecord(value)) rows.push(withFallbackId(value, key));
    }
    return { recognized: true, rows };
  }

  const data = ownValue(root, 'data');
  if (Array.isArray(data)) {
    return { recognized: true, rows: data.filter(isRecord) };
  }

  // 容错：整份文件就是单个供应商对象
  const looksSingle =
    pickString(root, ['baseUrl', 'base_url', 'url', 'endpoint', 'apiBase', 'api_base']) !== '' &&
    (pickString(root, ['name', 'displayName', 'key', 'api_key', 'apiKey']) !== '' ||
      pickString(root, ['protocol', 'type']) !== '');
  if (looksSingle) return { recognized: true, rows: [root] };

  return { recognized: false, rows: [] };
}

/** Magpie 也允许把 baseUrl/key 放在 config/settings 子对象里 */
function mergeMagpieProviderRecord(row: JsonRecord): JsonRecord {
  const merged: JsonRecord = { ...row };
  for (const key of ['config', 'settings', 'auth']) {
    const nested = decodeJson(ownValue(row, key));
    if (!isRecord(nested)) continue;
    for (const [nestedKey, value] of Object.entries(nested)) {
      if (ownValue(merged, nestedKey) === undefined) merged[nestedKey] = value;
    }
  }
  return merged;
}

function parseMagpieRaw(raw: unknown): ParsedOutcome {
  const { recognized, rows } = magpieRows(raw);
  const candidates: ImportCandidate[] = [];
  let importedSeq = 0;

  for (const row of rows) {
    const record = mergeMagpieProviderRecord(row);

    let rawUrl = pickString(record, [
      'baseUrl',
      'base_url',
      'baseURL',
      'url',
      'endpoint',
      'apiBase',
      'api_base',
    ]);
    const fullUrlValue = pickValue(record, ['isFullUrl', 'is_full_url', 'fullUrl', 'full_url']);
    let explicitFullUrl = false;
    if (typeof fullUrlValue === 'string' && /^https?:\/\//i.test(fullUrlValue.trim())) {
      rawUrl = fullUrlValue.trim();
      explicitFullUrl = true;
    } else if (isTruthyFlag(fullUrlValue)) {
      explicitFullUrl = true;
    }
    if (rawUrl === '') continue;

    const endpoint = stripEndpointSuffix(rawUrl);
    const idHint = pickString(record, ['id', 'providerId', 'provider_id', 'slug']);
    const name = pickString(record, ['name', 'displayName', 'display_name', 'title', 'label']);
    const protocolField = pickString(record, [
      'protocol',
      'type',
      'providerType',
      'provider_type',
      'apiType',
      'api_type',
    ]).toLowerCase();
    const protocol: ImportProtocol =
      protocolField !== ''
        ? protocolField.includes('anthropic') || protocolField.includes('claude')
          ? 'anthropic'
          : 'openai'
        : isMessagesEndpoint(rawUrl) || /anthropic|claude/i.test(rawUrl)
          ? 'anthropic'
          : 'openai';

    const candidate = finalizeCandidate(
      {
        idHint,
        name,
        protocol,
        baseUrl: endpoint.baseUrl,
        isFullUrl: explicitFullUrl || endpoint.isFullUrl,
        models: pickModels(record, ['models', 'model', 'modelList', 'model_list']),
        apiKey: pickString(record, [
          'key',
          'api_key',
          'apiKey',
          'token',
          'authToken',
          'auth_token',
          'apiToken',
          'api_token',
        ]),
        source: 'magpie',
      },
      () => {
        importedSeq += 1;
        return importedSeq;
      },
    );

    candidates.push(candidate);
  }

  return { recognized, rowCount: rows.length, candidates };
}

// ============================================================================
// CC Switch：SQLite / JSON
// ============================================================================

function isCcSwitchRow(record: JsonRecord): boolean {
  for (const alias of ['settings_config', 'settingsConfig', 'config', 'settings', 'env']) {
    if (ownValue(record, alias) !== undefined) return true;
  }
  return Object.keys(record).some((key) => /^(ANTHROPIC|OPENAI)_[A-Z0-9_]+$/.test(key.trim().toUpperCase()));
}

function collectCcSwitchRows(value: unknown, depth: number, out: JsonRecord[]): void {
  if (depth > 5) return;
  if (Array.isArray(value)) {
    for (const item of value) collectCcSwitchRows(item, depth + 1, out);
    return;
  }
  if (!isRecord(value)) return;
  if (isCcSwitchRow(value)) {
    out.push(value);
    return;
  }
  for (const child of Object.values(value)) collectCcSwitchRows(child, depth + 1, out);
}

function ccSwitchRows(raw: unknown): { recognized: boolean; rows: JsonRecord[] } {
  const root = isRecord(raw) ? raw : null;
  if (Array.isArray(raw)) {
    const rows: JsonRecord[] = [];
    collectCcSwitchRows(raw, 0, rows);
    return { recognized: rows.length > 0, rows };
  }
  if (root === null) return { recognized: false, rows: [] };

  for (const alias of ['providers', 'data']) {
    const container = ownValue(root, alias);
    if (container !== undefined) {
      const rows: JsonRecord[] = [];
      collectCcSwitchRows(container, 0, rows);
      return { recognized: Array.isArray(container) || isRecord(container), rows };
    }
  }

  const rows: JsonRecord[] = [];
  collectCcSwitchRows(root, 0, rows);
  return { recognized: rows.length > 0, rows };
}

/** 从 settings_config / config / env 等容器里递归收集 ANTHROPIC_* / OPENAI_* */
function extractEnvValues(row: JsonRecord): Record<string, string> {
  const out: Record<string, string> = {};
  const register = (key: string, value: unknown): void => {
    const normalized = key.trim().toUpperCase();
    if (!/^(ANTHROPIC|OPENAI)_[A-Z0-9_]+$/.test(normalized)) return;
    if (out[normalized] !== undefined) return;
    const text = envString(value);
    if (text !== '') out[normalized] = text;
  };

  const visit = (node: unknown, depth: number): void => {
    if (depth > 4) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    if (!isRecord(node)) return;
    for (const [key, value] of Object.entries(node)) {
      const upperKey = key.trim().toUpperCase();
      if (/^(ANTHROPIC|OPENAI)_[A-Z0-9_]+$/.test(upperKey)) {
        register(key, value);
        continue;
      }
      if (
        (upperKey === 'ENV' ||
          upperKey === 'SETTINGS' ||
          upperKey === 'CONFIG' ||
          upperKey === 'SETTINGSCONFIG' ||
          upperKey === 'SETTINGS_CONFIG') &&
        (isRecord(value) || typeof value === 'string')
      ) {
        visit(decodeJson(value), depth + 1);
      }
    }
  };

  for (const alias of ['settings_config', 'settingsConfig', 'config', 'settings', 'env']) {
    visit(decodeJson(ownValue(row, alias)), 0);
  }
  visit(row, 0);
  return out;
}

function firstEnv(env: Record<string, string>, keys: string[]): string {
  for (const key of keys) {
    const value = env[key];
    if (value !== undefined && value !== '') return value;
  }
  return '';
}

function modelsFromEnv(env: Record<string, string>): string[] {
  const out: string[] = [];
  const anth = env.ANTHROPIC_MODEL;
  if (anth !== undefined) out.push(...toStringList(anth));
  const openai = env.OPENAI_MODEL;
  if (openai !== undefined) out.push(...toStringList(openai));
  return uniqueStrings(out);
}

function ccSwitchModels(row: JsonRecord, env: Record<string, string>): string[] {
  const out = modelsFromEnv(env);
  out.push(...pickModels(row, ['models', 'model', 'modelList', 'model_list']));
  for (const alias of ['settings_config', 'settingsConfig', 'config', 'settings']) {
    const decoded = decodeJson(ownValue(row, alias));
    if (isRecord(decoded)) {
      out.push(...pickModels(decoded, ['models', 'model', 'modelList', 'model_list']));
    }
  }
  return uniqueStrings(out);
}

function ccSwitchDescriptor(row: JsonRecord): RawCandidate | null {
  const env = extractEnvValues(row);
  const anthropicBase = firstEnv(env, ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_URL', 'ANTHROPIC_ENDPOINT']);
  const anthropicKey = firstEnv(env, [
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_TOKEN',
  ]);
  const openaiBase = firstEnv(env, ['OPENAI_BASE_URL', 'OPENAI_API_BASE', 'OPENAI_ENDPOINT']);
  const openaiKey = firstEnv(env, ['OPENAI_API_KEY', 'OPENAI_AUTH_TOKEN', 'OPENAI_TOKEN']);

  // 有 ANTHROPIC_* → anthropic；否则 openai；两套都缺（或都无 baseUrl）→ 跳过该行
  let rawUrl = '';
  let protocol: ImportProtocol = 'openai';
  let apiKey = '';
  if (anthropicBase !== '') {
    rawUrl = anthropicBase;
    protocol = 'anthropic';
    apiKey = anthropicKey;
  } else if (openaiBase !== '') {
    rawUrl = openaiBase;
    protocol = 'openai';
    apiKey = openaiKey;
  }
  if (rawUrl === '') return null;

  const endpoint = stripEndpointSuffix(rawUrl);
  const idHint = pickString(row, ['id', 'provider_id', 'providerId', 'slug', 'uuid']);
  const name = pickString(row, [
    'name',
    'display_name',
    'displayName',
    'provider_name',
    'label',
  ]);

  return {
    idHint,
    name,
    protocol,
    baseUrl: endpoint.baseUrl,
    isFullUrl: endpoint.isFullUrl,
    models: ccSwitchModels(row, env),
    apiKey,
    source: 'ccswitch',
  };
}

function finishCcSwitch(rows: JsonRecord[], recognized: boolean): ParsedOutcome {
  const candidates: ImportCandidate[] = [];
  let importedSeq = 0;

  for (const row of rows) {
    const descriptor = ccSwitchDescriptor(row);
    if (descriptor === null) continue;
    const candidate = finalizeCandidate(descriptor, () => {
      importedSeq += 1;
      return importedSeq;
    });
    candidates.push(candidate);
  }

  return { recognized, rowCount: rows.length, candidates };
}

function parseCcSwitchRaw(raw: unknown): ParsedOutcome {
  const { recognized, rows } = ccSwitchRows(raw);
  return finishCcSwitch(rows, recognized);
}

// ============================================================================
// SQLite 只读读取（系统 sqlite3 CLI）
// ============================================================================

function hasSqliteHeader(filePath: string): boolean {
  let fd: number | null = null;
  try {
    fd = openSync(filePath, 'r');
    const buffer = Buffer.alloc(16);
    const bytes = readSync(fd, buffer, 0, 16, 0);
    return bytes === 16 && buffer.toString('utf8') === 'SQLite format 3\u0000';
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* 忽略关闭失败 */
      }
    }
  }
}

function looksLikeSqliteFile(filePath: string): boolean {
  if (/\.(db|sqlite|sqlite3)$/i.test(filePath)) return true;
  return hasSqliteHeader(filePath);
}

function sqliteFailureMessage(error: unknown): string {
  const fields = error as { code?: unknown; status?: unknown; stderr?: unknown; message?: unknown };
  const stderr =
    typeof fields.stderr === 'string'
      ? fields.stderr
      : Buffer.isBuffer(fields.stderr)
        ? fields.stderr.toString('utf8')
        : '';
  const message = typeof fields.message === 'string' ? fields.message : String(error);
  const detail = `${stderr} ${message}`;

  if (fields.code === 'ENOENT' || /ENOENT|not found|command not found/i.test(detail)) {
    return '系统缺少 sqlite3，可手动导出 JSON 后在「导入文件」里选择';
  }
  if (/no such table/i.test(detail)) {
    return 'CC Switch 数据库中没有 providers 表（确认文件是否为 cc-switch.db）';
  }
  if (/file is not a database|not a database/i.test(detail)) {
    return '不是有效的 SQLite 数据库（文件可能损坏，或并非 CC Switch 数据）';
  }
  if (/unable to open database/i.test(detail)) {
    return '无法打开 SQLite 数据库（文件可能不存在或无读取权限）';
  }
  if (fields.code === 'ETIMEDOUT' || /timed?\s?out/i.test(detail)) {
    return '读取 SQLite 超时（8s），数据库可能被占用，请先关闭 CC Switch 后重试';
  }
  return `读取 SQLite 失败：${(stderr.trim() || message).slice(0, 200)}`;
}

function readProvidersFromSqlite(dbPath: string): { rows?: JsonRecord[]; error?: string } {
  let stdout: string;
  try {
    // 只读铁律：`-readonly` + 仅 SELECT；绝不写原文件
    stdout = execFileSync('sqlite3', ['-readonly', '-json', dbPath, 'SELECT * FROM providers;'], {
      encoding: 'utf8',
      timeout: SQLITE_TIMEOUT_MS,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    return { error: sqliteFailureMessage(error) };
  }

  const trimmed = stripBom(stdout).trim();
  if (trimmed === '') return { rows: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    return { error: 'sqlite3 返回的 JSON 无法解析（providers 表结构可能异常）' };
  }
  if (!Array.isArray(parsed)) {
    return { error: 'sqlite3 返回的数据不是数组，无法识别 providers 表' };
  }
  return { rows: parsed.filter(isRecord) };
}

// ============================================================================
// 文件读取与格式嗅探
// ============================================================================

function readJsonFile(filePath: string): { value?: unknown; error?: string } {
  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (error) {
    return { error: `无法读取文件：${describeError(error)}` };
  }
  try {
    return { value: JSON.parse(stripBom(text)) };
  } catch (error) {
    return { error: `JSON 解析失败：${describeError(error)}` };
  }
}

function collectJsonRecords(value: unknown, depth: number, out: JsonRecord[]): void {
  if (depth > 4) return;
  if (Array.isArray(value)) {
    for (const item of value) collectJsonRecords(item, depth + 1, out);
    return;
  }
  if (!isRecord(value)) return;
  out.push(value);
  for (const child of Object.values(value)) collectJsonRecords(child, depth + 1, out);
}

function detectJsonFlavor(raw: unknown): 'magpie' | 'ccswitch' | 'unknown' {
  const nodes: JsonRecord[] = [];
  collectJsonRecords(raw, 0, nodes);

  if (nodes.some(isCcSwitchRow)) return 'ccswitch';

  const hasMagpieShape = nodes.some(
    (record) =>
      pickString(record, ['baseUrl', 'base_url', 'baseURL', 'url', 'endpoint', 'apiBase', 'api_base']) !== '' ||
      pickString(record, ['key', 'api_key', 'apiKey', 'token']) !== '',
  );
  if (hasMagpieShape) return 'magpie';

  const root = isRecord(raw) ? raw : null;
  if (root !== null && ownValue(root, 'providers') !== undefined) return 'magpie';
  if (Array.isArray(raw)) return 'magpie';
  return 'unknown';
}

function defaultMagpiePath(home: string): string {
  return join(home, ...MAGPIE_DEFAULT_SUBPATH);
}

function mtimeOf(filePath: string): number {
  try {
    return statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

/** 默认 CC Switch 数据源候选：db → 旧版 config.json → JSON 导出备份（backups 里最新优先） */
function defaultCcSwitchCandidates(home: string): string[] {
  const dir = join(home, CCSWITCH_DIR);
  const paths = [
    join(dir, CCSWITCH_DB),
    join(dir, 'config.json'),
    join(dir, 'cc-switch.json'),
    join(dir, 'providers.json'),
  ];
  try {
    const backupDir = join(dir, 'backups');
    if (existsSync(backupDir) && statSync(backupDir).isDirectory()) {
      const backups = readdirSync(backupDir)
        .filter((name) => name.toLowerCase().endsWith('.json'))
        .map((name) => join(backupDir, name))
        .sort((left, right) => mtimeOf(right) - mtimeOf(left));
      paths.push(...backups.slice(0, 5));
    }
  } catch {
    /* 备份目录不可读不影响主路径 */
  }
  return paths;
}

function scanOk(source: ImportSource, detectedPath: string, candidates: ImportCandidate[]): ImportScanResult {
  return {
    ok: true,
    source,
    detectedPath,
    items: candidates.map(toPreview),
  };
}

function scanError(source: ImportSource, detectedPath: string, error: string): ImportScanResult {
  return { ok: false, error, source, detectedPath, items: [] };
}

/** 内部扫描结果：对外的预览 result + 绝不跨 IPC 的明文候选（失败时候选为空） */
interface ScanDetail {
  result: ImportScanResult;
  candidates: ImportCandidate[];
}

function scanOkDetail(
  source: ImportSource,
  detectedPath: string,
  candidates: ImportCandidate[],
): ScanDetail {
  return { result: scanOk(source, detectedPath, candidates), candidates };
}

function scanErrorDetail(source: ImportSource, detectedPath: string, error: string): ScanDetail {
  return { result: scanError(source, detectedPath, error), candidates: [] };
}

// ============================================================================
// 对外 API
// ============================================================================

/** 可安全下发渲染进程的预览（不含 apiKey；短 Key 全掩码） */
export function toPreview(candidate: ImportCandidate): ImportPreviewItem {
  const apiKey = candidate.apiKey.trim();
  return {
    id: candidate.id,
    name: candidate.name,
    protocol: candidate.protocol,
    baseUrl: candidate.baseUrl,
    models: [...candidate.models],
    hasKey: apiKey !== '',
    keyMask: maskKey(apiKey),
    matchedBuiltin: candidate.matchedBuiltin,
  };
}

/** Magpie `~/.config/magpie/providers.json`（或显式文件）只读扫描 */
function scanMagpieDetail(filePath?: string, homeDir?: string): ScanDetail {
  const home = homeDir !== undefined && homeDir.trim() !== '' ? homeDir : homedir();
  const explicit = filePath !== undefined && filePath.trim() !== '';
  const target = explicit ? resolve(filePath.trim()) : defaultMagpiePath(home);

  try {
    if (!existsSync(target)) {
      return scanErrorDetail(
        'magpie',
        '',
        explicit ? `未找到 Magpie 配置文件：${target}` : `未找到 Magpie 配置文件（默认 ${target}）`,
      );
    }

    const json = readJsonFile(target);
    if (json.error !== undefined) return scanErrorDetail('magpie', target, `Magpie ${json.error}`);

    const outcome = parseMagpieRaw(json.value);
    if (!outcome.recognized) {
      return scanErrorDetail(
        'magpie',
        target,
        '不是有效的 Magpie 配置（需为供应商数组、{providers:[...]}、{providers:{id:{...}}} 或单个供应商对象）',
      );
    }
    if (outcome.rowCount > 0 && outcome.candidates.length === 0) {
      return scanErrorDetail('magpie', target, '未从 Magpie 配置中解析到可用供应商（缺少 baseUrl 等字段）');
    }
    return scanOkDetail('magpie', target, outcome.candidates);
  } catch (error) {
    return scanErrorDetail('magpie', target, `Magpie 读取失败：${describeError(error)}`);
  }
}

/** Magpie 只读扫描（对外仅返回可下发预览） */
export function scanMagpie(filePath?: string, homeDir?: string): ImportScanResult {
  return scanMagpieDetail(filePath, homeDir).result;
}

/** 读取单个 CC Switch 文件（已确认存在）——db 走 sqlite3，其余按 JSON */
function scanCcSwitchAt(target: string): ScanDetail {
  if (looksLikeSqliteFile(target)) {
    const read = readProvidersFromSqlite(target);
    if (read.error !== undefined) return scanErrorDetail('ccswitch', target, read.error);
    const outcome = finishCcSwitch(read.rows ?? [], true);
    if (outcome.rowCount > 0 && outcome.candidates.length === 0) {
      return scanErrorDetail(
        'ccswitch',
        target,
        '未从 CC Switch 数据库解析到可用供应商（每行需含 ANTHROPIC_* 或 OPENAI_* 的 baseUrl/Key）',
      );
    }
    return scanOkDetail('ccswitch', target, outcome.candidates);
  }

  const json = readJsonFile(target);
  if (json.error !== undefined) return scanErrorDetail('ccswitch', target, `CC Switch ${json.error}`);
  const outcome = parseCcSwitchRaw(json.value);
  if (!outcome.recognized) {
    return scanErrorDetail('ccswitch', target, '不是有效的 CC Switch 数据（未找到 providers 列表或供应商配置）');
  }
  if (outcome.rowCount > 0 && outcome.candidates.length === 0) {
    return scanErrorDetail(
      'ccswitch',
      target,
      '未从 CC Switch 数据解析到可用供应商（每行需含 ANTHROPIC_* 或 OPENAI_* 的 baseUrl/Key）',
    );
  }
  return scanOkDetail('ccswitch', target, outcome.candidates);
}

/** CC Switch 只读扫描：`.db` / JSON 导出备份 / 旧版 config.json */
function scanCcSwitchDetail(filePath?: string, homeDir?: string): ScanDetail {
  const home = homeDir !== undefined && homeDir.trim() !== '' ? homeDir : homedir();
  const explicit = filePath !== undefined && filePath.trim() !== '';
  let detectedPath = '';

  try {
    if (explicit) {
      const target = resolve(filePath.trim());
      detectedPath = target;
      if (!existsSync(target)) {
        return scanErrorDetail('ccswitch', '', `未找到 CC Switch 数据：${target}`);
      }
      return scanCcSwitchAt(target);
    }

    const candidates = defaultCcSwitchCandidates(home);
    const target = candidates.find((candidate) => existsSync(candidate));
    if (target === undefined) {
      return scanErrorDetail(
        'ccswitch',
        '',
        `未找到 CC Switch 数据（默认 ${join(home, CCSWITCH_DIR, CCSWITCH_DB)}）`,
      );
    }
    detectedPath = target;
    return scanCcSwitchAt(target);
  } catch (error) {
    return scanErrorDetail('ccswitch', detectedPath, `CC Switch 读取失败：${describeError(error)}`);
  }
}

/** CC Switch 只读扫描（对外仅返回可下发预览） */
export function scanCcSwitch(filePath?: string, homeDir?: string): ImportScanResult {
  return scanCcSwitchDetail(filePath, homeDir).result;
}

/** 自动嗅探：SQLite 头 → CC Switch db；JSON → Magpie / CC Switch 二选一 */
function scanImportFileDetail(filePath: string): ScanDetail {
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    return scanErrorDetail('file', '', '未指定导入文件路径');
  }
  const target = resolve(filePath.trim());
  if (!existsSync(target)) return scanErrorDetail('file', '', `未找到导入文件：${target}`);

  try {
    // SQLite 头或 .db/.sqlite/.sqlite3 扩展名 → CC Switch 数据库
    if (looksLikeSqliteFile(target)) return scanCcSwitchAt(target);

    const json = readJsonFile(target);
    if (json.error !== undefined) return scanErrorDetail('file', target, json.error);

    const flavor = detectJsonFlavor(json.value);
    const magpie = parseMagpieRaw(json.value);
    const ccswitch = parseCcSwitchRaw(json.value);
    const ordered: Array<{ source: 'magpie' | 'ccswitch'; outcome: ParsedOutcome }> =
      flavor === 'ccswitch'
        ? [
            { source: 'ccswitch', outcome: ccswitch },
            { source: 'magpie', outcome: magpie },
          ]
        : [
            { source: 'magpie', outcome: magpie },
            { source: 'ccswitch', outcome: ccswitch },
          ];

    for (const entry of ordered) {
      if (entry.outcome.candidates.length > 0) {
        return scanOkDetail(entry.source, target, entry.outcome.candidates);
      }
    }

    const primary = ordered[0];
    if (primary !== undefined && primary.outcome.recognized) {
      if (primary.outcome.rowCount === 0) return scanOkDetail(primary.source, target, []);
      return scanErrorDetail(
        primary.source,
        target,
        '已识别导入文件格式，但未解析到可用供应商（检查 baseUrl 与 API Key 字段）',
      );
    }
    return scanErrorDetail(
      'file',
      target,
      '无法识别的导入文件（既不是 Magpie providers.json，也不是 CC Switch 导出/数据库）',
    );
  } catch (error) {
    return scanErrorDetail('file', target, `导入读取失败：${describeError(error)}`);
  }
}

/** 自动嗅探导入文件（对外仅返回可下发预览） */
export function scanImportFile(filePath: string): ImportScanResult {
  return scanImportFileDetail(filePath).result;
}

/**
 * 主进程内部使用：返回扫描结果（可下发预览）+ 含明文 Key 的内部候选（绝不跨 IPC）。
 * 成功时 candidates 与 result.items 一一对应、同顺序；失败时 candidates 为空。
 */
export function collectImportCandidates(
  source: ImportSource,
  filePath?: string,
  homeDir?: string,
): { result: ImportScanResult; candidates: ImportCandidate[] } {
  try {
    if (source === 'magpie') {
      const detail = scanMagpieDetail(filePath, homeDir);
      return { result: detail.result, candidates: detail.result.ok ? detail.candidates : [] };
    }
    if (source === 'ccswitch') {
      const detail = scanCcSwitchDetail(filePath, homeDir);
      return { result: detail.result, candidates: detail.result.ok ? detail.candidates : [] };
    }
    if (source === 'file') {
      if (typeof filePath !== 'string' || filePath.trim() === '') {
        return {
          result: scanError('file', '', '未指定导入文件路径'),
          candidates: [],
        };
      }
      const detail = scanImportFileDetail(filePath);
      return { result: detail.result, candidates: detail.result.ok ? detail.candidates : [] };
    }
    return {
      result: scanError('file', '', `未知导入来源：${String(source)}`),
      candidates: [],
    };
  } catch (error) {
    return {
      result: scanError(source, '', `导入失败：${describeError(error)}`),
      candidates: [],
    };
  }
}

/**
 * 冲突计划（纯函数）：
 * - 目标 id 不存在 → create；
 * - 已存在（无论是否已存 Key，existingKeys 的 boolean 仅作状态提示）→ policy=overwrite 则 update，否则 skip；
 * - policy 非法/缺省一律按 skip（安全优先），绝不因缺 Key 而 create 出重复 id。
 */
export function planImport(
  candidates: ImportCandidate[],
  options: { policy: 'skip' | 'overwrite'; existingKeys: Record<string, boolean> },
): Array<{ candidate: ImportCandidate; action: 'create' | 'update' | 'skip' }> {
  const overwrite = options.policy === 'overwrite';
  return candidates.map((candidate) => {
    const known = Object.prototype.hasOwnProperty.call(options.existingKeys, candidate.id);
    if (!known) return { candidate, action: 'create' as const };
    // 已有条目但没有凭据：无论 skip/overwrite 都应补全元数据（设计稿 confirmImport 语义）
    if (overwrite || options.existingKeys[candidate.id] !== true) return { candidate, action: 'update' as const };
    return { candidate, action: 'skip' as const };
  });
}
