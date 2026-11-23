/**
 * T-M6-33 语音后端探测：界面必须如实展示 mcode / say / 未适配，
 * 不能把 macOS say 兜底冒充成角色 TTS，也不能在 Windows 上假装可用。
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));

import { detectVoiceBackend } from './voice-host';

describe('detectVoiceBackend', () => {
  it('macOS + mcode-tools → mcode（角色音色链，失败回落 say）', () => {
    const info = detectVoiceBackend('darwin', (cmd) => cmd === 'mcode-tools');
    expect(info.backend).toBe('mcode');
    expect(info.detail).toContain('mcode-tools');
  });

  it('macOS 无 mcode-tools → say，并明确不是角色 TTS', () => {
    const info = detectVoiceBackend('darwin', () => false);
    expect(info.backend).toBe('say');
    expect(info.detail).toContain('say');
    expect(info.detail).toContain('非角色 TTS');
  });

  it('非 macOS → unsupported（Windows 语音未适配如实上报）', () => {
    const info = detectVoiceBackend('win32', () => true);
    expect(info.backend).toBe('unsupported');
    expect(info.detail).toContain('win32');
  });

  it('每次调用重新探测（安装 mcode-tools 后无需重启即可识别）', () => {
    expect(detectVoiceBackend('darwin', () => false).backend).toBe('say');
    expect(detectVoiceBackend('darwin', () => true).backend).toBe('mcode');
  });
});
