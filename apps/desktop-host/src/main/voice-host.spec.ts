/**
 * T-M6-33 语音后端探测：界面必须如实展示 mcode / say / 未适配，
 * 不能把 macOS say 兜底冒充成角色 TTS，也不能在 Windows 上假装可用。
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));

import { detectVoiceBackend, createVoiceHost, type PlaybackControl } from './voice-host';

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

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('createVoiceHost（T-M6-38 全局串行抢麦）', () => {
  it('多角色按全局队列串行播放，并广播 speaking/idle 与角色音色', async () => {
    const controls: Array<{ input: { voiceId: string }; deferred: ReturnType<typeof deferred> }> = [];
    const speakers: Array<{ activeAgentId: string | null; state: string; voiceId?: string }> = [];
    const host = createVoiceHost('darwin', {
      resolveVoiceId: (characterId) => characterId === 'agent-b' ? 'diadia_xuemei' : 'qiaopi_mengmei',
      onSpeakerChange: (event) => speakers.push({ activeAgentId: event.activeAgentId, state: event.state, ...(event.voiceId === undefined ? {} : { voiceId: event.voiceId }) }),
      play: (input): PlaybackControl => {
        const gate = deferred();
        controls.push({ input, deferred: gate });
        return { done: gate.promise, abort: () => gate.resolve() };
      },
    });

    expect(host.speak({ agentId: 'agent-a', characterId: 'agent-a', speakerName: '小鲸', text: '我先说' }).ok).toBe(true);
    expect(host.speak({ agentId: 'agent-b', characterId: 'agent-b', speakerName: '泡芙', text: '轮到我' }).queued).toBe(true);
    await vi.waitFor(() => expect(speakers).toContainEqual({ activeAgentId: 'agent-a', state: 'speaking', voiceId: 'qiaopi_mengmei' }));

    controls[0]!.deferred.resolve();
    await vi.waitFor(() => expect(speakers).toContainEqual({ activeAgentId: 'agent-b', state: 'speaking', voiceId: 'diadia_xuemei' }));
    expect(controls).toHaveLength(2);

    controls[1]!.deferred.resolve();
    await vi.waitFor(() => expect(speakers.at(-1)).toEqual({ activeAgentId: null, state: 'idle' }));
    expect(host.speakerState()).toEqual({ activeAgentId: null, speakerName: '', state: 'idle' });
  });

  it('TTS 失败/被 P0 抢占会广播语音终态供气泡静音角标使用', async () => {
    const results: Array<{ status: string }> = [];
    const gates: Array<ReturnType<typeof deferred>> = [];
    const host = createVoiceHost('darwin', {
      onSpeechResult: (event) => results.push({ status: event.status }),
      play: () => {
        const gate = deferred();
        gates.push(gate);
        return { done: gate.promise, abort: () => gate.resolve() };
      },
    });
    host.setConfig({ enabled: false });
    host.speak({ agentId: 'agent-a', speakerName: '小鲸', text: '静音测试' });
    expect(results.at(-1)).toEqual({ status: 'failed' });
    host.setConfig({ enabled: true });
    host.speak({ agentId: 'agent-a', speakerName: '小鲸', text: '第一条' });
    await vi.waitFor(() => expect(gates).toHaveLength(1));
    host.speak({ agentId: 'agent-b', speakerName: '泡芙', text: 'P0 抢麦', scene: 'p0' });
    await vi.waitFor(() => expect(results.some((item) => item.status === 'interrupted')).toBe(true));
  });

  it('8s 节流命中时补发 completed 终态，气泡不挂 60s TTL（T-A）', async () => {
    const results: Array<{ status: string }> = [];
    const gates: Array<ReturnType<typeof deferred>> = [];
    const host = createVoiceHost('darwin', {
      onSpeechResult: (event) => results.push({ status: event.status }),
      play: () => {
        const gate = deferred();
        gates.push(gate);
        return { done: gate.promise, abort: () => gate.resolve() };
      },
    });
    host.speak({ agentId: 'agent-a', speakerName: '小鲸', text: '同一句话' });
    await vi.waitFor(() => expect(gates).toHaveLength(1));

    const second = host.speak({ agentId: 'agent-a', speakerName: '小鲸', text: '同一句话' });
    expect(second.ok).toBe(true);
    expect(second.queued).toBeUndefined();
    await vi.waitFor(() => expect(results.at(-1)).toEqual({ status: 'completed' }));
    expect(gates).toHaveLength(1); // 节流不建立第二个租约
  });

  it('空台词与内心戏关闭不产生回执，不污染正在等待的气泡（T-A）', () => {
    const results: Array<{ status: string }> = [];
    const host = createVoiceHost('darwin', {
      onSpeechResult: (event) => results.push({ status: event.status }),
      play: () => {
        const gate = deferred();
        return { done: gate.promise, abort: () => gate.resolve() };
      },
    });
    host.setConfig({ innerVoice: false });
    expect(host.speak({ agentId: 'agent-a', speakerName: '小鲸', text: '心声', scene: 'inner' }).ok).toBe(false);
    expect(host.speak({ agentId: 'agent-a', speakerName: '小鲸', text: '   ' }).ok).toBe(false);
    expect(results).toEqual([]);
  });
});
