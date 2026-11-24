/**
 * 8 家本机 AI CLI 的工作跟随钩子安装引擎（T-M6-58）。
 *
 * 安全铁律：
 *   - 只碰 `homeDir` 下**已知**配置文件（claude/gemini/cursor 三个标准 JSON 钩子文件），
 *     其余 5 家诚实标注「手动命令模式」，绝不乱改未知格式；
 *   - 修改前先备份 `<file>.whale-isle.bak`；坏 JSON 直接拒绝，绝不覆盖；
 *   - 幂等合并（按命令行里的 WB_WORK_FOLLOW_SOURCE 标记识别鲸屿条目），
 *     卸载只移除自己的条目，完整保留用户原有钩子；
 *   - 钩子脚本同步到 `userData/work-follow/hook.mjs`，打包态/源码态都能跑。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

export type WorkFollowSource = 'claude' | 'codex' | 'deepseek' | 'gemini' | 'cursor' | 'qwen' | 'kimi' | 'grok';

export interface CliHookStrategy {
  source: WorkFollowSource;
  label: string;
  /** home 下用于探测「是否安装了该 CLI」的配置目录（相对路径） */
  detectPath: string;
  mode: 'json' | 'manual';
  /** 标准 JSON 钩子文件（相对 home）；manual 模式为 undefined */
  configPath?: string;
  /** 需要合并的事件名（顺序固定，便于幂等；显式携带 start/tool/stop 避免依赖各家私有 stdin 字段） */
  events?: ReadonlyArray<{ name: string; kind: 'start' | 'tool' | 'stop'; matcher?: string }>;
  manualHint: string;
}

export const CLI_STRATEGIES: readonly CliHookStrategy[] = [
  {
    source: 'claude', label: 'Claude Code', detectPath: '.claude', mode: 'json',
    configPath: '.claude/settings.json',
    events: [
      { name: 'UserPromptSubmit', kind: 'start' },
      { name: 'PreToolUse', kind: 'tool', matcher: '*' },
      { name: 'Stop', kind: 'stop' },
    ],
    manualHint: '在 ~/.claude/settings.json 的 hooks 中写入下列命令（start/tool/stop 三个事件）',
  },
  {
    source: 'gemini', label: 'Gemini CLI', detectPath: '.gemini', mode: 'json',
    configPath: '.gemini/settings.json',
    events: [
      { name: 'BeforeAgent', kind: 'start' },
      { name: 'BeforeTool', kind: 'tool', matcher: '*' },
      { name: 'AfterAgent', kind: 'stop' },
    ],
    manualHint: '在 ~/.gemini/settings.json 的 hooks 中写入下列命令（BeforeAgent/BeforeTool/AfterAgent）',
  },
  {
    source: 'cursor', label: 'Cursor', detectPath: '.cursor', mode: 'json',
    configPath: '.cursor/hooks.json',
    events: [
      { name: 'beforeSubmitPrompt', kind: 'start' },
      { name: 'beforeShellExecution', kind: 'tool' },
      { name: 'stop', kind: 'stop' },
    ],
    manualHint: '在 ~/.cursor/hooks.json 中写入下列命令（beforeSubmitPrompt/beforeShellExecution/stop）',
  },
  { source: 'codex', label: 'Codex CLI', detectPath: '.codex', mode: 'manual', manualHint: '在 Shell 包装脚本或项目任务前调用下列命令（kind=start/tool/stop）' },
  { source: 'deepseek', label: 'DeepSeek Harness', detectPath: '.deepseek', mode: 'manual', manualHint: '在 Harness 的任务钩子里绑定下列命令' },
  { source: 'qwen', label: 'Qwen Code', detectPath: '.qwen', mode: 'manual', manualHint: '在 Qwen Code 的任务钩子里绑定下列命令' },
  { source: 'kimi', label: 'Kimi CLI', detectPath: '.kimi', mode: 'manual', manualHint: '在 Kimi CLI 的包装脚本里调用下列命令' },
  { source: 'grok', label: 'Grok CLI', detectPath: '.grok', mode: 'manual', manualHint: '在 Grok CLI 的包装脚本里调用下列命令' },
];

export const HOOK_MARKER = 'WB_WORK_FOLLOW_SOURCE';

export interface CliHookStatus {
  source: WorkFollowSource;
  label: string;
  detected: boolean;
  mode: 'json' | 'manual';
  installed: boolean;
  /** 展示用（~ 开头，不含真实用户名） */
  configPath: string;
  snippet: string;
  /** 读文件失败/坏 JSON 的如实原因（installed=false 时） */
  error?: string;
}

export interface InstallResult {
  ok: boolean;
  mode: 'json' | 'manual';
  installed?: boolean;
  snippet?: string;
  backupPath?: string;
  error?: string;
}

export interface WorkFollowInstaller {
  catalog(): CliHookStatus[];
  install(source: string): InstallResult;
  uninstall(source: string): InstallResult;
  manualSnippet(source: string): string;
  hookPath(): string;
}

