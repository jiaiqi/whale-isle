/** 统一姿态档案（T-M6-63）：随包 crosspet-* 与自定义角色共用读取口径、首见问候按天去重。 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));

import { invalidateCustomCharacters } from './custom-character';
import { resolvePoseCharacterProfile, resolveProfileGreeting } from './custom-character-host';
import type { GreetingLog } from './greeting-schedule';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  invalidateCustomCharacters();
});

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pose-profile-'));
  dirs.push(dir);
  return dir;
}

function writeCrossPet(root: string, dirName: string, data: Record<string, unknown>, poses: string[]): void {
  const dir = join(root, 'crosspet', 'characters', dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'character.json'), JSON.stringify({ name: dirName, ...data }), 'utf8');
  for (const pose of poses) writeFileSync(join(dir, `${pose}.webp`), '');
}

function memoryStore(initial: GreetingLog = { seen: {} }): { read: () => GreetingLog; write: (log: GreetingLog) => void } {
  let log = initial;
  return { read: () => log, write: (next) => { log = next; } };
}

describe('resolvePoseCharacterProfile：随包 CrossPet', () => {
  it('读取真实存在的扩展字段与姿态；立绘不进姿态表；缺省字段保持 undefined', () => {
    const root = temp();
    writeCrossPet(root, 'claude', {
      greeting: '我在这儿～',
      accent: '#e8a33d',
      apps: ['com.anthropic.claudefordesktop'],
      lines: { idle: ['在呢'], fest_spring: ['新年好'] },
      correctedPose: 'sorry',
      longThink: { after: 20, pose: 'deepthink' },
      fx: { proud: 'victory' },
      idleActions: ['clawd'],
      glyph: { fill: '#b5651d' },
      outfit: '米色针织衫',
    }, ['idle', 'sorry', 'deepthink', 'clawd', 'fest_spring', 'portrait', 'avatar']);
    const profile = resolvePoseCharacterProfile({ userDataDir: join(root, 'user'), packsRoot: root, characterId: 'crosspet-claude' });
    expect(profile).not.toBeNull();
    expect(profile).toMatchObject({
      characterId: 'crosspet-claude',
      source: 'crosspet',
      name: 'claude',
      greeting: '我在这儿～',
      correctedPose: 'sorry',
      longThink: { after: 20, pose: 'deepthink' },
      fx: { proud: 'victory' },
      idleActions: ['clawd'],
      glyph: { fill: '#b5651d' },
      apps: ['com.anthropic.claudefordesktop'],
      accent: '#e8a33d',
      outfit: '米色针织衫',
    });
    expect([...(profile?.poses ?? [])].sort()).toEqual(['clawd', 'deepthink', 'fest_spring', 'idle', 'sorry']);
    expect(profile?.pokePose).toBeUndefined();
    expect(profile?.egg).toBeUndefined();
    expect(profile?.host).toBeUndefined();
  });

  it('非 crosspet 前缀、目录穿越、坏 JSON、缺少姿态图都返回 null', () => {
    const root = temp();
    writeCrossPet(root, 'gpt', { name: 'GPT' }, ['idle']);
    expect(resolvePoseCharacterProfile({ userDataDir: join(root, 'user'), packsRoot: root, characterId: 'unknown-id' })).toBeNull();
    expect(resolvePoseCharacterProfile({ userDataDir: join(root, 'user'), packsRoot: root, characterId: 'crosspet-../../etc' })).toBeNull();
    const broken = join(root, 'crosspet', 'characters', 'broken');
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, 'character.json'), '{oops', 'utf8');
    writeFileSync(join(broken, 'idle.webp'), '');
    expect(resolvePoseCharacterProfile({ userDataDir: join(root, 'user'), packsRoot: root, characterId: 'crosspet-broken' })).toBeNull();
    const noPose = join(root, 'crosspet', 'characters', 'empty');
    mkdirSync(noPose, { recursive: true });
    writeFileSync(join(noPose, 'character.json'), JSON.stringify({ name: '空' }), 'utf8');
    expect(resolvePoseCharacterProfile({ userDataDir: join(root, 'user'), packsRoot: root, characterId: 'crosspet-empty' })).toBeNull();
  });
});

describe('resolvePoseCharacterProfile：自定义角色优先', () => {
  it('custom-* 命中后返回角色协议字段（不读随包同 id）', () => {
    const root = temp();
    const customDir = join(root, 'pet-characters', 'my-claude');
    mkdirSync(customDir, { recursive: true });
    writeFileSync(join(customDir, 'character.json'), JSON.stringify({
      name: '我的 Claude',
      greeting: '来啦',
      lines: { idle: ['嗯'] },
      correctedPose: 'sorry',
      pokePose: 'pout',
      apps: ['com.anthropic.claudefordesktop'],
      egg: true,
    }), 'utf8');
    writeFileSync(join(customDir, 'idle.png'), '');
    writeCrossPet(root, 'claude', { name: '随包 Claude', lines: { idle: ['随包'] } }, ['idle']);
    const profile = resolvePoseCharacterProfile({ userDataDir: root, packsRoot: root, characterId: 'custom-my-claude' });
    expect(profile).toMatchObject({ characterId: 'custom-my-claude', source: 'custom', name: '我的 Claude', egg: true, pokePose: 'pout' });
    // 也允许直接传目录 id
    expect(resolvePoseCharacterProfile({ userDataDir: root, packsRoot: root, characterId: 'my-claude' })?.characterId).toBe('custom-my-claude');
  });
});

describe('resolveProfileGreeting：节日优先 + 按天去重', () => {
  it('春节当天命中 fest_spring 并只触发一次；换日可再次触发', () => {
    const root = temp();
    writeCrossPet(root, 'claude', { lines: { fest_spring: ['新年好'], greet_morning: ['早上好'] } }, ['fest_spring', 'greet_morning']);
    const profile = resolvePoseCharacterProfile({ userDataDir: join(root, 'user'), packsRoot: root, characterId: 'crosspet-claude' })!;
    const store = memoryStore();
    const spring = new Date(2026, 1, 17, 8, 0, 0);
    expect(resolveProfileGreeting(profile, store, spring)).toMatchObject({ key: 'fest_spring', pose: 'fest_spring', line: '新年好' });
    expect(resolveProfileGreeting(profile, store, spring)).toBeNull();
    // 同一天换时段也不再重复（键不同但当天节日优先；这里已验证首见原子去重）
    expect(store.read().seen['crosspet-claude:2026-02-17:fest_spring']).toBeTruthy();
    const nextDay = new Date(2026, 2, 2, 8, 0, 0);
    expect(resolveProfileGreeting(profile, store, nextDay)).toMatchObject({ key: 'greet_morning' });
  });

  it('没有任何节日/时段姿态图时返回 null（不编造问候）', () => {
    const root = temp();
    writeCrossPet(root, 'gemini', { lines: {} }, ['idle']);
    const profile = resolvePoseCharacterProfile({ userDataDir: join(root, 'user'), packsRoot: root, characterId: 'crosspet-gemini' })!;
    expect(resolveProfileGreeting(profile, memoryStore(), new Date(2026, 2, 2, 9, 0, 0))).toBeNull();
  });
});
