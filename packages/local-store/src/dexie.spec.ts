import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { DirectorDexie, createDirectorStore } from './dexie';

/** T-M0-03：渲染进程 Dexie 配置库（fake-indexeddb 环境下验证读写/快照/删除） */

let db: DirectorDexie;

beforeEach(() => {
  db = new DirectorDexie(`director-test-${Math.random().toString(36).slice(2)}`);
});

describe('DirectorDexie 配置库', () => {
  it('set → get → 覆盖 → 删除', async () => {
    const store = createDirectorStore(db);
    await store.setConfig('diningProfile', { profileId: 'BUDGET_SLACKING', displayName: '🍚 省饭摸鱼档' });
    const first = await store.getConfig<{ profileId: string }>('diningProfile');
    expect(first?.profileId).toBe('BUDGET_SLACKING');
    await store.setConfig('diningProfile', { profileId: 'DELUXE_LIVESTREAM' });
    expect((await store.getConfig<{ profileId: string }>('diningProfile'))?.profileId).toBe('DELUXE_LIVESTREAM');
    await store.deleteConfig('diningProfile');
    expect(await store.getConfig('diningProfile')).toBeUndefined();
    expect(await store.getConfig('absent')).toBeUndefined();
  });

  it('快照 hydrate 与 UI 状态', async () => {
    const store = createDirectorStore(db);
    await store.setConfig('a', 1);
    await store.setConfig('b', 'x');
    await store.setUiState('lastProgramState', 'GAMING_MAIN');
    expect(await store.snapshotConfigs()).toEqual({ a: 1, b: 'x' });
    expect(await store.getUiState<string>('lastProgramState')).toBe('GAMING_MAIN');
    expect(await store.getUiState('absent')).toBeUndefined();
  });

  it('同名库重开数据仍在（IndexedDB 持久化语义）', async () => {
    const name = `director-persist-${Math.random().toString(36).slice(2)}`;
    await createDirectorStore(new DirectorDexie(name)).setConfig('k', 'v');
    const reopened = createDirectorStore(new DirectorDexie(name));
    expect(await reopened.getConfig('k')).toBe('v');
  });
});