function assertInside(base: string, target: string): string {
  const root = resolve(base);
  const path = resolve(target);
  if (path !== root && !path.startsWith(`${root}${sep}`)) throw new Error('配置路径越界');
  return path;
}

function quote(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

/** 命令行里的固定标记：既用于识别鲸屿条目，也用于幂等去重。 */
export function buildHookCommand(source: WorkFollowSource, hookPath: string, inboxDir: string, kind?: 'start' | 'tool' | 'stop'): string {
  const env = [
    `${HOOK_MARKER}=${source}`,
    `WB_WORK_FOLLOW_DIR=${quote(inboxDir)}`,
    ...(kind === undefined ? [] : [`WB_WORK_FOLLOW_KIND=${kind}`]),
  ].join(' ');
  return `${env} node ${quote(hookPath)}`;
}

export function manualSnippet(source: WorkFollowSource, hookPath: string, inboxDir: string): string {
  return [
    buildHookCommand(source, hookPath, inboxDir, 'start'),
    buildHookCommand(source, hookPath, inboxDir, 'tool'),
    buildHookCommand(source, hookPath, inboxDir, 'stop'),
  ].join('\n');
}

function isOurEntry(value: unknown): boolean {
  try {
    const text = JSON.stringify(value);
    // 只用固定标记或「work-follow/hook.mjs」精确路径识别；绝不因用户自己的 xxx-hook.mjs 误删
    return text.includes(HOOK_MARKER) || /work-follow[\\/]hook\.mjs/.test(text);
  } catch {
    return false;
  }
}

function readJsonObject(path: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (!existsSync(path)) return { ok: true, value: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: '配置文件不是 JSON 对象，拒绝写入（避免破坏原文件）' };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, error: '配置文件不是合法 JSON，拒绝写入（避免破坏原文件）' };
  }
}

function writeAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.whale-isle.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(temp, path);
}

function backup(path: string): string | undefined {
  if (!existsSync(path) || !statSync(path).isFile()) return undefined;
  const target = `${path}.whale-isle.bak`;
  copyFileSync(path, target);
  return target;
}

function strategyOf(source: string): CliHookStrategy | null {
  return CLI_STRATEGIES.find((entry) => entry.source === source) ?? null;
}

/** 合并一个标准 JSON 钩子文件（纯函数，便于单测）：返回新文档或错误。 */
export function mergeHooksDocument(
  document: Record<string, unknown>,
  strategy: CliHookStrategy,
  command: string | ((kind: 'start' | 'tool' | 'stop') => string),
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const existing = document.hooks;
  if (existing !== undefined && (existing === null || typeof existing !== 'object' || Array.isArray(existing))) {
    return { ok: false, error: 'hooks 字段不是对象，拒绝写入（未知格式）' };
  }
  const hooks: Record<string, unknown> = { ...(existing as Record<string, unknown> | undefined) };
  for (const event of strategy.events ?? []) {
    const current = hooks[event.name];
    if (current !== undefined && !Array.isArray(current)) {
      return { ok: false, error: `hooks.${event.name} 不是数组，拒绝写入（未知格式）` };
    }
    const kept = (Array.isArray(current) ? current : []).filter((entry) => !isOurEntry(entry));
    const resolvedCommand = typeof command === 'function' ? command(event.kind) : command;
    hooks[event.name] = [
      ...kept,
      {
        ...(event.matcher === undefined ? {} : { matcher: event.matcher }),
        hooks: [{ type: 'command', command: resolvedCommand }],
      },
    ];
  }
  return { ok: true, value: { ...document, hooks } };
}

/** 移除鲸屿条目（纯函数）：保留其他钩子；空事件数组/空 hooks 一并清理。 */
export function removeHooksFromDocument(document: Record<string, unknown>): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const existing = document.hooks;
  if (existing === undefined || existing === null) return { ok: true, value: document };
  if (typeof existing !== 'object' || Array.isArray(existing)) {
    return { ok: false, error: 'hooks 字段不是对象，拒绝修改（未知格式）' };
  }
  const hooks: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(existing as Record<string, unknown>)) {
    if (!Array.isArray(value)) {
      hooks[name] = value;
      continue;
    }
    const kept = value.filter((entry) => !isOurEntry(entry));
    if (kept.length > 0) hooks[name] = kept;
  }
  const next: Record<string, unknown> = { ...document };
  if (Object.keys(hooks).length === 0) delete next.hooks;
  else next.hooks = hooks;
  return { ok: true, value: next };
}

