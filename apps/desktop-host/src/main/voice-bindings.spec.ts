/**
 * 语音中心角色绑定（T-M6-46）：默认值继承、覆盖持久化、非法输入与坏文件降级。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));

import { characterVoiceViews, createVoiceBindingStore } from './voice-bindings';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const DEFAULTS: Record<string, string> = { 'aboutme-dsh': 'qiaopi_mengmei', 'aboutme-grok': 'Arrogant_Miss' };

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), 'voice-bindings-'));
  dirs.push(dir);
  const filePath = join(dir, 'voice-bindings.json');
  return { filePath, store: createVoiceBindingStore({ filePath, defaultVoiceOf: (id) => DEFAULTS[id] }) };
}

describe('角色声线绑定', () => {
  it('未覆盖时继承角色包默认音色', () => {
    const { store } = makeStore();
    expect(store.resolve('aboutme-dsh')).toBe('qiaopi_mengmei');
    expect(store.all()).toEqual({});
  });

  it('覆盖值持久化并在重建后仍生效；改回默认则删除覆盖', () => {
    const { filePath, store } = makeStore();
    expect(store.set('aboutme-grok', 'diadia_xuemei')).toEqual({ ok: true });
    expect(store.resolve('aboutme-grok')).toBe('diadia_xuemei');
    const reloaded = createVoiceBindingStore({ filePath, defaultVoiceOf: (id) => DEFAULTS[id] });
    expect(reloaded.get('aboutme-grok')).toBe('diadia_xuemei');
    expect(reloaded.set('aboutme-grok', 'Arrogant_Miss')).toEqual({ ok: true });
    expect(reloaded.get('aboutme-grok')).toBeUndefined();
    expect(reloaded.resolve('aboutme-grok')).toBe('Arrogant_Miss');
  });

  it('拒绝未知角色与空音色；坏文件按空表降级', () => {
    const { filePath, store } = makeStore();
    expect(store.set('nobody', 'x')).toMatchObject({ ok: false });
    expect(store.set('aboutme-dsh', '')).toMatchObject({ ok: false });
    writeFileSync(filePath, '{broken');
    const recovered = createVoiceBindingStore({ filePath, defaultVoiceOf: (id) => DEFAULTS[id] });
    expect(recovered.all()).toEqual({});
    expect(recovered.resolve('aboutme-dsh')).toBe('qiaopi_mengmei');
  });

  it('9 角色视图标记默认/覆盖来源', () => {
    const { store } = makeStore();
    store.set('aboutme-grok', 'diadia_xuemei');
    const views = characterVoiceViews([
      { id: 'aboutme-dsh', displayName: '蓝蓝', voiceId: 'qiaopi_mengmei' },
      { id: 'aboutme-grok', displayName: '小魔女', voiceId: 'Arrogant_Miss' },
    ], store);
    expect(views[0]).toMatchObject({ characterId: 'aboutme-dsh', voiceId: 'qiaopi_mengmei', overridden: false });
    expect(views[1]).toMatchObject({ characterId: 'aboutme-grok', voiceId: 'diadia_xuemei', defaultVoiceId: 'Arrogant_Miss', overridden: true });
  });
});
