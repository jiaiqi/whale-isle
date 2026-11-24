/** CLI 钩子安装引擎（T-M6-58）：沙箱 home 下幂等安装/备份/干净卸载/坏 JSON 拒绝/手动模式。 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildHookCommand, CLI_STRATEGIES, createWorkFollowInstaller, mergeHooksDocument, removeHooksFromDocument } from './work-follow-installer';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function sandbox(): { home: string; userData: string; hookSource: string; installer: ReturnType<typeof createWorkFollowInstaller> } {
  const root = mkdtempSync(join(tmpdir(), 'cli-hooks-'));
  dirs.push(root);
  const home = join(root, 'home');
  const userData = join(root, 'userData');
  mkdirSync(home, { recursive: true });
  mkdirSync(userData, { recursive: true });
  const hookSource = join(root, 'hook-src.mjs');
  writeFileSync(hookSource, '#!/usr/bin/env node\nconsole.log("hook");\n', 'utf8');
  return { home, userData, hookSource, installer: createWorkFollowInstaller({ homeDir: home, userDataDir: userData, hookSource }) };
}

describe('CLI 策略清单', () => {
  it('覆盖 8 家；Claude/Gemini/Cursor 为标准 JSON，其余诚实手动模式', () => {
    expect(CLI_STRATEGIES).toHaveLength(8);
    expect(CLI_STRATEGIES.filter((entry) => entry.mode === 'json').map((entry) => entry.source)).toEqual(['claude', 'gemini', 'cursor']);
    expect(CLI_STRATEGIES.filter((entry) => entry.mode === 'manual').map((entry) => entry.source)).toEqual(['codex', 'deepseek', 'qwen', 'kimi', 'grok']);
  });

  it('命令带固定 WB_WORK_FOLLOW_SOURCE 标记与收件目录', () => {
    const command = buildHookCommand('claude', '/tmp/hook.mjs', '/tmp/inbox');
    expect(command).toContain('WB_WORK_FOLLOW_SOURCE=claude');
    expect(command).toContain('WB_WORK_FOLLOW_DIR="/tmp/inbox"');
    expect(command).toContain('node "/tmp/hook.mjs"');
    expect(buildHookCommand('codex', '/tmp/hook.mjs', '/tmp/inbox', 'start')).toContain('WB_WORK_FOLLOW_KIND=start');
  });
});

describe('catalog 探测', () => {
  it('目录存在 → 已检测到；手动模式未安装；配置路径以 ~ 展示', () => {
    const { home, installer } = sandbox();
    mkdirSync(join(home, '.claude'), { recursive: true });
    mkdirSync(join(home, '.codex'), { recursive: true });
    const catalog = installer.catalog();
    const claude = catalog.find((entry) => entry.source === 'claude')!;
    expect(claude).toMatchObject({ detected: true, mode: 'json', installed: false, configPath: '~/.claude/settings.json' });
    expect(catalog.find((entry) => entry.source === 'codex')).toMatchObject({ detected: true, mode: 'manual', installed: false });
    expect(catalog.find((entry) => entry.source === 'gemini')).toMatchObject({ detected: false, mode: 'json', installed: false });
    expect(claude.snippet).toContain('WB_WORK_FOLLOW_SOURCE=claude');
  });
});

describe('安装 / 幂等 / 备份 / 卸载', () => {
  it('首次安装：复制 hook 脚本、备份原文件、保留用户钩子并追加三条事件', () => {
    const { home, userData, installer } = sandbox();
    const configPath = join(home, '.claude', 'settings.json');
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(configPath, JSON.stringify({
      theme: 'dark',
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo user-hook' }] }] },
    }, null, 2));

    const result = installer.install('claude');
    expect(result.ok).toBe(true);
    expect(result.backupPath).toBe('settings.json.whale-isle.bak');
    expect(existsSync(join(userData, 'work-follow', 'hook.mjs'))).toBe(true);
    expect(existsSync(`${configPath}.whale-isle.bak`)).toBe(true);

    const doc = JSON.parse(readFileSync(configPath, 'utf8')) as { theme: string; hooks: Record<string, unknown[]> };
    expect(doc.theme).toBe('dark');
    expect(doc.hooks.PreToolUse).toHaveLength(2);
    expect(JSON.stringify(doc.hooks.PreToolUse?.[0])).toContain('echo user-hook');
    expect(JSON.stringify(doc.hooks.PreToolUse?.[1])).toContain('WB_WORK_FOLLOW_SOURCE=claude');
    expect(doc.hooks.UserPromptSubmit).toHaveLength(1);
    expect(doc.hooks.Stop).toHaveLength(1);

    // 幂等：再装一次不重复
    expect(installer.install('claude').ok).toBe(true);
    const again = JSON.parse(readFileSync(configPath, 'utf8')) as { hooks: Record<string, unknown[]> };
    expect(again.hooks.PreToolUse).toHaveLength(2);
    expect(again.hooks.UserPromptSubmit).toHaveLength(1);
    expect(installer.catalog().find((entry) => entry.source === 'claude')?.installed).toBe(true);
  });

  it('卸载：只移除鲸屿条目，用户钩子与顶层配置完整保留', () => {
    const { home, installer } = sandbox();
    const configPath = join(home, '.cursor', 'hooks.json');
    mkdirSync(join(home, '.cursor'), { recursive: true });
    writeFileSync(configPath, JSON.stringify({
      version: 1,
      hooks: {
        stop: [{ command: 'echo user-stop' }],
        customEvent: [{ command: 'echo keep' }],
      },
    }, null, 2));
    expect(installer.install('cursor').ok).toBe(true);
    expect(installer.uninstall('cursor').ok).toBe(true);
    const doc = JSON.parse(readFileSync(configPath, 'utf8')) as { version: number; hooks: Record<string, Array<{ command?: string }>> };
    expect(doc.version).toBe(1);
    expect(doc.hooks.stop).toEqual([{ command: 'echo user-stop' }]);
    expect(doc.hooks.customEvent).toEqual([{ command: 'echo keep' }]);
    expect(doc.hooks.beforeSubmitPrompt).toBeUndefined();
    expect(doc.hooks.beforeShellExecution).toBeUndefined();
    expect(JSON.stringify(doc)).not.toContain('WB_WORK_FOLLOW_SOURCE');
    expect(installer.catalog().find((entry) => entry.source === 'cursor')?.installed).toBe(false);
  });

  it('之前没有配置文件：安装新建，卸载后只留空对象不报错', () => {
    const { home, installer } = sandbox();
    expect(installer.install('gemini').ok).toBe(true);
    const path = join(home, '.gemini', 'settings.json');
    expect(existsSync(path)).toBe(true);
    expect(installer.uninstall('gemini').ok).toBe(true);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({});
  });
});

describe('安全门禁', () => {
  it('坏 JSON 拒绝写入且原文件一字不动', () => {
    const { home, installer } = sandbox();
    const configPath = join(home, '.claude', 'settings.json');
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(configPath, '{ not json', 'utf8');
    const result = installer.install('claude');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('不是合法 JSON');
    expect(readFileSync(configPath, 'utf8')).toBe('{ not json');
    expect(installer.catalog().find((entry) => entry.source === 'claude')?.error).toContain('不是合法 JSON');
  });

  it('hooks 字段不是对象 / 事件不是数组 → 拒绝（不乱改未知格式）', () => {
    const { home, installer } = sandbox();
    const claudePath = join(home, '.claude', 'settings.json');
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(claudePath, JSON.stringify({ hooks: 'weird' }));
    expect(installer.install('claude').error).toContain('hooks 字段');
    writeFileSync(claudePath, JSON.stringify({ hooks: { PreToolUse: { command: 'x' } } }));
    expect(installer.install('claude').error).toContain('PreToolUse 不是数组');
    expect(readFileSync(claudePath, 'utf8')).toContain('PreToolUse');
  });

  it('手动模式不写任何文件，只返回可复制命令；未知来源拒绝', () => {
    const { home, userData, installer } = sandbox();
    const before = JSON.stringify(installer.catalog());
    const manual = installer.install('codex');
    expect(manual.ok).toBe(false);
    expect(manual.mode).toBe('manual');
    expect(manual.snippet).toContain('WB_WORK_FOLLOW_SOURCE=codex');
    expect(existsSync(join(home, '.codex'))).toBe(false);
    expect(JSON.stringify(installer.catalog())).toBe(before);
    expect(existsSync(join(userData, 'work-follow', 'hook.mjs'))).toBe(false);
    expect(installer.install('unknown').error).toContain('未知 CLI');
    expect(installer.manualSnippet('unknown')).toBe('');
  });

  it('钩子脚本源缺失 → 安装失败但不动配置文件', () => {
    const root = mkdtempSync(join(tmpdir(), 'cli-hooks-'));
    dirs.push(root);
    const home = join(root, 'home');
    mkdirSync(join(home, '.claude'), { recursive: true });
    const installer = createWorkFollowInstaller({ homeDir: home, userDataDir: join(root, 'ud'), hookSource: join(root, 'missing.mjs') });
    const result = installer.install('claude');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('钩子脚本不存在');
    expect(existsSync(join(home, '.claude', 'settings.json'))).toBe(false);
  });
});

describe('纯合并函数', () => {
  it('mergeHooksDocument 不修改原对象（不可变）；removeHooksFromDocument 清空后删除 hooks 键', () => {
    const original = { hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'WB_WORK_FOLLOW_SOURCE=claude node hook.mjs' }] }] } };
    const merged = mergeHooksDocument(original, CLI_STRATEGIES[0]!, buildHookCommand('claude', '/h/hook.mjs', '/inbox'));
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    expect(original.hooks.UserPromptSubmit).toHaveLength(1);
    expect((merged.value.hooks as Record<string, unknown[]>).UserPromptSubmit).toHaveLength(1); // 幂等替换
    const removed = removeHooksFromDocument(merged.value);
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    expect(removed.value.hooks).toBeUndefined();
  });
});