export function createWorkFollowInstaller(options: {
  homeDir: string;
  userDataDir: string;
  /** 源码态 tools/hooks/work-follow-hook.mjs 或打包态 resources/hooks/work-follow-hook.mjs */
  hookSource: string;
}): WorkFollowInstaller {
  const inboxDir = join(options.userDataDir, 'work-follow');
  const hookPath = join(inboxDir, 'hook.mjs');

  const ensureHookScript = (): void => {
    if (!existsSync(options.hookSource)) throw new Error(`钩子脚本不存在：${options.hookSource.split(sep).slice(-2).join('/')}`);
    mkdirSync(inboxDir, { recursive: true });
    copyFileSync(options.hookSource, hookPath);
  };

  const configPathOf = (strategy: CliHookStrategy): string | null => {
    if (strategy.mode !== 'json' || strategy.configPath === undefined) return null;
    return assertInside(options.homeDir, join(options.homeDir, strategy.configPath));
  };

  const catalog: WorkFollowInstaller['catalog'] = () => CLI_STRATEGIES.map((strategy) => {
    const detected = existsSync(join(options.homeDir, strategy.detectPath));
    const displayPath = strategy.configPath === undefined ? '' : `~/${strategy.configPath}`;
    const snippet = manualSnippet(strategy.source, hookPath, inboxDir);
    if (strategy.mode === 'manual') {
      return { source: strategy.source, label: strategy.label, detected, mode: 'manual' as const, installed: false, configPath: displayPath, snippet };
    }
    const path = configPathOf(strategy);
    if (path === null) return { source: strategy.source, label: strategy.label, detected, mode: 'json' as const, installed: false, configPath: displayPath, snippet };
    const parsed = readJsonObject(path);
    if (!parsed.ok) {
      return { source: strategy.source, label: strategy.label, detected, mode: 'json' as const, installed: false, configPath: displayPath, snippet, error: parsed.error };
    }
    const hooks = parsed.value.hooks;
    const installed = hooks !== undefined && typeof hooks === 'object' && !Array.isArray(hooks)
      && Object.values(hooks as Record<string, unknown>).some((value) => Array.isArray(value) && value.some((entry) => isOurEntry(entry)));
    return { source: strategy.source, label: strategy.label, detected, mode: 'json' as const, installed, configPath: displayPath, snippet };
  });

  const install = (source: string): InstallResult => {
    const strategy = strategyOf(source);
    if (strategy === null) return { ok: false, mode: 'manual', error: `未知 CLI：${source}` };
    const snippet = manualSnippet(strategy.source, hookPath, inboxDir);
    if (strategy.mode === 'manual') {
      return { ok: false, mode: 'manual', snippet, error: '该 CLI 暂无标准 JSON 钩子文件，请按「手动命令模式」配置' };
    }
    const path = configPathOf(strategy);
    if (path === null) return { ok: false, mode: 'json', error: '配置路径解析失败' };
    try {
      ensureHookScript();
    } catch (error) {
      return { ok: false, mode: 'json', error: error instanceof Error ? error.message : String(error) };
    }
    const parsed = readJsonObject(path);
    if (!parsed.ok) return { ok: false, mode: 'json', error: parsed.error };
    const merged = mergeHooksDocument(parsed.value, strategy, (kind) => buildHookCommand(strategy.source, hookPath, inboxDir, kind));
    if (!merged.ok) return { ok: false, mode: 'json', error: merged.error };
    try {
      const backupPath = backup(path);
      writeAtomic(path, merged.value);
      return { ok: true, mode: 'json', installed: true, ...(backupPath === undefined ? {} : { backupPath: backupPath.split(sep).slice(-1)[0] }), snippet };
    } catch (error) {
      return { ok: false, mode: 'json', error: error instanceof Error ? error.message : String(error) };
    }
  };

  const uninstall = (source: string): InstallResult => {
    const strategy = strategyOf(source);
    if (strategy === null) return { ok: false, mode: 'manual', error: `未知 CLI：${source}` };
    if (strategy.mode === 'manual') return { ok: false, mode: 'manual', error: '手动模式无需卸载：删除你粘贴的命令即可' };
    const path = configPathOf(strategy);
    if (path === null) return { ok: false, mode: 'json', error: '配置路径解析失败' };
    if (!existsSync(path)) return { ok: true, mode: 'json', installed: false };
    const parsed = readJsonObject(path);
    if (!parsed.ok) return { ok: false, mode: 'json', error: parsed.error };
    const removed = removeHooksFromDocument(parsed.value);
    if (!removed.ok) return { ok: false, mode: 'json', error: removed.error };
    try {
      const backupPath = backup(path);
      writeAtomic(path, removed.value);
      return { ok: true, mode: 'json', installed: false, ...(backupPath === undefined ? {} : { backupPath: backupPath.split(sep).slice(-1)[0] }) };
    } catch (error) {
      return { ok: false, mode: 'json', error: error instanceof Error ? error.message : String(error) };
    }
  };

  return {
    catalog,
    install,
    uninstall,
    manualSnippet: (source) => {
      const strategy = strategyOf(source);
      if (strategy === null) return '';
      return manualSnippet(strategy.source, hookPath, inboxDir);
    },
    hookPath: () => hookPath,
  };
}
