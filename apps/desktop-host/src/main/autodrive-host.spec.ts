import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { isPackaged: false },
  ipcMain: { handle: vi.fn() },
  safeStorage: { isEncryptionAvailable: () => false },
}));
vi.mock('./character-persona', () => ({
  currentPersonaPrompt: () => '',
  currentPersonaReflex: () => null,
}));

import { dayKeyExtractorFor, resolveGuideDirectory } from './autodrive-host';

describe('autodrive host game paths', () => {
  it('uses distinct game-day keys for Stardew, Terraria, and DST', () => {
    expect(dayKeyExtractorFor('stardew')('第1年春16日 08:00')).toBe('春16日');
    expect(dayKeyExtractorFor('terraria')('第 42 天')).toBe('terraria-42');
    expect(dayKeyExtractorFor('dst')('第 8 轮 白天')).toBe('dst-8');
  });

  it('resolves bundled guides from Electron resources in packaged builds', () => {
    expect(resolveGuideDirectory(true, '/tmp/whale-resources')).toBe('/tmp/whale-resources/guide-forager');
    expect(resolveGuideDirectory(false, '/unused', 'file:///repo/apps/desktop-host/src/main/index.js')).toMatch(/\/guide-forager$/);
  });
});
