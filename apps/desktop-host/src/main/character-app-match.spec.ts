/** 前台应用 → 角色匹配（T-M6-55）：精确/子串、自定义优先、坏包跳过、空值安全。 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() }, app: { isPackaged: false } }));

import { invalidateCustomCharacters } from './custom-character';
import { matchCharacterForApp, matchesFrontApp } from './custom-character';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); invalidateCustomCharacters(); });

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'app-match-'));
  dirs.push(dir);
  return dir;
}

function writeCharacter(root: string, kind: 'custom' | 'crosspet', id: string, apps: string[]): void {
  const dir = kind === 'custom'
    ? join(root, 'pet-characters', id)
    : join(root, 'packs', 'crosspet', 'characters', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'character.json'), JSON.stringify({ name: id, apps }), 'utf8');
  // 自定义角色需要至少一张姿态图才会出现在 readCustomCharacters
  if (kind === 'custom') writeFileSync(join(dir, 'idle.png'), '');
}

describe('matchesFrontApp', () => {
  it('精确匹配大小写不敏感；子串需 ≥4 字符', () => {
    expect(matchesFrontApp(['com.anthropic.claudefordesktop'], 'com.anthropic.claudefordesktop')).toBe(true);
    expect(matchesFrontApp(['Claude'], 'com.anthropic.claudefordesktop')).toBe(true); // 应用名作为子串命中
    expect(matchesFrontApp(['photoshop'], 'com.anthropic.claudefordesktop')).toBe(false);
    expect(matchesFrontApp(['anthropic'], 'com.anthropic.claudefordesktop')).toBe(true);
    expect(matchesFrontApp(['abc'], 'com.abcdef')).toBe(false); // 3 字符不参与子串
    expect(matchesFrontApp([], 'com.anthropic.claudefordesktop')).toBe(false);
    expect(matchesFrontApp(['Claude'], '')).toBe(false);
  });
});

describe('matchCharacterForApp', () => {
  it('自定义角色优先于随包角色，且只返回命中的一个', () => {
    const root = temp();
    writeCharacter(root, 'custom', 'my-claude', ['com.anthropic.claudefordesktop']);
    writeCharacter(root, 'crosspet', 'claude', ['com.anthropic.claudefordesktop']);
    const match = matchCharacterForApp({ userDataDir: root, packsRoot: join(root, 'packs'), bundleId: 'com.anthropic.claudefordesktop' });
    expect(match).toEqual({ characterId: 'custom-my-claude', name: 'my-claude', app: 'com.anthropic.claudefordesktop' });
  });

  it('随包角色可按 apps 命中；无匹配返回 null；坏角色文件跳过', () => {
    const root = temp();
    writeCharacter(root, 'crosspet', 'cursor', ['com.todesktop.230313mzl4w4u92']);
    mkdirSync(join(root, 'packs', 'crosspet', 'characters', 'broken'), { recursive: true });
    writeFileSync(join(root, 'packs', 'crosspet', 'characters', 'broken', 'character.json'), '{oops', 'utf8');
    expect(matchCharacterForApp({ userDataDir: root, packsRoot: join(root, 'packs'), bundleId: 'com.todesktop.230313mzl4w4u92' }))
      .toEqual({ characterId: 'crosspet-cursor', name: 'cursor', app: 'com.todesktop.230313mzl4w4u92' });
    expect(matchCharacterForApp({ userDataDir: root, packsRoot: join(root, 'packs'), bundleId: 'com.openai.chat' })).toBeNull();
  });

  it('未提供 packsRoot 时只看自定义角色；空 apps 不参与', () => {
    const root = temp();
    writeCharacter(root, 'custom', 'plain', []);
    writeCharacter(root, 'crosspet', 'claude', ['com.anthropic.claudefordesktop']);
    expect(matchCharacterForApp({ userDataDir: root, bundleId: 'com.anthropic.claudefordesktop' })).toBeNull();
    expect(matchCharacterForApp({ userDataDir: root, packsRoot: join(root, 'packs'), bundleId: 'com.anthropic.claudefordesktop' }))
      .toMatchObject({ characterId: 'crosspet-claude' });
  });
});
